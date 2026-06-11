import { normalizeTextForMatch } from '../chat/autofix-config';
import { coerceBañoSeveridadToCatalog } from '../chat/baño-pintura-llm';

/** Tamaño de carrocería (eje 1 del precio por pieza). */
export type VehicleSizeTier = 'Compacto' | 'Mediano' | 'Grande' | 'XL';

export type VehiclePricingTierSource =
  | 'cliente'
  | 'llm'
  | 'operador'
  | 'vision'
  | 'inferido';

/** Perfil vehicular para lookup de matriz + multiplicador premium. */
export interface VehiclePricingProfile {
  vehicleLabel: string;
  sizeTier: VehicleSizeTier;
  isPremium: boolean;
  /** Factor premium (default 1.10 si omitido). */
  premiumFactor?: number;
  tierSource?: VehiclePricingTierSource;
}

export const DEFAULT_PREMIUM_FACTOR = 1.1;

/**
 * Factor sobre precio base compacto estándar (DL legacy en matriz).
 * Ajustables cuando existan celdas `Tier|severidad` en catálogo.
 */
export const VEHICLE_SIZE_TIER_FACTORS: Readonly<
  Record<VehicleSizeTier, number>
> = {
  Compacto: 1,
  Mediano: 1.0344827586, // ~3000/2900
  Grande: 1.1724137931, // ~3400/2900
  XL: 1.275862069, // ~3700/2900 sin premium extra
};

const PREMIUM_BRAND_RE =
  /\b(bmw|mercedes|mercedes-benz|audi|porsche|lexus|land\s*rover|jaguar|maserati|infiniti|acura|volvo|mini|bentley|rolls\s*royce|ferrari|lamborghini|mclaren|cadillac|lincoln|genesis|tesla)\b/i;

const XL_BODY_RE =
  /\b(escalade|suburban|tahoe|expedition|navigator|sequoia|armada|yukon|silverado\s*2500|f-250|f250|ram\s*2500|ram\s*3500|lobo\s*2500|tundra|sierra\s*2500|highlander|4runner|pathfinder|durango|wagoneer|grand\s*wagoneer)\b/i;

const GRANDE_BODY_RE =
  /\b(f-150|f150|silverado|ram\s*1500|lobo|tundra|tacoma|hilux|ranger|frontier|colorado|canyon|cr-v|crv|rav4|rav\s*4|x-trail|xtrail|rogue|escape|equinox|tucson|sportage|sorento|edge|explorer|highlander|4runner|pick\s*up|pickup|camioneta|suv)\b/i;

const COMPACTO_BODY_RE =
  /\b(aveo|spark|march|mirage|vers[aá]|rio|fit|yaris|i10|i20|matiz|beat|figo|punto|500|mini\s*cooper|smart|up!|gol|polo|clio|sandero)\b/i;

const SIZE_TIER_VALUES: readonly VehicleSizeTier[] = [
  'Compacto',
  'Mediano',
  'Grande',
  'XL',
];

export function normalizeVehicleSizeTier(raw: unknown): VehicleSizeTier | null {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  if (SIZE_TIER_VALUES.includes(t as VehicleSizeTier)) {
    return t as VehicleSizeTier;
  }
  const key = normalizeTextForMatch(t);
  const map: Record<string, VehicleSizeTier> = {
    chico: 'Compacto',
    compacto: 'Compacto',
    compact: 'Compacto',
    mediano: 'Mediano',
    sedan: 'Mediano',
    sedán: 'Mediano',
    grande: 'Grande',
    large: 'Grande',
    xl: 'XL',
    extra: 'XL',
    extragrande: 'XL',
    'extra grande': 'XL',
  };
  return map[key] ?? null;
}

/** @deprecated alias — Premium ya no es tamaño; usar {@link normalizeVehicleSizeTier}. */
export function normalizeCategoriaTamanoToSizeTier(
  raw: unknown,
): VehicleSizeTier | null {
  const t = String(raw ?? '').trim();
  if (normalizeTextForMatch(t) === 'premium') return null;
  return normalizeVehicleSizeTier(raw);
}

