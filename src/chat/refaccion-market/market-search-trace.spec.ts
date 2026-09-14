import { parseVehiclePartIdentity } from './parse-vehicle-part-identity';
import { runRefaccionMarketPipeline, createRefaccionMarketService } from './refaccion-market.orchestrator';
import { RefaccionMarketCache } from './refaccion-market.cache';
import {
  MARKET_TRACE_EVENTS,
  PEG_MARKET_TRACE_ENV,
  PEG_MARKET_TRACE_PREFIX,
  PEG_MARKET_TRACE_VERBOSE_ENV,
} from './market-search-trace';
import { computeMarketSearchFunnel } from './compute-market-funnel';
import type {
  RawProviderHit,
  RefaccionMarketEstimate,
  RefaccionPriceProvider,
} from './refaccion-market.types';
import { sanitizeToolResultForLlm } from '../llm-tool-result-sanitize';

const altimaRight = parseVehiclePartIdentity({
  vehiculoText: 'Nissan Altima 2014',
  pieza: 'Calavera_Derecha',
});

const altimaLeft = parseVehiclePartIdentity({
  vehiculoText: 'Nissan Altima 2014',
  pieza: 'Calavera_Izquierda',
});

function hit(
  title: string,
  price?: number,
  opts?: Partial<RawProviderHit>,
): RawProviderHit {
  return {
    provider: opts?.provider ?? 'GOOGLE_WEB',
    title,
    ...(price != null ? { price } : {}),
    url: opts?.url ?? `https://shop.example/${encodeURIComponent(title)}`,
    snippet: opts?.snippet ?? title,
    condition: opts?.condition,
    externalId: opts?.externalId,
    query: 'calavera derecha Nissan Altima 2014',
    retrievedAt: '2026-09-13T00:00:00.000Z',
    ...opts,
  };
}

const MIXED_HITS: RawProviderHit[] = [
  hit('Calavera derecha Nissan Altima 2014 aftermarket $2,200', 2200, {
    url: 'https://refac.mx/a1',
  }),
  hit('Calavera derecha Nissan Altima 2014 aftermarket $2,250', 2250, {
    url: 'https://refac.mx/a2',
  }),
  hit('Calavera derecha Nissan Altima 2014 aftermarket $2,300', 2300, {
    url: 'https://refac.mx/a3',
  }),
  hit('Calavera derecha Nissan Altima 2014 original $2,800', 2800, {
    url: 'https://refac.mx/o1',
  }),
  hit('Calavera derecha Nissan Altima 2014 original $2,900', 2900, {
    url: 'https://refac.mx/o2',
  }),
  hit('Calavera derecha Nissan Altima 2014 usado $1,400', 1400, {
    url: 'https://refac.mx/u1',
  }),
  hit('Calavera izquierda Nissan Altima 2014 $2,200', 2200, {
    url: 'https://refac.mx/left',
  }),
  hit('Calavera Nissan Altima 2014 $2,200', 2200, {
    url: 'https://refac.mx/noside',
  }),
  hit('Calavera derecha Nissan Sentra 2014 $2,200', 2200, {
    url: 'https://refac.mx/sentra',
  }),
  hit('Calavera derecha Nissan Altima 2014 aftermarket $2,200', 2200, {
    url: 'https://refac.mx/a1',
  }),
  hit('Faros niebla Nissan Altima 2014 $800', 800, {
    url: 'https://refac.mx/fog',
  }),
];

const OK_HITS: RawProviderHit[] = [
  hit('Calavera derecha Nissan Altima 2014 aftermarket $2,100', 2100, {
    url: 'https://refac.mx/ok-1',
  }),
  hit('Calavera derecha Nissan Altima 2014 aftermarket $2,200', 2200, {
    url: 'https://refac.mx/ok-2',
  }),
  hit('Calavera derecha Nissan Altima 2014 aftermarket $2,300', 2300, {
    url: 'https://refac.mx/ok-3',
  }),
  hit('Calavera derecha Nissan Altima 2014 aftermarket $2,400', 2400, {
    url: 'https://refac.mx/ok-4',
  }),
];

type TraceEvent = { event: string; [k: string]: unknown };

function captureTraceLogs<T>(fn: () => T): { events: TraceEvent[]; result: T } {
  const events: TraceEvent[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (!line.includes(PEG_MARKET_TRACE_PREFIX)) return;
    const json = line.slice(line.indexOf(PEG_MARKET_TRACE_PREFIX) + PEG_MARKET_TRACE_PREFIX.length).trim();
    try {
      events.push(JSON.parse(json) as TraceEvent);
    } catch {
      /* ignore */
    }
  };
  try {
    return { events, result: fn() };
  } finally {
    console.log = orig;
  }
}

