import { parseVisionDamageItems } from './vision-item-normalize';
import {
  inventoryItemsToVehicleAnalysis,
  mergeVisionIntoPriorInventory,
} from './quote-cart-analysis';
import { resolveMarketVehicleText } from './vision-bpc-inventory';
import { parseVehiclePartIdentity } from './refaccion-market/parse-vehicle-part-identity';
import { createRefaccionMarketService } from './refaccion-market/refaccion-market.orchestrator';
import { applyMarketEstimateToItem } from './refaccion-market/apply-estimate-to-item';
import { inferTreatmentDecision } from './piece-treatment';
import {
  quoteRowsFromDamageInventory,
} from './draft-quote-inventory-pricing';
import { draftQuoteLinesToClientePiezaRows } from './draft-quote-resume';
import { INCIERTO_SUBSTITUTION_DISCLAIMER } from './piece-treatment';
import { buildDraftQuoteLinesFromDamageInventory } from './draft-quote-inventory-pricing';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import type { DetectedDamageItem } from './entities/chat.entity';
import type {
  RawProviderHit,
  RefaccionPriceProvider,
  VehiclePartIdentity,
} from './refaccion-market/refaccion-market.types';

function mockPricingSnap(
  prices: Record<string, number>,
): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: (canonical: string, level: string) =>
      prices[`${canonical}|${level}`] ?? 0,
    getAmount: (pieza: string, level: string) =>
      prices[`${pieza}|${level}`] ?? 0,
    getDiasEntregaForCanonical: () => 5,
    listSeveridadesForCanonical: () => ['DL', 'DMFuerte', 'MONTAJE_PINTURA'],
  } as MatrixPricingSnapshot;
}

const snap = mockPricingSnap({
  'Cofre|DMFuerte': 7650,
  'Cofre|DL': 4500,
  'Fascia|MONTAJE_PINTURA': 2900,
  'Fascia|DL': 2900,
});

function fdHits(): RawProviderHit[] {
  const titles = [
    'Fascia delantera Mazda 3 2019-2023 aftermarket $8200',
    'Defensa Mazda 3 2020 aftermarket $8500',
    'Bumper Mazda 3 2020 nuevo $9200',
    'Fascia Mazda 3 2019 a 2023 $9800',
    'Fascia delantera Mazda3 2020 $10200',
  ];
  const prices = [8200, 8500, 9200, 9800, 10200];
  return titles.map((title, i) => ({
    provider: i % 2 === 0 ? 'MERCADO_LIBRE' : 'GOOGLE_WEB',
    title,
    price: prices[i]!,
    url: `https://shop.example/fd-${i}`,
    snippet: title,
    condition: 'NEW' as const,
    query: 'Fascia delantera Mazda 3 2020 precio nuevo México',
    retrievedAt: '2026-09-11T00:00:00.000Z',
  }));
}

