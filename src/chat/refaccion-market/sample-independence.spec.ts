import { parseVehiclePartIdentity } from './parse-vehicle-part-identity';
import { classifyRawHit } from './normalize-market-sample';
import {
  assignSampleIndependence,
  extractListingId,
  uniqueIndependentSamples,
} from './sample-independence';
import type { MarketSample, RawProviderHit } from './refaccion-market.types';
import { applyCustomerMargin } from './compute-market-range';
import { DEFAULT_REFACCION_MARKET_POLICY } from './refaccion-market.types';
import { runRefaccionMarketPipeline } from './refaccion-market.orchestrator';

const altima = parseVehiclePartIdentity({
  vehiculoText: 'Nissan Altima 2014',
  pieza: 'Calavera_Derecha',
});

function sample(partial: Partial<MarketSample> & Pick<MarketSample, 'title' | 'url'>): MarketSample {
  return {
    source: 'GOOGLE_WEB',
    domain: 'shop.example',
    price: 2200,
    currency: 'MXN',
    condition: 'NEW',
    partType: 'AFTERMARKET_NEW',
    compatibilityConfidence: 'HIGH',
    query: 'q',
    retrievedAt: '2026-09-13T00:00:00.000Z',
    ...partial,
  };
}

function hit(title: string, price: number, opts?: Partial<RawProviderHit>): RawProviderHit {
  return {
    provider: opts?.provider ?? 'GOOGLE_WEB',
    title,
    price,
    url: opts?.url ?? `https://shop.example/${encodeURIComponent(title)}`,
    snippet: title,
    query: 'calavera derecha Nissan Altima 2014',
    retrievedAt: '2026-09-13T00:00:00.000Z',
    ...opts,
  };
}

