import {
  computeCatalogPiecePrice,
  coerceDamageMagnitude,
  mergeCatalogPricingRules,
  type CatalogPricingRules,
  type DamageMagnitude,
} from './catalog-pricing-rules';
import type { MatrixPricingSnapshot } from './matrix-pricing-snapshot';
import {
  describePremiumAdjustment,
  tierMatrixSeveridadKeys,
  type VehiclePricingProfile,
  type VehicleSizeTier,
} from './vehicle-pricing-profile';
import {
  PRICING_TRACE_SCHEMA_VERSION,
  type PricingTraceOperationOrder,
  type PricingTraceV1,
} from '../domain/peritaje-v1/types';

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

export type PiecePriceResolution = {
  amount: number;
  trace: PricingTraceV1;
};

function pieceTrace(input: {
  catalogService: string;
  matrixSeverityKey?: string;
  catalogBasePrice?: number;
  formulaBasePrice?: number;
  vehicleSizeTier?: VehicleSizeTier;
  formulaSizeTier?: VehicleSizeTier;
  formulaPremiumApplied?: boolean;
  premiumApplied?: boolean;
  premiumFactor?: number;
  operationOrder?: PricingTraceOperationOrder;
  intermediateRoundToMx?: number;
  damageMagnitude?: DamageMagnitude;
  rules: CatalogPricingRules;
  amount: number;
  configured: boolean;
}): PricingTraceV1 {
  if (!input.configured) {
    return {
      schemaVersion: PRICING_TRACE_SCHEMA_VERSION,
      pricingMethod: 'unconfigured',
      catalogService: input.catalogService || undefined,
      matrixSeverityKey: input.matrixSeverityKey,
      calculatedAmountMx: 0,
      pricingSource: 'UNCONFIGURED',
      pricingStatus: 'UNCONFIGURED',
    };
  }
  const formulaSize = input.formulaSizeTier ?? input.vehicleSizeTier ?? 'Compacto';
  const vehicleSize = input.vehicleSizeTier ?? formulaSize;
  const magnitude = input.damageMagnitude ?? 'MEDIO';
  const premiumApplied = Boolean(input.premiumApplied);
  const formulaPremium = Boolean(input.formulaPremiumApplied);
  return {
    schemaVersion: PRICING_TRACE_SCHEMA_VERSION,
    pricingMethod: 'catalog_piece',
    catalogService: input.catalogService,
    matrixSeverityKey: input.matrixSeverityKey,
    ...(input.catalogBasePrice != null
      ? { catalogBasePriceMx: input.catalogBasePrice }
      : {}),
    ...(input.formulaBasePrice != null
      ? {
          effectiveBasePriceMx: input.formulaBasePrice,
          basePriceMx: input.formulaBasePrice,
        }
      : {}),
    vehicleSizeTier: vehicleSize,
    formulaSizeTier: formulaSize,
    sizeFactor: input.rules.sizeTierFactors[formulaSize] ?? 1,
    premiumApplied,
    formulaPremiumApplied: formulaPremium,
    premiumFactor: premiumApplied
      ? input.premiumFactor
      : formulaPremium
        ? input.rules.premiumFactor
        : 1,
    operationOrder: input.operationOrder ?? 'size_premium_severity',
    ...(input.intermediateRoundToMx != null
      ? { intermediateRoundToMx: input.intermediateRoundToMx }
      : {}),
    damageMagnitude: magnitude,
    severityFactor: input.rules.severityFactors[magnitude] ?? 1,
    roundToMx: input.rules.roundToMx,
    calculatedAmountMx: input.amount,
    pricingSource: 'AUTOFIX_CATALOG',
    pricingStatus: 'OK',
  };
}

/**
 * Precio de pieza y la celda que ese mismo cálculo consultó.
 * La función numérica antigua devuelve solo `amount`.
 */
