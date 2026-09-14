import { quoteRowsFromDamageInventory } from './draft-quote-inventory-pricing';
import { resolveReplacementInstallationMode } from './piece-treatment';
import { getClientPieceLabel } from '../catalog/panel-pieza-catalog';
import { buildCanonicalQuoteV1 } from './canonical-quote-engine';
import { canonicalPhysicalPanelKey } from './piece-treatment';
import {
  createQuoteLineId,
  peritajeFromLegacyAnalysis,
  renderCanonicalQuoteFinancialBlock,
  validateFinalClientQuoteMessage,
  REFACCION_AVAILABILITY_DISCLAIMER,
} from '../domain/peritaje-v1';
import type { DetectedDamageItem } from './entities/chat.entity';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';

function snap(prices: Record<string, number> = {}): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: (canonical: string, level: string) =>
      prices[`${canonical}|${level}`] ?? prices[canonical] ?? 0,
    getAmount: (pieza: string, level: string) =>
      prices[`${pieza}|${level}`] ?? 0,
    getDiasEntregaForCanonical: () => 4,
    listSeveridadesForCanonical: () => ['DL', 'MONTAJE_PINTURA', 'MONTAJE'],
  } as MatrixPricingSnapshot;
}

function item(
  overrides: Partial<DetectedDamageItem> & Pick<DetectedDamageItem, 'pieza'>,
): DetectedDamageItem {
  return {
    severidad: 'DF',
    descripcionTecnica: 'quebrada',
    urls_origen: ['https://cdn.example/p.jpg'],
    tratamiento: 'SUSTITUIR',
    treatmentSource: 'vision',
    damageEvidenceStatus: 'CONFIRMED_VISIBLE',
    ...overrides,
  };
}

describe('resolveReplacementInstallationMode', () => {
  it('óptica SUSTITUIR → MONTAJE (non_paintable_optic)', () => {
    expect(
      resolveReplacementInstallationMode({
        pieza: 'Calavera_Derecha',
        tratamiento: 'SUSTITUIR',
      }),
    ).toEqual({
      installationMode: 'MONTAJE',
      reason: 'non_paintable_optic',
    });
    expect(
      resolveReplacementInstallationMode({
        pieza: 'Faro_Izquierdo',
        tratamiento: 'SUSTITUIR',
      }).installationMode,
    ).toBe('MONTAJE');
  });

  it('parrilla SUSTITUIR → MONTAJE (non_paintable_grille)', () => {
    expect(
      resolveReplacementInstallationMode({
        pieza: 'Parrilla',
        tratamiento: 'SUSTITUIR',
      }),
    ).toEqual({
      installationMode: 'MONTAJE',
      reason: 'non_paintable_grille',
    });
  });

  it('fascia/salpicadera SUSTITUIR → MONTAJE_PINTURA', () => {
    expect(
      resolveReplacementInstallationMode({
        pieza: 'FD',
        tratamiento: 'SUSTITUIR',
      }),
    ).toEqual({
      installationMode: 'MONTAJE_PINTURA',
      reason: 'paintable_body_part',
    });
    expect(
      resolveReplacementInstallationMode({
        pieza: 'SI',
        tratamiento: 'SUSTITUIR',
      }).installationMode,
    ).toBe('MONTAJE_PINTURA');
  });

  it('moldura respeta finishType', () => {
    expect(
      resolveReplacementInstallationMode({
        pieza: 'MOLDURA',
        tratamiento: 'SUSTITUIR',
        finishType: 'PINTADA_CARROCERIA',
      }),
    ).toEqual({
      installationMode: 'MONTAJE_PINTURA',
      reason: 'painted_molding',
    });
    expect(
      resolveReplacementInstallationMode({
        pieza: 'MOLDURA',
        tratamiento: 'SUSTITUIR',
        finishType: 'NEGRA_TEXTURIZADA',
      }),
    ).toEqual({
      installationMode: 'MONTAJE',
      reason: 'textured_non_paintable',
    });
    expect(
      resolveReplacementInstallationMode({
        pieza: 'MOLDURA',
        tratamiento: 'SUSTITUIR',
        finishType: 'UNKNOWN',
      }),
    ).toEqual({
      installationMode: 'NONE',
      reason: 'unknown_finish_conservative',
    });
  });

  it('REPARAR no emite instalación', () => {
    expect(
      resolveReplacementInstallationMode({
        pieza: 'Calavera_Derecha',
        tratamiento: 'REPARAR',
      }).installationMode,
    ).toBe('NONE');
  });
});

