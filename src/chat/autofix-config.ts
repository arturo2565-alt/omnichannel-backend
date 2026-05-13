/**
 * Matriz de precios (pieza × nivel de daño) para hojalatería / pintura.
 * Los importes viven en BD (`price_matrix`); aquí solo tipos y funciones puras
 * que reciben la matriz en memoria (p. ej. caché del servidor).
 */

export const AUTO_FIX_CURRENCY = 'MXN' as const;

/** Niveles de daño (columnas de la matriz) */
export const DAMAGE_LEVEL_KEYS = [
  'DL',
  'DML',
  'DM',
  'DMF',
  'DF',
  'DMFuerte',
] as const;

export type DamageLevel = (typeof DAMAGE_LEVEL_KEYS)[number];

/**
 * Normaliza el texto del modelo a un código de nivel válido para la matriz.
 * Orden de prueba evita que "DM" coincida dentro de "DMF" / "DMFuerte".
 */
export function coerceDamageLevelCode(raw: string): DamageLevel {
  const t = (raw ?? '').trim();
  if (!t) return 'DM';
  const order: DamageLevel[] = ['DMFuerte', 'DF', 'DMF', 'DM', 'DML', 'DL'];
  for (const level of order) {
    const escaped = level.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(t)) return level;
  }
  return 'DM';
}

export type PiezaPriceRow = { pieza: string } & Record<DamageLevel, number>;

export class AutofixPricingLookupError extends Error {
  constructor(
    message: string,
    public readonly pieza: string,
    public readonly severidad: string,
  ) {
    super(message);
    this.name = 'AutofixPricingLookupError';
  }
}

export function normalizePiezaTextForMatch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Construye filas agregadas pieza × niveles a partir de entradas planas (BD).
 */
export function buildPiezaPriceRowsFromFlatEntries(
  entries: ReadonlyArray<{ pieza: string; severidad: string; precio: number }>,
): PiezaPriceRow[] {
  const byPieza = new Map<string, PiezaPriceRow>();
  for (const e of entries) {
    const pieza = String(e.pieza ?? '').trim();
    if (!pieza) continue;
    const sevRaw = String(e.severidad ?? '').trim();
    const sev = DAMAGE_LEVEL_KEYS.includes(sevRaw as DamageLevel)
      ? (sevRaw as DamageLevel)
      : coerceDamageLevelCode(sevRaw);
    const precio = Number(e.precio);
    if (!Number.isFinite(precio) || precio < 0) continue;
    let row = byPieza.get(pieza);
    if (!row) {
      row = { pieza } as PiezaPriceRow;
      for (const k of DAMAGE_LEVEL_KEYS) {
        (row as Record<DamageLevel, number>)[k] = 0;
      }
      byPieza.set(pieza, row);
    }
    (row as Record<DamageLevel, number>)[sev] = precio;
  }
  return [...byPieza.values()];
}

function buildRowIndex(matrix: readonly PiezaPriceRow[]): {
  rowByPiezaNorm: Map<string, PiezaPriceRow>;
  rowsByPiezaLengthDesc: PiezaPriceRow[];
} {
  const rowByPiezaNorm = new Map<string, PiezaPriceRow>();
  for (const row of matrix) {
    rowByPiezaNorm.set(normalizePiezaTextForMatch(row.pieza), row);
  }
  const rowsByPiezaLengthDesc = [...matrix].sort(
    (a, b) => b.pieza.length - a.pieza.length,
  );
  return { rowByPiezaNorm, rowsByPiezaLengthDesc };
}

/**
 * Intenta emparejar texto libre del peritaje con una fila de la matriz en memoria.
 * @returns nombre canónico de `pieza` en la matriz, o null.
 */
export function matchPiezaFromAnalysisWithMatrix(
  parteLibre: string,
  matrix: readonly PiezaPriceRow[],
): string | null {
  if (!matrix.length) return null;
  const { rowByPiezaNorm, rowsByPiezaLengthDesc } = buildRowIndex(matrix);
  const n = normalizePiezaTextForMatch(parteLibre);
  if (!n) return null;
  if (rowByPiezaNorm.has(n)) return rowByPiezaNorm.get(n)!.pieza;
  for (const row of rowsByPiezaLengthDesc) {
    const key = normalizePiezaTextForMatch(row.pieza);
    if (!key) continue;
    if (n.includes(key) || (key.length >= 4 && key.includes(n))) {
      return row.pieza;
    }
  }
  return null;
}