async function captureTraceLogsAsync<T>(
  fn: () => Promise<T>,
): Promise<{ events: TraceEvent[]; result: T }> {
  const events: TraceEvent[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (!line.includes(PEG_MARKET_TRACE_PREFIX)) return;
    const json = line.slice(line.indexOf(PEG_MARKET_TRACE_PREFIX) + PEG_MARKET_TRACE_PREFIX.length).trim();
    try {
      events.push(JSON.parse(json) as TraceEvent);
    } catch {
      /* ignore */
    }
  };
  try {
    return { events, result: await fn() };
  } finally {
    console.log = orig;
  }
}

function pricingCore(estimate: RefaccionMarketEstimate) {
  return {
    pricingStatus: estimate.pricingStatus,
    partTypeGroup: estimate.partTypeGroup,
    cantidadMuestras: estimate.cantidadMuestras,
    customer: estimate.customerPriceRange,
    market: estimate.marketPriceRange,
    prices: (estimate.samples ?? []).map((s) => s.price).sort((a, b) => a - b),
    priceSource: estimate.priceSource,
  };
}

function fakeProvider(hits: RawProviderHit[]): RefaccionPriceProvider {
  return {
    id: 'GOOGLE_WEB',
    search: async () => hits,
  };
}

function observation(searchRunId = 'mrs_test') {
  return {
    ids: {
      searchRunId,
      pieceCode: altimaRight.pieza,
      marketIdentityKey: 'nissan|altima|2014|calaveraderecha||',
      marketStrategyVersion: 'v2',
    },
    source: 'PROVIDER' as const,
    cacheHit: false,
    cacheKey: 'v2|nissan|altima|2014|calaveraderecha||',
    totalDurationMs: 12,
    providerDurationMs: 8,
  };
}

function setTraceFlags(opts: { trace?: boolean; verbose?: boolean }) {
  if (opts.trace) process.env[PEG_MARKET_TRACE_ENV] = 'true';
  else delete process.env[PEG_MARKET_TRACE_ENV];
  if (opts.verbose) process.env[PEG_MARKET_TRACE_VERBOSE_ENV] = 'true';
  else delete process.env[PEG_MARKET_TRACE_VERBOSE_ENV];
}

afterEach(() => {
  delete process.env[PEG_MARKET_TRACE_ENV];
  delete process.env[PEG_MARKET_TRACE_VERBOSE_ENV];
});

describe('observabilidad profunda — invariante de resultado', () => {
  it('logs / observation no cambian pricing ni samples', () => {
    const baseline = runRefaccionMarketPipeline({
      identity: altimaRight,
      rawHits: MIXED_HITS,
      providersUsed: ['GOOGLE_WEB'],
    });
    setTraceFlags({ trace: true, verbose: true });
    const { result: observed } = captureTraceLogs(() =>
      runRefaccionMarketPipeline({
        identity: altimaRight,
        rawHits: MIXED_HITS,
        providersUsed: ['GOOGLE_WEB'],
        observation: observation(),
      }),
    );
    expect(pricingCore(observed)).toEqual(pricingCore(baseline));
    expect(observed.audit?.acceptedSampleCount).toBe(
      baseline.audit?.acceptedSampleCount,
    );
    expect(observed.audit?.rejectedByReason).toEqual(
      baseline.audit?.rejectedByReason,
    );
  });
});

