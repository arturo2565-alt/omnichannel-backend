import type { MarketProviderId, PartType } from './refaccion-market.types';

export const MARKET_REJECTION_REASONS = [
  'ACCESSORY',
  'PIEZA_MISMATCH',
  'SIDE_MISSING',
  'SIDE_MISMATCH',
  'MODEL_MISMATCH',
  'YEAR_MISMATCH',
  'INVALID_PRICE',
  'PRICE_PARSE_FAILED',
  'DUPLICATE',
] as const;

export type MarketRejectionReason =
  (typeof MARKET_REJECTION_REASONS)[number];

/**
 * Metadata interna de un lookup de mercado.
 * Vive en inventory / quotePayload. No se narra al cliente.
 */
export const MARKET_LOOKUP_PATHS = [
  'MARKET_LOOKUP_EXECUTED',
  'MARKET_CACHE_REUSED',
] as const;
export type MarketLookupPath = (typeof MARKET_LOOKUP_PATHS)[number];

export const MARKET_INSUFFICIENT_CAUSES = [
  'FILTER_FAILURE',
  'PRICE_PARSE_FAILURE',
  'PART_TYPE_SAMPLE_SHORTAGE',
  'PROVIDER_EMPTY',
] as const;
export type MarketInsufficientCause =
  (typeof MARKET_INSUFFICIENT_CAUSES)[number];

export type RefaccionMarketAudit = {
  damageItemId?: string;
  pieceCode: string;
  family: string;
  marketIdentityKey: string;
  marketStrategyVersion?: string;
  queries: string[];
  executedQueries?: string[];
  providersUsed: MarketProviderId[];
  rawResultCount: number;
  compatibleSampleCount: number;
  acceptedSampleCount: number;
  rejectedResultCount: number;
  rejectedByReason: Partial<Record<MarketRejectionReason, number>>;
  selectedPartType: PartType | null;
  acceptedDomains: string[];
  sampleCount: number;
  pricingStatus: 'OK' | 'INSUFFICIENT_MARKET_SAMPLE' | 'AWAITING_VEHICLE_DATA';
  lookupPath?: MarketLookupPath;
  insufficientCause?: MarketInsufficientCause;
  searchRunId?: string;
  cacheHit?: boolean;
  cacheKey?: string;
  queryCount?: number;
  providerCounts?: Partial<Record<MarketProviderId, number>>;
  funnel?: import('./market-search-trace').MarketSearchFunnel;
  bestAvailablePartType?: PartType | null;
  bestAvailableSampleCount?: number;
  samplesMissingToThreshold?: number;
  providerContribution?: import('./provider-coverage').ProviderContribution;
  uniqueSamplesAfterCrossProviderDedupe?: number;
  independenceCounts?: {
    UNIQUE: number;
    DUPLICATE: number;
    AMBIGUOUS: number;
  };
  shoppingRecall?: number;
  shoppingUniqueListings?: number;
  partNumbersDiscovered?: number;
  pivotUniqueListings?: number;
  marketUniqueMerchants?: number;
  uniqueSamplesPerVariant?: Record<string, number>;
  selectedVariantKey?: string | null;
  variantUncertainty?: boolean;
  shoppingFunnel?: {
    shoppingRaw: number;
    shoppingUnique: number;
    partNumbersDiscovered: number;
    pivotRaw: number;
    crossQueryUnique: number;
    compatible: number;
    byVariant?: Record<string, number>;
    byPartType?: Partial<Record<PartType, number>>;
    finalSamples?: number;
  };
  resolvedMarketPart?: {
    oemPartNumbers: string[];
    aftermarketPartNumbers: string[];
    commercialAliases: string[];
    side: string | null;
  };
};