describe('SUSTITUIR emite REFACCION + instalación', () => {
  it('1. Calavera SUSTITUIR → REFACCION + MONTAJE', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        item({
          pieza: 'Calavera_Derecha',
          precioMx: 3650,
          precioMinEstimado: 3300,
          precioMaxEstimado: 3650,
          priceSource: 'WEB_MARKET_ESTIMATE',
          pricingStatus: 'OK',
        }),
      ],
      snap({ 'Calavera|MONTAJE': 800 }),
    );
    expect(rows.map((r) => r.serviceType)).toEqual(['REFACCION', 'MONTAJE']);
    expect(rows[0]?.billable).toBe(true);
    expect(rows[0]?.precioMx).toBe(3650);
    expect(rows[1]?.billable).toBe(true);
    expect(rows[1]?.precioMx).toBe(800);
    expect(rows.some((r) => r.serviceType === 'MONTAJE_PINTURA')).toBe(false);
  });

  it('2. Faro SUSTITUIR → REFACCION + MONTAJE', () => {
    const rows = quoteRowsFromDamageInventory(
      [item({ pieza: 'Faro_Izquierdo', precioMx: 2200 })],
      snap({ 'Faro|MONTAJE': 700 }),
    );
    expect(rows.map((r) => r.serviceType)).toEqual(['REFACCION', 'MONTAJE']);
  });

  it('3. Parrilla SUSTITUIR → REFACCION + MONTAJE', () => {
    const rows = quoteRowsFromDamageInventory(
      [item({ pieza: 'Parrilla', precioMx: 1500 })],
      snap({ 'Parilla|MONTAJE': 500 }),
    );
    expect(rows.map((r) => r.serviceType)).toEqual(['REFACCION', 'MONTAJE']);
    expect(rows.some((r) => r.serviceType === 'MONTAJE_PINTURA')).toBe(false);
  });

  it('4. Fascia SUSTITUIR → REFACCION + MONTAJE_PINTURA', () => {
    const rows = quoteRowsFromDamageInventory(
      [item({ pieza: 'FD', precioMx: 6500 })],
      snap({ 'Fascia|MONTAJE_PINTURA': 3400, 'Fascia|DL': 2900 }),
    );
    expect(rows.map((r) => r.serviceType)).toEqual([
      'REFACCION',
      'MONTAJE_PINTURA',
    ]);
    expect(rows.some((r) => r.serviceType === 'MONTAJE')).toBe(false);
  });

  it('5. Salpicadera SUSTITUIR → REFACCION + MONTAJE_PINTURA', () => {
    const rows = quoteRowsFromDamageInventory(
      [item({ pieza: 'SI', precioMx: 4800 })],
      snap({ 'Salpicadera|MONTAJE_PINTURA': 3100, 'Salpicadera|DL': 2800 }),
    );
    expect(rows.map((r) => r.serviceType)).toEqual([
      'REFACCION',
      'MONTAJE_PINTURA',
    ]);
  });

  it('6. Moldura pintada → MONTAJE_PINTURA', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        item({
          pieza: 'MOLDURA',
          moldingPosition: 'FASCIA',
          finishType: 'PINTADA_CARROCERIA',
          precioMx: 1800,
        }),
      ],
      snap({ 'MOLDURA_PINTADA|MONTAJE_PINTURA': 2000 }),
    );
    expect(rows.map((r) => r.serviceType)).toEqual([
      'REFACCION',
      'MONTAJE_PINTURA',
    ]);
  });

  it('7. Moldura negra → MONTAJE', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        item({
          pieza: 'MOLDURA',
          moldingPosition: 'ARCO_DELANTERO_IZQUIERDO',
          finishType: 'NEGRA_TEXTURIZADA',
          precioMx: 1800,
        }),
      ],
      snap({ 'MOLDURA|MONTAJE': 600, 'MOLDURA_PINTADA|MONTAJE_PINTURA': 2000 }),
    );
    expect(rows.map((r) => r.serviceType)).toEqual(['REFACCION', 'MONTAJE']);
    expect(rows.some((r) => r.serviceType === 'MONTAJE_PINTURA')).toBe(false);
  });

  it('moldura UNKNOWN SUSTITUIR no asume pintura ni inventa montaje', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        item({
          pieza: 'MOLDURA',
          moldingPosition: 'FASCIA',
          finishType: 'UNKNOWN',
          precioMx: 1800,
        }),
      ],
      snap({ 'MOLDURA|MONTAJE': 600, 'MOLDURA_PINTADA|MONTAJE_PINTURA': 2000 }),
    );
    expect(rows.map((r) => r.serviceType)).toEqual(['REFACCION']);
    expect(rows[0]?.disclaimer).toBeTruthy();
  });

  it('8. Tarifa montaje ausente → parcial, no inventa', () => {
    const rows = quoteRowsFromDamageInventory(
      [
        item({
          pieza: 'Calavera_Derecha',
          precioMx: 3650,
          priceSource: 'WEB_MARKET_ESTIMATE',
          pricingStatus: 'OK',
        }),
      ],
      snap(),
    );
    const montaje = rows.find((r) => r.serviceType === 'MONTAJE');
    const refaccion = rows.find((r) => r.serviceType === 'REFACCION');
    expect(refaccion?.billable).toBe(true);
    expect(refaccion?.precioMx).toBe(3650);
    expect(montaje?.precioMx).toBe(0);
    expect(montaje?.billable).toBe(false);
    expect(montaje?.pricingStatus).toBe('UNCONFIGURED');
  });

  it('9. quoteLineId de MONTAJE es estable por damageItemId + serviceType', () => {
    const dmg = item({
      pieza: 'Calavera_Derecha',
      damageItemId: 'dmg_cal_der_1',
      vehicleId: 'veh_altima',
      precioMx: 3650,
    });
    const first = quoteRowsFromDamageInventory(
      [dmg],
      snap({ 'Calavera|MONTAJE': 800 }),
    );
    const second = quoteRowsFromDamageInventory(
      [dmg],
      snap({ 'Calavera|MONTAJE': 800 }),
    );
    const montajeA = first.find((r) => r.serviceType === 'MONTAJE');
    const montajeB = second.find((r) => r.serviceType === 'MONTAJE');
    const expected = createQuoteLineId({
      damageItemId: 'dmg_cal_der_1',
      serviceType: 'MONTAJE',
    });
    expect(montajeA?.quoteLineId).toBe(expected);
    expect(montajeB?.quoteLineId).toBe(expected);
    expect(first.filter((r) => r.serviceType === 'MONTAJE')).toHaveLength(1);
  });

  it('10. rebuild no duplica MONTAJE', () => {
    const inv = [
      item({
        pieza: 'Calavera_Derecha',
        damageItemId: 'dmg_cal_der_2',
        vehicleId: 'veh_altima',
        precioMx: 3650,
        priceSource: 'WEB_MARKET_ESTIMATE',
        pricingStatus: 'OK',
      }),
    ];
    const pricing = snap({ 'Calavera|MONTAJE': 800 });
    const a = quoteRowsFromDamageInventory(inv, pricing);
    const b = quoteRowsFromDamageInventory(inv, pricing);
    expect(a.filter((r) => r.serviceType === 'MONTAJE')).toHaveLength(1);
    expect(b.filter((r) => r.serviceType === 'MONTAJE')).toHaveLength(1);
    expect(a.find((r) => r.serviceType === 'MONTAJE')?.quoteLineId).toBe(
      b.find((r) => r.serviceType === 'MONTAJE')?.quoteLineId,
    );
  });
});

