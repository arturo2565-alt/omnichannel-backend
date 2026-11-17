import type { SeverityLevel } from './severity-annotation';
import type { SeverityRequest } from './severity-import';

/**
 * La frase humana manda sobre la pieza y su lateralidad.
 * Una inferencia visual puede quedar como observación. No reescribe
 * el nombre, el tratamiento ni el precio, y no valida la severidad.
 */

const LEVELS: Array<{ level: SeverityLevel; pattern: RegExp }> = [
  { level: 'medio_leve', pattern: /dano medio[\s-]+leve/g },
  { level: 'medio_fuerte', pattern: /dano medio[\s-]+fuerte/g },
  { level: 'leve', pattern: /dano leve/g },
  { level: 'fuerte', pattern: /dano fuerte/g },
  { level: 'medio', pattern: /dano medio/g },
];

const DISCREPANCY = 'Posible discrepancia visual: la fotografía parece mostrar el lado contrario de la pieza declarada. Procedencia: visual_inference. No es un hecho confirmado.';
const CLARIFICATION = 'La severidad escrita no es un nivel explícito de severity-v1 y queda sin clasificación.';
const VISUAL_SEVERITY = 'Advertencia visual no aplicada: la inferencia no sustituye la severidad declarada. Procedencia: visual_inference.';

export type QuoteAuthorityResult = {
  lineItems: unknown;
  visualObservations: unknown;
  severity: SeverityRequest[] | null;
};

export function applyQuoteAuthority(input: {
  lineItems: unknown;
  visualObservations: unknown;
  severity: SeverityRequest[] | null;
  operatorStatement?: unknown;
}): QuoteAuthorityResult {
  if (!Array.isArray(input.lineItems) || input.lineItems.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    return {
      lineItems: input.lineItems,
      visualObservations: input.visualObservations,
      severity: input.severity,
    };
  }
  const statement = typeof input.operatorStatement === 'string' ? input.operatorStatement : '';
  const lines = input.lineItems.map((item) => ({ ...(item as Record<string, unknown>) }));
  for (const line of lines) {
    if (typeof line.part !== 'string') continue;
    const declared = declaredReplacement(statement, line.part);
    if (declared) line.part = declared;
  }
  const observations = Array.isArray(input.visualObservations) ? [...input.visualObservations] : input.visualObservations;
  const notes = Array.isArray(observations) ? observations : [];
  let discrepancy = false;
  for (const line of lines) {
    const visual = typeof line.visual_part === 'string' ? line.visual_part : '';
    if (typeof line.part === 'string' && visual && samePieceOppositeSide(line.part, visual)) discrepancy = true;
    delete line.visual_part;
  }
  if (discrepancy) notes.push(DISCREPANCY);
  const severity = declaredSeverity(lines, statement, input.severity, notes);
  return {
    lineItems: lines,
    visualObservations: Array.isArray(observations) ? notes : input.visualObservations,
    severity,
  };
}

function declaredSeverity(
  lines: Array<Record<string, unknown>>,
  statement: string,
  supplied: SeverityRequest[] | null,
  notes: unknown[],
): SeverityRequest[] | null {
  const parts = lines.map((line) => (typeof line.part === 'string' ? line.part : ''));
  const assigned = new Map<number, SeverityLevel>();
  const blocked = new Set<number>();
  let ambiguous = false;
  let current: number[] = [];
  for (const clause of clauses(statement)) {
    const mentioned = mentionedLines(clause, parts);
    if (mentioned.length > 0) current = mentioned;
    const reading = clauseLevels(clause);
    if (reading.ambiguous) {
      ambiguous = true;
      continue;
    }
    if (reading.levels.length !== 1) continue;
    const targets = mentioned.length > 0 ? mentioned : current.length > 0 ? current : parts.length === 1 ? [0] : [];
    if (targets.length === 0) {
      ambiguous = true;
      continue;
    }
    for (const index of targets) {
      if (!grant(assigned, blocked, index, reading.levels[0])) ambiguous = true;
    }
  }
  lines.forEach((line, index) => {
    if (typeof line.part !== 'string' || blocked.has(index)) return;
    const reading = clauseLevels(line.part);
    if (reading.ambiguous) {
      ambiguous = true;
      return;
    }
    if (reading.levels.length === 1 && !grant(assigned, blocked, index, reading.levels[0])) ambiguous = true;
  });
  if (ambiguous) notes.push(CLARIFICATION);
  const kept = (supplied ?? []).filter((item) => {
    const index = lines.findIndex((line) => line.line_id === item.lineId);
    return index < 0 || !assigned.has(index);
  });
  let warned = false;
  for (const [index, level] of assigned) {
    if (blocked.has(index)) continue;
    const lineId = lines[index]?.line_id;
    if (typeof lineId !== 'string' || !lineId.trim()) continue;
    const previous = (supplied ?? []).find((item) => item.lineId === lineId);
    if (previous?.assessment === 'visual_inference' && previous.level !== level) warned = true;
    kept.push({ lineId, assessment: 'human_declaration', level });
  }
  if (warned) notes.push(VISUAL_SEVERITY);
  return kept.length > 0 ? kept : null;
}

