import { Injectable } from '@nestjs/common';
import { buildMarketEstimate, insufficientEstimate } from './compute-market-range';
import {
  defaultCoverageProviders,
  runCoverageLookup,
  type CoverageRunResult,
  type ProviderContribution,
} from './provider-coverage';
import {
  assignSampleIndependence,
  independenceCounts,
  hasSufficientIndependentSamples,
} from './sample-independence';
import { classifyRawHit } from './normalize-market-sample';
import {
  clusterSamplesByVariant,
  selectVariantCluster,
} from './variant-cluster';
import {
  runShoppingFirstDiscovery,
  type ShoppingFirstResult,
  type ShoppingRetrievalMetrics,
  type ShoppingSearcher,
} from './shopping-first-retrieval';
import type { ResolvedMarketPartIdentity } from './resolved-market-part';
import { emitMarketTrace, MARKET_TRACE_EVENTS } from './market-search-trace';
import { RefaccionMarketCache } from './refaccion-market.cache';
import type {
  MarketProviderId,
  MarketSample,
  RawProviderHit,
  RefaccionMarketEstimate,
  RefaccionMarketPolicy,
  RefaccionPriceProvider,
  VehiclePartIdentity,
} from './refaccion-market.types';
import { DEFAULT_REFACCION_MARKET_POLICY } from './refaccion-market.types';
import {
  logRefaccionMarketEvent,
  REFACCION_MARKET_EVENTS,
  type RefaccionMarketEventSink,
} from './refaccion-market-events';
import {
  bumpRejection,
  emptyRejectedByReason,
  resolveInsufficientCause,
  type RefaccionMarketAudit,
} from './market-audit';
import { resolveMarketPieceTaxonomy } from './market-piece-taxonomy';
import { buildMarketSearchQueryPlan } from './market-search-queries';
import {
  MARKET_STRATEGY_VERSION,
  marketCacheKey,
  marketIdentityKey,
} from './parse-vehicle-part-identity';
import {
  createSearchRunId,
  resolveMarketTraceIds,
  runWithMarketSearchIds,
  type MarketEstimateTraceInput,
} from './market-search-trace';
import {
  emitCacheDecisionTrace,
  emitCachedSearchFinished,
  emitQueriesGeneratedTrace,
  emitSearchStartedTrace,
  observeSearchRun,
} from './observe-search-run';
import { MARKET_CACHE_TTL_MS } from './refaccion-market.cache';

function emitMarketAudit(
  emit: RefaccionMarketEventSink,
  audit: RefaccionMarketAudit,
): void {
  emit(REFACCION_MARKET_EVENTS.AUDIT, {
    damageItemId: audit.damageItemId,
    pieceCode: audit.pieceCode,
    family: audit.family,
    marketIdentityKey: audit.marketIdentityKey,
    marketStrategyVersion: audit.marketStrategyVersion ?? MARKET_STRATEGY_VERSION,
    lookupPath: audit.lookupPath ?? 'MARKET_LOOKUP_EXECUTED',
    insufficientCause: audit.insufficientCause,
    cacheHit: audit.lookupPath === 'MARKET_CACHE_REUSED',
    queries: audit.queries,
    executedQueries: audit.executedQueries,
    providersUsed: audit.providersUsed,
    rawResultCount: audit.rawResultCount,
    compatibleSampleCount: audit.compatibleSampleCount,
    acceptedSampleCount: audit.acceptedSampleCount,
    rejectedResultCount: audit.rejectedResultCount,
    rejectedByReason: audit.rejectedByReason,
    selectedPartType: audit.selectedPartType,
    acceptedDomains: audit.acceptedDomains,
    sampleCount: audit.sampleCount,
    pricingStatus: audit.pricingStatus,
    searchRunId: audit.searchRunId,
    cacheKey: audit.cacheKey,
    queryCount: audit.queryCount,
    providerCounts: audit.providerCounts,
    funnel: audit.funnel,
    bestAvailablePartType: audit.bestAvailablePartType,
    bestAvailableSampleCount: audit.bestAvailableSampleCount,
    samplesMissingToThreshold: audit.samplesMissingToThreshold,
    providerContribution: audit.providerContribution,
    uniqueSamplesAfterCrossProviderDedupe:
      audit.uniqueSamplesAfterCrossProviderDedupe,
    independenceCounts: audit.independenceCounts,
    shoppingRecall: audit.shoppingRecall,
    shoppingUniqueListings: audit.shoppingUniqueListings,
    partNumbersDiscovered: audit.partNumbersDiscovered,
    pivotUniqueListings: audit.pivotUniqueListings,
    marketUniqueMerchants: audit.marketUniqueMerchants,
    uniqueSamplesPerVariant: audit.uniqueSamplesPerVariant,
    selectedVariantKey: audit.selectedVariantKey,
    variantUncertainty: audit.variantUncertainty,
    shoppingFunnel: audit.shoppingFunnel,
    resolvedMarketPart: audit.resolvedMarketPart,
  });
}

