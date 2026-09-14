/**
 * Independencia comercial. No colapsa solo por title.
 * Dos merchants del mismo DEPO pueden ser dos precios de mercado.
 */
import { canonicalizeUrl, domainFromUrl } from './normalize-market-sample';
import { pickPartTypeGroup } from './compute-market-range';
import { clusterSamplesByVariant, clusterHasPricingSamples } from './variant-cluster';
import type {
  MarketSample,
  RefaccionMarketPolicy,
} from './refaccion-market.types';
import { DEFAULT_REFACCION_MARKET_POLICY } from './refaccion-market.types';

export const SAMPLE_INDEPENDENCE_STATUSES = [
  'UNIQUE',
  'DUPLICATE',
  'AMBIGUOUS',
] as const;
export type SampleIndependenceStatus =
  (typeof SAMPLE_INDEPENDENCE_STATUSES)[number];

export type IndependentSample = MarketSample & {
  independenceStatus: SampleIndependenceStatus;
  identityKey: string;
};

function normTitle(title: string): string {
  return String(title ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractListingId(
  url?: string,
  externalId?: string,
): string | undefined {
  const ext = String(externalId ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (ext.length >= 6) return ext;
  const raw = String(url ?? '');
  const m = /(?:\/|-)(MLM-?\d{3,})/i.exec(raw);
  if (m?.[1]) return m[1].toUpperCase().replace(/-/g, '');
  return undefined;
}

function merchantOf(sample: MarketSample): string {
  return String(sample.merchant ?? sample.seller ?? '')
    .trim()
    .toLowerCase();
}

function identityKeys(sample: MarketSample): string[] {
  const keys: string[] = [];
  const listingId = extractListingId(sample.url, sample.externalId);
  if (listingId) keys.push(`listing:${listingId}`);
  const merchant = merchantOf(sample);
  const productId = String(sample.productId ?? '').trim();
  if (productId && merchant) keys.push(`shop:${productId}|${merchant}`);
  const url = canonicalizeUrl(sample.url);
  if (url) keys.push(`url:${url}`);
  const pn = String(sample.partNumber ?? '').trim().toUpperCase();
  if (merchant && pn) keys.push(`pn:${merchant}|${pn}`);
  const title = normTitle(sample.title);
  if (merchant && title && sample.price > 0) {
    keys.push(`offer:${merchant}|${title}|${sample.price}`);
  }
  return keys;
}

export function assignSampleIndependence(
  samples: readonly MarketSample[],
): IndependentSample[] {
  const seen = new Set<string>();
  return samples.map((sample, index) => {
    const keys = identityKeys(sample);
    const dup = keys.find((key) => seen.has(key));
    if (dup) {
      return { ...sample, independenceStatus: 'DUPLICATE' as const, identityKey: dup };
    }
    if (keys.length) {
      for (const key of keys) seen.add(key);
      return { ...sample, independenceStatus: 'UNIQUE' as const, identityKey: keys[0]! };
    }
    return {
      ...sample,
      independenceStatus: 'AMBIGUOUS' as const,
      identityKey: `amb:${index}`,
    };
  });
}

export function uniqueIndependentSamples(
  samples: readonly MarketSample[],
): IndependentSample[] {
  return assignSampleIndependence(samples).filter(
    (s) => s.independenceStatus === 'UNIQUE',
  );
}

export function independenceCounts(samples: readonly IndependentSample[]): {
  UNIQUE: number;
  DUPLICATE: number;
  AMBIGUOUS: number;
} {
  const bag = { UNIQUE: 0, DUPLICATE: 0, AMBIGUOUS: 0 };
  for (const s of samples) bag[s.independenceStatus] += 1;
  return bag;
}

export function hasSufficientIndependentSamples(
  samples: readonly MarketSample[],
  policy: RefaccionMarketPolicy = DEFAULT_REFACCION_MARKET_POLICY,
): boolean {
  const unique = uniqueIndependentSamples(samples);
  const clusters = clusterSamplesByVariant(unique);
  if (clusters.some((c) => clusterHasPricingSamples(c, policy))) return true;
  const picked = pickPartTypeGroup(unique, policy);
  return Boolean(
    picked.group &&
      picked.members.length >= policy.minValidSamples &&
      clusters.length <= 1,
  );
}

export function domainOfSampleUrl(url?: string): string {
  return domainFromUrl(url);
}