describe('funnel y part types', () => {
  it('funnel es consistente y rejection reasons suman', () => {
    const estimate = runRefaccionMarketPipeline({
      identity: altimaRight,
      rawHits: MIXED_HITS,
      providersUsed: ['GOOGLE_WEB'],
      observation: observation(),
    });
    const funnel = estimate.audit?.funnel;
    expect(funnel).toBeDefined();
    const providerSum = Object.values(funnel!.providerRawResults).reduce(
      (s, n) => s + (n ?? 0),
      0,
    );
    expect(funnel!.rawResultCount).toBe(MIXED_HITS.length);
    expect(providerSum).toBe(MIXED_HITS.length);
    expect(funnel!.afterDedupe).toBeLessThanOrEqual(funnel!.rawResultCount);
    expect(funnel!.pieceCompatible).toBeLessThanOrEqual(funnel!.afterDedupe);
    expect(funnel!.sideCompatible).toBeLessThanOrEqual(funnel!.pieceCompatible);
    expect(funnel!.vehicleCompatible).toBeLessThanOrEqual(funnel!.sideCompatible);
    expect(funnel!.yearCompatible).toBeLessThanOrEqual(funnel!.vehicleCompatible);
    expect(funnel!.validPrice).toBeLessThanOrEqual(funnel!.yearCompatible);
    const rejectedSum = Object.values(funnel!.rejectedByReason).reduce(
      (s, n) => s + (n ?? 0),
      0,
    );
    expect(rejectedSum).toBe(funnel!.rawResultCount - funnel!.validPrice);
    expect(funnel!.rejectedByReason.DUPLICATE).toBe(
      funnel!.rawResultCount - funnel!.afterDedupe,
    );
    const acceptedByType = Object.values(funnel!.acceptedByPartType).reduce(
      (s, n) => s + (n ?? 0),
      0,
    );
    expect(acceptedByType).toBe(estimate.audit!.acceptedSampleCount);
    expect(acceptedByType).toBe(
      (estimate.audit!.funnel!.acceptedByPartType.AFTERMARKET_NEW ?? 0) +
        (estimate.audit!.funnel!.acceptedByPartType.UNKNOWN ?? 0) +
        (estimate.audit!.funnel!.acceptedByPartType.OEM_NEW ?? 0) +
        (estimate.audit!.funnel!.acceptedByPartType.OEM_USED ?? 0),
    );
  });

  it('acceptedSampleCount coincide con muestras únicas y part-type counts', () => {
    const estimate = runRefaccionMarketPipeline({
      identity: altimaRight,
      rawHits: MIXED_HITS,
      providersUsed: ['GOOGLE_WEB'],
      observation: observation(),
    });
    expect(estimate.audit!.acceptedSampleCount).toBe(6);
    expect(estimate.audit!.funnel!.acceptedByPartType.AFTERMARKET_NEW).toBe(3);
    expect(estimate.audit!.funnel!.acceptedByPartType.OEM_NEW).toBe(2);
    expect(estimate.audit!.funnel!.acceptedByPartType.OEM_USED).toBe(1);
    expect(estimate.audit!.bestAvailablePartType).toBe('AFTERMARKET_NEW');
    expect(estimate.audit!.bestAvailableSampleCount).toBe(3);
    expect(estimate.pricingStatus).toBe('INSUFFICIENT_MARKET_SAMPLE');
    expect(estimate.audit!.samplesMissingToThreshold).toBe(1);
  });

  it('computeMarketSearchFunnel coincide con audit.funnel', () => {
    const estimate = runRefaccionMarketPipeline({
      identity: altimaRight,
      rawHits: MIXED_HITS,
      providersUsed: ['GOOGLE_WEB'],
      observation: observation(),
    });
    const recomputed = computeMarketSearchFunnel(
      MIXED_HITS,
      altimaRight,
      [
        ...Array.from({ length: estimate.audit!.acceptedSampleCount }).map(
          (_, i) => estimate.samples?.[i],
        ),
      ].filter(Boolean) as NonNullable<(typeof estimate.samples)[number]>[],
    );
    expect(recomputed.rawResultCount).toBe(estimate.audit!.funnel!.rawResultCount);
    expect(recomputed.afterDedupe).toBe(estimate.audit!.funnel!.afterDedupe);
    expect(recomputed.rejectedByReason).toEqual(
      estimate.audit!.funnel!.rejectedByReason,
    );
  });
});