function finalizeAudit(audit: RefaccionMarketAudit): RefaccionMarketAudit {
  const next: RefaccionMarketAudit = {
    ...audit,
    marketStrategyVersion: audit.marketStrategyVersion ?? MARKET_STRATEGY_VERSION,
    lookupPath: audit.lookupPath ?? 'MARKET_LOOKUP_EXECUTED',
  };
  next.insufficientCause = resolveInsufficientCause(next);
  return next;
}

export function runRefaccionMarketPipeline(input: {
  identity: VehiclePartIdentity;
  rawHits: RawProviderHit[];
  providersUsed: MarketProviderId[];
  policy?: RefaccionMarketPolicy;
  emit?: RefaccionMarketEventSink;
  queries?: string[];
  damageItemId?: string;
  providerContribution?: ProviderContribution;
  shoppingMetrics?: ShoppingRetrievalMetrics;
  resolvedPart?: ResolvedMarketPartIdentity;
  observation?: {
    ids: ReturnType<typeof resolveMarketTraceIds>;
    source: 'CACHE' | 'PROVIDER';
    cacheHit: boolean;
    cacheKey: string;
    totalDurationMs: number;
    providerDurationMs: number;
  };
}): RefaccionMarketEstimate {
  const emit = input.emit ?? logRefaccionMarketEvent;
  const plan = buildMarketSearchQueryPlan(input.identity);
  const queries = input.queries?.length ? input.queries : plan.queries;
  const query = queries[0] ?? input.rawHits[0]?.query ?? input.identity.piezaLabel;
  const taxonomy = resolveMarketPieceTaxonomy(
    input.identity.pieza || input.identity.piezaLabel,
  );
  const rejectedByReason = emptyRejectedByReason();
  let compatibleSampleCount = 0;

  if (!input.identity.confirmed) {
    const empty = insufficientEstimate(input.identity, query, {
      providersUsed: input.providersUsed,
    });
    const observation = input.observation
      ? observeSearchRun({
          ids: input.observation.ids,
          identity: input.identity,
          rawHits: [],
          uniqueAccepted: [],
          estimate: empty,
          policy: input.policy,
          source: input.observation.source,
          cacheHit: input.observation.cacheHit,
          totalDurationMs: input.observation.totalDurationMs,
          providerDurationMs: input.observation.providerDurationMs,
        })
      : undefined;
    empty.audit = finalizeAudit({
      damageItemId: input.damageItemId,
      pieceCode: taxonomy.pieceCode,
      family: taxonomy.family,
      marketIdentityKey: marketCacheKey(input.identity),
      queries,
      providersUsed: input.providersUsed,
      rawResultCount: 0,
      compatibleSampleCount: 0,
      acceptedSampleCount: 0,
      rejectedResultCount: 0,
      rejectedByReason,
      selectedPartType: null,
      acceptedDomains: [],
      sampleCount: 0,
      pricingStatus: 'INSUFFICIENT_MARKET_SAMPLE',
      searchRunId: input.observation?.ids.searchRunId,
      cacheHit: input.observation?.cacheHit,
      cacheKey: input.observation?.cacheKey,
      queryCount: queries.length,
      providerCounts: observation?.funnel.providerRawResults,
      funnel: observation?.funnel,
      bestAvailablePartType: observation?.partType.bestAvailablePartType,
      bestAvailableSampleCount: observation?.partType.bestAvailableSampleCount,
      samplesMissingToThreshold: observation?.partType.samplesMissingToThreshold,
    });
    emitMarketAudit(emit, empty.audit);
    return empty;
  }

  const accepted: MarketSample[] = [];
  for (const hit of input.rawHits) {
    const classified = classifyRawHit(hit, input.identity);
    if (classified.compatible) compatibleSampleCount += 1;
    if (!classified.ok) {
      bumpRejection(rejectedByReason, classified.reason);
      continue;
    }
    accepted.push(classified.sample);
  }

  if (input.rawHits.length > 0 && accepted.length === 0) {
    emit(REFACCION_MARKET_EVENTS.COMPATIBILITY_REJECTED, {
      pieza: input.identity.piezaLabel,
      marca: input.identity.marca,
      modelo: input.identity.modelo,
      anio: input.identity.anio,
      rawHits: input.rawHits.length,
    });
  }

  const labeled = assignSampleIndependence(accepted);
  const unique = labeled.filter((s) => s.independenceStatus === 'UNIQUE');
  for (const row of labeled) {
    if (row.independenceStatus === 'DUPLICATE') {
      bumpRejection(rejectedByReason, 'DUPLICATE');
    }
  }
  const independence = independenceCounts(labeled);
  const clusters = clusterSamplesByVariant(unique);
  const selection = selectVariantCluster(clusters, input.policy);
  const pricingSamples = selection.selected?.members ?? unique;
  if (input.observation?.ids) {
    emitMarketTrace(MARKET_TRACE_EVENTS.MARKET_SAMPLE_SELECTED, input.observation.ids, {
      selectedVariantKey: selection.selected?.variantKey ?? null,
      unique: pricingSamples.length,
      uncertainty: selection.uncertainty,
      uniqueSamplesPerVariant: selection.uniqueSamplesPerVariant,
    });
  }
  const estimate = buildMarketEstimate({
    identity: input.identity,
    query,
    samples: pricingSamples,
    providersUsed: input.providersUsed,
    policy: input.policy,
  });
  const domains = [
    ...new Set(
      (estimate.samples ?? [])
        .map((s) => s.domain)
        .filter((d) => d && d !== 'unknown'),
    ),
  ];
  const rejectedResultCount = Object.values(rejectedByReason).reduce(
    (s, n) => s + (n ?? 0),
    0,
  );
  const observation = input.observation
    ? observeSearchRun({
        ids: input.observation.ids,
        identity: input.identity,
        rawHits: input.rawHits,
        uniqueAccepted: pricingSamples,
        estimate,
        policy: input.policy,
        source: input.observation.source,
        cacheHit: input.observation.cacheHit,
        totalDurationMs: input.observation.totalDurationMs,
        providerDurationMs: input.observation.providerDurationMs,
      })
    : undefined;
  estimate.audit = finalizeAudit({
    damageItemId: input.damageItemId,
    pieceCode: taxonomy.pieceCode,
    family: taxonomy.family,
    marketIdentityKey: marketCacheKey(input.identity),
    queries,
    providersUsed: input.providersUsed,
    rawResultCount: input.rawHits.length,
    compatibleSampleCount,
    acceptedSampleCount: unique.length,
    rejectedResultCount,
    rejectedByReason,
    selectedPartType: estimate.partTypeGroup,
    acceptedDomains: domains,
    sampleCount: estimate.cantidadMuestras,
    pricingStatus: estimate.pricingStatus,
    searchRunId: input.observation?.ids.searchRunId,
    cacheHit: input.observation?.cacheHit,
    cacheKey: input.observation?.cacheKey,
    queryCount: queries.length,
    providerCounts: observation?.funnel.providerRawResults,
    funnel: observation?.funnel,
    bestAvailablePartType: observation?.partType.bestAvailablePartType,
    bestAvailableSampleCount: observation?.partType.bestAvailableSampleCount,
    samplesMissingToThreshold: observation?.partType.samplesMissingToThreshold,
    providerContribution: input.providerContribution,
    uniqueSamplesAfterCrossProviderDedupe: unique.length,
    independenceCounts: independence,
    shoppingRecall: input.shoppingMetrics?.shoppingRecall,
    shoppingUniqueListings: input.shoppingMetrics?.shoppingUniqueListings,
    partNumbersDiscovered: input.shoppingMetrics?.partNumbersDiscovered,
    pivotUniqueListings: input.shoppingMetrics?.pivotUniqueListings,
    marketUniqueMerchants: input.shoppingMetrics?.marketUniqueMerchants,
    uniqueSamplesPerVariant: selection.uniqueSamplesPerVariant,
    selectedVariantKey: selection.selected?.variantKey ?? null,
    variantUncertainty: selection.uncertainty,
    shoppingFunnel: input.shoppingMetrics
      ? {
          shoppingRaw: input.shoppingMetrics.shoppingRaw,
          shoppingUnique: input.shoppingMetrics.shoppingUnique,
          partNumbersDiscovered: input.shoppingMetrics.partNumbersDiscovered,
          pivotRaw: input.shoppingMetrics.pivotRaw,
          crossQueryUnique: input.shoppingMetrics.crossQueryUnique,
          compatible: input.shoppingMetrics.compatible,
          byVariant: selection.uniqueSamplesPerVariant,
          byPartType: (estimate.samples ?? []).reduce<
            Partial<Record<MarketSample['partType'], number>>
          >((acc, s) => {
            acc[s.partType] = (acc[s.partType] ?? 0) + 1;
            return acc;
          }, {}),
          finalSamples: estimate.cantidadMuestras,
        }
      : undefined,
    resolvedMarketPart: input.resolvedPart
      ? {
          oemPartNumbers: input.resolvedPart.oemPartNumbers,
          aftermarketPartNumbers: input.resolvedPart.aftermarketPartNumbers,
          commercialAliases: input.resolvedPart.commercialAliases,
          side: input.resolvedPart.side,
        }
      : undefined,
  });
  emitMarketAudit(emit, estimate.audit);
  return estimate;
}

