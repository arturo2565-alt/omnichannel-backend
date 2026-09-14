import type {
  MarketSample,
  RawProviderHit,
  RefaccionMarketEstimate,
  RefaccionMarketPolicy,
  VehiclePartIdentity,
} from './refaccion-market.types';
import { DEFAULT_REFACCION_MARKET_POLICY } from './refaccion-market.types';
import type { MarketSearchQueryPlan } from './market-search-queries';
import { buildSiteScopedQueries, INDEXED_ML_SITE } from './site-scoped-queries';
import { resolveMarketPieceTaxonomy } from './market-piece-taxonomy';
import { parseMarketSide } from './market-side';
import {
  computeMarketSearchFunnel,
  observePartTypeSelection,
  observePriceStats,
} from './compute-market-funnel';
import {
  domainOfHit,
  evaluateMarketSample,
  rawPriceTextOf,
} from './evaluate-market-sample';
import { extractListingYearRange } from './validate-market-sample';
import {
  emitMarketTrace,
  hashUrlForTrace,
  isMarketTraceEnabled,
  isMarketTraceVerboseEnabled,
  MARKET_TRACE_EVENTS,
  MARKET_TRACE_VERBOSE_LIMIT,
  type MarketSearchFunnel,
  type MarketSearchTraceIds,
  type PartTypeSelectionTrace,
} from './market-search-trace';

export type SearchObservation = {
  funnel: MarketSearchFunnel;
  partType: PartTypeSelectionTrace;
};

export function emitSearchStartedTrace(
  ids: MarketSearchTraceIds,
  identity: VehiclePartIdentity,
  policy: RefaccionMarketPolicy,
  confirmedVehicleFields?: readonly string[],
): void {
  const taxonomy = resolveMarketPieceTaxonomy(identity.pieza || identity.piezaLabel);
  emitMarketTrace(MARKET_TRACE_EVENTS.SEARCH_STARTED, ids, {
    canonicalLabel: taxonomy.canonicalLabel,
    family: taxonomy.family,
    side: taxonomy.requiredSide,
    vehicle: {
      make: identity.marca,
      model: identity.modelo,
      year: identity.anio,
      version: identity.version ?? null,
      variant: null,
    },
    confirmedVehicleFields:
      confirmedVehicleFields ?? confirmedFieldsFromIdentity(identity),
    preferredPartTypes: policy.preferredPartTypes,
    minValidSamples: policy.minValidSamples,
  });
}

export function emitQueriesGeneratedTrace(
  ids: MarketSearchTraceIds,
  identity: VehiclePartIdentity,
  plan: MarketSearchQueryPlan,
): void {
  const taxonomy = resolveMarketPieceTaxonomy(identity.pieza || identity.piezaLabel);
  emitMarketTrace(MARKET_TRACE_EVENTS.QUERIES_GENERATED, ids, {
    queries: [
      ...plan.googleQueries.map((query) => ({
        provider: 'GOOGLE_WEB',
        query,
        aliasUsed:
          taxonomy.searchAliases.find((a) => query.includes(a)) ??
          taxonomy.canonicalLabel,
        sideExpression: parseMarketSide(query),
      })),
      ...plan.mlQueries.map((query) => ({
        provider: 'MERCADO_LIBRE',
        query,
        aliasUsed:
          taxonomy.searchAliases.find((a) => query.includes(a)) ??
          taxonomy.canonicalLabel,
        sideExpression: parseMarketSide(query),
      })),
      ...buildSiteScopedQueries(identity, INDEXED_ML_SITE).map((query) => ({
        provider: 'GOOGLE_WEB',
        query,
        aliasUsed:
          taxonomy.searchAliases.find((a) => query.includes(a)) ??
          taxonomy.canonicalLabel,
        sideExpression: parseMarketSide(query),
        siteScope: INDEXED_ML_SITE,
      })),
    ],
  });
}

export function emitCacheDecisionTrace(
  ids: MarketSearchTraceIds,
  input: {
    cacheKey: string;
    cacheHit: boolean;
    cachedPricingStatus?: string;
    cacheAgeSeconds?: number;
    ttlSeconds?: number;
  },
): void {
  emitMarketTrace(MARKET_TRACE_EVENTS.CACHE_DECISION, ids, input);
}

function confirmedFieldsFromIdentity(
  identity: VehiclePartIdentity,
): string[] {
  const fields: string[] = [];
  if (identity.marca) fields.push('make');
  if (identity.modelo) fields.push('model');
  if (identity.anio) fields.push('year');
  if (identity.version) fields.push('version');
  return fields;
}

