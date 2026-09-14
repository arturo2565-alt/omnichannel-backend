import { parseVehiclePartIdentity } from './parse-vehicle-part-identity';
import { DEFAULT_REFACCION_MARKET_POLICY } from './refaccion-market.types';
import type { RawProviderHit, RefaccionPriceProvider } from './refaccion-market.types';
import { runShoppingFirstDiscovery } from './shopping-first-retrieval';
import { createRefaccionMarketService } from './refaccion-market.orchestrator';
import { RefaccionMarketCache } from './refaccion-market.cache';
import { runRefaccionMarketPipeline } from './refaccion-market.orchestrator';
import {
  assignSampleIndependence,
  uniqueIndependentSamples,
} from './sample-independence';
import { clusterSamplesByVariant } from './variant-cluster';
import { classifyRawHit } from './normalize-market-sample';
import { applyCustomerMargin } from './compute-market-range';
import { buildShoppingDiscoveryQueries } from './resolved-market-part';

const altima = parseVehiclePartIdentity({
  vehiculoText: 'Nissan Altima 2014',
  pieza: 'Calavera_Derecha',
});

function shopHit(
  title: string,
  price: number,
  opts: Partial<RawProviderHit> = {},
): RawProviderHit {
  return {
    provider: 'SERPER_SHOPPING',
    title,
    price,
    url: opts.url ?? `https://shop.example/${encodeURIComponent(title)}-${price}`,
    snippet: title,
    merchant: opts.merchant ?? `merchant-${price}`,
    seller: opts.seller ?? opts.merchant ?? `merchant-${price}`,
    productId: opts.productId ?? `pid-${price}`,
    query: opts.query ?? 'calavera derecha Nissan Altima 2014',
    retrievedAt: '2026-09-13T00:00:00.000Z',
    ...opts,
  };
}

function aftermarketRight(price: number, merchant: string, extra = ''): RawProviderHit {
  return shopHit(
    `Calavera derecha Nissan Altima 2014 aftermarket $${price} ${extra}`.trim(),
    price,
    { merchant, productId: `pid-${merchant}` },
  );
}