type RefaccionMarketServiceOpts = {
  cache?: RefaccionMarketCache;
  providers?: RefaccionPriceProvider[];
  policy?: RefaccionMarketPolicy;
  shoppingFirst?: boolean;
  shopping?: ShoppingSearcher;
};

type CoverageWithShopping = CoverageRunResult & {
  shopping?: ShoppingFirstResult;
};

function hitsToCompatibleSamples(
  hits: readonly RawProviderHit[],
  identity: VehiclePartIdentity,
): MarketSample[] {
  const out: MarketSample[] = [];
  for (const hit of hits) {
    const classified = classifyRawHit(hit, identity);
    if (classified.ok) out.push(classified.sample);
  }
  return out;
}

@Injectable()
export class RefaccionMarketService {
  private cache: RefaccionMarketCache;
  private providers: RefaccionPriceProvider[];
  private policy: RefaccionMarketPolicy;
  private shoppingFirst: boolean;
  private shopping?: ShoppingSearcher;

  /** Sin parámetros: Nest no debe inyectar el objeto de opciones. */
  constructor() {
    this.applyOpts();
  }

  applyOpts(opts?: RefaccionMarketServiceOpts): this {
    this.cache = opts?.cache ?? new RefaccionMarketCache();
    this.providers = opts?.providers ?? defaultCoverageProviders();
    this.policy = opts?.policy ?? DEFAULT_REFACCION_MARKET_POLICY;
    this.shoppingFirst = opts?.shoppingFirst ?? !opts?.providers;
    this.shopping = opts?.shopping;
    return this;
  }

