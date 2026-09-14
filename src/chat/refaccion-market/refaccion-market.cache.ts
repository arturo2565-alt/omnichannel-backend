import type { RefaccionMarketEstimate } from './refaccion-market.types';
import {
  MARKET_STRATEGY_VERSION,
  marketCacheKey,
  marketIdentityKey,
} from './parse-vehicle-part-identity';
import type { VehiclePartIdentity } from './refaccion-market.types';

/** TTL único (OK e INSUFFICIENT). 24h. */
export const MARKET_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type Entry = {
  value: RefaccionMarketEstimate;
  createdAt: number;
  expiresAt: number;
};

export type MarketCacheInspect = {
  hit: boolean;
  key: string;
  identityKey: string;
  strategyVersion: string;
  ttlMs: number;
  pricingStatus?: RefaccionMarketEstimate['pricingStatus'];
  createdAt?: string;
  expiresAt?: string;
  ageMs?: number;
  value?: RefaccionMarketEstimate;
};

export class RefaccionMarketCache {
  private readonly store = new Map<string, Entry>();

  constructor(private readonly ttlMs = MARKET_CACHE_TTL_MS) {}

  inspect(identity: VehiclePartIdentity): MarketCacheInspect {
    const key = marketCacheKey(identity);
    const identityKey = marketIdentityKey(identity);
    const base = {
      hit: false,
      key,
      identityKey,
      strategyVersion: MARKET_STRATEGY_VERSION,
      ttlMs: this.ttlMs,
    };
    const hit = this.store.get(key);
    if (!hit) return base;
    if (Date.now() >= hit.expiresAt) {
      this.store.delete(key);
      return base;
    }
    return {
      ...base,
      hit: true,
      pricingStatus: hit.value.pricingStatus,
      createdAt: new Date(hit.createdAt).toISOString(),
      expiresAt: new Date(hit.expiresAt).toISOString(),
      ageMs: Date.now() - hit.createdAt,
      value: hit.value,
    };
  }

  get(identity: VehiclePartIdentity): RefaccionMarketEstimate | null {
    return this.inspect(identity).value ?? null;
  }

  set(identity: VehiclePartIdentity, value: RefaccionMarketEstimate): void {
    const now = Date.now();
    this.store.set(marketCacheKey(identity), {
      value,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    });
  }

  clear(): void {
    this.store.clear();
  }
}
