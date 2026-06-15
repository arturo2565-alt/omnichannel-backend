/** Código panel: posibles daños internos (no confundir con PDI = puerta delantera izquierda). */
export const PANEL_PIEZA_INTERNAL_DAMAGES_CODE = 'PDI_INT';

/** Refacción con detalle y precio manual. */
export const PANEL_PIEZA_REFACCION_CODE = 'REFACCION';

export type PanelPiezaOption = {
  code: string;
  fullName: string;
  catalogPieza: string;
  internalDamageRange?: boolean;
  refaccionManual?: boolean;
};

export const PANEL_PIEZA_OPTIONS: readonly PanelPiezaOption[] = [
  {
    code: PANEL_PIEZA_INTERNAL_DAMAGES_CODE,
    fullName: 'Posibles daños internos',
    catalogPieza: '',
    internalDamageRange: true,
  },
  {
    code: PANEL_PIEZA_REFACCION_CODE,
    fullName: 'Refacción',
    catalogPieza: '',
    refaccionManual: true,
  },
  { code: 'SI', fullName: 'Salpicadera izquierda', catalogPieza: 'Salpicadera' },
  { code: 'SD', fullName: 'Salpicadera derecha', catalogPieza: 'Salpicadera' },
  {
    code: 'STI',
    fullName: 'Salpicadera trasera izquierda',
    catalogPieza: 'Salpicadera',
  },
  {
    code: 'STD',
    fullName: 'Salpicadera trasera derecha',
    catalogPieza: 'Salpicadera',
  },
  { code: 'PDI', fullName: 'Puerta delantera izquierda', catalogPieza: 'Puerta' },
  { code: 'PDD', fullName: 'Puerta delantera derecha', catalogPieza: 'Puerta' },
  { code: 'PTI', fullName: 'Puerta trasera izquierda', catalogPieza: 'Puerta' },
  { code: 'PTD', fullName: 'Puerta trasera derecha', catalogPieza: 'Puerta' },
  { code: 'EI', fullName: 'Estribos izquierdos', catalogPieza: 'Estribo' },
  { code: 'ED', fullName: 'Estribos derechos', catalogPieza: 'Estribo' },
  { code: 'FD', fullName: 'Fascia delantera', catalogPieza: 'Fascia' },
  { code: 'FT', fullName: 'Fascia trasera', catalogPieza: 'Fascia' },
  { code: 'POI', fullName: 'Poste izquierdo', catalogPieza: 'Poste' },
  { code: 'POD', fullName: 'Poste derecho', catalogPieza: 'Poste' },
  { code: 'Cofre', fullName: 'Cofre', catalogPieza: 'Cofre' },
  { code: 'BiCO', fullName: 'Bigote Cofre', catalogPieza: 'BiCO' },
  { code: 'Parilla', fullName: 'Parilla', catalogPieza: 'Parilla' },
  { code: 'Tapa Cajuela', fullName: 'Tapa de cajuela', catalogPieza: 'Tapa Cajuela' },
  { code: 'Toldo', fullName: 'Toldo', catalogPieza: 'Toldo' },
  { code: 'Espejo', fullName: 'Espejo', catalogPieza: 'Espejo' },
  { code: 'Moldura', fullName: 'Moldura', catalogPieza: 'Estetica Exterior' },
  {
    code: 'Estetica Exterior',
    fullName: 'Estética exterior',
    catalogPieza: 'Estetica Exterior',
  },
  {
    code: 'BPC',
    fullName: 'Baño de Pintura Completo',
    catalogPieza: 'Baño de Pintura Exterior',
  },
];

const byCode = new Map(PANEL_PIEZA_OPTIONS.map((o) => [o.code, o]));

function normalizePiezaText(s: string): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Aliases explícitos cuando varias siglas comparten el mismo catalogPieza. */
const EXPLICIT_PIEZA_ALIASES: Readonly<Record<string, string>> = {
  'fascia delantera': 'FD',
  'fascia delantero': 'FD',
  'fascia trasera': 'FT',
  'fascia trasero': 'FT',
  'salpicadera izquierda': 'SI',
  'salpicadera derecha': 'SD',
  'salpicadera delantera izquierda': 'SI',
  'salpicadera delantera derecha': 'SD',
  'salpicadera del izquierda': 'SI',
  'salpicadera trasera izquierda': 'STI',
  'salpicadera trasera derecha': 'STD',
  'puerta delantera izquierda': 'PDI',
  'puerta delantera derecha': 'PDD',
  'puerta trasera izquierda': 'PTI',
  'puerta trasera derecha': 'PTD',
  'estribo izquierdo': 'EI',
  'estribos izquierdos': 'EI',
  'estribo derecho': 'ED',
  'estribos derechos': 'ED',
  'poste izquierdo': 'POI',
  'poste derecho': 'POD',
  'bigote cofre': 'BiCO',
  bico: 'BiCO',
  parilla: 'Parilla',
};

const catalogPiezaCodeCounts = new Map<string, number>();
for (const opt of PANEL_PIEZA_OPTIONS) {
  if (!opt.catalogPieza) continue;
  catalogPiezaCodeCounts.set(
    opt.catalogPieza,
    (catalogPiezaCodeCounts.get(opt.catalogPieza) ?? 0) + 1,
  );
}