export function findPiezaRowInMatrix(
  pieza: string,
  matrix: readonly PiezaPriceRow[],
): PiezaPriceRow | null {
  if (!matrix.length) return null;
  const { rowByPiezaNorm } = buildRowIndex(matrix);
  const n = normalizePiezaTextForMatch(pieza);
  if (rowByPiezaNorm.has(n)) return rowByPiezaNorm.get(n)!;
  const matched = matchPiezaFromAnalysisWithMatrix(pieza, matrix);
  if (!matched) return null;
  return rowByPiezaNorm.get(normalizePiezaTextForMatch(matched)) ?? null;
}

/**
 * Infiere el nivel de daño a partir de texto (códigos DL…DMFuerte o lenguaje natural).
 */
export function resolveDamageLevelFromText(
  severidad: string,
  descripcionTecnica?: string,
): DamageLevel | null {
  const blob = normalizePiezaTextForMatch(
    `${severidad} ${descripcionTecnica ?? ''}`,
  );
  if (!blob) return null;

  for (const level of DAMAGE_LEVEL_KEYS) {
    if (level === 'DMFuerte') {
      if (/\bdmfuerte\b|\bdmf\s*fuerte\b/i.test(blob)) return 'DMFuerte';
      continue;
    }
    const re = new RegExp(`\\b${level}\\b`, 'i');
    if (re.test(blob)) return level;
  }

  if (
    /\bdmfuerte\b|\bdmf\s*fuerte\b|\bmuy\s*grave\b|\bcatastrof/i.test(blob) ||
    /\bseveridad\s*extrema\b/i.test(blob)
  ) {
    return 'DMFuerte';
  }
  if (/\bgrave\b|\bdf\b(?![a-z])/i.test(blob) || /\bsevero\b/i.test(blob)) {
    return 'DF';
  }
  if (/\bdmf\b/i.test(blob)) return 'DMF';
  if (/moderad|intermedio|\bmedio\b/i.test(blob)) return 'DM';
  if (/dml|\bmenor\b|\bligero\b/i.test(blob)) return 'DML';
  if (/leve|superficial|rayon|arañazo|rozad/i.test(blob)) return 'DL';

  return null;
}

export type CalculateEstimateOptions = {
  /** Si es 'throw', no coincidencia de pieza o nivel lanza AutofixPricingLookupError */
  onMissing?: 'zero' | 'throw';
  /** Texto adicional (p. ej. descripción técnica) para inferir nivel de daño */
  descripcionTecnica?: string;
};

function damageLevelRank(level: DamageLevel): number {
  const i = DAMAGE_LEVEL_KEYS.indexOf(level);
  return i >= 0 ? i : 0;
}

export type PiezaSeveridadMatrizInput = {
  pieza: string;
  severidad: string;
};

export function matrixAmountForPairWithMatrix(
  pieza: string,
  severidad: string,
  matrix: readonly PiezaPriceRow[],
  options?: CalculateEstimateOptions,
): { amount: number; level: DamageLevel | null; row: PiezaPriceRow | null } {
  const onMissing = options?.onMissing ?? 'zero';
  const row = findPiezaRowInMatrix(pieza, matrix);
  const level = resolveDamageLevelFromText(
    severidad,
    options?.descripcionTecnica,
  );

  if (!row || !level) {
    if (onMissing === 'throw') {
      throw new AutofixPricingLookupError(
        !row
          ? `Pieza no reconocida en la matriz: "${pieza}"`
          : `Nivel de daño no reconocido: "${severidad}"`,
        pieza,
        severidad,
      );
    }
    return { amount: 0, level, row };
  }

  const amount = row[level];
  if (typeof amount !== 'number' || Number.isNaN(amount)) {
    if (onMissing === 'throw') {
      throw new AutofixPricingLookupError(
        'Precio inválido en matriz',
        pieza,
        severidad,
      );
    }
    return { amount: 0, level, row };
  }
  return { amount, level, row };
}