  async estimate(
    identity: VehiclePartIdentity,
    traceInput?: MarketEstimateTraceInput,
  ): Promise<RefaccionMarketEstimate> {
    const startedAt = Date.now();
    const inspect = this.cache.inspect(identity);
    const plan = buildMarketSearchQueryPlan(identity);
    const pieceCode = identity.pieza || identity.piezaLabel;
    const ids = resolveMarketTraceIds({
      searchRunId: createSearchRunId(),
      pieceCode,
      marketIdentityKey: marketIdentityKey(identity),
      marketStrategyVersion: MARKET_STRATEGY_VERSION,
      ...traceInput,
    });
    emitSearchStartedTrace(
      ids,
      identity,
      this.policy,
      traceInput?.confirmedVehicleFields,
    );
    emitQueriesGeneratedTrace(ids, identity, plan);
    emitCacheDecisionTrace(ids, {
      cacheKey: inspect.key,
      cacheHit: inspect.hit,
      cachedPricingStatus: inspect.pricingStatus,
      cacheAgeSeconds:
        inspect.ageMs != null ? Math.round(inspect.ageMs / 1000) : undefined,
      ttlSeconds: Math.round((inspect.ttlMs ?? MARKET_CACHE_TTL_MS) / 1000),
    });
    if (inspect.hit && inspect.value) {
      const cached = inspect.value;
      logRefaccionMarketEvent(REFACCION_MARKET_EVENTS.CACHE_REUSED, {
        cacheHit: true,
        lookupPath: 'MARKET_CACHE_REUSED',
        cacheKey: inspect.key,
        marketIdentityKey: inspect.identityKey,
        marketStrategyVersion: inspect.strategyVersion,
        pieceCode,
        cachedPricingStatus: inspect.pricingStatus,
        pricingStatus: cached.pricingStatus,
        cacheCreatedAt: inspect.createdAt,
        cacheExpiresAt: inspect.expiresAt,
        cacheAgeMs: inspect.ageMs,
        ttlMs: inspect.ttlMs,
        queries: cached.audit?.queries ?? plan.queries,
        providersUsed: cached.audit?.providersUsed ?? cached.providersUsed,
        auditMissing: !cached.audit,
        searchRunId: ids.searchRunId,
      });
      if (cached.audit) {
        emitMarketAudit(logRefaccionMarketEvent, {
          ...cached.audit,
          lookupPath: 'MARKET_CACHE_REUSED',
          marketStrategyVersion:
            cached.audit.marketStrategyVersion ?? MARKET_STRATEGY_VERSION,
          cacheHit: true,
          searchRunId: ids.searchRunId,
        });
      }
      emitCachedSearchFinished({
        ids,
        estimate: cached,
        policy: this.policy,
        totalDurationMs: Date.now() - startedAt,
      });
      return cached;
    }
    const executedQueries = [
      ...plan.googleQueries,
      ...plan.mlQueries,
    ].filter((q, i, all) => q && all.indexOf(q) === i);
    logRefaccionMarketEvent(REFACCION_MARKET_EVENTS.LOOKUP_EXECUTED, {
      cacheHit: false,
      lookupPath: 'MARKET_LOOKUP_EXECUTED',
      cacheKey: inspect.key,
      marketIdentityKey: inspect.identityKey,
      marketStrategyVersion: MARKET_STRATEGY_VERSION,
      pieceCode,
      queries: plan.queries,
      executedQueries,
      googleQueries: plan.googleQueries,
      mlQueries: plan.mlQueries,
      confirmed: identity.confirmed,
      searchRunId: ids.searchRunId,
    });
    const observationBase = {
      ids,
      source: 'PROVIDER' as const,
      cacheHit: false,
      cacheKey: inspect.key,
      totalDurationMs: 0,
      providerDurationMs: 0,
    };
    if (!identity.confirmed) {
      const empty = runRefaccionMarketPipeline({
        identity,
        rawHits: [],
        providersUsed: [],
        queries: plan.queries,
        policy: this.policy,
        damageItemId: traceInput?.damageItemId,
        observation: {
          ...observationBase,
          totalDurationMs: Date.now() - startedAt,
        },
      });
      this.cache.set(identity, empty);
      return empty;
    }
    const providerStarted = Date.now();
    const coverage = await runWithMarketSearchIds(ids, () =>
      this.lookupCoverage(identity),
    );
    const providerDurationMs = Date.now() - providerStarted;
    const estimate = runRefaccionMarketPipeline({
      identity,
      rawHits: coverage.rawHits,
      providersUsed: coverage.providersUsed,
      queries: [
        ...plan.queries,
        ...(coverage.shopping?.discoveryQueries ?? []),
        ...(coverage.shopping?.pivotQueries ?? []),
      ].filter((q, i, all) => q && all.indexOf(q) === i),
      policy: this.policy,
      damageItemId: traceInput?.damageItemId,
      providerContribution: coverage.providerContribution,
      shoppingMetrics: coverage.shopping?.metrics,
      resolvedPart: coverage.shopping?.resolvedPart,
      observation: {
        ...observationBase,
        totalDurationMs: Date.now() - startedAt,
        providerDurationMs,
      },
    });
    if (estimate.audit) {
      estimate.audit.executedQueries = [
        ...executedQueries,
        ...(coverage.shopping?.discoveryQueries ?? []),
        ...(coverage.shopping?.pivotQueries ?? []),
      ].filter((q, i, all) => q && all.indexOf(q) === i);
    }
    this.cache.set(identity, estimate);
    return estimate;
  }

