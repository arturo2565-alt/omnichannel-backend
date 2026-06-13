import type { VehicleSizeTier } from './vehicle-pricing-profile';
import {
  DEFAULT_PREMIUM_FACTOR,
  VEHICLE_SIZE_TIER_FACTORS,
} from './vehicle-pricing-profile';

/** Magnitud de daño para cotización (4 niveles). */
export type DamageMagnitude = 'LEVE' | 'MEDIO' | 'FUERTE' | 'MUY_FUERTE';

export const DAMAGE_MAGNITUDE_ORDER: readonly DamageMagnitude[] = [
  'LEVE',
  'MEDIO',
  'FUERTE',
  'MUY_FUERTE',
];

export const DAMAGE_MAGNITUDE_LABELS: Record<DamageMagnitude, string> = {
  LEVE: 'Leve',
  MEDIO: 'Medio',
  FUERTE: 'Fuerte',
  MUY_FUERTE: 'Muy fuerte',
};

/** Severidad almacenada en matriz para precio base de pieza. */
export const PIECE_BASE_SEVERITY = 'LEVE';

/** Severidad almacenada en matriz para precio base de servicio integral. */
export const INTEGRAL_BASE_SEVERITY = 'BASE';

function normalizeIntegralServiceKey(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Baño de pintura, estética automotriz o cerámico (sin severidad de daño). */
export function isIntegralServiceName(servicio: string): boolean {
  const k = normalizeIntegralServiceKey(servicio);
  if (!k) return false;
  if (k.includes('bano de pintura') || k.includes('bano pintura')) return true;
  if (k.includes('estetica') && k.includes('automotriz')) return true;
  return k.includes('ceramico');
}

export interface CatalogPricingRules {
  sizeTierFactors: Record<VehicleSizeTier, number>;
  premiumFactor: number;
  severityFactors: Record<DamageMagnitude, number>;
  /** Redondeo comercial en MXN (50 = a centenas de 50). */
  roundToMx: number;
}

export const DEFAULT_CATALOG_PRICING_RULES: CatalogPricingRules = {
  sizeTierFactors: { ...VEHICLE_SIZE_TIER_FACTORS },
  premiumFactor: DEFAULT_PREMIUM_FACTOR,
  severityFactors: {
    LEVE: 1,
    MEDIO: 1.12,
    FUERTE: 1.3,
    MUY_FUERTE: 1.55,
  },
  roundToMx: 50,
};

const LEGACY_DAMAGE_TO_MAGNITUDE: Record<string, DamageMagnitude> = {
  DL: 'LEVE',
  DML: 'LEVE',
  DM: 'MEDIO',
  DMF: 'FUERTE',
  DF: 'FUERTE',
  DMFUERTE: 'MUY_FUERTE',
  LEVE: 'LEVE',
  MEDIO: 'MEDIO',
  FUERTE: 'FUERTE',
  MUY_FUERTE: 'MUY_FUERTE',
};

export function normalizeDamageMagnitudeKey(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, '_')
    .trim();
}

export function coerceDamageMagnitude(raw: string): DamageMagnitude {
  const key = normalizeDamageMagnitudeKey(raw);
  return LEGACY_DAMAGE_TO_MAGNITUDE[key] ?? 'MEDIO';
}

export function mergeCatalogPricingRules(
  partial?: Partial<CatalogPricingRules> | null,
): CatalogPricingRules {
  const d = DEFAULT_CATALOG_PRICING_RULES;
  return {
    sizeTierFactors: {
      Compacto:
        partial?.sizeTierFactors?.Compacto ?? d.sizeTierFactors.Compacto,
      Mediano: partial?.sizeTierFactors?.Mediano ?? d.sizeTierFactors.Mediano,
      Grande: partial?.sizeTierFactors?.Grande ?? d.sizeTierFactors.Grande,
      XL: partial?.sizeTierFactors?.XL ?? d.sizeTierFactors.XL,
    },
    premiumFactor:
      typeof partial?.premiumFactor === 'number' &&
      partial.premiumFactor > 0
        ? partial.premiumFactor
        : d.premiumFactor,
    severityFactors: {
      LEVE: partial?.severityFactors?.LEVE ?? d.severityFactors.LEVE,
      MEDIO: partial?.severityFactors?.MEDIO ?? d.severityFactors.MEDIO,
      FUERTE: partial?.severityFactors?.FUERTE ?? d.severityFactors.FUERTE,
      MUY_FUERTE:
        partial?.severityFactors?.MUY_FUERTE ?? d.severityFactors.MUY_FUERTE,
    },
    roundToMx:
      typeof partial?.roundToMx === 'number' && partial.roundToMx > 0
        ? partial.roundToMx
        : d.roundToMx,
  };
}

export function roundCatalogPrice(
  amount: number,
  roundToMx: number,
): number {
  const n = Math.max(0, Math.round(Number(amount) || 0));
  if (n < 100 || roundToMx <= 0) return n;
  return Math.round(n / roundToMx) * roundToMx;
}

export function computeCatalogPiecePrice(input: {
  basePrice: number;
  sizeTier: VehicleSizeTier;
  isPremium: boolean;
  damageMagnitude: DamageMagnitude;
  rules?: CatalogPricingRules;
}): number {
  const rules = mergeCatalogPricingRules(input.rules);
  const base = Math.max(0, Math.round(Number(input.basePrice) || 0));
  if (base <= 0) return 0;
  let price = base;
  price *= rules.sizeTierFactors[input.sizeTier] ?? 1;
  if (input.isPremium) price *= rules.premiumFactor;
  price *= rules.severityFactors[input.damageMagnitude] ?? 1;
  return roundCatalogPrice(price, rules.roundToMx);
}