export function resolvePiecePriceResolution(
  snap: MatrixPricingSnapshot,
  canonicalServicio: string,
  damageLevel: string,
  profile?: VehiclePricingProfile | null,
  rules?: CatalogPricingRules | null,
): PiecePriceResolution {
  const canonical = String(canonicalServicio ?? '').trim();
  const sev = String(damageLevel ?? '').trim();
  const mergedRules = mergeCatalogPricingRules(rules ?? undefined);
  if (!canonical || !sev) {
    return {
      amount: 0,
      trace: pieceTrace({
        catalogService: canonical,
        rules: mergedRules,
        amount: 0,
        configured: false,
      }),
    };
  }

  const magnitude = coerceDamageMagnitude(sev);

  if (profile) {
    for (const key of tierMatrixSeveridadKeys(profile.sizeTier, sev)) {
      const tierPrice = snap.getPriceForCanonical(canonical, key);
      if (tierPrice > 0) {
        const premium = describePremiumAdjustment(tierPrice, profile);
        const amount = computeCatalogPiecePrice({
          basePrice: premium.amount,
          sizeTier: 'Compacto',
          isPremium: false,
          damageMagnitude: magnitude,
          rules: mergedRules,
        });
        return {
          amount,
          trace: pieceTrace({
            catalogService: canonical,
            matrixSeverityKey: key,
            catalogBasePrice: tierPrice,
            formulaBasePrice: premium.amount,
            vehicleSizeTier: profile.sizeTier,
            formulaSizeTier: 'Compacto',
            premiumApplied: premium.applied,
            premiumFactor: premium.factor,
            formulaPremiumApplied: false,
            operationOrder: premium.applied
              ? 'premium_round_then_severity'
              : 'tier_cell_then_severity',
            intermediateRoundToMx: premium.intermediateRoundToMx,
            damageMagnitude: magnitude,
            rules: mergedRules,
            amount,
            configured: true,
          }),
        };
      }
    }
  }

  const legacyLeve = snap.getPriceForCanonical(canonical, 'LEVE');
  const legacyDl = snap.getPriceForCanonical(canonical, 'DL');
  const cellKey = legacyLeve > 0 ? 'LEVE' : legacyDl > 0 ? 'DL' : sev;
  const compactoBase =
    legacyLeve > 0 ? legacyLeve : legacyDl > 0 ? legacyDl : snap.getPriceForCanonical(canonical, sev);

  if (compactoBase <= 0) {
    const viaAmount = snap.getAmount(canonical, sev);
    if (viaAmount <= 0) {
      return {
        amount: 0,
        trace: pieceTrace({
          catalogService: canonical,
          matrixSeverityKey: cellKey,
          rules: mergedRules,
          amount: 0,
          configured: false,
        }),
      };
    }
    const amount = computeCatalogPiecePrice({
      basePrice: viaAmount,
      sizeTier: profile?.sizeTier ?? 'Compacto',
      isPremium: profile?.isPremium ?? false,
      damageMagnitude: magnitude,
      rules: mergedRules,
    });
    const viaSize = profile?.sizeTier ?? 'Compacto';
    const viaPremium = profile?.isPremium ?? false;
    return {
      amount,
      trace: pieceTrace({
        catalogService: canonical,
        matrixSeverityKey: sev,
        catalogBasePrice: viaAmount,
        formulaBasePrice: viaAmount,
        vehicleSizeTier: viaSize,
        formulaSizeTier: viaSize,
        premiumApplied: viaPremium,
        premiumFactor: viaPremium ? mergedRules.premiumFactor : 1,
        formulaPremiumApplied: viaPremium,
        operationOrder: 'size_premium_severity',
        damageMagnitude: magnitude,
        rules: mergedRules,
        amount,
        configured: true,
      }),
    };
  }

  const sizeTier = profile?.sizeTier ?? 'Compacto';
  const isPremium = profile?.isPremium ?? false;
  const amount = computeCatalogPiecePrice({
    basePrice: compactoBase,
    sizeTier,
    isPremium,
    damageMagnitude: magnitude,
    rules: mergedRules,
  });
  return {
    amount,
    trace: pieceTrace({
      catalogService: canonical,
      matrixSeverityKey: cellKey,
      catalogBasePrice: compactoBase,
      formulaBasePrice: compactoBase,
      vehicleSizeTier: sizeTier,
      formulaSizeTier: sizeTier,
      premiumApplied: isPremium,
      premiumFactor: isPremium ? mergedRules.premiumFactor : 1,
      formulaPremiumApplied: isPremium,
      operationOrder: 'size_premium_severity',
      damageMagnitude: magnitude,
      rules: mergedRules,
      amount,
      configured: true,
    }),
  };
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
  return resolvePiecePriceResolution(
    snap,
    canonicalServicio,
    damageLevel,
    profile,
    rules,
  ).amount;
}