describe('flags PEG_MARKET_TRACE', () => {
  it('verbose off no imprime sample-level data', async () => {
    setTraceFlags({ trace: true, verbose: false });
    const market = createRefaccionMarketService({
      cache: new RefaccionMarketCache(),
      providers: [fakeProvider(OK_HITS)],
    });
    const { events } = await captureTraceLogsAsync(() =>
      market.estimate(altimaRight),
    );
    const names = events.map((e) => e.event);
    expect(names).toContain(MARKET_TRACE_EVENTS.SEARCH_STARTED);
    expect(names).toContain(MARKET_TRACE_EVENTS.QUERIES_GENERATED);
    expect(names).toContain(MARKET_TRACE_EVENTS.CACHE_DECISION);
    expect(names).toContain(MARKET_TRACE_EVENTS.SEARCH_FUNNEL);
    expect(names).toContain(MARKET_TRACE_EVENTS.PART_TYPE_SELECTION);
    expect(names).toContain(MARKET_TRACE_EVENTS.PRICING_DECISION);
    expect(names).toContain(MARKET_TRACE_EVENTS.SEARCH_FINISHED);
    expect(names).not.toContain(MARKET_TRACE_EVENTS.RAW_SAMPLE);
    expect(names).not.toContain(MARKET_TRACE_EVENTS.SAMPLE_EVALUATED);
    expect(names).not.toContain(MARKET_TRACE_EVENTS.ACCEPTED_SAMPLE);
    const queries = events.find(
      (e) => e.event === MARKET_TRACE_EVENTS.QUERIES_GENERATED,
    );
    expect(Array.isArray(queries?.queries)).toBe(true);
    expect((queries?.queries as { provider: string; query: string }[]).length).toBeGreaterThan(0);
  });

  it('verbose on sí imprime RAW / EVALUATED / ACCEPTED', async () => {
    setTraceFlags({ verbose: true });
    const market = createRefaccionMarketService({
      cache: new RefaccionMarketCache(),
      providers: [fakeProvider(OK_HITS)],
    });
    const { events } = await captureTraceLogsAsync(() =>
      market.estimate(altimaRight),
    );
    const names = events.map((e) => e.event);
    expect(names).toContain(MARKET_TRACE_EVENTS.RAW_SAMPLE);
    expect(names).toContain(MARKET_TRACE_EVENTS.SAMPLE_EVALUATED);
    expect(names).toContain(MARKET_TRACE_EVENTS.ACCEPTED_SAMPLE);
    const evaluated = events.filter(
      (e) => e.event === MARKET_TRACE_EVENTS.SAMPLE_EVALUATED,
    );
    expect(evaluated.length).toBeGreaterThan(0);
    for (const ev of evaluated) {
      if (ev.accepted) continue;
      expect(typeof ev.rejectionReason).toBe('string');
    }
  });

  it('cache hit queda distinguido de provider lookup', async () => {
    setTraceFlags({ trace: true });
    const provider = fakeProvider(OK_HITS);
    const market = createRefaccionMarketService({
      cache: new RefaccionMarketCache(),
      providers: [provider],
    });
    const first = await captureTraceLogsAsync(() => market.estimate(altimaRight));
    const second = await captureTraceLogsAsync(() => market.estimate(altimaRight));
    const firstFinished = first.events.find(
      (e) => e.event === MARKET_TRACE_EVENTS.SEARCH_FINISHED,
    );
    const secondFinished = second.events.find(
      (e) => e.event === MARKET_TRACE_EVENTS.SEARCH_FINISHED,
    );
    const firstCache = first.events.find(
      (e) => e.event === MARKET_TRACE_EVENTS.CACHE_DECISION,
    );
    const secondCache = second.events.find(
      (e) => e.event === MARKET_TRACE_EVENTS.CACHE_DECISION,
    );
    expect(firstCache?.cacheHit).toBe(false);
    expect(secondCache?.cacheHit).toBe(true);
    expect(firstFinished?.source).toBe('PROVIDER');
    expect(firstFinished?.cacheHit).toBe(false);
    expect(secondFinished?.source).toBe('CACHE');
    expect(secondFinished?.cacheHit).toBe(true);
    expect(pricingCore(first.result)).toEqual(pricingCore(second.result));
  });

  it('INSUFFICIENT reporta cuánto faltó al umbral', () => {
    setTraceFlags({ trace: true });
    const { events, result } = captureTraceLogs(() =>
      runRefaccionMarketPipeline({
        identity: altimaRight,
        rawHits: MIXED_HITS,
        providersUsed: ['GOOGLE_WEB'],
        observation: observation('mrs_missing'),
      }),
    );
    const pricing = events.find(
      (e) => e.event === MARKET_TRACE_EVENTS.PRICING_DECISION,
    );
    expect(result.pricingStatus).toBe('INSUFFICIENT_MARKET_SAMPLE');
    expect(pricing?.bestAvailablePartType).toBe('AFTERMARKET_NEW');
    expect(pricing?.bestAvailableSampleCount).toBe(3);
    expect(pricing?.samplesMissingToThreshold).toBe(1);
    expect(result.audit?.samplesMissingToThreshold).toBe(1);
  });

  it('flags off no emiten [PEG_MARKET_TRACE]', async () => {
    setTraceFlags({});
    const market = createRefaccionMarketService({
      cache: new RefaccionMarketCache(),
      providers: [fakeProvider(OK_HITS)],
    });
    const { events, result } = await captureTraceLogsAsync(() =>
      market.estimate(altimaRight),
    );
    expect(events).toEqual([]);
    expect(result.pricingStatus).toBe('OK');
    expect(result.audit?.funnel).toBeDefined();
  });
});

describe('no se expone al cliente / LLM', () => {
  it('funnel y samples no pasan por sanitizeToolResultForLlm', () => {
    const estimate = runRefaccionMarketPipeline({
      identity: altimaLeft,
      rawHits: [
        hit('Calavera izquierda Nissan Altima 2014 aftermarket $2,100', 2100, {
          url: 'https://ok.mx/1',
        }),
      ],
      providersUsed: ['GOOGLE_WEB'],
      observation: observation(),
    });
    const exposed = sanitizeToolResultForLlm(
      {
        success: true,
        quoteFlowMode: 'CANONICAL',
        marketAudit: estimate.audit,
        funnel: estimate.audit?.funnel,
        searchRunId: estimate.audit?.searchRunId,
      },
      { toolName: 'obtenerCotizacionExpress' },
    );
    expect(exposed.marketAudit).toBeUndefined();
    expect(exposed.funnel).toBeUndefined();
    expect(exposed.searchRunId).toBeUndefined();
  });
});
