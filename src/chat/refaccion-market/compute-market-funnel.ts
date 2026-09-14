import type {
  MarketProviderId,
  MarketSample,
  PartType,
  RawProviderHit,
  VehiclePartIdentity,
} from './refaccion-market.types';
import { canonicalizeUrl, domainFromUrl } from './normalize-market-sample';
import { evaluateMarketSample } from './evaluate-market-sample';
import {
  emptyPartTypeCounts,
  type MarketSearchFunnel,
  type MarketTraceRejectionReason,
  type PartTypeSelectionTrace,
} from './market-search-trace';
import type { RefaccionMarketPolicy } from './refaccion-market.types';
import { pickPartTypeGroup } from './compute-market-range';

function normTitle(title: string): string {
  return String(title ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Misma semántica que el pipeline (URL / externalId / título), solo observación. */
function uniqueRawHits(hits: readonly RawProviderHit[]): RawProviderHit[] {
  const seenUrl = new Set<string>();
  const seenExt = new Set<string>();
  const seenTitle = new Set<string>();
  const out: RawProviderHit[] = [];
  for (const hit of hits) {
    const url = canonicalizeUrl(hit.url);
    const ext = String(hit.externalId ?? '').trim().toUpperCase();
    const titleKey = `${domainFromUrl(hit.url)}|${normTitle(hit.title)}`;
    if (
      (url && seenUrl.has(url)) ||
      (ext && seenExt.has(ext)) ||
      (titleKey !== 'unknown|' && seenTitle.has(titleKey))
    ) {
      continue;
    }
    if (url) seenUrl.add(url);
    if (ext) seenExt.add(ext);
    if (titleKey !== 'unknown|') seenTitle.add(titleKey);
    out.push(hit);
  }
  return out;
}

export function computeMarketSearchFunnel(
  rawHits: readonly RawProviderHit[],
  identity: VehiclePartIdentity,
  uniqueAccepted: readonly MarketSample[],
): MarketSearchFunnel {
  const providerRawResults: Partial<Record<MarketProviderId, number>> = {};
  for (const hit of rawHits) {
    providerRawResults[hit.provider] = (providerRawResults[hit.provider] ?? 0) + 1;
  }
  const deduped = uniqueRawHits(rawHits);
  let pieceCompatible = 0;
  let sideCompatible = 0;
  let vehicleCompatible = 0;
  let yearCompatible = 0;
  let validPrice = 0;
  const obsRejected: MarketSearchFunnel['rejectedByReason'] = {};
  const bump = (reason: MarketTraceRejectionReason) => {
    obsRejected[reason] = (obsRejected[reason] ?? 0) + 1;
  };
  for (let i = 0; i < rawHits.length - deduped.length; i += 1) {
    bump('DUPLICATE');
  }
  for (const hit of deduped) {
    const ev = evaluateMarketSample(hit, identity);
    if (!ev.pieceMatch) {
      bump(ev.rejectionReason ?? 'PIEZA_MISMATCH');
      continue;
    }
    pieceCompatible += 1;
    if (ev.expectedSide && ev.sideMatch !== true) {
      bump(ev.rejectionReason ?? 'SIDE_MISSING');
      continue;
    }
    sideCompatible += 1;
    if (!ev.makeMatch || !ev.modelMatch) {
      bump(ev.rejectionReason ?? 'MODEL_MISMATCH');
      continue;
    }
    vehicleCompatible += 1;
    if (!ev.yearMatch) {
      bump(ev.rejectionReason ?? 'YEAR_MISMATCH');
      continue;
    }
    yearCompatible += 1;
    if (!ev.priceValid) {
      bump(ev.rejectionReason ?? 'INVALID_PRICE');
      continue;
    }
    validPrice += 1;
  }
  const acceptedByPartType: Partial<Record<PartType, number>> = {};
  for (const s of uniqueAccepted) {
    acceptedByPartType[s.partType] = (acceptedByPartType[s.partType] ?? 0) + 1;
  }
  return {
    providerRawResults,
    rawResultCount: rawHits.length,
    afterDedupe: deduped.length,
    pieceCompatible,
    sideCompatible,
    vehicleCompatible,
    yearCompatible,
    validPrice,
    acceptedByPartType,
    rejectedByReason: obsRejected,
  };
}

export function observePartTypeSelection(
  uniqueAccepted: readonly MarketSample[],
  policy: RefaccionMarketPolicy,
): PartTypeSelectionTrace {
  const counts = emptyPartTypeCounts();
  for (const s of uniqueAccepted) {
    counts[s.partType] += 1;
  }
  const picked = pickPartTypeGroup(uniqueAccepted, policy);
  let bestAvailablePartType: PartType | null = null;
  let bestAvailableSampleCount = 0;
  for (const type of policy.preferredPartTypes) {
    const n = counts[type];
    if (n > bestAvailableSampleCount) {
      bestAvailablePartType = type;
      bestAvailableSampleCount = n;
    }
  }
  const selectedSampleCount = picked.members.length;
  const samplesMissingToThreshold = picked.group
    ? 0
    : Math.max(0, policy.minValidSamples - bestAvailableSampleCount);
  return {
    preferredOrder: policy.preferredPartTypes,
    counts,
    minValidSamples: policy.minValidSamples,
    selectedPartType: picked.group,
    selectedSampleCount,
    bestAvailablePartType,
    bestAvailableSampleCount,
    samplesMissingToThreshold,
  };
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

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** Observa la misma IQR que pricing; no escribe el estimate. */
export function observePriceStats(prices: readonly number[]): {
  rawPrices: number[];
  filteredPrices: number[];
  p20: number;
  median: number;
  p80: number;
  iqr: number;
} {
  const rawPrices = prices.filter((n) => Number.isFinite(n) && n > 0);
  const s = [...rawPrices].sort((a, b) => a - b);
  if (s.length < 4) {
    return {
      rawPrices,
      filteredPrices: s,
      p20: percentile(s, 0.2),
      median: median(s),
      p80: percentile(s, 0.8),
      iqr: 0,
    };
  }
  const q1 = percentile(s, 0.25);
  const q3 = percentile(s, 0.75);
  const iqr = Math.max(0, q3 - q1);
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const kept = s.filter((n) => n >= lo && n <= hi);
  const filteredPrices = kept.length >= 3 ? kept : s;
  return {
    rawPrices,
    filteredPrices,
    p20: percentile(filteredPrices, 0.2),
    median: median(filteredPrices),
    p80: percentile(filteredPrices, 0.8),
    iqr,
  };
}
