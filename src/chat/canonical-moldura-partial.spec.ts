import {
  createQuoteLineId,
  peritajeFromLegacyAnalysis,
} from '../domain/peritaje-v1';
import {
  derivePartialQuoteReasons,
  renderCanonicalQuoteFinancialBlock,
} from '../domain/peritaje-v1/quote-narrative';
import { buildCanonicalQuoteV1 } from './canonical-quote-engine';
import { stampInventoryFromCanonicalPeritaje } from './canonical-identity';
import {
  buildPersistedDraftQuoteItemRows,
} from './quote-line-identity';
import { canonicalPhysicalPanelKey } from './piece-treatment';
import type { DetectedDamageItem } from './entities/chat.entity';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import { CANONICAL_TRACE_EVENTS } from './canonical-trace';

const PHOTO = 'https://cdn.example/byd-lateral.jpg';

function snap(prices: Record<string, number>): MatrixPricingSnapshot {
  const amountFor = (canonical: string) => {
    if (/salpicadera/i.test(canonical)) return prices.Salpicadera ?? 0;
    if (/fascia/i.test(canonical)) return prices.Fascia ?? 0;
    return prices[canonical] ?? 0;
  };
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: (canonical: string) => amountFor(canonical),
    getAmount: (pieza: string) => amountFor(pieza),
    getDiasEntregaForCanonical: () => 5,
    listSeveridadesForCanonical: () => ['DL', 'DM', 'DMFuerte', 'BASE', 'Mediano'],
    serviciosOrderedLongestFirst: ['Salpicadera', 'Fascia', 'FD', 'SI'],
  } as MatrixPricingSnapshot;
}

function item(
  overrides: Partial<DetectedDamageItem> & Pick<DetectedDamageItem, 'pieza'>,
): DetectedDamageItem {
  return {
    severidad: 'DM',
    descripcionTecnica: 'golpe',
    urls_origen: [PHOTO],
    tratamiento: 'REPARAR',
    treatmentSource: 'vision',
    treatmentReason: 'vision_structured',
    vehiculoDetectado: 'Toyota Avanza',
    ...overrides,
  };
}

function bydInventory(): DetectedDamageItem[] {
  return [
    item({
      pieza: 'SI',
      severidad: 'DL',
      descripcionTecnica: 'salpicadera izquierda abollada',
    }),
    item({
      pieza: 'FD',
      severidad: 'DL',
      descripcionTecnica: 'fascia delantera rayada',
    }),
    item({
      pieza: 'MOLDURA',
      moldingPosition: 'ARCO_DELANTERO_IZQUIERDO',
      finishType: 'NEGRA_TEXTURIZADA',
      tratamiento: 'INCIERTO',
      descripcionTecnica: 'moldura de arco negra texturizada desprendida',
    }),
  ];
}

const BYD_PRICES = {
  'Salpicadera|DM': 4650,
  Salpicadera: 4650,
  'Fascia|DM': 3900,
  Fascia: 3900,
};

