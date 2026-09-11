import { parseVehiclePartIdentity } from './parse-vehicle-part-identity';
import { listingYearCompatible, validateListingAgainstIdentity } from './validate-market-sample';
import { normalizeRawHit } from './normalize-market-sample';
import { dedupeMarketSamples } from './dedupe-market-samples';
import {
  applyCustomerMargin,
  buildMarketEstimate,
  pickPartTypeGroup,
} from './compute-market-range';
import { runRefaccionMarketPipeline } from './refaccion-market.orchestrator';
import type { RawProviderHit } from './refaccion-market.types';

const mazdaCofre = parseVehiclePartIdentity({
  vehiculoText: 'Mazda 3 2020',
  pieza: 'Cofre',
});

function hit(
  title: string,
  price: number,
  opts?: Partial<RawProviderHit>,
): RawProviderHit {
  return {
    provider: opts?.provider ?? 'GOOGLE_WEB',
    title,
    price,
    url: opts?.url ?? `https://shop.example/${price}`,
    snippet: opts?.snippet ?? title,
    condition: opts?.condition,
    externalId: opts?.externalId,
    query: 'Cofre Mazda 3 2020 precio nuevo México',
    retrievedAt: '2026-09-11T00:00:00.000Z',
    ...opts,
  };
}

describe('refaccion-market pipeline', () => {
  it('parsea Mazda 3 2020 + Cofre', () => {
    expect(mazdaCofre.marca).toMatch(/mazda/i);
    expect(mazdaCofre.modelo).toMatch(/3/);
    expect(mazdaCofre.anio).toBe('2020');
    expect(mazdaCofre.piezaLabel).toBe('Cofre');
    expect(mazdaCofre.confirmed).toBe(true);
  });

  it('año: rango explícito sí, año vecino suelto no', () => {
    expect(
      listingYearCompatible('Cofre Mazda 3 2019-2023', '', '2020'),
    ).toBe(true);
    expect(
      listingYearCompatible('Cofre Mazda 3 2019 a 2023', '', '2020'),
    ).toBe(true);
    expect(listingYearCompatible('Cofre Mazda 3 2020', '', '2020')).toBe(true);
    expect(listingYearCompatible('Cofre Mazda 3 2019', '', '2020')).toBe(false);
    expect(listingYearCompatible('Cofre Mazda 3 2021', '', '2020')).toBe(false);
  });

  it('rechaza bisagra y cubre cofre', () => {
    expect(
      validateListingAgainstIdentity(
        'Bisagra cofre Mazda 3 2020',
        '',
        mazdaCofre,
      ).ok,
    ).toBe(false);
    expect(
      validateListingAgainstIdentity('Cubre cofre Mazda 3 2020', '', mazdaCofre)
        .ok,
    ).toBe(false);
  });

  it('no mezcla OEM_NEW con AFTERMARKET_NEW', () => {
    const after = [8200, 8500, 9000, 9500, 11000].map((p, i) =>
      normalizeRawHit(
        hit(`Cofre aftermarket Mazda 3 2020 $${p}`, p, {
          url: `https://refac.mx/a${i}`,
        }),
        mazdaCofre,
      ),
    );
    const oem = [18000, 19000, 20000, 21000].map((p, i) =>
      normalizeRawHit(
        hit(`Cofre OEM original Mazda 3 2020 $${p}`, p, {
          url: `https://oem.mx/${i}`,
          condition: 'NEW',
        }),
        mazdaCofre,
      ),
    );
    const samples = [...after, ...oem].filter((s): s is NonNullable<typeof s> => s != null);
    const picked = pickPartTypeGroup(samples);
    expect(picked.group).toBe('AFTERMARKET_NEW');
    expect(picked.members.every((s) => s.partType === 'AFTERMARKET_NEW')).toBe(
      true,
    );
  });

  it('deduplica la misma publicación ML vista por Google y por API', () => {
    const a = normalizeRawHit(
      hit('Cofre Mazda 3 2019-2023 $9200', 9200, {
        provider: 'MERCADO_LIBRE',
        url: 'https://articulo.mercadolibre.com.mx/MLM-123',
        externalId: 'MLM123',
      }),
      mazdaCofre,
    );
    const b = normalizeRawHit(
      hit('Cofre Mazda 3 2019-2023 $9200', 9200, {
        provider: 'GOOGLE_WEB',
        url: 'https://articulo.mercadolibre.com.mx/MLM-123?utm=x',
        externalId: 'MLM123',
      }),
      mazdaCofre,
    );
    const unique = dedupeMarketSamples([a!, b!]);
    expect(unique).toHaveLength(1);
  });

  it('Mazda 3 2020 Cofre: crudos → marketPriceRange → customerPriceRange', () => {
    const raw: RawProviderHit[] = [
      hit('Cofre Mazda 3 2019-2023 nuevo $8,200', 8200, {
        provider: 'MERCADO_LIBRE',
        url: 'https://articulo.mercadolibre.com.mx/MLM-1',
        externalId: 'MLM1',
        condition: 'NEW',
      }),
      hit('Cofre Mazda 3 2020 aftermarket $8,500', 8500, {
        provider: 'GOOGLE_WEB',
        url: 'https://refaccionaria.mx/cofre-mazda3-2020',
      }),
      hit('Cofre Mazda3 2020 nuevo $9,200', 9200, {
        provider: 'GOOGLE_WEB',
        url: 'https://autopartes.mx/cofre-2020',
      }),
      hit('Cofre Mazda 3 2020 aftermarket $10,200', 10200, {
        provider: 'GOOGLE_WEB',
        url: 'https://refac2.mx/cofre-mazda3',
      }),
      hit('Cofre Mazda 3 2019 a 2023 $9,800', 9800, {
        provider: 'MERCADO_LIBRE',
        url: 'https://articulo.mercadolibre.com.mx/MLM-2',
        externalId: 'MLM2',
        condition: 'NEW',
      }),
      hit('Cofre Mazda 3 2020 $11,500', 11500, {
        provider: 'GOOGLE_WEB',
        url: 'https://shop.mx/cofre-mazda-3',
      }),
      hit('Bisagra cofre Mazda 3 2020 $450', 450, {
        url: 'https://shop.mx/bisagra',
      }),
      hit('Cubre cofre Mazda 3 2020 $890', 890, {
        url: 'https://shop.mx/cubre',
      }),
      hit('Cofre Mazda 3 2019 $4,200', 4200, {
        url: 'https://shop.mx/2019-only',
      }),
      hit('Cofre OEM original Mazda 3 2020 $18,900', 18900, {
        url: 'https://oem.mx/cofre',
        condition: 'NEW',
      }),
    ];

    const estimate = runRefaccionMarketPipeline({
      identity: mazdaCofre,
      rawHits: raw,
      providersUsed: ['MERCADO_LIBRE', 'GOOGLE_WEB'],
    });

    expect(estimate.pricingStatus).toBe('OK');
    expect(estimate.pricingType).toBe('RANGE');
    expect(estimate.priceSource).toBe('WEB_MARKET_ESTIMATE');
    expect(estimate.partTypeGroup).toBe('AFTERMARKET_NEW');
    expect(estimate.cantidadMuestras).toBeGreaterThanOrEqual(4);
    expect(estimate.cantidadDominios).toBeGreaterThanOrEqual(2);
    expect(estimate.providersUsed).toEqual(
      expect.arrayContaining(['MERCADO_LIBRE', 'GOOGLE_WEB']),
    );
    expect(estimate.samples.every((s) => s.partType === 'AFTERMARKET_NEW')).toBe(
      true,
    );

    const market = estimate.marketPriceRange!;
    expect(market.precioMinEstimado).toBeGreaterThanOrEqual(8000);
    expect(market.precioMaxEstimado).toBeLessThanOrEqual(12000);
    expect(market.precioCentral).toBeGreaterThanOrEqual(market.precioMinEstimado);
    expect(market.precioCentral).toBeLessThanOrEqual(market.precioMaxEstimado);

    const customer = estimate.customerPriceRange!;
    const expectedCustomer = applyCustomerMargin(market);
    expect(customer).toEqual(expectedCustomer);
    expect(customer.precioCentral).toBeGreaterThan(market.precioCentral);
  });

  it('INSUFFICIENT_MARKET_SAMPLE si hay menos de 4 válidas', () => {
    const estimate = buildMarketEstimate({
      identity: mazdaCofre,
      query: 'Cofre Mazda 3 2020',
      providersUsed: ['GOOGLE_WEB'],
      samples: [8200, 8500].map((p, i) =>
        normalizeRawHit(
          hit(`Cofre Mazda 3 2020 $${p}`, p, { url: `https://a.mx/${i}` }),
          mazdaCofre,
        )!,
      ),
    });
    expect(estimate.pricingStatus).toBe('INSUFFICIENT_MARKET_SAMPLE');
    expect(estimate.pricingType).toBe('NONE');
    expect(estimate.marketPriceRange).toBeUndefined();
    expect(estimate.customerPriceRange).toBeUndefined();
    expect(estimate.priceSource).toBe('INSUFFICIENT_MARKET_SAMPLE');
  });
});