export function legacyCategoriaWasPremiumOnly(raw: unknown): boolean {
  return normalizeTextForMatch(String(raw ?? '')) === 'premium';
}

export function inferIsPremiumBrand(vehicleText: string): boolean {
  const n = normalizeTextForMatch(vehicleText);
  if (!n) return false;
  return PREMIUM_BRAND_RE.test(n);
}

export function inferSizeTierFromVehicleText(
  vehicleText: string,
): VehicleSizeTier {
  const n = normalizeTextForMatch(vehicleText);
  if (!n) return 'Mediano';
  if (XL_BODY_RE.test(n)) return 'XL';
  if (GRANDE_BODY_RE.test(n)) return 'Grande';
  if (COMPACTO_BODY_RE.test(n)) return 'Compacto';
  return 'Mediano';
}

export function resolveVehiclePricingProfile(input: {
  modeloVehiculo: string;
  sizeTier?: VehicleSizeTier | null;
  isPremium?: boolean | null;
  tierSource?: VehiclePricingTierSource;
  premiumFactor?: number;
}): VehiclePricingProfile {
  const vehicleLabel = String(input.modeloVehiculo ?? '').trim() || 'Vehículo';
  const ctx = vehicleLabel;
  const sizeTier =
    input.sizeTier ??
    inferSizeTierFromVehicleText(ctx);
  const isPremium =
    input.isPremium != null
      ? Boolean(input.isPremium)
      : inferIsPremiumBrand(ctx);
  const premiumFactor =
    typeof input.premiumFactor === 'number' &&
    Number.isFinite(input.premiumFactor) &&
    input.premiumFactor > 0
      ? input.premiumFactor
      : DEFAULT_PREMIUM_FACTOR;

  return {
    vehicleLabel,
    sizeTier,
    isPremium,
    premiumFactor,
    tierSource: input.tierSource ?? 'inferido',
  };
}

export function parseExpressVehicleSizingArgs(raw: {
  categoriaTamano?: unknown;
  categoriaTamaño?: unknown;
  esPremium?: unknown;
  isPremium?: unknown;
  modeloVehiculo?: unknown;
}): VehiclePricingProfile | null {
  const modelo = String(raw.modeloVehiculo ?? '').trim();
  if (!modelo) return null;

  const categoriaRaw = raw.categoriaTamaño ?? raw.categoriaTamano;
  const legacyPremiumOnly = legacyCategoriaWasPremiumOnly(categoriaRaw);
  const sizeTier =
    normalizeVehicleSizeTier(categoriaRaw) ??
    (legacyPremiumOnly ? inferSizeTierFromVehicleText(modelo) : null);

  if (!sizeTier && !legacyPremiumOnly) return null;

  const esPremiumRaw = raw.esPremium ?? raw.isPremium;
  let isPremium: boolean | null = null;
  if (typeof esPremiumRaw === 'boolean') {
    isPremium = esPremiumRaw;
  } else if (esPremiumRaw != null && String(esPremiumRaw).trim() !== '') {
    const k = normalizeTextForMatch(String(esPremiumRaw));
    isPremium = k === 'si' || k === 'sí' || k === 'true' || k === '1';
  }
  if (legacyPremiumOnly && isPremium == null) {
    isPremium = true;
  }

  return resolveVehiclePricingProfile({
    modeloVehiculo: modelo,
    sizeTier: sizeTier ?? inferSizeTierFromVehicleText(modelo),
    isPremium,
    tierSource: 'llm',
  });
}

/** Claves de severidad en matriz para precio por tier (opcional en BD). */
export function tierMatrixSeveridadKeys(
  sizeTier: VehicleSizeTier,
  damageLevel: string,
): string[] {
  const sev = String(damageLevel ?? '').trim();
  if (!sev) return [];
  return [
    `Tier:${sizeTier}|${sev}`,
    `${sizeTier}|${sev}`,
    `${sizeTier} ${sev}`,
  ];
}

