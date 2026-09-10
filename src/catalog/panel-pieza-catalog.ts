/** Código panel: posibles daños internos (no confundir con PDI = puerta delantera izquierda). */
export const PANEL_PIEZA_INTERNAL_DAMAGES_CODE = 'PDI_INT';

/** Refacción con detalle y precio manual. */
export const PANEL_PIEZA_REFACCION_CODE = 'REFACCION';

/** Baño de pintura exterior (alias legacy BPC). */
export const PANEL_PIEZA_BPE_CODE = 'BPE';
/** Baño exterior + interiores de puertas/cofre. */
export const PANEL_PIEZA_BPEI_CODE = 'BPEI';
/** Baño con cambio total de color (incluye desarmado). */
export const PANEL_PIEZA_BPCC_CODE = 'BPCC';
/** @deprecated usar BPE — se conserva para carritos viejos. */
export const PANEL_PIEZA_BPC_CODE = 'BPC';

/** Cerámico automotriz (servicio integral). */
export const PANEL_PIEZA_CERAMICO_CODE = 'CERAMICO';

/** Estética automotriz integral. */
export const PANEL_PIEZA_ESTETICA_AUTO_CODE = 'ESTETICA_AUTO';

export type PanelPiezaOption = {
  code: string;
  fullName: string;
  catalogPieza: string;
  internalDamageRange?: boolean;
  refaccionManual?: boolean;
  banioCompleto?: boolean;
  integralService?: boolean;
  /** Óptica / faro / calavera: no se valúa en matriz de pintura. */
  optica?: boolean;
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
  { code: 'CTI', fullName: 'Costado izquierdo', catalogPieza: 'Salpicadera' },
  { code: 'CTD', fullName: 'Costado derecho', catalogPieza: 'Salpicadera' },
  { code: 'Tapa Cajuela', fullName: 'Tapa de cajuela', catalogPieza: 'Tapa Cajuela' },
  { code: 'Toldo', fullName: 'Toldo', catalogPieza: 'Toldo' },
  { code: 'ESI', fullName: 'Espejo izquierdo', catalogPieza: 'Espejo' },
  { code: 'ESD', fullName: 'Espejo derecho', catalogPieza: 'Espejo' },
  { code: 'Espejo', fullName: 'Espejo', catalogPieza: 'Espejo' },
  {
    code: 'Faro_Izquierdo',
    fullName: 'Faro izquierdo',
    catalogPieza: '',
    optica: true,
  },
  {
    code: 'Faro_Derecho',
    fullName: 'Faro derecho',
    catalogPieza: '',
    optica: true,
  },
  {
    code: 'Calavera_Izquierda',
    fullName: 'Calavera izquierda',
    catalogPieza: '',
    optica: true,
  },
  {
    code: 'Calavera_Derecha',
    fullName: 'Calavera derecha',
    catalogPieza: '',
    optica: true,
  },
  {
    code: 'Faro_Niebla_Izquierdo',
    fullName: 'Faro de niebla izquierdo',
    catalogPieza: '',
    optica: true,
  },
  {
    code: 'Faro_Niebla_Derecho',
    fullName: 'Faro de niebla derecho',
    catalogPieza: '',
    optica: true,
  },
  { code: 'Moldura', fullName: 'Moldura', catalogPieza: 'Estetica Exterior' },
  {
    code: 'Estetica Exterior',
    fullName: 'Estética exterior',
    catalogPieza: 'Estetica Exterior',
  },
  {
    code: PANEL_PIEZA_BPE_CODE,
    fullName: 'Baño de Pintura Exterior',
    catalogPieza: 'Baño de Pintura Exterior',
    banioCompleto: true,
    integralService: true,
  },
  {
    code: PANEL_PIEZA_BPEI_CODE,
    fullName: 'Baño de Pintura Exterior e Interiores',
    catalogPieza: 'Baño de Pintura Exterior',
    banioCompleto: true,
    integralService: true,
  },
  {
    code: PANEL_PIEZA_BPCC_CODE,
    fullName: 'Baño de Pintura con Cambio de Color',
    catalogPieza: 'Baño de Pintura Exterior',
    banioCompleto: true,
    integralService: true,
  },
  {
    code: PANEL_PIEZA_BPC_CODE,
    fullName: 'Baño de Pintura Completo',
    catalogPieza: 'Baño de Pintura Exterior',
    banioCompleto: true,
    integralService: true,
  },
  {
    code: PANEL_PIEZA_CERAMICO_CODE,
    fullName: 'Cerámico Automotriz',
    catalogPieza: 'Cerámico Automotriz',
    integralService: true,
  },
  {
    code: PANEL_PIEZA_ESTETICA_AUTO_CODE,
    fullName: 'Estética Automotriz',
    catalogPieza: 'Estética Automotriz',
    integralService: true,
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
  'costado izquierdo': 'CTI',
  'costado izq': 'CTI',
  'costado derecho': 'CTD',
  'costado der': 'CTD',
  'espejo izquierdo': 'ESI',
  'espejo izq': 'ESI',
  'espejo derecho': 'ESD',
  'espejo der': 'ESD',
  porton: 'Tapa Cajuela',
  'porton trasero': 'Tapa Cajuela',
  'portón': 'Tapa Cajuela',
  'portón trasero': 'Tapa Cajuela',
  'tapa cajuela': 'Tapa Cajuela',
  'bigote cofre': 'BiCO',
  bico: 'BiCO',
  parilla: 'Parilla',
  'faro izquierdo': 'Faro_Izquierdo',
  'faro izq': 'Faro_Izquierdo',
  'faro principal izquierdo': 'Faro_Izquierdo',
  'faro delantero izquierdo': 'Faro_Izquierdo',
  'optica delantera izquierda': 'Faro_Izquierdo',
  faro_izq: 'Faro_Izquierdo',
  'faro derecho': 'Faro_Derecho',
  'faro der': 'Faro_Derecho',
  'faro principal derecho': 'Faro_Derecho',
  'faro delantero derecho': 'Faro_Derecho',
  'optica delantera derecha': 'Faro_Derecho',
  faro_der: 'Faro_Derecho',
  'calavera izquierda': 'Calavera_Izquierda',
  'calavera izq': 'Calavera_Izquierda',
  'calavera trasera izquierda': 'Calavera_Izquierda',
  'stop izquierdo': 'Calavera_Izquierda',
  'luz trasera izquierda': 'Calavera_Izquierda',
  cal_izq: 'Calavera_Izquierda',
  'calavera derecha': 'Calavera_Derecha',
  'calavera der': 'Calavera_Derecha',
  'calavera trasera derecha': 'Calavera_Derecha',
  'stop derecho': 'Calavera_Derecha',
  'luz trasera derecha': 'Calavera_Derecha',
  cal_der: 'Calavera_Derecha',
  'faro niebla izquierdo': 'Faro_Niebla_Izquierdo',
  'faro de niebla izquierdo': 'Faro_Niebla_Izquierdo',
  'antiniebla izquierdo': 'Faro_Niebla_Izquierdo',
  faro_niebla_izq: 'Faro_Niebla_Izquierdo',
  'faro niebla derecho': 'Faro_Niebla_Derecho',
  'faro de niebla derecho': 'Faro_Niebla_Derecho',
  'antiniebla derecho': 'Faro_Niebla_Derecho',
  faro_niebla_der: 'Faro_Niebla_Derecho',
};

/** Código de panel → código del catálogo de refacciones. */
export const OPTICA_PANEL_TO_CATALOG_CODIGO: Readonly<Record<string, string>> = {
  Faro_Izquierdo: 'FARO_IZQ',
  Faro_Derecho: 'FARO_DER',
  Calavera_Izquierda: 'CAL_IZQ',
  Calavera_Derecha: 'CAL_DER',
  Faro_Niebla_Izquierdo: 'FARO_NIEBLA_IZQ',
  Faro_Niebla_Derecho: 'FARO_NIEBLA_DER',
};

const CATALOG_CODIGO_TO_OPTICA_PANEL: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(OPTICA_PANEL_TO_CATALOG_CODIGO).map(([panel, codigo]) => [
      codigo,
      panel,
    ]),
  );

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
aliasNormToCode.set(normalizePiezaText('bpe'), PANEL_PIEZA_BPE_CODE);
aliasNormToCode.set(normalizePiezaText('bpei'), PANEL_PIEZA_BPEI_CODE);
aliasNormToCode.set(normalizePiezaText('bpcc'), PANEL_PIEZA_BPCC_CODE);
aliasNormToCode.set(normalizePiezaText('bpc'), PANEL_PIEZA_BPE_CODE);
aliasNormToCode.set(
  normalizePiezaText('bano de pintura completo'),
  PANEL_PIEZA_BPE_CODE,
);
aliasNormToCode.set(
  normalizePiezaText('baño de pintura completo'),
  PANEL_PIEZA_BPE_CODE,
);
aliasNormToCode.set(
  normalizePiezaText('bano de pintura exterior'),
  PANEL_PIEZA_BPE_CODE,
);
aliasNormToCode.set(
  normalizePiezaText('baño de pintura exterior'),
  PANEL_PIEZA_BPE_CODE,
);
aliasNormToCode.set(
  normalizePiezaText('bano de pintura exterior e interiores'),
  PANEL_PIEZA_BPEI_CODE,
);
aliasNormToCode.set(
  normalizePiezaText('baño de pintura exterior e interiores'),
  PANEL_PIEZA_BPEI_CODE,
);
aliasNormToCode.set(
  normalizePiezaText('cambio de color'),
  PANEL_PIEZA_BPCC_CODE,
);
aliasNormToCode.set(
  normalizePiezaText('bano de pintura con cambio de color'),
  PANEL_PIEZA_BPCC_CODE,
);
aliasNormToCode.set(
  normalizePiezaText('baño de pintura con cambio de color'),
  PANEL_PIEZA_BPCC_CODE,
);
aliasNormToCode.set(
  normalizePiezaText('ceramico automotriz'),
  PANEL_PIEZA_CERAMICO_CODE,
);
aliasNormToCode.set(
  normalizePiezaText('cerámico automotriz'),
  PANEL_PIEZA_CERAMICO_CODE,
);
aliasNormToCode.set(
  normalizePiezaText('estetica automotriz'),
  PANEL_PIEZA_ESTETICA_AUTO_CODE,
);
aliasNormToCode.set(
  normalizePiezaText('estética automotriz'),
  PANEL_PIEZA_ESTETICA_AUTO_CODE,
);
for (const [codigo, panel] of Object.entries(CATALOG_CODIGO_TO_OPTICA_PANEL)) {
  aliasNormToCode.set(normalizePiezaText(codigo), panel);
}

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
  return canonicalizePanelCode(raw);
}