describe('CANONICAL — parcial moldura + proyección de identidad', () => {
  it('BYD Song Plus: SI+FD cobrables, moldura pendiente, narrativa sin refacción inventada', () => {
    const inventoryIn = bydInventory();
    const peritaje = peritajeFromLegacyAnalysis({
      conversationId: 'c_byd',
      tallerId: 't1',
      peritajeId: 'per_byd',
      now: '2026-09-13T00:00:00.000Z',
      canonicalizePanel: canonicalPhysicalPanelKey,
      analysis: {
        vehiculoDetectado: 'Toyota Avanza',
        inventory: inventoryIn,
      },
    });
    const moldura = peritaje.damages.find((d) => d.pieceCode === 'MOLDURA')!;
    expect(moldura.physicalPanelKey).toBe(
      'MOLDURA::ARCO_DELANTERO_IZQUIERDO',
    );
    expect(moldura.moldingPosition).toBe('ARCO_DELANTERO_IZQUIERDO');
    expect(moldura.finishType).toBe('NEGRA_TEXTURIZADA');

    const inventory = stampInventoryFromCanonicalPeritaje(inventoryIn, peritaje);
    const stampedMoldura = inventory.find((it) => it.pieza === 'MOLDURA')!;
    expect(stampedMoldura.damageItemId).toBe(moldura.damageItemId);
    expect(stampedMoldura.physicalPanelKey).toBe(moldura.physicalPanelKey);
    expect(stampedMoldura.moldingPosition).toBe('ARCO_DELANTERO_IZQUIERDO');
    expect(stampedMoldura.finishType).toBe('NEGRA_TEXTURIZADA');

    const built = buildCanonicalQuoteV1({
      peritaje,
      pricedInventory: inventory,
      snap: snap(BYD_PRICES),
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const { quote } = built;
    const si = quote.lines.find((l) =>
      /salpicadera/i.test(l.description),
    );
    const fd = quote.lines.find((l) => /fascia/i.test(l.description));
    const moldLine = quote.lines.find(
      (l) => l.damageItemId === moldura.damageItemId,
    );
    expect(si?.serviceType).toBe('REPARACION_PINTURA');
    expect(si?.amount).toBe(4650);
    expect(si?.billable).toBe(true);
    expect(fd?.serviceType).toBe('REPARACION_PINTURA');
    expect(fd?.amount).toBe(3900);
    expect(fd?.billable).toBe(true);
    expect(moldLine?.serviceType).toBe('PENDIENTE');
    expect(moldLine?.amount).toBe(0);
    expect(moldLine?.billable).toBe(false);
    expect(quote.lines.some((l) => l.serviceType === 'REFACCION')).toBe(false);
    expect(quote.total).toBe(8550);
    expect(quote.isPartial).toBe(true);

    const reasons = derivePartialQuoteReasons(quote, peritaje);
    expect(reasons.map((r) => r.code)).toContain(
      'MOLDURA_NO_PINTABLE_REQUIERE_REVISION',
    );
    expect(reasons.map((r) => r.code)).not.toContain(
      'INSUFFICIENT_MARKET_SAMPLE',
    );

    const block = renderCanonicalQuoteFinancialBlock(quote, peritaje);
    expect(block.totalText).toMatch(/Subtotal parcial/);
    expect(block.totalText).toContain('$8,550');
    expect(block.totalText).toMatch(/pendiente de valoraci[oó]n/);
    expect(block.totalText).not.toMatch(/falta el precio de refacci[oó]n/i);
    expect(block.totalText).not.toMatch(/montaje\/pintura no cubre/i);

    const ql = createQuoteLineId({
      damageItemId: moldura.damageItemId,
      serviceType: 'PENDIENTE',
    });
    expect(moldLine?.quoteLineId).toBe(ql);
    const { rows, divergences } = buildPersistedDraftQuoteItemRows({
      lines: quote.lines.map((l) => ({
        damageItemId: l.damageItemId,
        quoteLineId: l.quoteLineId,
        serviceType: l.serviceType,
        subtotal: l.amount,
      })),
      inventory,
      canonicalPeritaje: peritaje,
    });
    expect(divergences.filter((d) => d.code === 'ORPHAN_QUOTE_LINE')).toEqual(
      [],
    );
    expect(rows.every((r) => r.damageItemId)).toBe(true);
    expect(rows.find((r) => r.damageItemId === moldura.damageItemId)?.quoteLineId).toBe(
      ql,
    );
  });

  it('SI/FD pricing no cambia al agregar moldura pendiente', () => {
    const withoutMoldura = [
      item({ pieza: 'SI', severidad: 'DL' }),
      item({ pieza: 'FD', severidad: 'DL' }),
    ];
    const withMoldura = bydInventory();
    const peritajeSolo = peritajeFromLegacyAnalysis({
      conversationId: 'c_sifd',
      canonicalizePanel: canonicalPhysicalPanelKey,
      analysis: { vehiculoDetectado: 'Toyota Avanza', inventory: withoutMoldura },
    });
    const peritajeFull = peritajeFromLegacyAnalysis({
      conversationId: 'c_sifd2',
      canonicalizePanel: canonicalPhysicalPanelKey,
      analysis: { vehiculoDetectado: 'Toyota Avanza', inventory: withMoldura },
    });
    const pricing = snap(BYD_PRICES);
    const a = buildCanonicalQuoteV1({
      peritaje: peritajeSolo,
      pricedInventory: stampInventoryFromCanonicalPeritaje(
        withoutMoldura,
        peritajeSolo,
      ),
      snap: pricing,
    });
    const b = buildCanonicalQuoteV1({
      peritaje: peritajeFull,
      pricedInventory: stampInventoryFromCanonicalPeritaje(
        withMoldura,
        peritajeFull,
      ),
      snap: pricing,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const amountOf = (
      quote: typeof a.quote,
      re: RegExp,
    ) => quote.lines.find((l) => re.test(l.description))?.amount;
    expect(amountOf(a.quote, /salpicadera/i)).toBe(4650);
    expect(amountOf(b.quote, /salpicadera/i)).toBe(4650);
    expect(amountOf(a.quote, /fascia/i)).toBe(3900);
    expect(amountOf(b.quote, /fascia/i)).toBe(3900);
    expect(
      a.quote.lines.every((l) => l.serviceType === 'REPARACION_PINTURA'),
    ).toBe(true);
  });

  it('refacción insuficiente SÍ menciona mercado; moldura negra no', () => {
    const refaccionQuote = {
      schemaVersion: 'quote.v1' as const,
      quoteId: 'q_ref',
      peritajeId: 'p',
      generatedAt: '2026-09-13T00:00:00.000Z',
      subtotal: 3400,
      total: 3400,
      isPartial: true,
      warnings: ['REFACCION_PENDIENTE_DE_COTIZAR'],
      lines: [
        {
          quoteLineId: 'ql_ref',
          damageItemId: 'dmg_fd',
          vehicleId: 'veh_1',
          serviceType: 'REFACCION' as const,
          description: 'fascia delantera',
          billable: false,
          amount: 0,
          pricingStatus: 'INSUFFICIENT_MARKET_SAMPLE' as const,
          pricingSource: 'INSUFFICIENT_MARKET_SAMPLE' as const,
          confidence: 'HIGH' as const,
        },
        {
          quoteLineId: 'ql_m',
          damageItemId: 'dmg_fd',
          vehicleId: 'veh_1',
          serviceType: 'MONTAJE_PINTURA' as const,
          description: 'fascia delantera',
          billable: true,
          amount: 3400,
          confidence: 'HIGH' as const,
        },
      ],
    };
    const block = renderCanonicalQuoteFinancialBlock(refaccionQuote);
    expect(block.totalText).toMatch(/estimaci[oó]n de mercado/);
  });

  it('CANONICAL_IDENTITY_PROJECTION_MISMATCH se registra sin bloquear', () => {
    const prev = process.env.PEG_CANONICAL_TRACE;
    process.env.PEG_CANONICAL_TRACE = '1';
    const logs: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map(String).join(' '));
    });
    try {
      const inv = [
        item({
          pieza: 'MOLDURA',
          moldingPosition: 'ARCO_DELANTERO_IZQUIERDO',
          finishType: 'NEGRA_TEXTURIZADA',
        }),
      ];
      const peritaje = peritajeFromLegacyAnalysis({
        conversationId: 'c_mm',
        canonicalizePanel: canonicalPhysicalPanelKey,
        analysis: { vehiculoDetectado: 'Toyota Avanza', inventory: inv },
      });
      const damage = peritaje.damages[0]!;
      const mismatched = item({
        pieza: 'MOLDURA',
        damageItemId: damage.damageItemId,
        vehicleId: damage.vehicleId,
        physicalPanelKey: 'MOLDURA::UNKNOWN',
      });
      const stamped = stampInventoryFromCanonicalPeritaje(
        [mismatched],
        peritaje,
      );
      expect(stamped[0]?.physicalPanelKey).toBe(
        'MOLDURA::ARCO_DELANTERO_IZQUIERDO',
      );
      expect(
        logs.some((l) =>
          l.includes(CANONICAL_TRACE_EVENTS.CANONICAL_IDENTITY_PROJECTION_MISMATCH),
        ),
      ).toBe(true);
    } finally {
      spy.mockRestore();
      if (prev == null) delete process.env.PEG_CANONICAL_TRACE;
      else process.env.PEG_CANONICAL_TRACE = prev;
    }
  });
});
