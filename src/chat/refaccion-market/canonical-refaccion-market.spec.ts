import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyCustomerMargin } from './compute-market-range';
import { enrichInventoryWithMarketRefacciones } from './enrich-inventory-with-market';
import { parseVehiclePartIdentity } from './parse-vehicle-part-identity';
import { runRefaccionMarketPipeline } from './refaccion-market.orchestrator';
import { REFACCION_MARKET_EVENTS } from './refaccion-market-events';
import type {
  RefaccionMarketEstimate,
  RefaccionPriceProvider,
  VehiclePartIdentity,
} from './refaccion-market.types';
import { createRefaccionMarketService } from './refaccion-market.orchestrator';
import { buildCanonicalQuoteV1 } from '../canonical-quote-engine';
import { quoteRowsFromDamageInventory } from '../draft-quote-inventory-pricing';
import { canonicalPhysicalPanelKey } from '../piece-treatment';
import { peritajeFromLegacyAnalysis } from '../../domain/peritaje-v1';
import type { DetectedDamageItem } from '../entities/chat.entity';
import type { MatrixPricingSnapshot } from '../../catalog/matrix-pricing-snapshot';
import type { RawProviderHit } from './refaccion-market.types';

function snap(prices: Record<string, number> = {}): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: (canonical: string, level: string) =>
      prices[`${canonical}|${level}`] ?? prices[canonical] ?? 0,
    getAmount: (pieza: string, level: string) =>
      prices[`${pieza}|${level}`] ?? prices[pieza] ?? 0,
    getDiasEntregaForCanonical: () => 5,
    listSeveridadesForCanonical: () => ['DL', 'MONTAJE_PINTURA'],
  } as MatrixPricingSnapshot;
}

function item(
  overrides: Partial<DetectedDamageItem> & Pick<DetectedDamageItem, 'pieza'>,
): DetectedDamageItem {
  return {
    severidad: 'DMFuerte',
    descripcionTecnica: 'destruido',
    urls_origen: ['https://cdn.example/a.jpg'],
    tratamiento: 'SUSTITUIR',
    ...overrides,
  };
}

function peritajeFrom(items: DetectedDamageItem[]) {
  return peritajeFromLegacyAnalysis({
    conversationId: 'c1',
    tallerId: 't1',
    peritajeId: 'per_refaccion_market',
    now: '2026-09-11T00:00:00.000Z',
    canonicalizePanel: canonicalPhysicalPanelKey,
    analysis: {
      vehiculoDetectado: 'Mazda 3 2020',
      inventory: items,
    },
  });
}

function readyEstimate(
  identity: VehiclePartIdentity,
  central = 10000,
): RefaccionMarketEstimate {
  const market = {
    precioMinEstimado: 9000,
    precioMaxEstimado: 11000,
    precioCentral: central,
  };
  return {
    pricingType: 'RANGE',
    pricingStatus: 'OK',
    marketPriceRange: market,
    customerPriceRange: applyCustomerMargin(market),
    cantidadMuestras: 5,
    cantidadDominios: 3,
    providersUsed: ['GOOGLE_WEB'],
    priceSource: 'WEB_MARKET_ESTIMATE',
    confidence: 'MEDIUM',
    partTypeGroup: 'AFTERMARKET_NEW',
    samples: [],
    identity,
    query: `${identity.piezaLabel} ${identity.marca} ${identity.modelo} ${identity.anio}`,
  };
}

function insufficientEstimate(
  identity: VehiclePartIdentity,
): RefaccionMarketEstimate {
  return {
    pricingType: 'NONE',
    pricingStatus: 'INSUFFICIENT_MARKET_SAMPLE',
    cantidadMuestras: 0,
    cantidadDominios: 0,
    providersUsed: [],
    priceSource: 'INSUFFICIENT_MARKET_SAMPLE',
    confidence: 'LOW',
    partTypeGroup: null,
    samples: [],
    identity,
    query: identity.piezaLabel,
  };
}

