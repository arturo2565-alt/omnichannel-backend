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
  { code: 'Cofre', fullName: 'Cofre', catalogPieza: 'Cofre' },
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

const aliasNormToCode = new Map<string, string>();
for (const opt of PANEL_PIEZA_OPTIONS) {
  aliasNormToCode.set(normalizePiezaText(opt.code), opt.code);
  aliasNormToCode.set(normalizePiezaText(opt.fullName), opt.code);
  if (opt.catalogPieza) {
    aliasNormToCode.set(normalizePiezaText(opt.catalogPieza), opt.code);
  }
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
    if (n === fn || n.includes(fn) || fn.includes(n)) return opt;
  }
  return null;
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
