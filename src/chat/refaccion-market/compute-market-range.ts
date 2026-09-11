import type {
  EstimateConfidence,
  MarketProviderId,
  MarketSample,
  PartType,
  PriceRange,
  RefaccionMarketEstimate,
  RefaccionMarketPolicy,
  VehiclePartIdentity,
} from './refaccion-market.types';
import { DEFAULT_REFACCION_MARKET_POLICY } from './refaccion-market.types';

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2
    ? s[mid]!
    : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo));
}

/** Quita outliers por IQR; si quedan < 3, usa la serie original. */
export function removePriceOutliers(prices: readonly number[]): number[] {
  const s = [...prices].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (s.length < 4) return s;
  const q1 = percentile(s, 0.25);
  const q3 = percentile(s, 0.75);
  const iqr = Math.max(0, q3 - q1);
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const kept = s.filter((n) => n >= lo && n <= hi);
  return kept.length >= 3 ? kept : s;
}

export function representativeRange(prices: readonly number[]): PriceRange | null {
  const cleaned = removePriceOutliers(prices);
  if (!cleaned.length) return null;
  const sorted = [...cleaned].sort((a, b) => a - b);
  const min = percentile(sorted, 0.2);
  const max = percentile(sorted, 0.8);
  const central = median(sorted);
  return {
    precioMinEstimado: Math.min(min, central),
    precioMaxEstimado: Math.max(max, central),
    precioCentral: central,
  };
}

export function applyCustomerMargin(
  market: PriceRange,
  policy: RefaccionMarketPolicy = DEFAULT_REFACCION_MARKET_POLICY,
): PriceRange {
  const round = (n: number) => {
    const raw = Math.max(0, n * policy.marginFactor);
    if (policy.roundToMx <= 0) return Math.round(raw);
    if (raw < 100) return Math.round(raw);
    return Math.round(raw / policy.roundToMx) * policy.roundToMx;
  };
  return {
    precioMinEstimado: round(market.precioMinEstimado),
    precioMaxEstimado: round(market.precioMaxEstimado),
    precioCentral: round(market.precioCentral),
  };
}

export function pickPartTypeGroup(
  samples: readonly MarketSample[],
  policy: RefaccionMarketPolicy = DEFAULT_REFACCION_MARKET_POLICY,
): { group: PartType | null; members: MarketSample[] } {
  const byType = new Map<PartType, MarketSample[]>();
  for (const s of samples) {
    const list = byType.get(s.partType) ?? [];
    list.push(s);
    byType.set(s.partType, list);
  }
  for (const type of policy.preferredPartTypes) {
    const members = byType.get(type) ?? [];
    if (members.length >= policy.minValidSamples) {
      return { group: type, members };
    }
  }
  return { group: null, members: [] };
}

export function estimateConfidence(
  cantidadMuestras: number,
  cantidadDominios: number,
): EstimateConfidence {
  if (cantidadMuestras >= 8 && cantidadDominios >= 3) return 'HIGH';
  if (cantidadMuestras >= 4 && cantidadDominios >= 2) return 'MEDIUM';
  if (cantidadMuestras >= 4) return 'LOW';
  return 'LOW';
}

export function insufficientEstimate(
  identity: VehiclePartIdentity,
  query: string,
  extras?: {
    cantidadMuestras?: number;
    cantidadDominios?: number;
    providersUsed?: MarketProviderId[];
    samples?: MarketSample[];
  },
): RefaccionMarketEstimate {
  return {
    pricingType: 'NONE',
    pricingStatus: 'INSUFFICIENT_MARKET_SAMPLE',
    cantidadMuestras: extras?.cantidadMuestras ?? 0,
    cantidadDominios: extras?.cantidadDominios ?? 0,
    providersUsed: extras?.providersUsed ?? [],
    priceSource: 'INSUFFICIENT_MARKET_SAMPLE',
    confidence: 'LOW',
    partTypeGroup: null,
    samples: extras?.samples ?? [],
    identity,
    query,
  };
}

export function buildMarketEstimate(input: {
  identity: VehiclePartIdentity;
  query: string;
  samples: MarketSample[];
  providersUsed: MarketProviderId[];
  policy?: RefaccionMarketPolicy;
}): RefaccionMarketEstimate {
  const policy = input.policy ?? DEFAULT_REFACCION_MARKET_POLICY;
  const { group, members } = pickPartTypeGroup(input.samples, policy);
  const domains = new Set(members.map((s) => s.domain).filter((d) => d && d !== 'unknown'));
  if (!group || members.length < policy.minValidSamples) {
    return insufficientEstimate(input.identity, input.query, {
      cantidadMuestras: members.length,
      cantidadDominios: domains.size,
      providersUsed: input.providersUsed,
      samples: input.samples,
    });
  }
  const market = representativeRange(members.map((s) => s.price));
  if (!market) {
    return insufficientEstimate(input.identity, input.query, {
      cantidadMuestras: members.length,
      cantidadDominios: domains.size,
      providersUsed: input.providersUsed,
      samples: input.samples,
    });
  }
  return {
    pricingType: 'RANGE',
    pricingStatus: 'OK',
    marketPriceRange: market,
    customerPriceRange: applyCustomerMargin(market, policy),
    cantidadMuestras: members.length,
    cantidadDominios: domains.size,
    providersUsed: input.providersUsed,
    priceSource: 'WEB_MARKET_ESTIMATE',
    confidence: estimateConfidence(members.length, domains.size),
    partTypeGroup: group,
    samples: members,
    identity: input.identity,
    query: input.query,
  };
}