/**
 * Código canónico de panel. Un código válido (FD, PDI, BPE…) o un nombre
 * natural resuelve a la sigla que `resolveMatrixServicioRaw` usa para price_matrix.
 */
export function canonicalizePanelCode(rawPiece: string): string {
  const t = String(rawPiece ?? '').trim();
  if (!t) return '';
  if (byCode.has(t)) return t;
  const upper = t.toUpperCase();
  if (byCode.has(upper)) return upper;
  const opt = findPanelPiezaOption(t);
  if (opt?.code) return opt.code;
  return t;
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

const OPTICA_PANEL_CODES = new Set(Object.keys(OPTICA_PANEL_TO_CATALOG_CODIGO));

export function isOpticaPanelPieza(raw: string): boolean {
  const t = String(raw ?? '').trim();
  if (!t) return false;
  if (/^refacci[oó]n(\s*:|$)/i.test(t)) {
    const inner = t.replace(/^refacci[oó]n\s*:\s*/i, '').trim();
    return inner ? isOpticaPanelPieza(inner) : false;
  }
  const code = canonicalizePanelCode(t);
  if (OPTICA_PANEL_CODES.has(code)) return true;
  if (Boolean(findPanelPiezaOption(t)?.optica)) return true;
  const n = normalizePiezaText(t);
  return /\b(faro|calavera|optica|antiniebla|luz trasera|\bstop\b)\b/.test(n);
}

/** Código de `RefaccionCatalog` para una pieza de visión o sigla de panel. */
export function refaccionCatalogCodigoForPieza(raw: string): string | null {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  const inner = t.replace(/^refacci[oó]n\s*:\s*/i, '').trim() || t;
  const code = canonicalizePanelCode(inner);
  if (OPTICA_PANEL_TO_CATALOG_CODIGO[code]) {
    return OPTICA_PANEL_TO_CATALOG_CODIGO[code]!;
  }
  const compact = inner.toUpperCase().replace(/[\s-]+/g, '_');
  if (CATALOG_CODIGO_TO_OPTICA_PANEL[compact]) return compact;
  if (/^[A-Z][A-Z0-9_]{1,31}$/.test(compact)) return compact;
  return null;
}

const BANIO_PANEL_CODES = new Set([
  PANEL_PIEZA_BPE_CODE,
  PANEL_PIEZA_BPEI_CODE,
  PANEL_PIEZA_BPCC_CODE,
  PANEL_PIEZA_BPC_CODE,
]);

export function isBanioPinturaCompletoPieza(raw: string): boolean {
  const code = canonicalizePanelCode(raw);
  if (BANIO_PANEL_CODES.has(code)) return true;
  if (Boolean(findPanelPiezaOption(raw)?.banioCompleto)) return true;
  const n = normalizePiezaText(String(raw ?? ''));
  return (
    n === 'bpc' ||
    n === 'bpe' ||
    n === 'bpei' ||
    n === 'bpcc' ||
    n.includes('bano de pintura') ||
    n.includes('baño de pintura')
  );
}

/** Cerámico, estética automotriz o baño de pintura (precio por tamaño). */
export function isIntegralPanelPieza(raw: string): boolean {
  const t = String(raw ?? '').trim();
  if (
    BANIO_PANEL_CODES.has(t) ||
    t === PANEL_PIEZA_CERAMICO_CODE ||
    t === PANEL_PIEZA_ESTETICA_AUTO_CODE
  ) {
    return true;
  }
  const opt = findPanelPiezaOption(raw);
  if (opt?.integralService || opt?.banioCompleto) return true;
  const n = normalizePiezaText(t);
  if (n.includes('ceramico') && n.includes('automotriz')) return true;
  if (n.includes('estetica') && n.includes('automotriz')) return true;
  return isBanioPinturaCompletoPieza(raw);
}

export function isSpecialPanelPieza(raw: string): boolean {
  return isInternalDamageRangePieza(raw) || isRefaccionPieza(raw);
}

/**
 * Pieza base del catálogo (PriceMatrix) para siglas del panel: SI/SD → Salpicadera, PDI → Puerta, etc.
 */
export function resolveCatalogPiezaForMatrixLookup(raw: string): string | null {
  if (isSpecialPanelPieza(raw) || isIntegralPanelPieza(raw)) return null;
  if (isOpticaPanelPieza(raw)) return null;
  const opt = findPanelPiezaOption(raw);
  if (opt?.catalogPieza) return opt.catalogPieza;
  return matchCatalogPiezaFromFreeText(raw);
}

/** Texto enviado a `matchServicio` antes de buscar en la matriz. */
export function resolveMatrixServicioRaw(parteLibre: string): string {
  const catalog = resolveCatalogPiezaForMatrixLookup(parteLibre);
  return catalog ?? String(parteLibre ?? '').trim();
}