export function resolveInsufficientCause(
  audit: Pick<
    RefaccionMarketAudit,
    | 'pricingStatus'
    | 'rawResultCount'
    | 'acceptedSampleCount'
    | 'sampleCount'
    | 'rejectedByReason'
  >,
  minValidSamples = 4,
): MarketInsufficientCause | undefined {
  if (audit.pricingStatus !== 'INSUFFICIENT_MARKET_SAMPLE') return undefined;
  if (
    audit.acceptedSampleCount >= minValidSamples &&
    audit.sampleCount < minValidSamples
  ) {
    return 'PART_TYPE_SAMPLE_SHORTAGE';
  }
  const parseFails = audit.rejectedByReason.PRICE_PARSE_FAILED ?? 0;
  if (audit.acceptedSampleCount === 0 && parseFails > 0) {
    return 'PRICE_PARSE_FAILURE';
  }
  if (audit.rawResultCount === 0) return 'PROVIDER_EMPTY';
  return 'FILTER_FAILURE';
}

export type MarketRecallMetrics = {
  family: string;
  marketRawRecall: number;
  compatibleSampleCount: number;
  acceptedSampleCount: number;
  rejectionRateByReason: Partial<Record<MarketRejectionReason, number>>;
  priceParseFailureRate: number;
  insufficientMarketRate: number;
  lookups: number;
};

export function emptyRejectedByReason(): Partial<
  Record<MarketRejectionReason, number>
> {
  return {};
}

export function bumpRejection(
  bag: Partial<Record<MarketRejectionReason, number>>,
  reason: MarketRejectionReason,
): void {
  bag[reason] = (bag[reason] ?? 0) + 1;
}

export function computeMarketRecallMetrics(
  audits: readonly RefaccionMarketAudit[],
): MarketRecallMetrics[] {
  const byFamily = new Map<string, RefaccionMarketAudit[]>();
  for (const a of audits) {
    const key = a.family || 'GENERIC';
    const list = byFamily.get(key) ?? [];
    list.push(a);
    byFamily.set(key, list);
  }
  return [...byFamily.entries()].map(([family, list]) => {
    const raw = list.reduce((s, a) => s + a.rawResultCount, 0);
    const accepted = list.reduce((s, a) => s + a.acceptedSampleCount, 0);
    const compatible = list.reduce((s, a) => s + a.compatibleSampleCount, 0);
    const parseFails = list.reduce(
      (s, a) => s + (a.rejectedByReason.PRICE_PARSE_FAILED ?? 0),
      0,
    );
    const insufficient = list.filter(
      (a) => a.pricingStatus === 'INSUFFICIENT_MARKET_SAMPLE',
    ).length;
    const rejectedByReason: Partial<Record<MarketRejectionReason, number>> = {};
    let rejected = 0;
    for (const a of list) {
      for (const [reason, n] of Object.entries(a.rejectedByReason)) {
        const count = Number(n) || 0;
        rejected += count;
        rejectedByReason[reason as MarketRejectionReason] =
          (rejectedByReason[reason as MarketRejectionReason] ?? 0) + count;
      }
    }
    const rates: Partial<Record<MarketRejectionReason, number>> = {};
    for (const [reason, n] of Object.entries(rejectedByReason)) {
      rates[reason as MarketRejectionReason] = raw > 0 ? (n ?? 0) / raw : 0;
    }
    return {
      family,
      marketRawRecall: raw > 0 ? accepted / raw : 0,
      compatibleSampleCount: compatible,
      acceptedSampleCount: accepted,
      rejectionRateByReason: rates,
      priceParseFailureRate: raw > 0 ? parseFails / raw : 0,
      insufficientMarketRate: list.length ? insufficient / list.length : 0,
      lookups: list.length,
    };
  });
}

export function collectMarketAuditsFromInventory(
  inventory: readonly { marketAudit?: RefaccionMarketAudit }[],
): RefaccionMarketAudit[] {
  return inventory
    .map((it) => it.marketAudit)
    .filter((a): a is RefaccionMarketAudit => Boolean(a));
}
