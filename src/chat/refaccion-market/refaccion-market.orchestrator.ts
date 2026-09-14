import { Injectable } from '@nestjs/common';
import { buildMarketEstimate, insufficientEstimate } from './compute-market-range';
import { dedupeMarketSamples } from './dedupe-market-samples';
import { GoogleWebSearchProvider } from './google-web-search.provider';
import { MercadoLibreProvider } from './mercado-libre.provider';
import { classifyRawHit } from './normalize-market-sample';
import { canonicalizeUrl } from './normalize-market-sample';
import { RefaccionMarketCache } from './refaccion-market.cache';
import type {
  MarketProviderId,
  MarketSample,
  RawProviderHit,
  RefaccionMarketEstimate,
  RefaccionMarketPolicy,
  RefaccionPriceProvider,
  VehiclePartIdentity,
} from './refaccion-market.types';
import { DEFAULT_REFACCION_MARKET_POLICY } from './refaccion-market.types';
import {
  logRefaccionMarketEvent,
  REFACCION_MARKET_EVENTS,
  type RefaccionMarketEventSink,
} from './refaccion-market-events';
import {
  bumpRejection,
  emptyRejectedByReason,
  type RefaccionMarketAudit,
} from './market-audit';
import { resolveMarketPieceTaxonomy } from './market-piece-taxonomy';
import { buildMarketSearchQueryPlan } from './market-search-queries';
import { marketCacheKey } from './parse-vehicle-part-identity';

function emitMarketAudit(
  emit: RefaccionMarketEventSink,
  audit: RefaccionMarketAudit,
): void {
  emit(REFACCION_MARKET_EVENTS.AUDIT, {
    damageItemId: audit.damageItemId,
    pieceCode: audit.pieceCode,
    family: audit.family,
    marketIdentityKey: audit.marketIdentityKey,
    queries: audit.queries,
    providersUsed: audit.providersUsed,
    rawResultCount: audit.rawResultCount,
    compatibleSampleCount: audit.compatibleSampleCount,
    acceptedSampleCount: audit.acceptedSampleCount,
    rejectedResultCount: audit.rejectedResultCount,
    rejectedByReason: audit.rejectedByReason,
    selectedPartType: audit.selectedPartType,
    acceptedDomains: audit.acceptedDomains,
    sampleCount: audit.sampleCount,
    pricingStatus: audit.pricingStatus,
  });
}

