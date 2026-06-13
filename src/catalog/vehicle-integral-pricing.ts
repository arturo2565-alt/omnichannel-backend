import {
  computeCatalogIntegralPrice,
  INTEGRAL_BASE_SEVERITY,
  isIntegralServiceName,
  mergeCatalogPricingRules,
  type CatalogPricingRules,
} from './catalog-pricing-rules';
import type { MatrixPricingSnapshot } from './matrix-pricing-snapshot';
import {
  resolveVehiclePricingProfile,
  type VehiclePricingProfile,
  type VehicleSizeTier,
} from './vehicle-pricing-profile';
import { normalizeTextForMatch } from '../chat/autofix-config';

const INTEGRAL_BASE_CANDIDATES = [
  INTEGRAL_BASE_SEVERITY,
  'N/A',
  'LEVE',
  'Chico',
] as const;

export type IntegralBaseResolution = {
  basePrice: number;
  diasEntrega: number;
  matrixSeverity: string;
};

function normalizeSevKey(sev: string): string {
  return normalizeTextForMatch(String(sev ?? '').trim());
}

/** Localiza la fila base (BASE / N/A / LEVE / Chico legacy) en catálogo. */
export function resolveIntegralBaseFromSnap(
  snap: MatrixPricingSnapshot,
  canonicalServicio: string,
): IntegralBaseResolution | null {
  const canonical = String(canonicalServicio ?? '').trim();
  if (!canonical || !isIntegralServiceName(canonical)) return null;

  const severities = snap.listSeveridadesForCanonical(canonical);
  if (!severities.length) return null;

  for (const candidate of INTEGRAL_BASE_CANDIDATES) {
    const hit = severities.find(
      (s) => normalizeSevKey(s) === normalizeSevKey(candidate),
    );
    if (!hit) continue;
    const basePrice = snap.getPriceForCanonical(canonical, hit);
    if (basePrice > 0) {
      const dias = snap.getDiasEntregaForCanonical(canonical, hit);
      return {
        basePrice,
        diasEntrega: dias > 0 ? dias : 5,
        matrixSeverity: hit,
      };
    }
  }

  let best: IntegralBaseResolution | null = null;
  let bestScore = -1;
  for (const sev of severities) {
    const raw = String(sev ?? '').trim();
    const k = normalizeSevKey(raw);
    let score = 0;
    if (k === 'base') score = 100;
    else if (k === 'n/a') score = 90;
    else if (k === 'leve') score = 80;
    else if (k === 'chico' && !/premium/i.test(raw)) score = 70;
    if (score <= 0) continue;
    const basePrice = snap.getPriceForCanonical(canonical, sev);
    if (basePrice <= 0) continue;
    if (score > bestScore) {
      bestScore = score;
      const dias = snap.getDiasEntregaForCanonical(canonical, sev);
      best = {
        basePrice,
        diasEntrega: dias > 0 ? dias : 5,
        matrixSeverity: sev,
      };
    }
  }
  return best;
}

export type IntegralPriceResolution = {
  unitPrice: number;
  diasEntrega: number;
  basePrice: number;
  matrixSeverity: string;
};

export function resolveIntegralPriceForVehicleProfile(
  snap: MatrixPricingSnapshot,
  canonicalServicio: string,
  profile?: VehiclePricingProfile | null,
  rules?: CatalogPricingRules | null,
): IntegralPriceResolution | null {
  const base = resolveIntegralBaseFromSnap(snap, canonicalServicio);
  if (!base || base.basePrice <= 0) return null;

  const mergedRules = mergeCatalogPricingRules(rules ?? undefined);
  const unitPrice = computeCatalogIntegralPrice({
    basePrice: base.basePrice,
    sizeTier: profile?.sizeTier ?? 'Compacto',
    isPremium: profile?.isPremium ?? false,
    rules: mergedRules,
  });
  if (unitPrice <= 0) return null;

  return {
    unitPrice,
    diasEntrega: base.diasEntrega,
    basePrice: base.basePrice,
    matrixSeverity: base.matrixSeverity,
  };
}

/** Deriva perfil vehicular desde celda legacy (p. ej. "Mediano Premium"). */
export function inferVehicleProfileFromLegacyBañoSeveridad(
  severidadLiteral: string,
  vehicleLabel = '',
): VehiclePricingProfile {
  const s = normalizeTextForMatch(severidadLiteral);
  const isPremium = s.includes('premium');
  let sizeTier: VehicleSizeTier = 'Mediano';
  if (/\bxl\b/.test(s)) sizeTier = 'XL';
  else if (/\bgrande\b/.test(s)) sizeTier = 'Grande';
  else if (/\bchico\b/.test(s)) sizeTier = 'Compacto';
  else if (/\bmediano\b/.test(s)) sizeTier = 'Mediano';

  return resolveVehiclePricingProfile({
    modeloVehiculo: vehicleLabel || 'legacy',
    sizeTier,
    isPremium,
    tierSource: 'inferido',
  });
}