describe('CANONICAL REFACCION = solo mercado', () => {
  const montajeSnap = snap({
    'Cofre|MONTAJE_PINTURA': 4000,
    'Cofre|DL': 3500,
  });

  it('1. SUSTITUIR siempre intenta market research', async () => {
    const identities: VehiclePartIdentity[] = [];
    const events: string[] = [];
    const service = {
      estimate: async (identity: VehiclePartIdentity) => {
        identities.push(identity);
        return insufficientEstimate(identity);
      },
    };
    await enrichInventoryWithMarketRefacciones(
      {
        pieza: 'Cofre',
        severidad: 'DMFuerte',
        descripcionTecnica: '',
        justificacion: '',
        partesAfectadas: ['Cofre'],
        severidadDelDano: 'DMFuerte',
        vehiculoDetectado: 'Mazda 3 2020',
        inventory: [item({ pieza: 'Cofre', precioMx: 99999 })],
      },
      service as never,
      (event) => events.push(event),
    );
    expect(identities).toHaveLength(1);
    expect(events).toContain(REFACCION_MARKET_EVENTS.SEARCH_STARTED);
  });

  it('2. precio manual en refaccion_catalog no afecta quote CANONICAL', async () => {
    const catalogManual = 4940;
    const service = {
      estimate: async (identity: VehiclePartIdentity) =>
        insufficientEstimate(identity),
    };
    const enriched = await enrichInventoryWithMarketRefacciones(
      {
        pieza: 'Cofre',
        severidad: 'DMFuerte',
        descripcionTecnica: '',
        justificacion: '',
        partesAfectadas: ['Cofre'],
        severidadDelDano: 'DMFuerte',
        vehiculoDetectado: 'Mazda 3 2020',
        inventory: [
          item({
            pieza: 'Cofre',
            precioMx: catalogManual,
            priceSource: 'AUTOFIX_CATALOG',
          }),
        ],
      },
      service as never,
    );
    expect(enriched.inventory?.[0]?.precioMx).toBe(0);
    expect(enriched.inventory?.[0]?.priceSource).toBe(
      'INSUFFICIENT_MARKET_SAMPLE',
    );

    const built = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(enriched.inventory ?? []),
      pricedInventory: enriched.inventory ?? [],
      snap: montajeSnap,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const refaccion = built.quote.lines.find((l) => l.serviceType === 'REFACCION');
    expect(refaccion?.amount).toBe(0);
    expect(refaccion?.billable).toBe(false);
    expect(refaccion?.amount).not.toBe(catalogManual);
  });

  it('3. market suficiente → REFACCION billable', async () => {
    const service = {
      estimate: async (identity: VehiclePartIdentity) =>
        readyEstimate(identity, 10000),
    };
    const enriched = await enrichInventoryWithMarketRefacciones(
      {
        pieza: 'Cofre',
        severidad: 'DMFuerte',
        descripcionTecnica: '',
        justificacion: '',
        partesAfectadas: ['Cofre'],
        severidadDelDano: 'DMFuerte',
        vehiculoDetectado: 'Mazda 3 2020',
        inventory: [item({ pieza: 'Cofre' })],
      },
      service as never,
    );
    const built = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(enriched.inventory ?? []),
      pricedInventory: enriched.inventory ?? [],
      snap: montajeSnap,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const refaccion = built.quote.lines.find((l) => l.serviceType === 'REFACCION')!;
    expect(refaccion.pricingSource).toBe('WEB_MARKET_ESTIMATE');
    expect(refaccion.billable).toBe(true);
    expect(refaccion.amount).toBeGreaterThan(0);
    expect(built.quote.isPartial).toBe(false);
  });

  it('4. market insuficiente → REFACCION no billable + isPartial', async () => {
    const service = {
      estimate: async (identity: VehiclePartIdentity) =>
        insufficientEstimate(identity),
    };
    const enriched = await enrichInventoryWithMarketRefacciones(
      {
        pieza: 'Cofre',
        severidad: 'DMFuerte',
        descripcionTecnica: '',
        justificacion: '',
        partesAfectadas: ['Cofre'],
        severidadDelDano: 'DMFuerte',
        vehiculoDetectado: 'Mazda 3 2020',
        inventory: [item({ pieza: 'Cofre' })],
      },
      service as never,
    );
    const built = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(enriched.inventory ?? []),
      pricedInventory: enriched.inventory ?? [],
      snap: montajeSnap,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const refaccion = built.quote.lines.find((l) => l.serviceType === 'REFACCION')!;
    expect(refaccion.amount).toBe(0);
    expect(refaccion.billable).toBe(false);
    expect(refaccion.pricingStatus).toBe('INSUFFICIENT_MARKET_SAMPLE');
    expect(built.quote.isPartial).toBe(true);
    expect(refaccion.description).toMatch(/pendiente de estimación/i);
  });

  it('5. MONTAJE_PINTURA sigue cobrando cuando market es insuficiente', async () => {
    const service = {
      estimate: async (identity: VehiclePartIdentity) =>
        insufficientEstimate(identity),
    };
    const enriched = await enrichInventoryWithMarketRefacciones(
      {
        pieza: 'Cofre',
        severidad: 'DMFuerte',
        descripcionTecnica: '',
        justificacion: '',
        partesAfectadas: ['Cofre'],
        severidadDelDano: 'DMFuerte',
        vehiculoDetectado: 'Mazda 3 2020',
        inventory: [item({ pieza: 'Cofre' })],
      },
      service as never,
    );
    const built = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(enriched.inventory ?? []),
      pricedInventory: enriched.inventory ?? [],
      snap: montajeSnap,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const montaje = built.quote.lines.find(
      (l) => l.serviceType === 'MONTAJE_PINTURA',
    )!;
    expect(montaje.amount).toBe(4000);
    expect(montaje.billable).toBe(true);
    expect(built.quote.total).toBe(4000);
  });

  it('6. vehicle make/model/year llegan a la búsqueda', async () => {
    let seen: VehiclePartIdentity | null = null;
    const provider: RefaccionPriceProvider = {
      id: 'GOOGLE_WEB',
      search: async (identity) => {
        seen = identity;
        return [];
      },
    };
    const market = createRefaccionMarketService({
      providers: [provider],
    });
    await market.estimate(
      parseVehiclePartIdentity({
        vehiculoText: 'Mazda 3 2020',
        pieza: 'Cofre',
      }),
    );
    expect(seen?.marca).toMatch(/mazda/i);
    expect(seen?.modelo).toMatch(/3/);
    expect(seen?.anio).toBe('2020');
    expect(seen?.version).toBeNull();
  });

  it('7. falta de compatibilidad no reutiliza precio genérico', () => {
    const identity = parseVehiclePartIdentity({
      vehiculoText: 'Mazda 3 2020',
      pieza: 'Cofre',
    });
    const events: string[] = [];
    const raw: RawProviderHit[] = [
      {
        provider: 'GOOGLE_WEB',
        title: 'Fascia Nissan Versa 2015 $2,900',
        price: 2900,
        url: 'https://shop.mx/generic',
        snippet: 'pieza genérica',
        query: 'Cofre',
        retrievedAt: '2026-09-11T00:00:00.000Z',
      },
    ];
    const estimate = runRefaccionMarketPipeline({
      identity,
      rawHits: raw,
      providersUsed: ['GOOGLE_WEB'],
      emit: (event) => events.push(event),
    });
    expect(events).toContain(REFACCION_MARKET_EVENTS.COMPATIBILITY_REJECTED);
    expect(estimate.pricingStatus).toBe('INSUFFICIENT_MARKET_SAMPLE');
    expect(estimate.customerPriceRange).toBeUndefined();
    expect(estimate.priceSource).not.toBe('AUTOFIX_CATALOG');
  });

  it('8. no se aplica doble margen', async () => {
    const identity = parseVehiclePartIdentity({
      vehiculoText: 'Mazda 3 2020',
      pieza: 'Cofre',
    });
    const estimate = readyEstimate(identity, 10000);
    const once = applyCustomerMargin(estimate.marketPriceRange!);
    const service = {
      estimate: async () => estimate,
    };
    const enriched = await enrichInventoryWithMarketRefacciones(
      {
        pieza: 'Cofre',
        severidad: 'DMFuerte',
        descripcionTecnica: '',
        justificacion: '',
        partesAfectadas: ['Cofre'],
        severidadDelDano: 'DMFuerte',
        vehiculoDetectado: 'Mazda 3 2020',
        inventory: [item({ pieza: 'Cofre' })],
      },
      service as never,
    );
    expect(enriched.inventory?.[0]?.precioMx).toBe(once.precioCentral);
    expect(enriched.inventory?.[0]?.precioMx).not.toBe(
      Math.round(once.precioCentral * 1.3),
    );
  });

  it('9. priceRange y marketEvidence sobreviven hasta CanonicalQuote', async () => {
    const service = {
      estimate: async (identity: VehiclePartIdentity) =>
        readyEstimate(identity, 10000),
    };
    const enriched = await enrichInventoryWithMarketRefacciones(
      {
        pieza: 'Cofre',
        severidad: 'DMFuerte',
        descripcionTecnica: '',
        justificacion: '',
        partesAfectadas: ['Cofre'],
        severidadDelDano: 'DMFuerte',
        vehiculoDetectado: 'Mazda 3 2020',
        inventory: [item({ pieza: 'Cofre' })],
      },
      service as never,
    );
    const built = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(enriched.inventory ?? []),
      pricedInventory: enriched.inventory ?? [],
      snap: montajeSnap,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const refaccion = built.quote.lines.find((l) => l.serviceType === 'REFACCION')!;
    expect(refaccion.priceRange?.central).toBeGreaterThan(0);
    expect(refaccion.marketEvidence?.sampleCount).toBe(5);
    expect(refaccion.marketEvidence?.domainCount).toBe(3);
    expect(refaccion.marketEvidence?.providersUsed).toEqual(['GOOGLE_WEB']);
    expect(refaccion.marketEvidence?.partTypeGroup).toBe('AFTERMARKET_NEW');
  });

  it('10. snapshot histórico con precio persistido se sigue leyendo', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        item({
          pieza: 'Cofre',
          precioMx: 7777,
          detallesRefaccion: 'Cofre histórico',
          priceSource: 'WEB_MARKET_ESTIMATE',
          pricingStatus: 'OK',
        }),
      ],
      montajeSnap,
    );
    const refaccion = rows.find((r) => r.serviceType === 'REFACCION');
    expect(refaccion?.precioMx).toBe(7777);
    expect(refaccion?.billable).toBe(true);
  });

  it('11. frontend ya no permite editar costo/margen/precio genérico', () => {
    const admin = readFileSync(
      join(process.cwd(), '../omnichannel-frontend/src/CatalogAdminPage.jsx'),
      'utf8',
    );
    expect(admin).not.toMatch(/RefaccionesCatalogTab/);
    expect(admin).not.toMatch(/costoReferenciaBase/);
    expect(admin).not.toMatch(/margenPorcentaje/);
    expect(admin).not.toMatch(/id: 'refacciones'/);
    expect(admin).toMatch(/mercado/);
  });
});