describe('shopping-first retrieval', () => {
  it('discovery queries priorizan comerciales + tail light', () => {
    const qs = buildShoppingDiscoveryQueries(altima);
    expect(qs.some((q) => /calavera/i.test(q) && /derecha/i.test(q))).toBe(true);
    expect(qs.some((q) => /right tail light/i.test(q))).toBe(true);
    expect(qs.length).toBeGreaterThanOrEqual(1);
    expect(qs.length).toBeLessThanOrEqual(3);
  });

  it('si el cluster compatible >= 4 no ejecuta pivot', async () => {
    const searchQueries = jest
      .fn()
      .mockResolvedValueOnce([
        aftermarketRight(2100, 'refac_a'),
        aftermarketRight(2200, 'refac_b'),
        aftermarketRight(2300, 'refac_c'),
        aftermarketRight(2400, 'refac_d'),
      ])
      .mockResolvedValueOnce([]);
    const result = await runShoppingFirstDiscovery({
      identity: altima,
      shopping: { isConfigured: () => true, searchQueries },
    });
    expect(searchQueries).toHaveBeenCalledTimes(1);
    expect(result.pivotQueries).toEqual([]);
    expect(result.metrics.crossQueryUnique).toBeGreaterThanOrEqual(4);
  });

  it('fixture DEPO 28667 extrae part number y genera pivot si <4', async () => {
    const searchQueries = jest
      .fn()
      .mockResolvedValueOnce([
        shopHit(
          'DEPO 28667 Calavera derecha Nissan Altima 2013-2016 aftermarket $2200',
          2200,
          { merchant: 'depo_mx', productId: 'g1' },
        ),
      ])
      .mockResolvedValueOnce([
        shopHit(
          'DEPO 28667 Calavera derecha Nissan Altima 2014 aftermarket $2250',
          2250,
          { merchant: 'autozone', productId: 'g2' },
        ),
      ]);
    const result = await runShoppingFirstDiscovery({
      identity: altima,
      shopping: { isConfigured: () => true, searchQueries },
    });
    expect(result.resolvedPart.aftermarketPartNumbers).toContain('28667');
    expect(result.pivotQueries.some((q) => q.includes('28667'))).toBe(true);
    expect(searchQueries).toHaveBeenCalledTimes(2);
  });

  it('fixture OEM 26550-3TG0B extrae OEM y genera pivot', async () => {
    const searchQueries = jest
      .fn()
      .mockResolvedValueOnce([
        shopHit(
          '26550-3TG0B Nissan Altima Tail Lamp derecha 2014 aftermarket $2400',
          2400,
          { merchant: 'oem_shop', productId: 'oem1' },
        ),
      ])
      .mockResolvedValueOnce([]);
    const result = await runShoppingFirstDiscovery({
      identity: altima,
      shopping: { isConfigured: () => true, searchQueries },
    });
    expect(result.resolvedPart.oemPartNumbers).toContain('26550-3TG0B');
    expect(result.pivotQueries.some((q) => q.includes('26550-3TG0B'))).toBe(true);
  });

  it('Shopping produce más listings independientes que generic web (Altima fixture)', () => {
    const genericHits: RawProviderHit[] = Array.from({ length: 5 }, () => ({
      provider: 'GOOGLE_WEB',
      title: 'Calavera derecha Nissan Altima 2014 $1,100–$2,500',
      price: 1100,
      url: undefined,
      snippet: 'Calavera derecha Nissan Altima 2014',
      query: 'calavera derecha Nissan Altima 2014',
      retrievedAt: '2026-09-13T00:00:00.000Z',
    }));
    const shoppingHits = [
      aftermarketRight(2100, 'mercadolibre'),
      aftermarketRight(2200, 'refaccionaria_norte'),
      aftermarketRight(2300, 'autopartes_sur'),
      aftermarketRight(2400, 'depo_oficial'),
      aftermarketRight(2500, 'amazon_mx'),
      aftermarketRight(2600, 'walmart'),
    ];
    const generic = runRefaccionMarketPipeline({
      identity: altima,
      rawHits: genericHits,
      providersUsed: ['GOOGLE_WEB'],
    });
    const shopping = runRefaccionMarketPipeline({
      identity: altima,
      rawHits: shoppingHits,
      providersUsed: ['SERPER_SHOPPING'],
    });
    expect(generic.audit?.acceptedSampleCount ?? 0).toBeLessThanOrEqual(1);
    expect(shopping.audit?.acceptedSampleCount ?? 0).toBeGreaterThanOrEqual(5);
    expect(shopping.audit?.acceptedSampleCount ?? 0).toBeGreaterThan(
      generic.audit?.acceptedSampleCount ?? 0,
    );
  });

  it('estimate shopping-first suficiente no llama secondary/web', async () => {
    const web: RefaccionPriceProvider = {
      id: 'GOOGLE_WEB',
      search: jest.fn(async () => [aftermarketRight(9999, 'should_not_run')]),
    };
    const searchQueries = jest.fn(async () => [
      aftermarketRight(2100, 'a'),
      aftermarketRight(2200, 'b'),
      aftermarketRight(2300, 'c'),
      aftermarketRight(2400, 'd'),
    ]);
    const market = createRefaccionMarketService({
      cache: new RefaccionMarketCache(),
      shoppingFirst: true,
      shopping: { isConfigured: () => true, searchQueries },
      providers: [web],
    });
    const estimate = await market.estimate(altima);
    expect(web.search).not.toHaveBeenCalled();
    expect(estimate.pricingStatus).toBe('OK');
    expect(estimate.cantidadMuestras).toBeGreaterThanOrEqual(4);
    expect(estimate.audit?.shoppingUniqueListings).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_REFACCION_MARKET_POLICY.minValidSamples).toBe(4);
    expect(estimate.customerPriceRange).toEqual(
      applyCustomerMargin(estimate.marketPriceRange!),
    );
  });

  it('no mezcla LED y NON_LED para alcanzar minValidSamples=4', () => {
    const raw = [
      shopHit('Calavera derecha LED Nissan Altima 2014 aftermarket $2100', 2100, {
        merchant: 'led1',
      }),
      shopHit('Calavera derecha LED Nissan Altima 2014 aftermarket $2200', 2200, {
        merchant: 'led2',
      }),
      shopHit(
        'Calavera derecha halogen Nissan Altima 2014 aftermarket $1800',
        1800,
        { merchant: 'hal1' },
      ),
      shopHit(
        'Calavera derecha sin LED Nissan Altima 2014 aftermarket $1900',
        1900,
        { merchant: 'hal2' },
      ),
    ];
    const estimate = runRefaccionMarketPipeline({
      identity: altima,
      rawHits: raw,
      providersUsed: ['SERPER_SHOPPING'],
    });
    expect(estimate.pricingStatus).toBe('INSUFFICIENT_MARKET_SAMPLE');
    expect(Object.keys(estimate.audit?.uniqueSamplesPerVariant ?? {}).length).toBeGreaterThan(
      1,
    );
  });

  it('distingue RIGHT vs LEFT en clusters', () => {
    const samples = [
      classifyRawHit(
        shopHit('Calavera derecha Nissan Altima 2014 aftermarket $2100', 2100, {
          merchant: 'r1',
        }),
        altima,
      ),
      classifyRawHit(
        shopHit('Calavera izquierda Nissan Altima 2014 aftermarket $2100', 2100, {
          merchant: 'l1',
        }),
        altima,
      ),
    ]
      .filter((c): c is Extract<typeof c, { ok: true }> => c.ok)
      .map((c) => c.sample);
    const rightOnly = samples.filter((s) => /derecha/i.test(s.title));
    expect(rightOnly).toHaveLength(1);
    const mixed = [
      ...rightOnly,
      {
        ...rightOnly[0]!,
        title: 'Calavera izquierda Nissan Altima 2014 aftermarket $2100',
        merchant: 'l1',
        url: 'https://shop.example/left',
      },
    ];
    const clusters = clusterSamplesByVariant(mixed);
    expect(clusters.map((c) => c.side).sort()).toEqual(['LEFT', 'RIGHT']);
  });
});

