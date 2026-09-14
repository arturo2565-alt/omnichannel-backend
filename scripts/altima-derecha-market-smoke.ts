/**
 * Smoke limpio: Nissan Altima 2014 + Calavera_Derecha.
 * Cache vacía. No imprime listings raw.
 */
import 'dotenv/config';
import { parseVehiclePartIdentity } from '../src/chat/refaccion-market/parse-vehicle-part-identity';
import {
  MARKET_STRATEGY_VERSION,
  marketCacheKey,
  marketIdentityKey,
} from '../src/chat/refaccion-market/parse-vehicle-part-identity';
import { createRefaccionMarketService } from '../src/chat/refaccion-market/refaccion-market.orchestrator';
import { MARKET_CACHE_TTL_MS } from '../src/chat/refaccion-market/refaccion-market.cache';

async function main() {
  process.env.PEG_MARKET_TRACE = process.env.PEG_MARKET_TRACE || 'true';
  const identity = parseVehiclePartIdentity({
    vehiculoText: 'Nissan Altima 2014',
    pieza: 'Calavera_Derecha',
  });
  const market = createRefaccionMarketService();
  const estimate = await market.estimate(identity);
  const audit = estimate.audit;
  const report = {
    pieceCode: identity.pieza,
    piezaLabel: identity.piezaLabel,
    confirmed: identity.confirmed,
    identityKey: marketIdentityKey(identity),
    cacheKey: marketCacheKey(identity),
    marketStrategyVersion: MARKET_STRATEGY_VERSION,
    negativeCacheTtlMs: MARKET_CACHE_TTL_MS,
    lookupPath: audit?.lookupPath,
    pricingStatus: estimate.pricingStatus,
    queries: audit?.queries,
    executedQueries: audit?.executedQueries,
    providersUsed: audit?.providersUsed,
    rawResultCount: audit?.rawResultCount,
    compatibleSampleCount: audit?.compatibleSampleCount,
    acceptedSampleCount: audit?.acceptedSampleCount,
    rejectedResultCount: audit?.rejectedResultCount,
    rejectedByReason: audit?.rejectedByReason,
    sampleCount: audit?.sampleCount,
    selectedPartType: audit?.selectedPartType,
    acceptedDomains: audit?.acceptedDomains,
    insufficientCause: audit?.insufficientCause,
    searchRunId: audit?.searchRunId,
    cacheHit: audit?.cacheHit,
    cacheKey: audit?.cacheKey,
    queryCount: audit?.queryCount,
    providerCounts: audit?.providerCounts,
    funnel: audit?.funnel,
    bestAvailablePartType: audit?.bestAvailablePartType,
    bestAvailableSampleCount: audit?.bestAvailableSampleCount,
    samplesMissingToThreshold: audit?.samplesMissingToThreshold,
    providerContribution: audit?.providerContribution,
    uniqueSamplesAfterCrossProviderDedupe:
      audit?.uniqueSamplesAfterCrossProviderDedupe,
    independenceCounts: audit?.independenceCounts,
    shoppingRecall: audit?.shoppingRecall,
    shoppingUniqueListings: audit?.shoppingUniqueListings,
    partNumbersDiscovered: audit?.partNumbersDiscovered,
    pivotUniqueListings: audit?.pivotUniqueListings,
    marketUniqueMerchants: audit?.marketUniqueMerchants,
    uniqueSamplesPerVariant: audit?.uniqueSamplesPerVariant,
    selectedVariantKey: audit?.selectedVariantKey,
    variantUncertainty: audit?.variantUncertainty,
    shoppingFunnel: audit?.shoppingFunnel,
    resolvedMarketPart: audit?.resolvedMarketPart,
  };
  console.log(JSON.stringify({ SMOKE_ALTIMA_DERECHA: report }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