describe('labels y renderer CANONICAL', () => {
  it('11-12. labels humanos; IDs internos no cambian', () => {
    expect(getClientPieceLabel('Calavera_Derecha')).toBe('Calavera derecha');
    expect(getClientPieceLabel('Calavera_Izquierda')).toBe(
      'Calavera izquierda',
    );
    expect(getClientPieceLabel('Faro_Izquierdo')).toBe('Faro izquierdo');
    expect(getClientPieceLabel('Faro_Niebla_Derecho')).toBe(
      'Faro de niebla derecho',
    );
    expect(getClientPieceLabel('FD')).toBe('Fascia delantera');
    expect(getClientPieceLabel('SI')).toBe('Salpicadera delantera izquierda');
    expect(getClientPieceLabel('Tapa Cajuela')).toBe('Tapa de cajuela');
    expect(canonicalPhysicalPanelKey('Calavera_Derecha')).toBe(
      'Calavera_Derecha',
    );
  });

  it('13-14. disclaimer solo en REFACCION de mercado', () => {
    const inventory = [
      item({
        pieza: 'Calavera_Derecha',
        vehiculoDetectado: 'Nissan Altima 2014',
        precioMx: 3650,
        precioMinEstimado: 3300,
        precioMaxEstimado: 3650,
        precioCentral: 3650,
        priceSource: 'WEB_MARKET_ESTIMATE',
        pricingStatus: 'OK',
        pricingType: 'RANGE',
      }),
    ];
    const peritaje = peritajeFromLegacyAnalysis({
      conversationId: 'conv_altima',
      peritajeId: 'per_altima',
      now: '2026-09-14T00:00:00.000Z',
      canonicalizePanel: canonicalPhysicalPanelKey,
      analysis: {
        vehiculoDetectado: 'Nissan Altima 2014',
        inventory,
      },
    });
    const built = buildCanonicalQuoteV1({
      peritaje,
      pricedInventory: inventory.map((it, i) => ({
        ...it,
        damageItemId: peritaje.damages[i]?.damageItemId,
        vehicleId: peritaje.damages[i]?.vehicleId,
      })),
      snap: snap({ 'Calavera|MONTAJE': 800 }),
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(peritaje.damages[0]?.pieceCode).toBe('Calavera_Derecha');
    expect(peritaje.damages[0]?.pieceLabel).toBe('Calavera derecha');
    const refaccion = built.quote.lines.find((l) => l.serviceType === 'REFACCION');
    const montaje = built.quote.lines.find((l) => l.serviceType === 'MONTAJE');
    expect(refaccion?.billable).toBe(true);
    expect(refaccion?.amount).toBe(3650);
    expect(refaccion?.priceRange).toEqual(
      expect.objectContaining({ min: 3300, max: 3650 }),
    );
    expect(montaje?.billable).toBe(true);
    expect(montaje?.amount).toBe(800);
    const block = renderCanonicalQuoteFinancialBlock(built.quote, peritaje);
    expect(block.text).toContain('Refacción Calavera derecha');
    expect(block.text).toContain('$3,300');
    expect(block.text).toContain('$3,650');
    expect(block.text).toContain(`_${REFACCION_AVAILABILITY_DISCLAIMER}_`);
    expect(block.text).toContain('Montaje Calavera derecha');
    expect(block.text).not.toMatch(/Calavera_Derecha/);
    expect(block.text).not.toMatch(/Montaje y pintura Calavera derecha/);
    const montajeLine = block.lineTexts.find((t) => t.includes('Montaje Calavera'));
    expect(montajeLine).not.toContain(REFACCION_AVAILABILITY_DISCLAIMER);
    const paintQ = {
      ...built.quote,
      lines: built.quote.lines.filter((l) => l.serviceType === 'MONTAJE'),
      subtotal: montaje?.amount ?? 0,
      total: montaje?.amount ?? 0,
      isPartial: false,
      warnings: [],
    };
    const paintBlock = renderCanonicalQuoteFinancialBlock(paintQ, peritaje);
    expect(paintBlock.text).not.toContain(REFACCION_AVAILABILITY_DISCLAIMER);
    const integrity = validateFinalClientQuoteMessage({
      canonicalQuote: built.quote,
      renderedFinancialBlock: block.text,
      finalMessage: `Hola\n\n${block.text}\n\n¿Agendamos?`,
    });
    expect(integrity.ok).toBe(true);
  });

  it('15. sin tarifa MONTAJE: warning + isPartial, REFACCION cobrable', () => {
    const inventory = [
      item({
        pieza: 'Calavera_Derecha',
        vehiculoDetectado: 'Nissan Altima 2014',
        precioMx: 3650,
        precioMinEstimado: 3300,
        precioMaxEstimado: 3650,
        priceSource: 'WEB_MARKET_ESTIMATE',
        pricingStatus: 'OK',
      }),
    ];
    const peritaje = peritajeFromLegacyAnalysis({
      conversationId: 'conv_altima_u',
      peritajeId: 'per_altima_u',
      now: '2026-09-14T00:00:00.000Z',
      canonicalizePanel: canonicalPhysicalPanelKey,
      analysis: { vehiculoDetectado: 'Nissan Altima 2014', inventory },
    });
    const built = buildCanonicalQuoteV1({
      peritaje,
      pricedInventory: inventory.map((it, i) => ({
        ...it,
        damageItemId: peritaje.damages[i]?.damageItemId,
        vehicleId: peritaje.damages[i]?.vehicleId,
      })),
      snap: snap(),
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const refaccion = built.quote.lines.find((l) => l.serviceType === 'REFACCION');
    const montaje = built.quote.lines.find((l) => l.serviceType === 'MONTAJE');
    expect(refaccion?.billable).toBe(true);
    expect(montaje?.amount).toBe(0);
    expect(montaje?.billable).toBe(false);
    expect(built.quote.isPartial).toBe(true);
    expect(built.quote.warnings).toContain('MONTAJE_TARIFA_NO_CONFIGURADA');
    expect(built.quote.total).toBe(refaccion?.amount);
  });
});
