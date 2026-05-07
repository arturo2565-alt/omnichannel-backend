/**
 * Matriz de precios (pieza × nivel de daño) para hojalatería / pintura.
 * Montos en MXN según tabla operativa.
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

/**
 * Matriz: cada fila es una pieza; cada columna un nivel de daño (precio MXN).
 */
export const PIEZA_DANO_PRICE_MATRIX: readonly PiezaPriceRow[] = [
  { pieza: 'Fascia', DL: 2900, DML: 3300, DM: 3600, DMF: 3500, DF: 3500, DMFuerte: 4900 },
  { pieza: 'Salpicadera', DL: 2900, DML: 2900, DM: 3350, DMF: 3900, DF: 4400, DMFuerte: 6150 },
  { pieza: 'Puerta', DL: 3100, DML: 2800, DM: 3250, DMF: 4200, DF: 5150, DMFuerte: 7200 },
  {
    pieza: 'Salpicadera trasera',
    DL: 2900,
    DML: 3200,
    DM: 3700,
    DMF: 4700,
    DF: 5700,
    DMFuerte: 8000,
  },
  { pieza: 'Cofre', DL: 4000, DML: 4500, DM: 5000, DMF: 4500, DF: 5450, DMFuerte: 7650 },
  {
    pieza: 'Tapa Cajuela',
    DL: 3500,
    DML: 3900,
    DM: 4900,
    DMF: 5800,
    DF: 6900,
    DMFuerte: 7650,
  },
  { pieza: 'Toldo', DL: 4500, DML: 5400, DM: 6500, DMF: 7500, DF: 8000, DMFuerte: 9800 },
  { pieza: 'Espejo', DL: 900, DML: 1050, DM: 1225, DMF: 1450, DF: 1650, DMFuerte: 2300 },
  { pieza: 'Estribo', DL: 2500, DML: 3200, DM: 3400, DMF: 3900, DF: 4500, DMFuerte: 5500 },
  {
    pieza: 'Estetica Exterior',
    DL: 3500,
    DML: 3500,
    DM: 3500,
    DMF: 3500,
    DF: 3500,
    DMFuerte: 3500,
  },
] as const;

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

function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const rowByPiezaNorm = new Map<string, PiezaPriceRow>();
for (const row of PIEZA_DANO_PRICE_MATRIX) {
  rowByPiezaNorm.set(normalizeText(row.pieza), row);
}

/** Filas ordenadas por longitud de nombre (coincidencias largas primero, p. ej. Salpicadera trasera). */
const rowsByPiezaLengthDesc = [...PIEZA_DANO_PRICE_MATRIX].sort(
  (a, b) => b.pieza.length - a.pieza.length,
);

/**
 * Intenta emparejar texto libre del peritaje con una fila de la matriz.
 * @returns nombre canónico de `pieza` en la matriz, o null.
 */
export function matchPiezaFromAnalysis(parteLibre: string): string | null {
  const n = normalizeText(parteLibre);
  if (!n) return null;
  if (rowByPiezaNorm.has(n)) return rowByPiezaNorm.get(n)!.pieza;
  for (const row of rowsByPiezaLengthDesc) {
    const key = normalizeText(row.pieza);
    if (!key) continue;
    if (n.includes(key) || (key.length >= 4 && key.includes(n))) {
      return row.pieza;
    }
  }
  return null;
}

/**
 * Obtiene la fila de matriz para un nombre de pieza (exacto o ya canónico).
 */
export function findPiezaRow(pieza: string): PiezaPriceRow | null {
  const n = normalizeText(pieza);
  if (rowByPiezaNorm.has(n)) return rowByPiezaNorm.get(n)!;
  const matched = matchPiezaFromAnalysis(pieza);
  if (!matched) return null;
  return rowByPiezaNorm.get(normalizeText(matched)) ?? null;
}

/**
 * Infiere el nivel de daño a partir de texto (códigos DL…DMFuerte o lenguaje natural).
 */
export function resolveDamageLevelFromText(
  severidad: string,
  descripcionTecnica?: string,
): DamageLevel | null {
  const blob = normalizeText(`${severidad} ${descripcionTecnica ?? ''}`);
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

/**
 * Precio exacto de la matriz para una pieza y un nivel de daño.
 * Si no hay coincidencia de pieza o nivel, devuelve 0 (por defecto) o lanza error si `onMissing: 'throw'`.
 */
export function calculateEstimate(
  pieza: string,
  severidad: string,
  options?: CalculateEstimateOptions,
): number {
  const onMissing = options?.onMissing ?? 'zero';
  const row = findPiezaRow(pieza);
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
    return 0;
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
    return 0;
  }
  return amount;
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
  analysisBasis: {
    pieza: string;
    severidad: string;
    partesAfectadas: string[];
    severidadDelDano: string;
    descripcionTecnica: string;
    justificacion: string;
  };
}