/**
 * Agrupa por pieza canónica en la matriz: suma una vez por pieza distinta usando
 * el mayor precio entre filas de esa pieza (criterio preventivo).
 */
export function matrixInventoryMaxLinesWithMatrix(
  items: ReadonlyArray<PiezaSeveridadMatrizInput>,
  matrix: readonly PiezaPriceRow[],
  options?: CalculateEstimateOptions,
): { canonical: string; unitPrice: number; damageLevel: DamageLevel }[] {
  type Best = { price: number; level: DamageLevel };
  const byCanonical = new Map<string, Best>();

  for (const it of items) {
    const { amount, level, row } = matrixAmountForPairWithMatrix(
      it.pieza,
      it.severidad,
      matrix,
      options,
    );
    if (!row || !level || amount <= 0) continue;

    const canonical = row.pieza;
    const cur = byCanonical.get(canonical);
    if (!cur || amount > cur.price) {
      byCanonical.set(canonical, { price: amount, level });
    } else if (amount === cur.price) {
      if (damageLevelRank(level) > damageLevelRank(cur.level)) {
        byCanonical.set(canonical, { price: amount, level });
      }
    }
  }

  return [...byCanonical.entries()].map(([canonical, b]) => ({
    canonical,
    unitPrice: b.price,
    damageLevel: b.level,
  }));
}

/**
 * Precio de matriz para una pieza y severidad, **o** total multi-pieza,
 * usando la matriz en memoria (p. ej. desde BD).
 */
export function calculateEstimateWithMatrix(
  matrix: readonly PiezaPriceRow[],
  pieza: string,
  severidad: string,
  options?: CalculateEstimateOptions,
): number;
export function calculateEstimateWithMatrix(
  matrix: readonly PiezaPriceRow[],
  items: ReadonlyArray<PiezaSeveridadMatrizInput>,
  options?: CalculateEstimateOptions,
): number;
export function calculateEstimateWithMatrix(
  matrix: readonly PiezaPriceRow[],
  piezaOrItems: string | ReadonlyArray<PiezaSeveridadMatrizInput>,
  severidadOrOptions?: string | CalculateEstimateOptions,
  options?: CalculateEstimateOptions,
): number {
  if (typeof piezaOrItems !== 'string') {
    const opts =
      severidadOrOptions !== undefined &&
      typeof severidadOrOptions === 'object' &&
      !Array.isArray(severidadOrOptions)
        ? (severidadOrOptions as CalculateEstimateOptions)
        : undefined;
    return matrixInventoryMaxLinesWithMatrix(piezaOrItems, matrix, opts).reduce(
      (acc, l) => acc + l.unitPrice,
      0,
    );
  }

  const pieza = piezaOrItems;
  const severidad =
    typeof severidadOrOptions === 'string' ? severidadOrOptions : '';
  return matrixAmountForPairWithMatrix(pieza, severidad, matrix, options).amount;
}

export function formatAutoFixMoney(amount: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: AUTO_FIX_CURRENCY,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

/** Línea de cotización enlazada al catálogo / matriz */
export interface DraftQuoteLine {
  priceItemId: string;
  description: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

export type DraftQuoteStatus = 'PENDING_APPROVAL';

export interface DraftQuote {
  status: DraftQuoteStatus;
  currency: typeof AUTO_FIX_CURRENCY;
  reference: string;
  generatedAt: string;
  lines: DraftQuoteLine[];
  subtotal: number;
  total: number;
  formalNarrative: string;
  /** Avisos internos (p. ej. pieza no catalogada con precio referencia). */
  pricingCatalogNotes?: string[];
  analysisBasis: {
    pieza: string;
    severidad: string;
    partesAfectadas: string[];
    severidadDelDano: string;
    descripcionTecnica: string;
    justificacion: string;
    inventory?: {
      pieza: string;
      severidad: string;
      descripcionTecnica: string;
      urls_origen: string[];
    }[];
  };
}
