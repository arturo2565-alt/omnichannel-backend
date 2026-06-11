import type { MatrixPricingSnapshot } from './matrix-pricing-snapshot';
import {
  applyPremiumMultiplier,
  applySizeTierToCompactoBase,
  tierMatrixSeveridadKeys,
  type VehiclePricingProfile,
} from './vehicle-pricing-profile';

/**
 * Precio de pieza según matriz + perfil vehicular (tamaño + premium).
 * 1) Celdas tier explícitas en catálogo (`Mediano|DL`, `Tier:Mediano|DL`)
 * 2) Base legacy `DL`/`DM`/… × factor tamaño × premium
 */
export function resolvePiecePriceForVehicleProfile(
  snap: MatrixPricingSnapshot,
  canonicalServicio: string,
  damageLevel: string,
  profile?: VehiclePricingProfile | null,
): number {
  const canonical = String(canonicalServicio ?? '').trim();
  const sev = String(damageLevel ?? '').trim();
  if (!canonical || !sev) return 0;

  if (profile) {
    for (const key of tierMatrixSeveridadKeys(profile.sizeTier, sev)) {
      const tierPrice = snap.getPriceForCanonical(canonical, key);
      if (tierPrice > 0) {
        return applyPremiumMultiplier(tierPrice, profile);
      }
    }
  }

  const legacyBase = snap.getPriceForCanonical(canonical, sev);
  if (legacyBase <= 0) {
    const viaAmount = snap.getAmount(canonical, sev);
    if (viaAmount <= 0) return 0;
    if (!profile) return Math.round(viaAmount);
    const sized = applySizeTierToCompactoBase(viaAmount, profile.sizeTier);
    return applyPremiumMultiplier(sized, profile);
  }

  if (!profile) return legacyBase;

  const sized = applySizeTierToCompactoBase(legacyBase, profile.sizeTier);
  return applyPremiumMultiplier(sized, profile);
}