export function runRefaccionMarketPipeline(input: {
  identity: VehiclePartIdentity;
  rawHits: RawProviderHit[];
  providersUsed: MarketProviderId[];
  policy?: RefaccionMarketPolicy;
  emit?: RefaccionMarketEventSink;
  queries?: string[];
  damageItemId?: string;
}): RefaccionMarketEstimate {
  const emit = input.emit ?? logRefaccionMarketEvent;
  const plan = buildMarketSearchQueryPlan(input.identity);
  const queries = input.queries?.length ? input.queries : plan.queries;
  const query = queries[0] ?? input.rawHits[0]?.query ?? input.identity.piezaLabel;
  const taxonomy = resolveMarketPieceTaxonomy(
    input.identity.pieza || input.identity.piezaLabel,
  );
  const rejectedByReason = emptyRejectedByReason();
  let compatibleSampleCount = 0;

  if (!input.identity.confirmed) {
    const empty = insufficientEstimate(input.identity, query, {
      providersUsed: input.providersUsed,
    });
    empty.audit = {
      damageItemId: input.damageItemId,
      pieceCode: taxonomy.pieceCode,
      family: taxonomy.family,
      marketIdentityKey: marketCacheKey(input.identity),
      queries,
      providersUsed: input.providersUsed,
      rawResultCount: 0,
      compatibleSampleCount: 0,
      acceptedSampleCount: 0,
      rejectedResultCount: 0,
      rejectedByReason,
      selectedPartType: null,
      acceptedDomains: [],
      sampleCount: 0,
      pricingStatus: 'INSUFFICIENT_MARKET_SAMPLE',
    };
    emitMarketAudit(emit, empty.audit);
    return empty;
  }

  const accepted: MarketSample[] = [];
  const seenUrl = new Set<string>();
  const seenExt = new Set<string>();
  for (const hit of input.rawHits) {
    const classified = classifyRawHit(hit, input.identity);
    if (classified.compatible) compatibleSampleCount += 1;
    if (!classified.ok) {
      bumpRejection(rejectedByReason, classified.reason);
      continue;
    }
    const url = canonicalizeUrl(classified.sample.url);
    const ext = String(classified.sample.externalId ?? '').trim().toUpperCase();
    if ((url && seenUrl.has(url)) || (ext && seenExt.has(ext))) {
      bumpRejection(rejectedByReason, 'DUPLICATE');
      continue;
    }
    if (url) seenUrl.add(url);
    if (ext) seenExt.add(ext);
    accepted.push(classified.sample);
  }

  if (input.rawHits.length > 0 && accepted.length === 0) {
    emit(REFACCION_MARKET_EVENTS.COMPATIBILITY_REJECTED, {
      pieza: input.identity.piezaLabel,
      marca: input.identity.marca,
      modelo: input.identity.modelo,
      anio: input.identity.anio,
      rawHits: input.rawHits.length,
    });
  }

  const unique = dedupeMarketSamples(accepted);
  const estimate = buildMarketEstimate({
    identity: input.identity,
    query,
    samples: unique,
    providersUsed: input.providersUsed,
    policy: input.policy,
  });
  const domains = [
    ...new Set(
      (estimate.samples ?? [])
        .map((s) => s.domain)
        .filter((d) => d && d !== 'unknown'),
    ),
  ];
  const rejectedResultCount = Object.values(rejectedByReason).reduce(
    (s, n) => s + (n ?? 0),
    0,
  );
  estimate.audit = {
    damageItemId: input.damageItemId,
    pieceCode: taxonomy.pieceCode,
    family: taxonomy.family,
    marketIdentityKey: marketCacheKey(input.identity),
    queries,
    providersUsed: input.providersUsed,
    rawResultCount: input.rawHits.length,
    compatibleSampleCount,
    acceptedSampleCount: unique.length,
    rejectedResultCount,
    rejectedByReason,
    selectedPartType: estimate.partTypeGroup,
    acceptedDomains: domains,
    sampleCount: estimate.cantidadMuestras,
    pricingStatus: estimate.pricingStatus,
  };
  emitMarketAudit(emit, estimate.audit);
  return estimate;
}

type RefaccionMarketServiceOpts = {
  cache?: RefaccionMarketCache;
  providers?: RefaccionPriceProvider[];
  policy?: RefaccionMarketPolicy;
};

@Injectable()
export class RefaccionMarketService {
  private cache: RefaccionMarketCache;
  private providers: RefaccionPriceProvider[];
  private policy: RefaccionMarketPolicy;

  /** Sin parámetros: Nest no debe inyectar el objeto de opciones. */
  constructor() {
    this.applyOpts();
  }

  applyOpts(opts?: RefaccionMarketServiceOpts): this {
    this.cache = opts?.cache ?? new RefaccionMarketCache();
    this.providers = opts?.providers ?? [
      new GoogleWebSearchProvider(),
      new MercadoLibreProvider(),
    ];
    this.policy = opts?.policy ?? DEFAULT_REFACCION_MARKET_POLICY;
    return this;
  }

  async estimate(identity: VehiclePartIdentity): Promise<RefaccionMarketEstimate> {
    const cached = this.cache.get(identity);
    if (cached) return cached;
    const plan = buildMarketSearchQueryPlan(identity);
    if (!identity.confirmed) {
      const empty = runRefaccionMarketPipeline({
        identity,
        rawHits: [],
        providersUsed: [],
        queries: plan.queries,
        policy: this.policy,
      });
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
      queries: plan.queries,
      policy: this.policy,
    });
    this.cache.set(identity, estimate);
    return estimate;
  }
}

export function createRefaccionMarketService(
  opts?: RefaccionMarketServiceOpts,
): RefaccionMarketService {
  return new RefaccionMarketService().applyOpts(opts);
}
