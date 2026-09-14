import {
  mergeDamageEvidenceStatus,
  parseDamageEvidenceStatus,
  resolveDamageEvidenceStatusForPricing,
} from './damage-evidence';
import { parseVisionDamageItems } from '../chat/vision-item-normalize';
import { quoteRowsFromDamageInventory } from '../chat/draft-quote-inventory-pricing';
import { buildCanonicalQuoteV1 } from '../chat/canonical-quote-engine';
import { peritajeFromLegacyAnalysis } from '../domain/peritaje-v1/from-legacy';
import { canonicalPhysicalPanelKey } from '../chat/piece-treatment';
import {
  derivePartialQuoteReasons,
  renderCanonicalQuoteFinancialBlock,
} from '../domain/peritaje-v1/quote-narrative';
import type { DetectedDamageItem } from '../chat/entities/chat.entity';
import type { MatrixPricingSnapshot } from './matrix-pricing-snapshot';
import { CANONICAL_TRACE_EVENTS } from '../chat/canonical-trace';

function snap(prices: Record<string, number> = {}): MatrixPricingSnapshot {
  const amountFor = (canonical: string) => {
    if (/salpicadera/i.test(canonical)) return prices.Salpicadera ?? 0;
    if (/fascia/i.test(canonical)) return prices.Fascia ?? 0;
    if (/cofre/i.test(canonical)) return prices.Cofre ?? 0;
    return prices[canonical] ?? 0;
  };
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: (canonical: string) => amountFor(canonical),
    getAmount: (pieza: string) => amountFor(pieza),
    getDiasEntregaForCanonical: () => 5,
    listSeveridadesForCanonical: () => ['DL', 'DM', 'MONTAJE_PINTURA'],
    serviciosOrderedLongestFirst: ['Salpicadera', 'Fascia', 'Cofre'],
  } as MatrixPricingSnapshot;
}

function item(
  overrides: Partial<DetectedDamageItem> & Pick<DetectedDamageItem, 'pieza'>,
): DetectedDamageItem {
  return {
    severidad: 'DL',
    descripcionTecnica: 'golpe',
    urls_origen: ['https://cdn.example/a.jpg'],
    tratamiento: 'REPARAR',
    treatmentSource: 'vision',
    treatmentReason: 'vision_structured',
    vehiculoDetectado: 'Toyota Avanza',
    ...overrides,
  };
}

function quoteOf(inventory: DetectedDamageItem[], prices?: Record<string, number>) {
  const pricing = snap(prices ?? { Salpicadera: 4500, Fascia: 3750, Cofre: 5600 });
  const peritaje = peritajeFromLegacyAnalysis({
    conversationId: 'c_ev',
    canonicalizePanel: canonicalPhysicalPanelKey,
    analysis: { vehiculoDetectado: 'Toyota Avanza', inventory },
  });
  return {
    peritaje,
    rows: quoteRowsFromDamageInventory(inventory, pricing),
    built: buildCanonicalQuoteV1({
      peritaje,
      pricedInventory: inventory,
      snap: pricing,
    }),
  };
}