describe('sample independence', () => {
  it('mismo URL desde dos providers → 1 UNIQUE', () => {
    const labeled = assignSampleIndependence([
      sample({
        source: 'MERCADO_LIBRE',
        title: 'Calavera derecha Nissan Altima 2014',
        url: 'https://articulo.mercadolibre.com.mx/MLM-123',
        externalId: 'MLM123',
        domain: 'articulo.mercadolibre.com.mx',
      }),
      sample({
        source: 'GOOGLE_WEB',
        title: 'Calavera derecha Nissan Altima 2014',
        url: 'https://articulo.mercadolibre.com.mx/MLM-123?utm=x',
        domain: 'articulo.mercadolibre.com.mx',
      }),
    ]);
    expect(labeled.map((s) => s.independenceStatus)).toEqual([
      'UNIQUE',
      'DUPLICATE',
    ]);
    expect(
      labeled.filter((s) => s.independenceStatus === 'UNIQUE'),
    ).toHaveLength(1);
  });

  it('mismo listingId → 1 UNIQUE', () => {
    expect(extractListingId('https://articulo.mercadolibre.com.mx/MLM-999', '')).toBe(
      'MLM999',
    );
    const labeled = assignSampleIndependence([
      sample({
        title: 'A',
        url: 'https://a.example/x',
        externalId: 'MLM999',
        domain: 'a.example',
      }),
      sample({
        title: 'B',
        url: 'https://b.example/y',
        externalId: 'MLM-999',
        domain: 'b.example',
      }),
    ]);
    expect(labeled[1]!.independenceStatus).toBe('DUPLICATE');
  });

  it('mismo title/domain sin evidencia independiente → AMBIGUOUS', () => {
    const labeled = assignSampleIndependence([
      sample({
        title: 'Calavera derecha Nissan Altima 2014 $1,100–$2,500',
        url: '',
        domain: 'unknown',
        source: 'OPENAI_WEB',
      }),
      sample({
        title: 'Calavera derecha Nissan Altima 2014 $1,100–$2,500',
        url: '',
        domain: 'unknown',
        source: 'OPENAI_WEB',
        price: 2500,
      }),
    ]);
    expect(labeled.every((s) => s.independenceStatus === 'AMBIGUOUS')).toBe(true);
    expect(uniqueIndependentSamples(labeled)).toHaveLength(0);
  });

  it('mismo producto con seller/listing distintos → independientes', () => {
    const labeled = assignSampleIndependence([
      sample({
        title: 'Calavera derecha Nissan Altima 2014',
        url: 'https://articulo.mercadolibre.com.mx/MLM-1',
        seller: 'refac_norte',
        domain: 'articulo.mercadolibre.com.mx',
      }),
      sample({
        title: 'Calavera derecha Nissan Altima 2014',
        url: 'https://articulo.mercadolibre.com.mx/MLM-2',
        seller: 'refac_sur',
        domain: 'articulo.mercadolibre.com.mx',
      }),
    ]);
    expect(labeled.map((s) => s.independenceStatus)).toEqual(['UNIQUE', 'UNIQUE']);
  });

  it('5 copias sintetizadas no inflan sampleCount', () => {
    const raw = Array.from({ length: 5 }, (_, i) =>
      hit(
        'Calavera derecha Nissan Altima 2013–2014–2016, aprox. $1,100–$2,500 MXN',
        1100 + i,
        { provider: 'OPENAI_WEB', url: undefined },
      ),
    );
    const estimate = runRefaccionMarketPipeline({
      identity: altima,
      rawHits: raw,
      providersUsed: ['OPENAI_WEB'],
    });
    expect(estimate.audit?.independenceCounts?.AMBIGUOUS).toBeGreaterThan(0);
    expect(estimate.audit?.acceptedSampleCount).toBe(0);
    expect(estimate.pricingStatus).toBe('INSUFFICIENT_MARKET_SAMPLE');
    expect(estimate.customerPriceRange).toBeUndefined();
  });

  it('minValidSamples sigue 4 y margen no cambia', () => {
    expect(DEFAULT_REFACCION_MARKET_POLICY.minValidSamples).toBe(4);
    const raw = [2100, 2200, 2300, 2400].map((p, i) =>
      hit(`Calavera derecha Nissan Altima 2014 aftermarket $${p}`, p, {
        url: `https://refac.mx/ok-${i}`,
      }),
    );
    const estimate = runRefaccionMarketPipeline({
      identity: altima,
      rawHits: raw,
      providersUsed: ['GOOGLE_WEB'],
    });
    expect(estimate.pricingStatus).toBe('OK');
    expect(estimate.cantidadMuestras).toBe(4);
    expect(estimate.customerPriceRange).toEqual(
      applyCustomerMargin(estimate.marketPriceRange!),
    );
  });

  it('title idéntico + merchants distintos no colapsa', () => {
    const labeled = assignSampleIndependence([
      sample({
        title: 'Calavera derecha Nissan Altima 2014',
        url: 'https://alpha.example/1',
        merchant: 'alpha',
        domain: 'alpha.example',
      }),
      sample({
        title: 'Calavera derecha Nissan Altima 2014',
        url: 'https://beta.example/2',
        merchant: 'beta',
        domain: 'beta.example',
      }),
    ]);
    expect(labeled.map((s) => s.independenceStatus)).toEqual(['UNIQUE', 'UNIQUE']);
  });

  it('mismo productId + merchant → 1 UNIQUE', () => {
    const labeled = assignSampleIndependence([
      sample({
        title: 'A',
        url: 'https://a.example/1',
        merchant: 'shop',
        productId: 'G123',
      }),
      sample({
        title: 'B',
        url: 'https://b.example/2',
        merchant: 'shop',
        productId: 'G123',
      }),
    ]);
    expect(labeled[1]!.independenceStatus).toBe('DUPLICATE');
  });

  it('classify sigue exigiendo compatibilidad (no se relaja)', () => {
    const classified = classifyRawHit(
      hit('Calavera izquierda Nissan Altima 2014 $2200', 2200),
      altima,
    );
    expect(classified.ok).toBe(false);
  });
});