export function applyPremiumMultiplier(
  basePrice: number,
  profile: Pick<VehiclePricingProfile, 'isPremium' | 'premiumFactor'>,
): number {
  const base = Math.max(0, Math.round(Number(basePrice) || 0));
  if (base <= 0 || !profile.isPremium) return base;
  const factor =
    profile.premiumFactor != null &&
    Number.isFinite(profile.premiumFactor) &&
    profile.premiumFactor > 0
      ? profile.premiumFactor
      : DEFAULT_PREMIUM_FACTOR;
  return roundCommercialMx(base * factor);
}

export function applySizeTierToCompactoBase(
  compactoBase: number,
  sizeTier: VehicleSizeTier,
): number {
  const base = Math.max(0, Math.round(Number(compactoBase) || 0));
  if (base <= 0) return 0;
  const factor = VEHICLE_SIZE_TIER_FACTORS[sizeTier] ?? 1;
  return roundCommercialMx(base * factor);
}

/** Redondeo comercial a $50 MXN. */
export function roundCommercialMx(amount: number): number {
  const n = Math.max(0, Math.round(Number(amount) || 0));
  if (n < 100) return n;
  return Math.round(n / 50) * 50;
}

/**
 * Severidad de catálogo para baño de pintura: tamaño + premium como celda compuesta.
 */
export function resolveBañoSeveridadFromVehicleProfile(
  profile: VehiclePricingProfile,
  allowed: readonly string[],
): string | null {
  const { sizeTier, isPremium } = profile;
  const sizeLabel =
    sizeTier === 'Compacto'
      ? 'Chico'
      : sizeTier === 'XL'
        ? 'XL'
        : sizeTier;

  const candidates: string[] = [];
  if (isPremium) {
    candidates.push(
      `${sizeLabel} Premium`,
      `${sizeTier} Premium`,
      sizeTier === 'Compacto' ? 'Chico Premium' : '',
      sizeTier === 'XL' ? 'XL Premium' : '',
      sizeTier === 'Grande' ? 'Grande Premium' : '',
      'Premium',
    );
  }
  candidates.push(sizeLabel, sizeTier, 'Mediano', 'Chico', 'Grande', 'XL');

  for (const c of candidates) {
    const k = normalizeTextForMatch(c);
    if (!k) continue;
    const hit = coerceBañoSeveridadToCatalog(c, allowed);
    if (hit) return hit;
  }
  return allowed[0] ?? null;
}

export function vehiclePricingProfileFromAnalysis(
  analysis:
    | {
        vehiculoDetectado?: string;
        quoteCartMeta?: {
          vehiclePricingProfile?: Partial<VehiclePricingProfile> & {
            vehicleLabel?: string;
            sizeTier?: VehicleSizeTier;
            isPremium?: boolean;
          };
        };
      }
    | null
    | undefined,
): VehiclePricingProfile | null {
  const stored = analysis?.quoteCartMeta?.vehiclePricingProfile;
  if (stored?.vehicleLabel && stored.sizeTier) {
    return resolveVehiclePricingProfile({
      modeloVehiculo: stored.vehicleLabel,
      sizeTier: stored.sizeTier,
      isPremium: stored.isPremium,
      premiumFactor: stored.premiumFactor,
      tierSource:
        (stored.tierSource as VehiclePricingTierSource | undefined) ??
        'inferido',
    });
  }
  const label = String(analysis?.vehiculoDetectado ?? '').trim();
  if (!label) return null;
  return resolveVehiclePricingProfile({
    modeloVehiculo: label,
    tierSource: 'vision',
  });
}

export function formatVehiclePricingProfileLabel(
  profile: VehiclePricingProfile,
): string {
  const size =
    profile.sizeTier === 'Compacto' ? 'Compacto' : profile.sizeTier;
  return profile.isPremium
    ? `${size} · Premium (${profile.vehicleLabel})`
    : `${size} (${profile.vehicleLabel})`;
}
