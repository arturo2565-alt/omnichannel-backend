import {
  ColorGithub,
  importColorReading,
  type ColorFiles,
  type ColorReading,
} from './color-annotation';

/**
 * El color es opcional. Si el expediente ya quedó guardado y la anotación
 * falla, la importación sigue en pie y un reintento la completa sin un
 * identificador nuevo. No confirma la corrección del propietario.
 */

const HISTORICAL = new Set(['AF-000001', 'AF-000002', 'AF-000003']);
const COLORS = new Set([
  'blanco', 'negro', 'rojo', 'azul', 'gris', 'plata', 'plateado', 'verde', 'amarillo',
  'naranja', 'cafe', 'beige', 'dorado', 'vino', 'guinda', 'grafito', 'marfil', 'cobre',
  'bronce', 'tinto', 'arena', 'crema', 'hueso',
]);
const TOKEN = /[0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+(?:-[0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)*/gu;
const CHANGE = /cambio de\s+([0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ-]+)\s+a\s+([0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ-]+)/giu;
const BATH = /ba[nñ]o de pintura en color\s+([0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ-]+)/giu;
const VISUAL = /se observa de color\s+([0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ-]+)/giu;
const EXPLICIT = /en color\s+([0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ-]+)/giu;
const CODE = /(?:c[oó]digo(?:\s+de\s+pintura)?|clave)\s+([A-Za-z0-9]{2,12})/giu;
const FINISH = /(?:acabado|terminado)\s+(mate|brillante|perlado|met[aá]lico|metalizado|s[oó]lido|tricapa|bicapa)/giu;

export type ColorImportReport = {
  status: 'recorded' | 'already_recorded' | 'retained' | 'conflict' | 'pending' | 'rejected';
  enriched: boolean;
  subjectId: string;
  clarification?: boolean;
};

export function interpretColorStatement(value: string): ColorReading | null {
  const text = value.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim();
  if (!text) return null;
  let ambiguous = false;
  const changes = uniquePairs([...text.matchAll(CHANGE)].map((match) => [match[1], match[2]] as const));
  const baths = uniqueTokens([...text.matchAll(BATH)].map((match) => match[1]));
  const visuals = uniqueTokens([...text.matchAll(VISUAL)].map((match) => match[1]));
  const explicit = uniqueTokens([...text.matchAll(EXPLICIT)]
    .filter((match) => !coveredBy(match.index ?? 0, [...text.matchAll(BATH)]) && !coveredBy(match.index ?? 0, [...text.matchAll(CHANGE)]))
    .map((match) => match[1]));
  const named = vehicleColors(text);
  if (changes.some(([from, to]) => !isColor(from) || !isColor(to))) ambiguous = true;
  if (baths.some((token) => !isColor(token)) || explicit.some((token) => !isColor(token)) || visuals.some((token) => !isColor(token))) {
    ambiguous = true;
  }
  const knownChanges = changes.filter(([from, to]) => isColor(from) && isColor(to));
  const declared = uniqueTokens([
    ...baths.filter(isColor),
    ...explicit.filter(isColor),
    ...named,
  ]);
  if (knownChanges.length > 1) ambiguous = true;
  if (knownChanges.length === 1 && declared.some((token) => fold(token) !== fold(knownChanges[0][0]) && fold(token) !== fold(knownChanges[0][1]))) {
    ambiguous = true;
  }
  if (knownChanges.length === 0 && declared.length > 1) ambiguous = true;
  const knownVisuals = visuals.filter(isColor);
  if (knownVisuals.length > 1) ambiguous = true;
  if (ambiguous || (mentionsColor(text) && knownChanges.length === 0 && declared.length === 0 && knownVisuals.length === 0)) {
    return unknownReading();
  }
  if (knownChanges.length === 1) {
    const [from, to] = knownChanges[0];
    return reading(from, 'human_declaration', to, text);
  }
  if (declared.length === 1) return reading(declared[0], 'human_declaration', null, text);
  if (knownVisuals.length === 1) {
    const human = declared[0];
    if (human && fold(human) !== fold(knownVisuals[0])) return reading(human, 'human_declaration', null, text);
    if (human) return reading(human, 'human_declaration', null, text);
    return reading(knownVisuals[0], 'visual_inference', null, text);
  }
  return null;
}

export function declaredColorReading(colors: {
  current: string | null;
  current_evidence: string;
  requested: string | null;
  requested_evidence: string;
}): ColorReading | null {
  const current = colors.current_evidence === 'customer_provided' ? colors.current : null;
  const requested = colors.requested_evidence === 'customer_provided' ? colors.requested : null;
  if (!current && !requested) return null;
  return {
    exteriorColor: current,
    exteriorProvenance: current ? 'human_declaration' : 'unknown',
    requestedColor: requested,
    requestedProvenance: requested ? 'human_declaration' : null,
    finish: null,
    finishProvenance: null,
    paintCode: null,
    paintCodeProvenance: null,
  };
}

export function visualColorReading(input: {
  statement?: unknown;
  observations?: readonly string[];
  make?: string | null;
  model?: string | null;
  variant?: string | null;
}): ColorReading | null {
  return interpretColorStatement([
    typeof input.statement === 'string' ? input.statement : '',
    ...(input.observations ?? []),
    [input.make, input.model, input.variant].filter((item) => typeof item === 'string' && item.trim()).join(' '),
  ].filter(Boolean).join('\n'));
}

export function repairColorReading(input: {
  make?: string | null;
  model?: string | null;
  variant?: string | null;
  conditions?: readonly string[];
}): ColorReading | null {
  return interpretColorStatement([
    [input.make, input.model, input.variant].filter((item) => typeof item === 'string' && item.trim()).join(' '),
    ...(input.conditions ?? []),
  ].filter(Boolean).join('\n'));
}

export async function applyColorImport(
  files: ColorFiles,
  subjectId: string,
  reading: ColorReading,
): Promise<ColorImportReport> {
  if (subjectId.startsWith('CQ-') && !/^CQ-\d{6}$/.test(subjectId)) {
    return { status: 'rejected', enriched: false, subjectId };
  }
  if (HISTORICAL.has(subjectId)) return { status: 'rejected', enriched: false, subjectId, clarification: false };
  try {
    const saved = await importColorReading(files, subjectId, reading);
    const clarified = reading.exteriorProvenance === 'unknown' && reading.requestedColor == null;
    return {
      status: saved.status === 'recorded' || saved.status === 'already_recorded' || saved.status === 'retained' || saved.status === 'conflict'
        ? saved.status
        : 'pending',
      enriched: saved.status === 'recorded' || saved.status === 'already_recorded' || saved.status === 'retained',
      subjectId,
      ...(clarified ? { clarification: true } : {}),
    };
  } catch {
    return { status: 'pending', enriched: false, subjectId };
  }
}

export function openImportedColorFiles(
  transport: typeof fetch,
  authorization: () => Promise<string>,
): ColorFiles {
  return new ColorGithub(transport, authorization);
}

export function pendingColor(subjectId: string): ColorImportReport {
  return { status: 'pending', enriched: false, subjectId };
}

function reading(
  exterior: string,
  provenance: 'human_declaration' | 'visual_inference',
  requested: string | null,
  text: string,
): ColorReading {
  const finish = single(FINISH, text);
  const paintCode = single(CODE, text);
  return {
    exteriorColor: exterior,
    exteriorProvenance: provenance,
    requestedColor: requested,
    requestedProvenance: requested ? 'human_declaration' : null,
    finish: provenance === 'human_declaration' ? finish : null,
    finishProvenance: provenance === 'human_declaration' && finish ? 'human_declaration' : null,
    paintCode: provenance === 'human_declaration' ? paintCode : null,
    paintCodeProvenance: provenance === 'human_declaration' && paintCode ? 'human_declaration' : null,
  };
}

function unknownReading(): ColorReading {
  return {
    exteriorColor: null,
    exteriorProvenance: 'unknown',
    requestedColor: null,
    requestedProvenance: null,
    finish: null,
    finishProvenance: null,
    paintCode: null,
    paintCodeProvenance: null,
  };
}

function vehicleColors(text: string): string[] {
  const found: string[] = [];
  for (const clause of text.split(/[.;\n]+/)) {
    const folded = fold(clause);
    if (/\b(?:observa|cambio|bano|fotografia|fotografias)\b/.test(folded) || /\ben color\b/.test(folded)) continue;
    const tokens = clause.match(TOKEN) ?? [];
    if (tokens.length < 2 || tokens.length > 6) continue;
    const last = tokens[tokens.length - 1];
    if (!isColor(last) || tokens.slice(0, -1).some(isColor)) continue;
    found.push(last);
  }
  return uniqueTokens(found);
}

function single(pattern: RegExp, text: string): string | null {
  const found = uniqueTokens([...text.matchAll(new RegExp(pattern.source, pattern.flags))].map((match) => match[1]));
  if (found.length !== 1) return null;
  if (pattern === CODE && isColor(found[0])) return null;
  return found[0];
}

function uniqueTokens(values: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const value of values) {
    const key = fold(value);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(value);
  }
  return kept;
}

function uniquePairs(values: ReadonlyArray<readonly [string, string]>): Array<[string, string]> {
  const seen = new Set<string>();
  const kept: Array<[string, string]> = [];
  for (const [from, to] of values) {
    const key = `${fold(from)}>${fold(to)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push([from, to]);
  }
  return kept;
}

function coveredBy(index: number, matches: RegExpMatchArray[]): boolean {
  return matches.some((match) => {
    const start = match.index ?? 0;
    return index >= start && index < start + match[0].length;
  });
}

function mentionsColor(text: string): boolean {
  if (/\bcolor\b/.test(fold(text))) return true;
  return (fold(text).match(/[a-z0-9-]+/g) ?? []).some((token) => COLORS.has(token));
}

function isColor(token: string): boolean {
  return COLORS.has(fold(token));
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es-MX');
}