/** Servicio integral: base × tamaño × premium (sin magnitud de daño). */
export function computeCatalogIntegralPrice(input: {
  basePrice: number;
  sizeTier: VehicleSizeTier;
  isPremium: boolean;
  rules?: CatalogPricingRules;
}): number {
  const rules = mergeCatalogPricingRules(input.rules);
  const base = Math.max(0, Math.round(Number(input.basePrice) || 0));
  if (base <= 0) return 0;
  let price = base;
  price *= rules.sizeTierFactors[input.sizeTier] ?? 1;
  if (input.isPremium) price *= rules.premiumFactor;
  return roundCatalogPrice(price, rules.roundToMx);
}

const INSTANT_SEVERIDAD_RE =
  /^(N\/A|CHICO|MEDIANO|GRANDE|XL|PREMIUM|CERAMICO|ESTETICA)/i;

/** Fila de matriz que corresponde a baño / instant / servicios sin daño por magnitud. */
export function isInstantOrBanioMatrixRow(
  servicio: string,
  severidad: string,
): boolean {
  const sev = String(severidad ?? '').trim();
  if (!sev || sev === 'N/A') return true;
  if (INSTANT_SEVERIDAD_RE.test(sev)) return true;
  if (/premium/i.test(sev) && !/^(DL|DM|DF|LEVE|MEDIO|FUERTE)/i.test(sev)) {
    return true;
  }
  const svc = String(servicio ?? '').toLowerCase();
  if (svc.includes('baño') || svc.includes('bano')) return true;
  if (svc.includes('ceramico') || svc.includes('estética') || svc.includes('estetica')) {
    return true;
  }
  return false;
}

export function isPieceBaseSeverity(severidad: string): boolean {
  const k = normalizeDamageMagnitudeKey(severidad);
  return k === 'LEVE' || k === 'DL';
}

export type PieceBaseRow = {
  servicio: string;
  basePrice: number;
  diasEntrega: number;
  matrixRowId: string | null;
  legacyRowId: string | null;
};

/** Agrupa filas de matriz en bases de pieza (severidad LEVE o DL legacy). */
export function aggregatePieceBaseRows(
  rows: ReadonlyArray<{
    id: string;
    servicio: string;
    severidad: string;
    precio: number;
    diasEntrega: number;
    isInstantService?: boolean;
  }>,
): PieceBaseRow[] {
  const byServicio = new Map<string, PieceBaseRow>();

  for (const row of rows) {
    if (row.isInstantService) continue;
    if (isInstantOrBanioMatrixRow(row.servicio, row.severidad)) continue;

    const svc = String(row.servicio ?? '').trim();
    if (!svc) continue;

    let entry = byServicio.get(svc);
    if (!entry) {
      entry = {
        servicio: svc,
        basePrice: 0,
        diasEntrega: row.diasEntrega ?? 4,
        matrixRowId: null,
        legacyRowId: null,
      };
      byServicio.set(svc, entry);
    }

    const sevKey = normalizeDamageMagnitudeKey(row.severidad);
    if (sevKey === 'LEVE') {
      entry.basePrice = row.precio;
      entry.diasEntrega = row.diasEntrega;
      entry.matrixRowId = row.id;
    } else if (sevKey === 'DL' && entry.basePrice <= 0) {
      entry.basePrice = row.precio;
      entry.diasEntrega = row.diasEntrega;
      entry.legacyRowId = row.id;
      if (!entry.matrixRowId) entry.matrixRowId = row.id;
    }
  }

  return [...byServicio.values()]
    .filter((p) => p.basePrice > 0)
    .sort((a, b) => a.servicio.localeCompare(b.servicio, 'es'));
}

export type IntegralBaseRow = {
  servicio: string;
  basePrice: number;
  diasEntrega: number;
  matrixRowId: string | null;
  legacyRowId: string | null;
};

function integralBaseSeverityScore(severidad: string): number {
  const raw = String(severidad ?? '').trim();
  const k = normalizeDamageMagnitudeKey(raw);
  if (k === 'BASE') return 100;
  if (k === 'N/A' || raw === 'N/A') return 90;
  if (k === 'LEVE') return 80;
  if (k === 'CHICO' && !/premium/i.test(raw)) return 70;
  return 0;
}

/** Una base por servicio integral (baño, estética, cerámico). */
export function aggregateIntegralBaseRows(
  rows: ReadonlyArray<{
    id: string;
    servicio: string;
    severidad: string;
    precio: number;
    diasEntrega: number;
    isInstantService?: boolean;
  }>,
): IntegralBaseRow[] {
  const byServicio = new Map<
    string,
    IntegralBaseRow & { bestScore: number }
  >();

  for (const row of rows) {
    const svc = String(row.servicio ?? '').trim();
    if (!svc || !isIntegralServiceName(svc)) continue;

    let entry = byServicio.get(svc);
    if (!entry) {
      entry = {
        servicio: svc,
        basePrice: 0,
        diasEntrega: row.diasEntrega ?? 5,
        matrixRowId: null,
        legacyRowId: null,
        bestScore: -1,
      };
      byServicio.set(svc, entry);
    }

    const score = integralBaseSeverityScore(row.severidad);
    if (score <= 0) continue;
    if (score > entry.bestScore || (score === entry.bestScore && row.precio > 0)) {
      entry.bestScore = score;
      entry.basePrice = row.precio;
      entry.diasEntrega = row.diasEntrega;
      entry.matrixRowId = row.id;
      entry.legacyRowId =
        normalizeDamageMagnitudeKey(row.severidad) === 'BASE'
          ? null
          : row.id;
    }
  }

  return [...byServicio.values()]
    .filter((p) => p.basePrice > 0)
    .map(({ bestScore: _s, ...rest }) => rest)
    .sort((a, b) => a.servicio.localeCompare(b.servicio, 'es'));
}