function vehicleLabelOf(identity: VehiclePartIdentity): string {
  return [identity.marca, identity.modelo, identity.anio]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

function providerPathOf(
  estimate: RefaccionMarketEstimate,
  fallback: string,
): string {
  const used = estimate.audit?.providersUsed ?? [];
  if (used.length === 0) return fallback;
  if (used[0] === 'SERPER_SHOPPING') return 'SERPER_SHOPPING';
  return used.join('+');
}

export function emitCachedSearchFinished(input: {
  ids: MarketSearchTraceIds;
  estimate: RefaccionMarketEstimate;
  policy?: RefaccionMarketPolicy;
  totalDurationMs: number;
}): void {
  const policy = input.policy ?? DEFAULT_REFACCION_MARKET_POLICY;
  const audit = input.estimate.audit;
  const diagnostic =
    isMarketTraceEnabled() || isMarketTraceVerboseEnabled();
  if (diagnostic && audit?.funnel) {
    emitMarketTrace(MARKET_TRACE_EVENTS.SEARCH_FUNNEL, input.ids, {
      ...audit.funnel,
    });
  }
  const counts = {
    AFTERMARKET_NEW: audit?.funnel?.acceptedByPartType?.AFTERMARKET_NEW ?? 0,
    UNKNOWN: audit?.funnel?.acceptedByPartType?.UNKNOWN ?? 0,
    OEM_NEW: audit?.funnel?.acceptedByPartType?.OEM_NEW ?? 0,
    OEM_USED: audit?.funnel?.acceptedByPartType?.OEM_USED ?? 0,
  };
  if (diagnostic) {
    emitMarketTrace(MARKET_TRACE_EVENTS.PART_TYPE_SELECTION, input.ids, {
      preferredOrder: policy.preferredPartTypes,
      counts,
      minValidSamples: policy.minValidSamples,
      selectedPartType: input.estimate.partTypeGroup ?? audit?.selectedPartType ?? null,
      selectedSampleCount: input.estimate.cantidadMuestras,
      bestAvailablePartType: audit?.bestAvailablePartType ?? null,
      bestAvailableSampleCount: audit?.bestAvailableSampleCount ?? 0,
      samplesMissingToThreshold: audit?.samplesMissingToThreshold ?? 0,
    });
    const pricedMembers = input.estimate.samples ?? [];
    const stats = observePriceStats(pricedMembers.map((s) => s.price));
    emitMarketTrace(MARKET_TRACE_EVENTS.PRICING_DECISION, input.ids, {
      selectedPartType: input.estimate.partTypeGroup,
      selectedSampleCount: input.estimate.cantidadMuestras,
      ...stats,
      marketRange: input.estimate.marketPriceRange,
      marginMultiplier: policy.marginFactor,
      roundedClientAmount: input.estimate.customerPriceRange?.precioCentral,
      pricingStatus: input.estimate.pricingStatus,
      ...(input.estimate.pricingStatus === 'INSUFFICIENT_MARKET_SAMPLE'
        ? {
            bestAvailablePartType: audit?.bestAvailablePartType ?? null,
            bestAvailableSampleCount: audit?.bestAvailableSampleCount ?? 0,
            samplesMissingToThreshold: audit?.samplesMissingToThreshold ?? 0,
          }
        : {}),
    });
  }
  emitMarketTrace(MARKET_TRACE_EVENTS.SEARCH_FINISHED, input.ids, {
    pricingStatus: input.estimate.pricingStatus,
    totalDurationMs: input.totalDurationMs,
    providerDurationMs: 0,
    rawResultCount: audit?.rawResultCount ?? 0,
    uniqueSamples:
      audit?.uniqueSamplesAfterCrossProviderDedupe ??
      audit?.funnel?.afterDedupe ??
      0,
    acceptedSampleCount: audit?.acceptedSampleCount ?? (input.estimate.samples ?? []).length,
    requiredSamples: policy.minValidSamples,
    selectedPartType: input.estimate.partTypeGroup,
    providerPath: providerPathOf(input.estimate, 'CACHE'),
    rejectedByReason: audit?.rejectedByReason ?? audit?.funnel?.rejectedByReason,
    cacheHit: true,
    source: 'CACHE',
  });
}

export function observeSearchRun(input: {
  ids: MarketSearchTraceIds;
  identity: VehiclePartIdentity;
  rawHits: readonly RawProviderHit[];
  uniqueAccepted: readonly MarketSample[];
  estimate: RefaccionMarketEstimate;
  policy?: RefaccionMarketPolicy;
  source: 'CACHE' | 'PROVIDER';
  cacheHit: boolean;
  totalDurationMs: number;
  providerDurationMs: number;
}): SearchObservation {
  const policy = input.policy ?? DEFAULT_REFACCION_MARKET_POLICY;
  const funnel = computeMarketSearchFunnel(
    input.rawHits,
    input.identity,
    input.uniqueAccepted,
  );
  const partType = observePartTypeSelection(input.uniqueAccepted, policy);
  const diagnostic = isMarketTraceEnabled() || isMarketTraceVerboseEnabled();
  if (diagnostic) {
    emitVerboseSamples(input.ids, input.identity, input.rawHits, input.uniqueAccepted);
    emitMarketTrace(MARKET_TRACE_EVENTS.SEARCH_FUNNEL, input.ids, { ...funnel });
    emitMarketTrace(MARKET_TRACE_EVENTS.PART_TYPE_SELECTION, input.ids, {
      ...partType,
    });

    const pricedMembers = input.estimate.samples ?? [];
    const stats = observePriceStats(pricedMembers.map((s) => s.price));
    emitMarketTrace(MARKET_TRACE_EVENTS.PRICING_DECISION, input.ids, {
      selectedPartType: input.estimate.partTypeGroup,
      selectedSampleCount: input.estimate.cantidadMuestras,
      ...stats,
      marketRange: input.estimate.marketPriceRange,
      marginMultiplier: policy.marginFactor,
      roundedClientAmount: input.estimate.customerPriceRange?.precioCentral,
      pricingStatus: input.estimate.pricingStatus,
      ...(input.estimate.pricingStatus === 'INSUFFICIENT_MARKET_SAMPLE'
        ? {
            bestAvailablePartType: partType.bestAvailablePartType,
            bestAvailableSampleCount: partType.bestAvailableSampleCount,
            samplesMissingToThreshold: partType.samplesMissingToThreshold,
          }
        : {}),
    });
  }

  emitMarketTrace(MARKET_TRACE_EVENTS.SEARCH_FINISHED, input.ids, {
    pricingStatus: input.estimate.pricingStatus,
    totalDurationMs: input.totalDurationMs,
    providerDurationMs: input.providerDurationMs,
    rawResultCount: input.rawHits.length,
    uniqueSamples: funnel.afterDedupe,
    acceptedSampleCount: input.uniqueAccepted.length,
    requiredSamples: policy.minValidSamples,
    selectedPartType: input.estimate.partTypeGroup,
    vehicleLabel: vehicleLabelOf(input.identity),
    providerPath: providerPathOf(input.estimate, input.source),
    rejectedByReason: funnel.rejectedByReason,
    cacheHit: input.cacheHit,
    source: input.source,
  });

  return { funnel, partType };
}

function emitVerboseSamples(
  ids: MarketSearchTraceIds,
  identity: VehiclePartIdentity,
  rawHits: readonly RawProviderHit[],
  uniqueAccepted: readonly MarketSample[],
): void {
  if (!isMarketTraceVerboseEnabled()) return;
  rawHits.slice(0, MARKET_TRACE_VERBOSE_LIMIT).forEach((hit, resultIndex) => {
    const ev = evaluateMarketSample(hit, identity);
    emitMarketTrace(MARKET_TRACE_EVENTS.RAW_SAMPLE, ids, {
      provider: hit.provider,
      resultIndex,
      title: hit.title,
      domain: domainOfHit(hit),
      normalizedUrlHash: hashUrlForTrace(hit.url),
      extractedPrice: ev.extractedPrice,
      rawPriceText: rawPriceTextOf(hit),
      detectedPartType: ev.detectedPartType,
    });
    emitMarketTrace(MARKET_TRACE_EVENTS.SAMPLE_EVALUATED, ids, {
      provider: hit.provider,
      resultIndex,
      title: hit.title,
      pieceMatch: ev.pieceMatch,
      matchedPieceAlias: ev.matchedPieceAlias,
      expectedSide: ev.expectedSide,
      detectedSide: ev.detectedSide,
      sideMatch: ev.sideMatch,
      makeMatch: ev.makeMatch,
      modelMatch: ev.modelMatch,
      yearMatch: ev.yearMatch,
      extractedYearRange: ev.extractedYearRange,
      targetYear: ev.targetYear,
      extractedPrice: ev.extractedPrice,
      priceValid: ev.priceValid,
      detectedPartType: ev.detectedPartType,
      accepted: ev.accepted,
      rejectionReason: ev.rejectionReason,
    });
  });
  uniqueAccepted.slice(0, MARKET_TRACE_VERBOSE_LIMIT).forEach((sample) => {
    emitMarketTrace(MARKET_TRACE_EVENTS.ACCEPTED_SAMPLE, ids, {
      provider: sample.source,
      title: sample.title,
      domain: sample.domain,
      price: sample.price,
      partType: sample.partType,
      detectedSide: parseMarketSide(sample.title),
      yearRange: extractListingYearRange(sample.title),
    });
  });
}