function grant(
  assigned: Map<number, SeverityLevel>,
  blocked: Set<number>,
  index: number,
  level: SeverityLevel,
): boolean {
  const current = assigned.get(index);
  if (blocked.has(index) || (current && current !== level)) {
    assigned.delete(index);
    blocked.add(index);
    return false;
  }
  assigned.set(index, level);
  return true;
}

function clauses(statement: string): string[] {
  return fold(statement).split(/[.;\n]+/).map((item) => item.trim()).filter(Boolean);
}

function clauseLevels(clause: string): { levels: SeverityLevel[]; ambiguous: boolean } {
  const reading = explicitLevels(fold(clause));
  if (reading.leftover || reading.levels.length > 1) return { levels: [], ambiguous: true };
  if (reading.levels.length === 1) return { levels: reading.levels, ambiguous: false };
  if (/\bdano\b/.test(fold(clause))) return { levels: [], ambiguous: true };
  return { levels: [], ambiguous: false };
}

function explicitLevels(folded: string): { levels: SeverityLevel[]; leftover: boolean } {
  const covered: Array<[number, number]> = [];
  const found: SeverityLevel[] = [];
  for (const item of LEVELS) {
    for (const match of folded.matchAll(item.pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (covered.some(([left, right]) => start < right && end > left)) continue;
      covered.push([start, end]);
      found.push(item.level);
    }
  }
  const visible = [...folded];
  for (const [left, right] of covered) {
    for (let index = left; index < right; index += 1) visible[index] = ' ';
  }
  return {
    levels: [...new Set(found)],
    leftover: /\b(?:leve|medio|fuerte)\b/.test(visible.join('')),
  };
}

function mentionedLines(clause: string, parts: readonly string[]): number[] {
  const folded = fold(clause);
  const hits = parts.flatMap((part, index) => {
    const text = fold(part);
    return text && folded.includes(text) ? [{ index, text }] : [];
  });
  return hits
    .filter((item) => !hits.some((other) => other.index !== item.index && other.text.includes(item.text) && other.text !== item.text))
    .map((item) => item.index);
}

function declaredReplacement(statement: string, part: string): string | null {
  const side = sideOf(part);
  if (!side || !statement.trim()) return null;
  const other = side === 'derecha' ? 'izquierda' : 'derecha';
  const match = part.match(/\b(derecha|izquierda)\b/iu);
  if (!match || match.index == null) return null;
  const candidate = `${part.slice(0, match.index)}${other}${part.slice(match.index + match[1].length)}`;
  const found = statement.toLocaleLowerCase('es-MX').indexOf(candidate.toLocaleLowerCase('es-MX'));
  if (found < 0) return null;
  return statement.slice(found, found + candidate.length);
}

function samePieceOppositeSide(left: string, right: string): boolean {
  const leftSide = sideOf(left);
  const rightSide = sideOf(right);
  if (!leftSide || !rightSide || leftSide === rightSide) return false;
  return pieceKey(left, leftSide) === pieceKey(right, rightSide);
}

function pieceKey(value: string, side: 'derecha' | 'izquierda'): string {
  return fold(value).replace(new RegExp(`\\b${side}\\b`, 'u'), 'lado');
}

function sideOf(value: string): 'derecha' | 'izquierda' | null {
  const found = new Set(fold(value).match(/\b(?:derecha|izquierda)\b/gu) ?? []);
  if (found.size !== 1) return null;
  return [...found][0] as 'derecha' | 'izquierda';
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es-MX').replace(/\s+/g, ' ').trim();
}
