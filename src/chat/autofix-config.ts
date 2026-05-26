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

export function normalizeTextForMatch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(s: string): string {
  return normalizeTextForMatch(s);
}

function escapeRegExpChars(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `needle` ya normalizado (minúsculas, sin acentos). Comprueba que aparezca como unidad,
 * no como prefijo accidental de otra palabra (p. ej. evita "cia" dentro de "ceramico").
 */
function normalizedHaystackContainsWholeNeedle(
  haystackNorm: string,
  needleNorm: string,
): boolean {
  if (!needleNorm) return false;
  if (haystackNorm === needleNorm) return true;
  const re = new RegExp(
    `(?:^|[^a-z0-9]+)${escapeRegExpChars(needleNorm)}(?:[^a-z0-9]+|$)`,
    'i',
  );
  return re.test(haystackNorm);
}

const MIN_SERVICIO_FUZZ_LEN = 4;

/**
 * Empareja texto libre con un nombre canónico del catálogo (misma capitalización que en BD).
 * Compara con {@link normalizeText} (minúsculas, sin acentos). Entre varios candidatos, gana el nombre más largo.
 */
export function matchServicioFromCatalog(
  parteLibre: string,
  serviciosOrderedLongestFirst: readonly string[],
): string | null {
  const n = normalizeText(parteLibre);
  if (!n) return null;
  const byNorm = new Map<string, string>();
  for (const s of serviciosOrderedLongestFirst) {
    byNorm.set(normalizeText(s), s);
  }
  if (byNorm.has(n)) return byNorm.get(n)!;

  let best: { keyLen: number; name: string } | null = null;
  for (const svc of serviciosOrderedLongestFirst) {
    const key = normalizeText(svc);
    if (!key || key.length < MIN_SERVICIO_FUZZ_LEN) continue;

    let hit = false;
    if (n.includes(key) && normalizedHaystackContainsWholeNeedle(n, key)) {
      hit = true;
    } else if (
      key.length >= n.length &&
      n.length >= MIN_SERVICIO_FUZZ_LEN &&
      key.includes(n)
    ) {
      hit = true;
    }

    if (hit && (!best || key.length > best.keyLen)) {
      best = { keyLen: key.length, name: svc };
    }
  }
  return best?.name ?? null;
}

/** @deprecated usar {@link matchServicioFromCatalog} */
export const matchPiezaFromCatalog = matchServicioFromCatalog;

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

export type DraftQuoteStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'SENT';

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
