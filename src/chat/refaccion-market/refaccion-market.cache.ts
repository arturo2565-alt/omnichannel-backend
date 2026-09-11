import type { RefaccionMarketEstimate } from './refaccion-market.types';
import { marketCacheKey } from './parse-vehicle-part-identity';
import type { VehiclePartIdentity } from './refaccion-market.types';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

type Entry = { value: RefaccionMarketEstimate; expiresAt: number };

export class RefaccionMarketCache {
  private readonly store = new Map<string, Entry>();

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  get(identity: VehiclePartIdentity): RefaccionMarketEstimate | null {
    const key = marketCacheKey(identity);
    const hit = this.store.get(key);
    if (!hit) return null;
    if (Date.now() >= hit.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return hit.value;
  }

  set(identity: VehiclePartIdentity, value: RefaccionMarketEstimate): void {
    this.store.set(marketCacheKey(identity), {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  clear(): void {
    this.store.clear();
  }
}
