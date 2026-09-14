import { parseVehiclePartIdentity } from './parse-vehicle-part-identity';
import {
  MARKET_STRATEGY_VERSION,
  marketCacheKey,
  marketIdentityKey,
} from './parse-vehicle-part-identity';
import { MARKET_CACHE_TTL_MS, RefaccionMarketCache } from './refaccion-market.cache';
import { createRefaccionMarketService } from './refaccion-market.orchestrator';
import { REFACCION_MARKET_EVENTS } from './refaccion-market-events';
import { insufficientEstimate } from './compute-market-range';
import type { RawProviderHit, RefaccionPriceProvider } from './refaccion-market.types';

const altimaRight = parseVehiclePartIdentity({
  vehiculoText: 'Nissan Altima 2014',
  pieza: 'Calavera_Derecha',
});

describe('market cache + strategy version', () => {
  it('identity key legacy vs cache key versionada', () => {
    expect(marketIdentityKey(altimaRight)).toBe(
      'nissan|altima|2014|calaveraderecha||',
    );
    expect(marketCacheKey(altimaRight)).toBe(
      `${MARKET_STRATEGY_VERSION}|nissan|altima|2014|calaveraderecha||`,
    );
    expect(MARKET_STRATEGY_VERSION).toBe('v4');
    expect(MARKET_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('INSUFFICIENT se cachea (negative cache) con TTL 24h', () => {
    const cache = new RefaccionMarketCache();
    const empty = insufficientEstimate(altimaRight, 'q');
    cache.set(altimaRight, empty);
    const inspect = cache.inspect(altimaRight);
    expect(inspect.hit).toBe(true);
    expect(inspect.pricingStatus).toBe('INSUFFICIENT_MARKET_SAMPLE');
    expect(inspect.ttlMs).toBe(MARKET_CACHE_TTL_MS);
    expect(inspect.ageMs).toBeGreaterThanOrEqual(0);
    expect(inspect.key).toBe(marketCacheKey(altimaRight));
  });

  it('v2 no reutiliza una entrada keyed solo con identity (pre-aliases)', () => {
    const cache = new RefaccionMarketCache();
    const empty = insufficientEstimate(altimaRight, 'q');
    (cache as unknown as { store: Map<string, unknown> }).store.set(
      marketIdentityKey(altimaRight),
      {
        value: empty,
        createdAt: Date.now(),
        expiresAt: Date.now() + MARKET_CACHE_TTL_MS,
      },
    );
    expect(cache.inspect(altimaRight).hit).toBe(false);
  });

  it('cache miss → LOOKUP_EXECUTED + providers; hit → CACHE_REUSED sin providers', async () => {
    let searches = 0;
    const provider: RefaccionPriceProvider = {
      id: 'GOOGLE_WEB',
      search: async () => {
        searches += 1;
        return [] as RawProviderHit[];
      },
    };
    const events: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      const match = line.match(/\[RefaccionMarket\] ({.*})/);
      if (!match?.[1]) return;
      try {
        const parsed = JSON.parse(match[1]) as { event?: string };
        if (parsed.event) events.push(parsed.event);
      } catch {
        /* ignore */
      }
    };
    const market = createRefaccionMarketService({ providers: [provider] });
    const first = await market.estimate(altimaRight);
    const second = await market.estimate(altimaRight);
    console.log = origLog;
    expect(searches).toBe(1);
    expect(first.pricingStatus).toBe('INSUFFICIENT_MARKET_SAMPLE');
    expect(second.pricingStatus).toBe('INSUFFICIENT_MARKET_SAMPLE');
    expect(events.filter((e) => e === 'MARKET_LOOKUP_EXECUTED')).toHaveLength(1);
    expect(events.filter((e) => e === 'MARKET_CACHE_REUSED')).toHaveLength(1);
    expect(events).toContain('REFACCION_MARKET_AUDIT');
    expect(first.audit?.lookupPath).toBe('MARKET_LOOKUP_EXECUTED');
    expect(first.audit?.queries).toEqual([
      'calavera trasera derecha Nissan Altima 2014',
      'calavera derecha Nissan Altima 2014',
      'stop derecho Nissan Altima 2014',
      'calavera derecha Nissan Altima 2013 2014 2015',
    ]);
  });
});
