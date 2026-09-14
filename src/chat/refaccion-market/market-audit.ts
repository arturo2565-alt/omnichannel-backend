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
export type RefaccionMarketAudit = {
  damageItemId?: string;
  pieceCode: string;
  family: string;
  marketIdentityKey: string;
  queries: string[];
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
};

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