const aliasNormToCode = new Map<string, string>();
for (const opt of PANEL_PIEZA_OPTIONS) {
  aliasNormToCode.set(normalizePiezaText(opt.code), opt.code);
  aliasNormToCode.set(normalizePiezaText(opt.fullName), opt.code);
  if (
    opt.catalogPieza &&
    catalogPiezaCodeCounts.get(opt.catalogPieza) === 1
  ) {
    aliasNormToCode.set(normalizePiezaText(opt.catalogPieza), opt.code);
  }
}
for (const [alias, code] of Object.entries(EXPLICIT_PIEZA_ALIASES)) {
  aliasNormToCode.set(normalizePiezaText(alias), code);
}
aliasNormToCode.set(
  normalizePiezaText('posibles danos internos'),
  PANEL_PIEZA_INTERNAL_DAMAGES_CODE,
);
aliasNormToCode.set(
  normalizePiezaText('posibles daños internos'),
  PANEL_PIEZA_INTERNAL_DAMAGES_CODE,
);
aliasNormToCode.set(normalizePiezaText('refaccion'), PANEL_PIEZA_REFACCION_CODE);
aliasNormToCode.set(normalizePiezaText('refacción'), PANEL_PIEZA_REFACCION_CODE);

const catalogNamesByLengthDesc = [
  ...new Set(
    PANEL_PIEZA_OPTIONS.map((o) => o.catalogPieza).filter(Boolean),
  ),
].sort((a, b) => b.length - a.length);

function matchCatalogPiezaFromFreeText(parteLibre: string): string | null {
  const n = normalizePiezaText(parteLibre);
  if (!n) return null;
  for (const name of catalogNamesByLengthDesc) {
    const key = normalizePiezaText(name);
    if (!key) continue;
    if (n === key || n.includes(key) || (key.length >= 4 && key.includes(n))) {
      return name;
    }
  }
  return null;
}

function disambiguatePanelOptionsFromText(
  text: string,
  candidates: readonly PanelPiezaOption[],
): PanelPiezaOption | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  const n = normalizePiezaText(text);
  const wantsDelantera = /\bdelantera?\b|\bdel\b/.test(n);
  const wantsTrasera = /\btrasera?\b|\btras\b/.test(n);
  const wantsIzquierd = /\bizquierd/.test(n);
  const wantsDerech = /\bderech/.test(n);

  let pool = [...candidates];
  if (wantsDelantera) {
    pool = pool.filter((o) => /delantera|del\b/i.test(o.fullName));
  } else if (wantsTrasera) {
    pool = pool.filter((o) => /trasera|tras\b/i.test(o.fullName));
  }
  if (wantsIzquierd) {
    pool = pool.filter((o) => /izquierd/i.test(o.fullName));
  } else if (wantsDerech) {
    pool = pool.filter((o) => /derech/i.test(o.fullName));
  }
  if (pool.length === 1) return pool[0]!;
  return null;
}

export function findPanelPiezaOption(raw: string): PanelPiezaOption | null {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  if (byCode.has(t)) return byCode.get(t)!;
  const n = normalizePiezaText(t);
  const direct = aliasNormToCode.get(n);
  if (direct) return byCode.get(direct) ?? null;
  if (/^refacci[oó]n(\s*:|$)/i.test(t)) {
    return byCode.get(PANEL_PIEZA_REFACCION_CODE) ?? null;
  }
  for (const opt of PANEL_PIEZA_OPTIONS) {
    const fn = normalizePiezaText(opt.fullName);
    if (n === fn) return opt;
  }
  const partialHits: PanelPiezaOption[] = [];
  for (const opt of PANEL_PIEZA_OPTIONS) {
    const fn = normalizePiezaText(opt.fullName);
    if (n.includes(fn) || fn.includes(n)) partialHits.push(opt);
  }
  const disambiguated = disambiguatePanelOptionsFromText(t, partialHits);
  if (disambiguated) return disambiguated;
  if (partialHits.length === 1) return partialHits[0]!;
  return null;
}

/** Normaliza texto/sigla de visión o inventario al código del panel (FD, SI, …). */
export function normalizePanelPiezaCode(raw: string): string {
  const opt = findPanelPiezaOption(raw);
  return opt?.code ?? String(raw ?? '').trim();
}

export function isInternalDamageRangePieza(raw: string): boolean {
  const t = String(raw ?? '').trim();
  if (t === PANEL_PIEZA_INTERNAL_DAMAGES_CODE) return true;
  if (/posibles\s+da[nñ]os\s+internos/i.test(t)) return true;
  return Boolean(findPanelPiezaOption(raw)?.internalDamageRange);
}

export function isRefaccionPieza(raw: string): boolean {
  const t = String(raw ?? '').trim();
  if (t === PANEL_PIEZA_REFACCION_CODE) return true;
  if (/^refacci[oó]n(\s*:|$)/i.test(t)) return true;
  return Boolean(findPanelPiezaOption(raw)?.refaccionManual);
}

export function isSpecialPanelPieza(raw: string): boolean {
  return isInternalDamageRangePieza(raw) || isRefaccionPieza(raw);
}

/**
 * Pieza base del catálogo (PriceMatrix) para siglas del panel: SI/SD → Salpicadera, PDI → Puerta, etc.
 */
export function resolveCatalogPiezaForMatrixLookup(raw: string): string | null {
  if (isSpecialPanelPieza(raw)) return null;
  const opt = findPanelPiezaOption(raw);
  if (opt?.catalogPieza) return opt.catalogPieza;
  return matchCatalogPiezaFromFreeText(raw);
}

/** Texto enviado a `matchServicio` antes de buscar en la matriz. */
export function resolveMatrixServicioRaw(parteLibre: string): string {
  const catalog = resolveCatalogPiezaForMatrixLookup(parteLibre);
  return catalog ?? String(parteLibre ?? '').trim();
}
