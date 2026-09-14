import { classifyRawHit } from './normalize-market-sample';
import {
  emitMarketTrace,
  getMarketSearchIds,
  MARKET_TRACE_EVENTS,
} from './market-search-trace';
import { extractPartNumbers, type DiscoveredPartNumber } from './part-number';
import { buildPartNumberPivotQueries } from './part-number';
import {
  buildShoppingDiscoveryQueries,
  resolveMarketPartIdentity,
  type ResolvedMarketPartIdentity,
} from './resolved-market-part';
import { SerperShoppingProvider } from './serper-shopping.provider';
import {
  hasSufficientIndependentSamples,
  uniqueIndependentSamples,
} from './sample-independence';
import { clusterSamplesByVariant } from './variant-cluster';
import type {
  MarketProviderId,
  MarketSample,
  RawProviderHit,
  RefaccionMarketPolicy,
  VehiclePartIdentity,
} from './refaccion-market.types';
import { DEFAULT_REFACCION_MARKET_POLICY } from './refaccion-market.types';

export type ShoppingSearcher = {
  isConfigured?: () => boolean;
  searchQueries: (queries: readonly string[]) => Promise<RawProviderHit[]>;
};

export type ShoppingRetrievalMetrics = {
  shoppingRaw: number;
  shoppingUnique: number;
  partNumbersDiscovered: number;
  pivotRaw: number;
  pivotUniqueListings: number;
  crossQueryUnique: number;
  compatible: number;
  shoppingRecall: number;
  shoppingUniqueListings: number;
  marketUniqueMerchants: number;
};

export type ShoppingFirstResult = {
  rawHits: RawProviderHit[];
  resolvedPart: ResolvedMarketPartIdentity;
  metrics: ShoppingRetrievalMetrics;
  providersUsed: MarketProviderId[];
  discoveryQueries: string[];
  pivotQueries: string[];
};

function compatibleSamples(
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

function metricsFrom(
  shoppingHits: readonly RawProviderHit[],
  pivotHits: readonly RawProviderHit[],
  identity: VehiclePartIdentity,
  discovered: readonly DiscoveredPartNumber[],
): ShoppingRetrievalMetrics {
  const shoppingSamples = compatibleSamples(shoppingHits, identity);
  const shoppingUnique = uniqueIndependentSamples(shoppingSamples);
  const all = compatibleSamples([...shoppingHits, ...pivotHits], identity);
  const allUnique = uniqueIndependentSamples(all);
  const merchants = new Set(
    allUnique.map((s) => s.merchant || s.seller).filter(Boolean),
  );
  return {
    shoppingRaw: shoppingHits.length,
    shoppingUnique: shoppingUnique.length,
    partNumbersDiscovered: discovered.length,
    pivotRaw: pivotHits.length,
    pivotUniqueListings: Math.max(0, allUnique.length - shoppingUnique.length),
    crossQueryUnique: allUnique.length,
    compatible: all.length,
    shoppingRecall:
      shoppingHits.length > 0 ? shoppingUnique.length / shoppingHits.length : 0,
    shoppingUniqueListings: shoppingUnique.length,
    marketUniqueMerchants: merchants.size,
  };
}

export async function runShoppingFirstDiscovery(input: {
  identity: VehiclePartIdentity;
  policy?: RefaccionMarketPolicy;
  shopping?: ShoppingSearcher;
}): Promise<ShoppingFirstResult> {
  const policy = input.policy ?? DEFAULT_REFACCION_MARKET_POLICY;
  const shopping = input.shopping ?? new SerperShoppingProvider();
  const ids = getMarketSearchIds();
  const discoveryQueries = buildShoppingDiscoveryQueries(input.identity);
  let resolved = resolveMarketPartIdentity(input.identity);

  if (ids) {
    emitMarketTrace(MARKET_TRACE_EVENTS.PART_DISCOVERY_STARTED, ids, {
      discoveryQueries,
      family: resolved.family,
      side: resolved.side,
    });
    emitMarketTrace(MARKET_TRACE_EVENTS.SHOPPING_LOOKUP_STARTED, ids, {
      queries: discoveryQueries,
    });
  }

  const shoppingHits = shopping.isConfigured?.()
    ? await shopping.searchQueries(discoveryQueries)
    : [];
  if (ids) {
    emitMarketTrace(MARKET_TRACE_EVENTS.SHOPPING_LOOKUP_RESULT, ids, {
      raw: shoppingHits.length,
      configured: Boolean(shopping.isConfigured?.()),
    });
  }

  const discovered: DiscoveredPartNumber[] = [];
  const seenPn = new Set<string>();
  for (const hit of shoppingHits) {
    const classified = classifyRawHit(hit, input.identity);
    if (!classified.ok && !classified.compatible) continue;
    for (const pn of extractPartNumbers(hit.title, hit.snippet)) {
      if (seenPn.has(pn.normalized)) continue;
      seenPn.add(pn.normalized);
      discovered.push(pn);
      if (ids) {
        emitMarketTrace(MARKET_TRACE_EVENTS.PART_NUMBER_DISCOVERED, ids, {
          partNumber: pn.normalized,
          kind: pn.kind,
          raw: pn.raw,
        });
      }
    }
  }
  resolved = resolveMarketPartIdentity(input.identity, discovered);

  let pivotHits: RawProviderHit[] = [];
  const pivotQueries: string[] = [];
  const afterShopping = [...shoppingHits];
  if (
    shopping.isConfigured?.() &&
    discovered.length &&
    !hasSufficientIndependentSamples(
      compatibleSamples(afterShopping, input.identity),
      policy,
    )
  ) {
    const pivotParts = discovered.slice(0, 3);
    for (const pn of pivotParts) {
      pivotQueries.push(
        ...buildPartNumberPivotQueries(pn.normalized, input.identity).slice(0, 2),
      );
    }
    const uniquePivot = [...new Set(pivotQueries)].slice(0, 6);
    if (ids) {
      emitMarketTrace(MARKET_TRACE_EVENTS.PART_NUMBER_PIVOT_STARTED, ids, {
        partNumbers: pivotParts.map((p) => p.normalized),
        queries: uniquePivot,
      });
    }
    pivotHits = await shopping.searchQueries(uniquePivot);
    if (ids) {
      emitMarketTrace(MARKET_TRACE_EVENTS.PART_NUMBER_PIVOT_RESULT, ids, {
        raw: pivotHits.length,
      });
    }
  }

  const rawHits = [...shoppingHits, ...pivotHits];
  const unique = uniqueIndependentSamples(
    compatibleSamples(rawHits, input.identity),
  );
  if (ids) {
    emitMarketTrace(MARKET_TRACE_EVENTS.CROSS_QUERY_DEDUPE, ids, {
      raw: rawHits.length,
      unique: unique.length,
    });
    for (const cluster of clusterSamplesByVariant(unique)) {
      emitMarketTrace(MARKET_TRACE_EVENTS.VARIANT_CLUSTER_CREATED, ids, {
        variantKey: cluster.variantKey,
        count: cluster.members.length,
        lampType: cluster.lampType,
        side: cluster.side,
      });
    }
  }

  const m = metricsFrom(shoppingHits, pivotHits, input.identity, discovered);
  return {
    rawHits,
    resolvedPart: resolved,
    metrics: m,
    providersUsed: shoppingHits.length || pivotHits.length ? ['SERPER_SHOPPING'] : [],
    discoveryQueries,
    pivotQueries,
  };
}
