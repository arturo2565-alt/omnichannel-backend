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
} from './vehicle-pricing-profile';

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