  private async lookupCoverage(
    identity: VehiclePartIdentity,
  ): Promise<CoverageWithShopping> {
    if (!this.shoppingFirst) {
      return runCoverageLookup({
        identity,
        providers: this.providers,
        policy: this.policy,
      });
    }
    const shop = await runShoppingFirstDiscovery({
      identity,
      policy: this.policy,
      shopping: this.shopping,
    });
    const shopSamples = hitsToCompatibleSamples(shop.rawHits, identity);
    if (hasSufficientIndependentSamples(shopSamples, this.policy)) {
      return {
        rawHits: shop.rawHits,
        providersUsed: shop.providersUsed,
        providerContribution: {
          SERPER_SHOPPING: {
            raw: shop.rawHits.length,
            unique: shop.metrics.crossQueryUnique,
          },
        },
        uniqueSamplesAfterCrossProviderDedupe: shop.metrics.crossQueryUnique,
        stagesRun: shop.rawHits.length ? ['SERPER_SHOPPING'] : [],
        stagesSkipped: [],
        shopping: shop,
      };
    }
    const rest = await runCoverageLookup({
      identity,
      providers: this.providers,
      policy: this.policy,
      seedHits: shop.rawHits,
    });
    return {
      ...rest,
      providersUsed: [...new Set([...shop.providersUsed, ...rest.providersUsed])],
      providerContribution: {
        SERPER_SHOPPING: {
          raw: shop.rawHits.length,
          unique: shop.metrics.crossQueryUnique,
        },
        ...rest.providerContribution,
      },
      shopping: shop,
    };
  }
}

export function createRefaccionMarketService(
  opts?: RefaccionMarketServiceOpts,
): RefaccionMarketService {
  return new RefaccionMarketService().applyOpts(opts);
}
