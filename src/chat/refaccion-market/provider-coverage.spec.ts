import { parseVehiclePartIdentity } from './parse-vehicle-part-identity';
import { createRefaccionMarketService } from './refaccion-market.orchestrator';
import { RefaccionMarketCache } from './refaccion-market.cache';
import { runCoverageLookup } from './provider-coverage';
import { MercadoLibreProvider } from './mercado-libre.provider';
import { DEFAULT_REFACCION_MARKET_POLICY } from './refaccion-market.types';
import type { RawProviderHit, RefaccionPriceProvider } from './refaccion-market.types';

const altima = parseVehiclePartIdentity({
  vehiculoText: 'Nissan Altima 2014',
  pieza: 'Calavera_Derecha',
});

function okHit(i: number, provider: RawProviderHit['provider'] = 'GOOGLE_WEB'): RawProviderHit {
  return {
    provider,
    title: `Calavera derecha Nissan Altima 2014 aftermarket $${2100 + i * 50}`,
    price: 2100 + i * 50,
    url: `https://refac.mx/cov-${i}`,
    snippet: `Calavera derecha Nissan Altima 2014 aftermarket`,
    query: 'calavera derecha Nissan Altima 2014',
    retrievedAt: '2026-09-13T00:00:00.000Z',
  };
}

describe('provider coverage fallback', () => {
  it('minValidSamples sigue 4', () => {
    expect(DEFAULT_REFACCION_MARKET_POLICY.minValidSamples).toBe(4);
    expect(DEFAULT_REFACCION_MARKET_POLICY.preferredPartTypes).toEqual([
      'AFTERMARKET_NEW',
      'UNKNOWN',
      'OEM_NEW',
      'OEM_USED',
    ]);
  });

  it('provider 1 suficiente → provider 2 no corre', async () => {
    const p1: RefaccionPriceProvider = {
      id: 'GOOGLE_WEB',
      search: jest.fn(async () => [okHit(0), okHit(1), okHit(2), okHit(3)]),
    };
    const p2: RefaccionPriceProvider = {
      id: 'TAVILY',
      search: jest.fn(async () => [okHit(4, 'TAVILY')]),
    };
    const coverage = await runCoverageLookup({
      identity: altima,
      providers: [p1, p2],
    });
    expect(p1.search).toHaveBeenCalledTimes(1);
    expect(p2.search).not.toHaveBeenCalled();
    expect(coverage.providerContribution.TAVILY?.skipped).toBe(true);
    expect(coverage.providerContribution.TAVILY?.skipReason).toBe('THRESHOLD');
    expect(coverage.uniqueSamplesAfterCrossProviderDedupe).toBe(4);
  });

  it('provider 1 insuficiente → provider 2 corre', async () => {
    const p1: RefaccionPriceProvider = {
      id: 'GOOGLE_WEB',
      search: jest.fn(async () => [okHit(0)]),
    };
    const p2: RefaccionPriceProvider = {
      id: 'TAVILY',
      search: jest.fn(async () => [okHit(1, 'TAVILY'), okHit(2, 'TAVILY'), okHit(3, 'TAVILY')]),
    };
    const coverage = await runCoverageLookup({
      identity: altima,
      providers: [p1, p2],
    });
    expect(p2.search).toHaveBeenCalledTimes(1);
    expect(coverage.uniqueSamplesAfterCrossProviderDedupe).toBe(4);
    expect(coverage.providerContribution.GOOGLE_WEB?.unique).toBe(1);
    expect(coverage.providerContribution.TAVILY?.unique).toBe(3);
  });

  it('mismo listing cross-provider cuenta una vez', async () => {
    const shared: RawProviderHit = {
      ...okHit(0),
      url: 'https://articulo.mercadolibre.com.mx/MLM-555',
      externalId: 'MLM555',
    };
    const p1: RefaccionPriceProvider = {
      id: 'GOOGLE_WEB',
      search: async () => [shared],
    };
    const p2: RefaccionPriceProvider = {
      id: 'MERCADO_LIBRE',
      search: async () => [{ ...shared, provider: 'MERCADO_LIBRE' }],
    };
    const coverage = await runCoverageLookup({
      identity: altima,
      providers: [p1, p2],
    });
    expect(coverage.uniqueSamplesAfterCrossProviderDedupe).toBe(1);
    expect(coverage.providerContribution.MERCADO_LIBRE?.unique).toBe(0);
  });

  it('error de provider no rompe el lookup', async () => {
    const p1: RefaccionPriceProvider = {
      id: 'GOOGLE_WEB',
      search: async () => {
        throw new Error('boom');
      },
    };
    const p2: RefaccionPriceProvider = {
      id: 'TAVILY',
      search: async () => [okHit(0, 'TAVILY')],
    };
    const coverage = await runCoverageLookup({
      identity: altima,
      providers: [p1, p2],
    });
    expect(coverage.rawHits).toHaveLength(1);
    expect(coverage.uniqueSamplesAfterCrossProviderDedupe).toBe(1);
  });

  it('ML 403 queda observable y no aborta', async () => {
    const orig = global.fetch;
    global.fetch = (async () =>
      ({
        ok: false,
        status: 403,
      }) as Response) as typeof fetch;
    process.env.REFACCION_ML_SEARCH = '1';
    const ml = new MercadoLibreProvider();
    const hits = await ml.search(altima);
    global.fetch = orig;
    delete process.env.REFACCION_ML_SEARCH;
    expect(hits).toEqual([]);
    expect(ml.lastError).toBe('HTTP_403');

    const failingMl: RefaccionPriceProvider = {
      id: 'MERCADO_LIBRE',
      coverageStageId: 'MERCADO_LIBRE',
      lastError: 'HTTP_403',
      search: async () => [],
    };
    const coverage = await runCoverageLookup({
      identity: altima,
      providers: [
        failingMl,
        {
          id: 'GOOGLE_WEB',
          coverageStageId: 'GOOGLE_WEB',
          search: async () => [okHit(0)],
        },
      ],
    });
    expect(coverage.providerContribution.MERCADO_LIBRE?.error).toBe('HTTP_403');
    expect(coverage.rawHits).toHaveLength(1);
  });

  it('seedHits suficientes → no corre secondary', async () => {
    const p1: RefaccionPriceProvider = {
      id: 'GOOGLE_WEB',
      search: jest.fn(async () => [okHit(9)]),
    };
    const coverage = await runCoverageLookup({
      identity: altima,
      providers: [p1],
      seedHits: [okHit(0), okHit(1), okHit(2), okHit(3)],
    });
    expect(p1.search).not.toHaveBeenCalled();
    expect(coverage.providerContribution.GOOGLE_WEB?.skipReason).toBe('THRESHOLD');
  });

  it('estimate distingue cache vs lookup y no cambia pricing', async () => {
    const provider: RefaccionPriceProvider = {
      id: 'GOOGLE_WEB',
      search: jest.fn(async () => [okHit(0), okHit(1), okHit(2), okHit(3)]),
    };
    const market = createRefaccionMarketService({
      cache: new RefaccionMarketCache(),
      providers: [provider],
    });
    const first = await market.estimate(altima);
    const second = await market.estimate(altima);
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect(first.pricingStatus).toBe('OK');
    expect(second.pricingStatus).toBe(first.pricingStatus);
    expect(second.customerPriceRange).toEqual(first.customerPriceRange);
    expect(first.audit?.uniqueSamplesAfterCrossProviderDedupe).toBe(4);
  });
});
