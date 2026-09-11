import { Injectable } from '@nestjs/common';
import { buildMarketEstimate, insufficientEstimate } from './compute-market-range';
import { dedupeMarketSamples } from './dedupe-market-samples';
import { GoogleWebSearchProvider } from './google-web-search.provider';
import { MercadoLibreProvider } from './mercado-libre.provider';
import { normalizeRawHit } from './normalize-market-sample';
import { RefaccionMarketCache } from './refaccion-market.cache';
import type {
  MarketProviderId,
  RawProviderHit,
  RefaccionMarketEstimate,
  RefaccionMarketPolicy,
  RefaccionPriceProvider,
  VehiclePartIdentity,
} from './refaccion-market.types';
import { DEFAULT_REFACCION_MARKET_POLICY } from './refaccion-market.types';

export function runRefaccionMarketPipeline(input: {
  identity: VehiclePartIdentity;
  rawHits: RawProviderHit[];
  providersUsed: MarketProviderId[];
  policy?: RefaccionMarketPolicy;
}): RefaccionMarketEstimate {
  const query = input.rawHits[0]?.query ?? input.identity.piezaLabel;
  if (!input.identity.confirmed) {
    return insufficientEstimate(input.identity, query, {
      providersUsed: input.providersUsed,
    });
  }
  const normalized = input.rawHits
    .map((h) => normalizeRawHit(h, input.identity))
    .filter((s): s is NonNullable<typeof s> => s != null);
  const unique = dedupeMarketSamples(normalized);
  return buildMarketEstimate({
    identity: input.identity,
    query,
    samples: unique,
    providersUsed: input.providersUsed,
    policy: input.policy,
  });
}

@Injectable()
export class RefaccionMarketService {
  private readonly cache: RefaccionMarketCache;
  private readonly providers: RefaccionPriceProvider[];
  private readonly policy: RefaccionMarketPolicy;

  constructor(opts?: {
    cache?: RefaccionMarketCache;
    providers?: RefaccionPriceProvider[];
    policy?: RefaccionMarketPolicy;
  }) {
    this.cache = opts?.cache ?? new RefaccionMarketCache();
    this.providers = opts?.providers ?? [
      new GoogleWebSearchProvider(),
      new MercadoLibreProvider(),
    ];
    this.policy = opts?.policy ?? DEFAULT_REFACCION_MARKET_POLICY;
  }

  async estimate(identity: VehiclePartIdentity): Promise<RefaccionMarketEstimate> {
    const cached = this.cache.get(identity);
    if (cached) return cached;
    if (!identity.confirmed) {
      const empty = insufficientEstimate(identity, identity.piezaLabel);
      this.cache.set(identity, empty);
      return empty;
    }
    const settled = await Promise.all(
      this.providers.map(async (p) => {
        try {
          return { id: p.id, hits: await p.search(identity) };
        } catch {
          return { id: p.id, hits: [] as RawProviderHit[] };
        }
      }),
    );
    const rawHits = settled.flatMap((s) => s.hits);
    const providersUsed = settled
      .filter((s) => s.hits.length > 0)
      .map((s) => s.id);
    const estimate = runRefaccionMarketPipeline({
      identity,
      rawHits,
      providersUsed,
      policy: this.policy,
    });
    this.cache.set(identity, estimate);
    return estimate;
  }
}

export function createRefaccionMarketService(opts?: {
  cache?: RefaccionMarketCache;
  providers?: RefaccionPriceProvider[];
  policy?: RefaccionMarketPolicy;
}): RefaccionMarketService {
  return new RefaccionMarketService(opts);
}
