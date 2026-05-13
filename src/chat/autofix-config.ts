/**
 * Reglas de cotización AutoFix: niveles de daño, emparejado de piezas con el catálogo
 * (`price_matrix` en BD) y formato monetario.
 */

export const AUTO_FIX_CURRENCY = 'MXN' as const;

/** Columnas típicas de matriz ancha legacy (sin fila N/A en documentos viejos). */
export const DAMAGE_LEVEL_KEYS_STANDARD = [
  'DL',
  'DML',
  'DM',
  'DMF',
  'DF',
  'DMFuerte',
] as const;

export type StandardDamageLevel = (typeof DAMAGE_LEVEL_KEYS_STANDARD)[number];

/** Niveles en catálogo / cotización (`N/A` primero = menor “rango” de daño para desempates). */
export const DAMAGE_LEVEL_KEYS = [
  'N/A',
  ...DAMAGE_LEVEL_KEYS_STANDARD,
] as const;

export type DamageLevel = (typeof DAMAGE_LEVEL_KEYS)[number];

/**
 * Normaliza el texto del modelo a un código de nivel válido para la matriz.
 * Orden de prueba evita que "DM" coincida dentro de "DMF" / "DMFuerte".
 */
export function coerceDamageLevelCode(raw: string): DamageLevel {
  const t = (raw ?? '').trim();
  if (!t) return 'DM';
  if (/\bn\s*\/\s*a\b|^n\/a$/i.test(t)) return 'N/A';
  const order: DamageLevel[] = ['DMFuerte', 'DF', 'DMF', 'DM', 'DML', 'DL'];
  for (const level of order) {
    const escaped = level.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(t)) return level;
  }
  return 'DM';
}

function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Empareja texto libre del peritaje con un nombre canónico de pieza del catálogo.
 * `piezasOrderedLongestFirst` debe ser la lista DISTINCT de piezas ordenada por nombre largo → corto.
 */
export function matchPiezaFromCatalog(
  parteLibre: string,
  piezasOrderedLongestFirst: readonly string[],
): string | null {
  const n = normalizeText(parteLibre);
  if (!n) return null;
  const rowByPiezaNorm = new Map<string, string>();
  for (const p of piezasOrderedLongestFirst) {
    rowByPiezaNorm.set(normalizeText(p), p);
  }
  if (rowByPiezaNorm.has(n)) return rowByPiezaNorm.get(n)!;
  for (const pieza of piezasOrderedLongestFirst) {
    const key = normalizeText(pieza);
    if (!key) continue;
    if (n.includes(key) || (key.length >= 4 && key.includes(n))) {
      return pieza;
    }
  }
  return null;
}

export function damageLevelRank(level: DamageLevel): number {
  const i = DAMAGE_LEVEL_KEYS.indexOf(level);
  return i >= 0 ? i : 0;
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

  if (
    /\bn\s*\/\s*a\b|^n\/a$|no aplica|sin severidad|servicio sin dan/i.test(blob)
  ) {
    return 'N/A';
  }

  for (const level of DAMAGE_LEVEL_KEYS) {
    if (level === 'N/A') continue;
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
    inventory?: {
      pieza: string;
      severidad: string;
      descripcionTecnica: string;
      urls_origen: string[];
    }[];
  };
}
