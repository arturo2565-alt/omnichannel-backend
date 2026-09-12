import {
  computeCatalogPiecePrice,
  coerceDamageMagnitude,
  mergeCatalogPricingRules,
  type CatalogPricingRules,
} from './catalog-pricing-rules';
import type { MatrixPricingSnapshot } from './matrix-pricing-snapshot';
import {
  applyPremiumMultiplier,
  tierMatrixSeveridadKeys,
  type VehiclePricingProfile,
  type VehicleSizeTier,
} from './vehicle-pricing-profile';

/**
 * @deprecated LEGACY. CANONICAL usa la fila de catálogo BPCC ($39,000 BASE).
 * No llamar desde Quote Engine, express ni materializeIntegralQuoteResolution.
 */
export const BPCC_TURNKEY_LABEL =
  'Transformación Total / Cambio de Color (Exterior e Interiores completos)';

/**
 * @deprecated LEGACY $8,000 / $10,000. No gobierna cotizaciones CANONICAL.
 */
export function cambioDeColorAddonMxForSizeTier(
  sizeTier?: VehicleSizeTier | null,
): number {
  if (sizeTier === 'Grande' || sizeTier === 'XL') return 10_000;
  return 8_000;
}

export function normalizeBanioPricingCode(
  banioCode: string,
): 'BPE' | 'BPEI' | 'BPCC' {
  const c = String(banioCode ?? '').toUpperCase().trim();
  if (c === 'BPCC') return 'BPCC';
  if (c === 'BPEI') return 'BPEI';
  return 'BPE';
}

/**
 * @deprecated LEGACY (+15% / suplemento de color).
 * CANONICAL: lookupBanioCatalogBase + computeCatalogIntegralPrice.
 * No llamar desde flujos modernos.
 */
export function resolveBanioCodeUnitPrice(
  exteriorBase: number,
  banioCode: string,
  sizeTier?: VehicleSizeTier | null,
): number {
  let price = Math.max(0, Math.round(Number(exteriorBase) || 0));
  if (price <= 0) return 0;
  const code = normalizeBanioPricingCode(banioCode);
  if (code === 'BPEI' || code === 'BPCC') {
    price = Math.round((price * 1.15) / 50) * 50;
  }
  if (code === 'BPCC') {
    price += cambioDeColorAddonMxForSizeTier(sizeTier ?? 'Mediano');
  }
  return price;
}

export function banioTurnkeyDisplayLabel(
  banioCode: string,
  fallback = 'Baño de Pintura Exterior',
): string {
  const code = normalizeBanioPricingCode(banioCode);
  if (code === 'BPCC') return BPCC_TURNKEY_LABEL;
  if (code === 'BPEI') return 'Baño de Pintura Exterior e Interiores';
  return fallback;
}

/**
 * Precio de pieza: base (LEVE/DL) × tamaño × premium × magnitud de daño.
 * Opcional: celdas tier explícitas en catálogo (`Mediano|DL`).
 */
export function resolvePiecePriceForVehicleProfile(
  snap: MatrixPricingSnapshot,
  canonicalServicio: string,
  damageLevel: string,
  profile?: VehiclePricingProfile | null,
  rules?: CatalogPricingRules | null,
): number {
  const canonical = String(canonicalServicio ?? '').trim();
  const sev = String(damageLevel ?? '').trim();
  if (!canonical || !sev) return 0;

  const mergedRules = mergeCatalogPricingRules(rules ?? undefined);
  const magnitude = coerceDamageMagnitude(sev);

  if (profile) {
    for (const key of tierMatrixSeveridadKeys(profile.sizeTier, sev)) {
      const tierPrice = snap.getPriceForCanonical(canonical, key);
      if (tierPrice > 0) {
        const withPremium = applyPremiumMultiplier(tierPrice, profile);
        return computeCatalogPiecePrice({
          basePrice: withPremium,
          sizeTier: 'Compacto',
          isPremium: false,
          damageMagnitude: magnitude,
          rules: mergedRules,
        });
      }
    }
  }

  const legacyLeve = snap.getPriceForCanonical(canonical, 'LEVE');
  const legacyDl = snap.getPriceForCanonical(canonical, 'DL');
  const compactoBase =
    legacyLeve > 0 ? legacyLeve : legacyDl > 0 ? legacyDl : snap.getPriceForCanonical(canonical, sev);

  if (compactoBase <= 0) {
    const viaAmount = snap.getAmount(canonical, sev);
    if (viaAmount <= 0) return 0;
    return computeCatalogPiecePrice({
      basePrice: viaAmount,
      sizeTier: profile?.sizeTier ?? 'Compacto',
      isPremium: profile?.isPremium ?? false,
      damageMagnitude: magnitude,
      rules: mergedRules,
    });
  }

  return computeCatalogPiecePrice({
    basePrice: compactoBase,
    sizeTier: profile?.sizeTier ?? 'Compacto',
    isPremium: profile?.isPremium ?? false,
    damageMagnitude: magnitude,
    rules: mergedRules,
  });
}