describe('regresión Mazda 3 2020 FD + Cofre (visión estructurada)', () => {
  const visionJson = {
    vehiculo_detectado: 'Mazda 3 2020',
    peritaje_viable: true,
    items: [
      {
        pieza: 'FD',
        severidad: 'DMFuerte',
        descripcionTecnica: 'Fascia delantera con daño severo',
        tipo_dano: 'SUSTITUCION',
        requiere_refaccion: true,
        posible_reemplazo_refaccion: true,
        urls_origen: ['https://cdn.example/1.jpg'],
      },
      {
        pieza: 'Cofre',
        severidad: 'DMFuerte',
        descripcionTecnica: 'Abolladura con posible reemplazo de refacción',
        tipo_dano: 'REPARACION',
        requiere_refaccion: false,
        posible_reemplazo_refaccion: true,
        urls_origen: ['https://cdn.example/2.jpg'],
      },
    ],
  };

  it('FD SUSTITUIR + Cofre REPARAR; Mazda 3 2020 llega al orchestrator', async () => {
    const parsed = parseVisionDamageItems(visionJson);
    expect(parsed.find((i) => i.pieza === 'FD')?.tratamiento).toBe('SUSTITUIR');
    expect(parsed.find((i) => i.pieza === 'Cofre')?.tratamiento).toBe('REPARAR');

    const merged = mergeVisionIntoPriorInventory([], parsed);
    const analysis = inventoryItemsToVehicleAnalysis(
      merged.mergedInventory,
      [],
      String(visionJson.vehiculo_detectado),
    );
    expect(analysis.vehiculoDetectado).toBe('Mazda 3 2020');

    const seen: VehiclePartIdentity[] = [];
    const recordingProvider: RefaccionPriceProvider = {
      id: 'GOOGLE_WEB',
      async search(identity) {
        seen.push(identity);
        return identity.pieza === 'FD' ? fdHits() : [];
      },
    };
    const market = createRefaccionMarketService({
      providers: [recordingProvider],
    });

    const next: DetectedDamageItem[] = [];
    for (const it of analysis.inventory ?? []) {
      const tratamiento = inferTreatmentDecision(it, analysis.inventory ?? []);
      if (tratamiento !== 'SUSTITUIR') {
        next.push({ ...it, tratamiento });
        continue;
      }
      const identity = parseVehiclePartIdentity({
        vehiculoText: resolveMarketVehicleText(analysis),
        pieza: it.pieza,
      });
      const estimate = await market.estimate(identity);
      next.push(
        applyMarketEstimateToItem({ ...it, tratamiento: 'SUSTITUIR' }, estimate),
      );
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      marca: 'Mazda',
      modelo: '3',
      anio: '2020',
      pieza: 'FD',
      confirmed: true,
    });
    expect(seen[0]!.piezaLabel).toMatch(/fascia/i);

    const fdItem = next.find((i) => i.pieza === 'FD');
    expect(fdItem?.tratamiento).toBe('SUSTITUIR');
    expect(fdItem?.pricingStatus).toBe('OK');
    expect(Number(fdItem?.precioMx)).toBeGreaterThan(0);

    const cofreItem = next.find((i) => i.pieza === 'Cofre');
    expect(cofreItem?.tratamiento).toBe('REPARAR');
    expect(cofreItem?.posibleReemplazoRefaccion).toBe(true);

    const rows = quoteRowsFromDamageInventory(next, snap);
    const fdRef = rows.find(
      (r) => r.serviceType === 'REFACCION' && r.physicalPanelKey === 'FD',
    );
    const fdMontaje = rows.find(
      (r) => r.serviceType === 'MONTAJE_PINTURA' && r.physicalPanelKey === 'FD',
    );
    const cofreRepair = rows.find(
      (r) =>
        r.serviceType === 'REPARACION_PINTURA' && r.physicalPanelKey === 'Cofre',
    );
    const cofreMontaje = rows.find(
      (r) =>
        r.serviceType === 'MONTAJE_PINTURA' && r.physicalPanelKey === 'Cofre',
    );

    expect(fdRef).toBeDefined();
    expect(fdMontaje).toBeDefined();
    expect(fdRef?.billable).toBe(true);
    expect(cofreRepair?.tratamiento).toBe('REPARAR');
    expect(cofreRepair?.severidad).toBe('DMFuerte');
    expect(cofreRepair?.precioMx).toBeGreaterThan(4500);
    expect(cofreRepair?.disclaimer).toBe(INCIERTO_SUBSTITUTION_DISCLAIMER);
    expect(cofreMontaje).toBeUndefined();
  });

  it('SUSTITUIR sin muestra deja REFACCION visible y no un total cerrado', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        {
          pieza: 'FD',
          severidad: 'DMFuerte',
          descripcionTecnica: 'Fascia',
          urls_origen: [],
          tratamiento: 'SUSTITUIR',
          pricingStatus: 'INSUFFICIENT_MARKET_SAMPLE',
          priceSource: 'INSUFFICIENT_MARKET_SAMPLE',
        },
      ],
      snap,
    );
    const refaccion = rows.find((r) => r.serviceType === 'REFACCION');
    const montaje = rows.find((r) => r.serviceType === 'MONTAJE_PINTURA');
    expect(refaccion?.billable).toBe(false);
    expect(refaccion?.description).toMatch(
      /precio pendiente de estimaci[oó]n/i,
    );
    expect(montaje?.precioMx).toBe(2900);

    const clientRows = draftQuoteLinesToClientePiezaRows(
      buildDraftQuoteLinesFromDamageInventory(
        [
          {
            pieza: 'FD',
            severidad: 'DMFuerte',
            descripcionTecnica: 'Fascia',
            urls_origen: [],
            tratamiento: 'SUSTITUIR',
            pricingStatus: 'INSUFFICIENT_MARKET_SAMPLE',
            priceSource: 'INSUFFICIENT_MARKET_SAMPLE',
          },
        ],
        snap,
      ),
    );
    expect(
      clientRows.some((r) =>
        /precio pendiente de estimaci/i.test(r.description ?? ''),
      ),
    ).toBe(true);
    expect(clientRows.some((r) => r.serviceType === 'MONTAJE_PINTURA')).toBe(
      true,
    );
  });
});