describe('damageEvidenceStatus — confirmación vs tratamiento', () => {
  it('no infiere el status desde descripcionTecnica', () => {
    expect(
      parseDamageEvidenceStatus(
        'desalineación respecto de la zona afectada, posible transferencia',
      ),
    ).toBeUndefined();
    const parsed = parseVisionDamageItems({
      items: [
        {
          pieza: 'Cofre',
          severidad: 'DM',
          descripcionTecnica: 'posible desalineación y transferencia del golpe',
          tratamiento: 'INCIERTO',
          posibleReemplazoRefaccion: true,
        },
      ],
    });
    expect(parsed[0]?.damageEvidenceStatus).toBeUndefined();
    expect(
      resolveDamageEvidenceStatusForPricing(parsed[0]?.damageEvidenceStatus),
    ).toBe('CONFIRMED_VISIBLE');
  });

  it('legacy sin campo sigue cobrable (INCIERTO confirmado por omisión)', () => {
    const { built, rows } = quoteOf([
      item({ pieza: 'FD', tratamiento: 'INCIERTO' }),
    ]);
    expect(rows[0]?.serviceType).toBe('REPARACION_PINTURA');
    expect(rows[0]?.billable).toBe(true);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.quote.lines[0]?.serviceType).toBe('REPARACION_PINTURA');
    expect(built.quote.total).toBeGreaterThan(0);
  });

  it('confirmed visible + REPARAR → cobrable', () => {
    const { rows, built } = quoteOf([
      item({
        pieza: 'SI',
        tratamiento: 'REPARAR',
        damageEvidenceStatus: 'CONFIRMED_VISIBLE',
      }),
    ]);
    expect(rows[0]?.serviceType).toBe('REPARACION_PINTURA');
    expect(rows[0]?.billable).toBe(true);
    expect(built.ok && built.quote.total).toBe(4500);
  });

  it('confirmed visible + INCIERTO mantiene estimación preliminar', () => {
    const { rows, built } = quoteOf([
      item({
        pieza: 'SI',
        tratamiento: 'INCIERTO',
        damageEvidenceStatus: 'CONFIRMED_VISIBLE',
        posibleReemplazoRefaccion: true,
      }),
    ]);
    expect(rows[0]?.serviceType).toBe('REPARACION_PINTURA');
    expect(rows[0]?.billable).toBe(true);
    expect(built.ok && built.quote.warnings).toEqual(
      expect.arrayContaining(['POSSIBLE_SUBSTITUTION']),
    );
  });

  it('suspected + REPARAR no es cobrable', () => {
    const { rows, built } = quoteOf([
      item({
        pieza: 'Cofre',
        tratamiento: 'REPARAR',
        damageEvidenceStatus: 'SUSPECTED_INVOLVEMENT',
        descripcionTecnica: 'posible desalineación',
      }),
    ]);
    expect(rows[0]?.serviceType).toBe('PENDIENTE');
    expect(rows[0]?.billable).toBe(false);
    expect(rows[0]?.precioMx).toBe(0);
    expect(rows[0]?.tratamiento).toBe('REPARAR');
    expect(built.ok && built.quote.total).toBe(0);
    expect(built.ok && built.quote.isPartial).toBe(true);
  });

  it('suspected + INCIERTO no es cobrable (false-positive Cofre)', () => {
    const { rows, built } = quoteOf([
      item({
        pieza: 'Cofre',
        severidad: 'DM',
        tratamiento: 'INCIERTO',
        damageEvidenceStatus: 'SUSPECTED_INVOLVEMENT',
        posibleReemplazoRefaccion: true,
      }),
    ]);
    expect(rows[0]?.serviceType).toBe('PENDIENTE');
    expect(rows[0]?.precioMx).toBe(0);
    expect(built.ok && built.quote.total).toBe(0);
    expect(built.ok && built.quote.lines.some((l) => l.billable)).toBe(false);
  });

  it('not assessable no es cobrable', () => {
    const { rows } = quoteOf([
      item({
        pieza: 'SD',
        tratamiento: 'REPARAR',
        damageEvidenceStatus: 'NOT_ASSESSABLE',
      }),
    ]);
    expect(rows[0]?.serviceType).toBe('PENDIENTE');
    expect(rows[0]?.billable).toBe(false);
  });

  it('hidden damage no crea cargo interno; FD confirmado sí cobra', () => {
    const { rows, built } = quoteOf([
      item({
        pieza: 'FD',
        tratamiento: 'REPARAR',
        damageEvidenceStatus: 'CONFIRMED_VISIBLE',
        possibleHiddenDamage: {
          detected: true,
          areas: ['absorvedor'],
          requiresDisassembly: true,
        },
      }),
    ]);
    expect(rows.some((r) => r.serviceType === 'REPARACION_PINTURA' && r.billable)).toBe(
      true,
    );
    expect(rows.some((r) => r.serviceType === 'ADVERTENCIA' && r.billable)).toBe(
      false,
    );
    expect(built.ok && built.quote.warnings).toEqual(
      expect.arrayContaining(['HIDDEN_DAMAGE']),
    );
    expect(built.ok && built.quote.total).toBe(3750);
  });

  it('faro con rotura visible se puede cotizar', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        item({
          pieza: 'FARO_IZQ',
          tratamiento: 'SUSTITUIR',
          damageEvidenceStatus: 'CONFIRMED_VISIBLE',
          descripcionTecnica: 'lente roto',
          precioMx: 2200,
          priceSource: 'WEB_MARKET_ESTIMATE',
          pricingStatus: 'OK',
        }),
      ],
      snap(),
    );
    expect(rows.some((r) => r.serviceType === 'REFACCION' && r.billable)).toBe(
      true,
    );
    expect(rows.find((r) => r.serviceType === 'REFACCION')?.precioMx).toBe(2200);
  });

  it('faro con posible daño de soporte no se cotiza', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        item({
          pieza: 'FARO_IZQ',
          tratamiento: 'SUSTITUIR',
          damageEvidenceStatus: 'SUSPECTED_INVOLVEMENT',
          descripcionTecnica: 'golpe cerca de soportes, lente íntegro',
          precioMx: 2200,
          priceSource: 'WEB_MARKET_ESTIMATE',
        }),
      ],
      snap(),
    );
    expect(rows.some((r) => r.billable)).toBe(false);
    expect(rows[0]?.serviceType).toBe('PENDIENTE');
    expect(rows[0]?.precioMx).toBe(0);
  });

  it('caso blanco: SI+FD confirmados; Cofre/Faro sospechosos no suman', () => {
    const inventory = [
      item({
        pieza: 'SI',
        tratamiento: 'REPARAR',
        damageEvidenceStatus: 'CONFIRMED_VISIBLE',
      }),
      item({
        pieza: 'FD',
        tratamiento: 'REPARAR',
        damageEvidenceStatus: 'CONFIRMED_VISIBLE',
      }),
      item({
        pieza: 'MOLDURA',
        moldingPosition: 'ARCO_DELANTERO_IZQUIERDO',
        finishType: 'NEGRA_TEXTURIZADA',
        tratamiento: 'INCIERTO',
        damageEvidenceStatus: 'CONFIRMED_VISIBLE',
      }),
      item({
        pieza: 'Cofre',
        tratamiento: 'INCIERTO',
        damageEvidenceStatus: 'SUSPECTED_INVOLVEMENT',
        posibleReemplazoRefaccion: true,
      }),
      item({
        pieza: 'FARO_IZQ',
        tratamiento: 'INCIERTO',
        damageEvidenceStatus: 'SUSPECTED_INVOLVEMENT',
      }),
    ];
    const { built, peritaje, rows } = quoteOf(inventory, {
      Salpicadera: 4500,
      Fascia: 3750,
      Cofre: 5600,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(rows.find((r) => /cofre/i.test(r.pieza))?.precioMx).toBe(0);
    expect(built.quote.total).toBe(8250);
    expect(built.quote.isPartial).toBe(true);
    expect(
      built.quote.lines
        .filter((l) => l.billable)
        .reduce((s, l) => s + l.amount, 0),
    ).toBe(8250);

    const block = renderCanonicalQuoteFinancialBlock(built.quote, peritaje);
    expect(block.text).toContain('$8,250');
    expect(block.text).toMatch(/Cofre — pendiente de revisi[oó]n/i);
    expect(block.text).not.toMatch(/Cofre: \$/);
    expect(block.totalText).not.toMatch(/falta el precio de refacci/i);
    const reasons = derivePartialQuoteReasons(built.quote, peritaje);
    expect(reasons.some((r) => r.code === 'SUSPECTED_INVOLVEMENT')).toBe(true);
  });

  it('merge conserva CONFIRMED sobre sospecha', () => {
    expect(
      mergeDamageEvidenceStatus(
        'SUSPECTED_INVOLVEMENT',
        'CONFIRMED_VISIBLE',
      ),
    ).toBe('CONFIRMED_VISIBLE');
    expect(
      mergeDamageEvidenceStatus(undefined, 'SUSPECTED_INVOLVEMENT'),
    ).toBe('SUSPECTED_INVOLVEMENT');
  });

  it('PRICING_ELIGIBILITY se registra para sospecha', () => {
    const prev = process.env.PEG_CANONICAL_TRACE;
    process.env.PEG_CANONICAL_TRACE = '1';
    process.env.PEG_TRACE_MODE = 'debug';
    process.env.LOG_LEVEL = 'debug';
    const logs: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map(String).join(' '));
    });
    try {
      quoteRowsFromDamageInventory(
        [
          item({
            pieza: 'Cofre',
            damageEvidenceStatus: 'SUSPECTED_INVOLVEMENT',
            tratamiento: 'INCIERTO',
          }),
        ],
        snap({ Cofre: 5600 }),
      );
      expect(
        logs.some((l) => l.includes(CANONICAL_TRACE_EVENTS.PRICING_ELIGIBILITY)),
      ).toBe(true);
      expect(logs.some((l) => l.includes('suspected_involvement'))).toBe(true);
      expect(logs.some((l) => l.includes('"billableEligible":false'))).toBe(
        true,
      );
    } finally {
      spy.mockRestore();
      if (prev == null) delete process.env.PEG_CANONICAL_TRACE;
      else process.env.PEG_CANONICAL_TRACE = prev;
      delete process.env.PEG_TRACE_MODE;
      delete process.env.LOG_LEVEL;
    }
  });
});