describe('shopping sample independence', () => {
  it('mismo listing en 4 queries → 1 sample', () => {
    const labeled = assignSampleIndependence(
      [1, 2, 3, 4].map((q) => ({
        source: 'SERPER_SHOPPING' as const,
        domain: 'articulo.mercadolibre.com.mx',
        title: 'Calavera derecha Nissan Altima 2014',
        price: 2200,
        currency: 'MXN' as const,
        condition: 'NEW' as const,
        partType: 'AFTERMARKET_NEW' as const,
        url: 'https://articulo.mercadolibre.com.mx/MLM-888',
        compatibilityConfidence: 'HIGH' as const,
        query: `q${q}`,
        retrievedAt: '2026-09-13T00:00:00.000Z',
        externalId: 'MLM888',
        merchant: 'refac_ml',
      })),
    );
    expect(uniqueIndependentSamples(labeled)).toHaveLength(1);
  });

  it('mismo productId + merchant → 1', () => {
    const labeled = assignSampleIndependence([
      {
        source: 'SERPER_SHOPPING',
        domain: 'shopping.google',
        title: 'Calavera derecha A',
        price: 2100,
        currency: 'MXN',
        condition: 'NEW',
        partType: 'AFTERMARKET_NEW',
        url: 'https://a.example/1',
        compatibilityConfidence: 'HIGH',
        query: 'q1',
        retrievedAt: '2026-09-13T00:00:00.000Z',
        merchant: 'refac_a',
        productId: 'PID99',
      },
      {
        source: 'SERPER_SHOPPING',
        domain: 'shopping.google',
        title: 'Calavera derecha B',
        price: 2199,
        currency: 'MXN',
        condition: 'NEW',
        partType: 'AFTERMARKET_NEW',
        url: 'https://b.example/2',
        compatibilityConfidence: 'HIGH',
        query: 'q2',
        retrievedAt: '2026-09-13T00:00:00.000Z',
        merchant: 'refac_a',
        productId: 'PID99',
      },
    ]);
    expect(uniqueIndependentSamples(labeled)).toHaveLength(1);
  });

  it('mismo part number, merchants distintos → samples distintos', () => {
    const labeled = assignSampleIndependence([
      {
        source: 'SERPER_SHOPPING',
        domain: 'a.example',
        title: 'DEPO 28667 Calavera derecha Nissan Altima 2014',
        price: 2100,
        currency: 'MXN',
        condition: 'NEW',
        partType: 'AFTERMARKET_NEW',
        url: 'https://a.example/1',
        compatibilityConfidence: 'HIGH',
        query: 'q',
        retrievedAt: '2026-09-13T00:00:00.000Z',
        merchant: 'tienda_a',
        partNumber: '28667',
      },
      {
        source: 'SERPER_SHOPPING',
        domain: 'b.example',
        title: 'DEPO 28667 Calavera derecha Nissan Altima 2014',
        price: 2300,
        currency: 'MXN',
        condition: 'NEW',
        partType: 'AFTERMARKET_NEW',
        url: 'https://b.example/2',
        compatibilityConfidence: 'HIGH',
        query: 'q',
        retrievedAt: '2026-09-13T00:00:00.000Z',
        merchant: 'tienda_b',
        partNumber: '28667',
      },
    ]);
    expect(uniqueIndependentSamples(labeled)).toHaveLength(2);
  });

  it('title idéntico, merchants distintos → no colapsa', () => {
    const labeled = assignSampleIndependence([
      {
        source: 'SERPER_SHOPPING',
        domain: 'a.example',
        title: 'Calavera derecha Nissan Altima 2014',
        price: 2100,
        currency: 'MXN',
        condition: 'NEW',
        partType: 'AFTERMARKET_NEW',
        url: 'https://a.example/1',
        compatibilityConfidence: 'HIGH',
        query: 'q',
        retrievedAt: '2026-09-13T00:00:00.000Z',
        merchant: 'alpha',
      },
      {
        source: 'SERPER_SHOPPING',
        domain: 'b.example',
        title: 'Calavera derecha Nissan Altima 2014',
        price: 2100,
        currency: 'MXN',
        condition: 'NEW',
        partType: 'AFTERMARKET_NEW',
        url: 'https://b.example/2',
        compatibilityConfidence: 'HIGH',
        query: 'q',
        retrievedAt: '2026-09-13T00:00:00.000Z',
        merchant: 'beta',
      },
    ]);
    expect(uniqueIndependentSamples(labeled)).toHaveLength(2);
  });
});
