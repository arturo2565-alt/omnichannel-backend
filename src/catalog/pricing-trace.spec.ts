import { createMatrixPricingSnapshot } from './matrix-pricing-snapshot';
import type { PriceMatrix } from './entities/price-matrix.entity';
import {
  computeCatalogIntegralPrice,
  computeCatalogPiecePrice,
  type DamageMagnitude,
} from './catalog-pricing-rules';
import {
  resolvePiecePriceForVehicleProfile,
  resolvePiecePriceResolution,
} from './vehicle-piece-pricing';
import {
  resolveVehiclePricingProfile,
  type VehicleSizeTier,
} from './vehicle-pricing-profile';
import { resolveCatalogPiezaForMatrixLookup } from './panel-pieza-catalog';
import { quoteRowsFromDamageInventory } from '../chat/draft-quote-inventory-pricing';
import {
  buildCanonicalFreeze,
  buildCanonicalQuoteV1,
  frozenAmountsFromSnapshot,
} from '../chat/canonical-quote-engine';
import { canonicalPhysicalPanelKey } from '../chat/piece-treatment';
import type { DetectedDamageItem } from '../chat/entities/chat.entity';
import {
  peritajeFromLegacyAnalysis,
  type CanonicalQuoteV1,
} from '../domain/peritaje-v1';
import type { PricingTraceV1 } from '../domain/peritaje-v1/types';
import type { QuoteSendSnapshot } from '../chat/autofix-config';

function cell(
  servicio: string,
  precio: number,
  severidad = 'LEVE',
): PriceMatrix {
  return {
    servicio,
    severidad,
    precio,
    diasEntrega: 5,
    isInstantService: false,
  } as PriceMatrix;
}

function damage(
  pieza: string,
  severidad: string,
  extra: Partial<DetectedDamageItem> = {},
): DetectedDamageItem {
  return {
    pieza,
    severidad,
    descripcionTecnica: '',
    urls_origen: [],
    vehiculoDetectado: 'Mazda 2 2024',
    tratamiento: 'REPARAR',
    treatmentSource: 'vision',
    treatmentReason: 'vision_structured',
    ...extra,
  };
}

function profile(sizeTier: VehicleSizeTier, isPremium = false) {
  return resolveVehiclePricingProfile({
    modeloVehiculo: isPremium ? 'BMW Serie 3 2022' : 'Mazda 2 2024',
    sizeTier,
    isPremium,
    tierSource: 'cliente',
  });
}

function replay(trace: PricingTraceV1): number | null {
  if (
    trace.pricingMethod === 'catalog_piece' ||
    trace.pricingMethod === 'catalog_mount_paint'
  ) {
    const folded =
      trace.operationOrder === 'premium_round_then_severity' ||
      trace.operationOrder === 'tier_cell_then_severity';
    return computeCatalogPiecePrice({
      basePrice: folded
        ? (trace.effectiveBasePriceMx ?? trace.basePriceMx ?? 0)
        : (trace.basePriceMx ?? 0),
      sizeTier: (trace.formulaSizeTier ??
        trace.vehicleSizeTier ??
        'Compacto') as VehicleSizeTier,
      isPremium:
        trace.formulaPremiumApplied != null
          ? trace.formulaPremiumApplied
          : (trace.premiumFactor ?? 1) !== 1,
      damageMagnitude: (trace.damageMagnitude ?? 'MEDIO') as DamageMagnitude,
    });
  }
  if (trace.pricingMethod === 'catalog_integral') {
    return computeCatalogIntegralPrice({
      basePrice: trace.basePriceMx ?? 0,
      sizeTier: (trace.vehicleSizeTier ?? 'Compacto') as VehicleSizeTier,
      isPremium:
        trace.formulaPremiumApplied != null
          ? trace.formulaPremiumApplied
          : (trace.premiumFactor ?? 1) !== 1,
    });
  }
  return null;
}

function quoteFrom(
  items: DetectedDamageItem[],
  rows: ReturnType<typeof createMatrixPricingSnapshot>,
  vehicle = profile('Compacto'),
) {
  return buildCanonicalQuoteV1({
    peritaje: peritajeFromLegacyAnalysis({
      conversationId: 'c_trace',
      tallerId: 't_trace',
      peritajeId: 'per_trace',
      now: '2026-11-25T00:00:00.000Z',
      canonicalizePanel: canonicalPhysicalPanelKey,
      analysis: { vehiculoDetectado: vehicle.vehicleLabel, inventory: items },
    }),
    pricedInventory: items,
    snap: rows,
    vehicleProfile: vehicle,
    quoteId: 'quo_trace',
    generatedAt: '2026-11-25T00:00:00.000Z',
  });
}

describe('PricingTraceV1', () => {
  const frontBase = 1000;
  const rearBase = 2000;

  it('conserva el número histórico y la celda que ese cálculo usó', () => {
    const snap = createMatrixPricingSnapshot([
      cell('Salpicadera', frontBase),
      cell('Salpicadera trasera', rearBase),
    ]);
    const vehicle = profile('Compacto');
    const front = resolvePiecePriceResolution(
      snap,
      'Salpicadera',
      'FUERTE',
      vehicle,
    );
    const rear = resolvePiecePriceResolution(
      snap,
      'Salpicadera trasera',
      'LEVE',
      vehicle,
    );
    expect(
      resolvePiecePriceForVehicleProfile(
        snap,
        'Salpicadera',
        'FUERTE',
        vehicle,
      ),
    ).toBe(front.amount);
    expect(front.trace.catalogService).toBe('Salpicadera');
    expect(rear.trace.catalogService).toBe('Salpicadera trasera');
    expect(front.trace.matrixSeverityKey).toBe('LEVE');
    expect(rear.trace.matrixSeverityKey).toBe('LEVE');
    expect(front.trace.basePriceMx).toBe(frontBase);
    expect(rear.trace.basePriceMx).toBe(rearBase);
    expect(front.trace.catalogService).not.toBe(rear.trace.catalogService);
    expect(replay(front.trace)).toBe(front.amount);
    expect(replay(rear.trace)).toBe(rear.amount);
  });

  it('STI y CTI son el mismo panel y la misma tarifa', () => {
    const snap = createMatrixPricingSnapshot([
      cell('Salpicadera trasera', rearBase),
    ]);
    const rows = quoteRowsFromDamageInventory(
      [damage('STI', 'FUERTE'), damage('CTI', 'FUERTE')],
      snap,
      profile('Compacto'),
    );
    expect(resolveCatalogPiezaForMatrixLookup('STI')).toBe(
      'Salpicadera trasera',
    );
    expect(resolveCatalogPiezaForMatrixLookup('CTI')).toBe(
      'Salpicadera trasera',
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.physicalPanelKey).toBe('STI');
    expect(row?.pricingTrace?.catalogService).toBe('Salpicadera trasera');
    expect(row?.pricingTrace?.physicalPanelKey).toBe('STI');
    expect(row?.pricingTrace).toBeDefined();
    if (!row?.pricingTrace) return;
    expect(replay(row.pricingTrace)).toBe(row.precioMx);
  });

  it('distingue las cuatro magnitudes y los tamaños compacto y mediano', () => {
    const snap = createMatrixPricingSnapshot([cell('Salpicadera', frontBase)]);
    const magnitudes = ['LEVE', 'MEDIO', 'FUERTE', 'MUY_FUERTE'] as const;
    const compact = magnitudes.map((magnitude) =>
      resolvePiecePriceResolution(
        snap,
        'Salpicadera',
        magnitude,
        profile('Compacto'),
      ),
    );
    expect(compact.map((item) => item.trace.damageMagnitude)).toEqual([
      ...magnitudes,
    ]);
    expect(new Set(compact.map((item) => item.trace.severityFactor)).size).toBe(
      4,
    );
    for (const item of compact) expect(replay(item.trace)).toBe(item.amount);

    const medium = resolvePiecePriceResolution(
      snap,
      'Salpicadera',
      'LEVE',
      profile('Mediano'),
    );
    expect(medium.trace.vehicleSizeTier).toBe('Mediano');
    expect(medium.trace.sizeFactor).not.toBe(compact[0]?.trace.sizeFactor);
    expect(replay(medium.trace)).toBe(medium.amount);
    expect(medium.amount).not.toBe(compact[0]?.amount);
  });

  it('registra el premium y la celda de tamaño con los datos que entraron a la fórmula', () => {
    const snap = createMatrixPricingSnapshot([
      cell('Salpicadera', frontBase),
      cell('Salpicadera', 1500, 'Mediano|LEVE'),
    ]);
    const premium = resolvePiecePriceResolution(
      snap,
      'Salpicadera',
      'LEVE',
      profile('Mediano', true),
    );
    expect(premium.trace.catalogBasePriceMx).toBe(1500);
    expect(premium.trace.matrixSeverityKey).toBe('Mediano|LEVE');
    expect(premium.trace.matrixRowId).toBeUndefined();
    expect(premium.trace.vehicleSizeTier).toBe('Mediano');
    expect(premium.trace.premiumApplied).toBe(true);
    expect(premium.trace.premiumFactor).toBeGreaterThan(1);
    expect(premium.trace.operationOrder).toBe('premium_round_then_severity');
    expect(premium.trace.intermediateRoundToMx).toBe(50);
    expect(premium.trace.effectiveBasePriceMx).not.toBe(1500);
    expect(premium.trace.formulaSizeTier).toBe('Compacto');
    expect(premium.trace.formulaPremiumApplied).toBe(false);
    expect(replay(premium.trace)).toBe(premium.amount);
    expect(
      resolvePiecePriceForVehicleProfile(
        snap,
        'Salpicadera',
        'LEVE',
        profile('Mediano', true),
      ),
    ).toBe(premium.amount);

    const plain = resolvePiecePriceResolution(
      snap,
      'Salpicadera',
      'LEVE',
      profile('Compacto'),
    );
    expect(plain.trace.premiumFactor).toBe(1);
    expect(plain.trace.matrixSeverityKey).toBe('LEVE');
    expect(replay(plain.trace)).toBe(plain.amount);

    const premiumCompact = resolvePiecePriceResolution(
      snap,
      'Salpicadera',
      'FUERTE',
      profile('Compacto', true),
    );
    expect(premiumCompact.trace.premiumFactor).toBeGreaterThan(1);
    expect(premiumCompact.trace.vehicleSizeTier).toBe('Compacto');
    expect(replay(premiumCompact.trace)).toBe(premiumCompact.amount);
    expect(premiumCompact.amount).not.toBe(
      resolvePiecePriceResolution(
        snap,
        'Salpicadera',
        'FUERTE',
        profile('Compacto'),
      ).amount,
    );
  });

  it('una tarifa ausente queda sin configurar y sin base inventada', () => {
    const snap = createMatrixPricingSnapshot([cell('Fascia', frontBase)]);
    const rows = quoteRowsFromDamageInventory(
      [damage('STI', 'FUERTE'), damage('FT', 'LEVE')],
      snap,
      profile('Compacto'),
    );
    const side = rows.find((row) => row.physicalPanelKey === 'STI');
    const fascia = rows.find((row) => row.physicalPanelKey === 'FT');
    expect(side?.precioMx).toBe(0);
    expect(side?.pricingTrace?.pricingMethod).toBe('unconfigured');
    expect(side?.pricingTrace?.basePriceMx).toBeUndefined();
    expect(side?.pricingTrace?.catalogService).toBe('Salpicadera trasera');
    expect(fascia?.pricingTrace?.pricingMethod).toBe('catalog_piece');
    expect(replay(fascia!.pricingTrace!)).toBe(fascia?.precioMx);

    const built = quoteFrom(
      [damage('STI', 'FUERTE'), damage('FT', 'LEVE')],
      snap,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.quote.isPartial).toBe(true);
    expect(built.quote.total).toBe(fascia?.precioMx);
    expect(
      built.quote.lines.find(
        (line) => line.pricingTrace?.pricingMethod === 'unconfigured',
      )?.billable,
    ).toBe(false);
  });

  it('un precio manual no hereda la fórmula y una refacción no hereda la matriz', () => {
    const snap = createMatrixPricingSnapshot([
      cell('Fascia', frontBase),
      cell('Fascia', 400, 'MONTAJE_PINTURA'),
    ]);
    const repair = [damage('FT', 'LEVE')];
    const first = quoteFrom(repair, snap);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const line = first.quote.lines[0];
    if (!line) return;
    const manualAmount = line.amount + 75;
    const overridden = buildCanonicalQuoteV1({
      peritaje: peritajeFromLegacyAnalysis({
        conversationId: 'c_trace',
        tallerId: 't_trace',
        peritajeId: 'per_trace',
        now: '2026-11-25T00:00:00.000Z',
        canonicalizePanel: canonicalPhysicalPanelKey,
        analysis: { vehiculoDetectado: 'Mazda 2 2024', inventory: repair },
      }),
      pricedInventory: repair,
      snap,
      vehicleProfile: profile('Compacto'),
      quoteId: 'quo_trace',
      manualOverrides: [
        { quoteLineId: line.quoteLineId, amount: manualAmount },
      ],
    });
    expect(overridden.ok).toBe(true);
    if (!overridden.ok) return;
    const manual = overridden.quote.lines[0];
    if (!manual) return;
    expect(manual.amount).toBe(manualAmount);
    expect(manual.pricingSource).toBe('MANUAL');
    expect(manual.pricingTrace?.pricingMethod).toBe('manual');
    expect(manual.pricingTrace?.basePriceMx).toBeUndefined();
    expect(manual.pricingTrace?.matrixSeverityKey).toBeUndefined();
    expect(manual.pricingTrace?.calculatedAmountMx).toBe(manual.amount);

    const rows = quoteRowsFromDamageInventory(
      [
        damage('FT', 'N/A', {
          tratamiento: 'SUSTITUIR',
          precioMx: 1234,
          priceSource: 'WEB_MARKET_ESTIMATE',
          pricingStatus: 'OK',
        }),
      ],
      snap,
      profile('Compacto'),
    );
    const part = rows.find((row) => row.serviceType === 'REFACCION');
    const mount = rows.find((row) => row.serviceType === 'MONTAJE_PINTURA');
    expect(part?.precioMx).toBe(1234);
    expect(part?.pricingTrace?.pricingMethod).toBe('market_part');
    expect(part?.pricingTrace?.basePriceMx).toBeUndefined();
    expect(part?.pricingTrace?.matrixSeverityKey).toBeUndefined();
    expect(mount?.pricingTrace?.pricingMethod).toBe('catalog_mount_paint');
    expect(mount?.pricingTrace?.matrixSeverityKey).toBe('MONTAJE_PINTURA');
    expect(replay(mount!.pricingTrace!)).toBe(mount?.precioMx);
  });

  it('un servicio integral no guarda magnitud de daño', () => {
    const snap = createMatrixPricingSnapshot([
      cell('Baño de Pintura Exterior', 28000, 'BASE'),
    ]);
    const rows = quoteRowsFromDamageInventory(
      [damage('BPE', 'Mediano')],
      snap,
      profile('Mediano'),
    );
    const trace = rows[0]?.pricingTrace;
    expect(trace?.pricingMethod).toBe('catalog_integral');
    expect(trace?.damageMagnitude).toBeUndefined();
    expect(trace?.severityFactor).toBeUndefined();
    expect(trace?.matrixSeverityKey).toBe('BASE');
    expect(replay(trace!)).toBe(rows[0]?.precioMx);
  });

  it('el carrito, el envío y la recarga conservan importe, ids y traza', () => {
    const snap = createMatrixPricingSnapshot([
      cell('Salpicadera', frontBase),
      cell('Fascia', rearBase),
    ]);
    const items = [damage('SI', 'MEDIO'), damage('FT', 'LEVE')];
    const built = quoteFrom(items, snap);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.quote.lines).toHaveLength(2);
    expect(built.quote.total).toBe(
      built.quote.lines.reduce(
        (sum, line) => sum + (line.billable ? line.amount : 0),
        0,
      ),
    );
    expect(built.quote.subtotal).toBe(built.quote.total);
    for (const line of built.quote.lines) {
      expect(line.quoteLineId).toMatch(/\S/);
      expect(line.damageItemId).toMatch(/\S/);
      expect(replay(line.pricingTrace!)).toBe(line.amount);
    }

    const stored = JSON.parse(JSON.stringify(built.quote)) as CanonicalQuoteV1;
    expect(stored.total).toBe(built.quote.total);
    expect(stored.lines[0].pricingTrace.basePriceMx).toBe(frontBase);
    expect(stored.lines[0].quoteLineId).toBe(built.quote.lines[0]?.quoteLineId);

    const freeze = buildCanonicalFreeze(built.quote);
    const snapshot: QuoteSendSnapshot = {
      sentAt: '2026-11-25T00:00:00.000Z',
      total: built.quote.total,
      subtotal: built.quote.subtotal,
      desglose: [],
      canonicalFreeze: freeze,
    };
    expect(freeze.total).toBe(built.quote.total);
    expect(freeze.traces?.[0]?.pricingTrace.calculatedAmountMx).toBe(
      built.quote.lines[0]?.amount,
    );
    expect(
      frozenAmountsFromSnapshot(snapshot)?.get(
        built.quote.lines[0]?.quoteLineId ?? '',
      ),
    ).toBe(built.quote.lines[0]?.amount);

    const historical = JSON.parse(
      JSON.stringify(built.quote),
    ) as CanonicalQuoteV1;
    for (const line of historical.lines) delete line.pricingTrace;
    expect(historical.total).toBe(built.quote.total);
    expect(historical.lines[0].pricingTrace).toBeUndefined();

    const changed = createMatrixPricingSnapshot([
      cell('Salpicadera', frontBase + 500),
      cell('Fascia', rearBase + 500),
    ]);
    const rebuilt = quoteFrom(items, changed);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.quote.total).not.toBe(stored.total);
    expect(rebuilt.quote.lines[0]?.pricingTrace?.catalogBasePriceMx).toBe(
      frontBase + 500,
    );
    expect(stored.total).toBe(built.quote.total);
    expect(stored.lines[0].pricingTrace.basePriceMx).toBe(frontBase);
    expect(stored.lines[0].amount).toBe(built.quote.lines[0]?.amount);

    const frozen = buildCanonicalQuoteV1({
      peritaje: peritajeFromLegacyAnalysis({
        conversationId: 'c_trace',
        tallerId: 't_trace',
        peritajeId: 'per_trace',
        now: '2026-11-25T00:00:00.000Z',
        canonicalizePanel: canonicalPhysicalPanelKey,
        analysis: { vehiculoDetectado: 'Mazda 2 2024', inventory: items },
      }),
      pricedInventory: items,
      snap: changed,
      vehicleProfile: profile('Compacto'),
      quoteId: 'quo_trace',
      frozenByQuoteLineId: frozenAmountsFromSnapshot(snapshot),
      historicalTracesByQuoteLineId: new Map(
        (freeze.traces ?? []).map((item) => [
          item.quoteLineId,
          item.pricingTrace,
        ]),
      ),
    });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    expect(frozen.quote.total).toBe(built.quote.total);
    expect(frozen.quote.isPartial).toBe(built.quote.isPartial);
    expect(frozen.quote.lines[0]?.pricingTrace?.basePriceMx).toBe(frontBase);
    expect(frozen.quote.lines[0]?.pricingTrace?.calculatedAmountMx).toBe(
      built.quote.lines[0]?.amount,
    );
    expect(frozen.quote.lines[0]?.amount).toBe(built.quote.lines[0]?.amount);
    expect(stored.lines[0].pricingTrace.pricingMethod).toBe('catalog_piece');

    const legacySnapshot: QuoteSendSnapshot = {
      ...snapshot,
      canonicalFreeze: { ...freeze, traces: undefined },
    };
    const legacy = buildCanonicalQuoteV1({
      peritaje: peritajeFromLegacyAnalysis({
        conversationId: 'c_trace',
        tallerId: 't_trace',
        peritajeId: 'per_trace',
        now: '2026-11-25T00:00:00.000Z',
        canonicalizePanel: canonicalPhysicalPanelKey,
        analysis: { vehiculoDetectado: 'Mazda 2 2024', inventory: items },
      }),
      pricedInventory: items,
      snap: changed,
      vehicleProfile: profile('Compacto'),
      quoteId: 'quo_trace',
      frozenByQuoteLineId: frozenAmountsFromSnapshot(legacySnapshot),
    });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    expect(legacy.quote.total).toBe(built.quote.total);
    expect(legacy.quote.lines.every((line) => line.pricingTrace == null)).toBe(
      true,
    );
  });

  it('una corrección manual posterior al envío no reescribe el snapshot', () => {
    const snap = createMatrixPricingSnapshot([cell('Fascia', frontBase)]);
    const items = [damage('FT', 'LEVE')];
    const sent = quoteFrom(items, snap);
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    const line = sent.quote.lines[0];
    if (!line) return;
    const freeze = buildCanonicalFreeze(sent.quote);
    const snapshot: QuoteSendSnapshot = {
      sentAt: '2026-11-25T00:00:00.000Z',
      total: sent.quote.total,
      subtotal: sent.quote.subtotal,
      desglose: [],
      canonicalFreeze: freeze,
    };
    const snapshotBefore = JSON.parse(
      JSON.stringify(snapshot),
    ) as QuoteSendSnapshot;
    const correctedAmount = line.amount + 125;
    const corrected = buildCanonicalQuoteV1({
      peritaje: peritajeFromLegacyAnalysis({
        conversationId: 'c_trace',
        tallerId: 't_trace',
        peritajeId: 'per_trace',
        now: '2026-11-25T00:00:00.000Z',
        canonicalizePanel: canonicalPhysicalPanelKey,
        analysis: { vehiculoDetectado: 'Mazda 2 2024', inventory: items },
      }),
      pricedInventory: items,
      snap,
      vehicleProfile: profile('Compacto'),
      quoteId: 'quo_trace',
      frozenByQuoteLineId: frozenAmountsFromSnapshot(snapshot),
      historicalTracesByQuoteLineId: new Map(
        (freeze.traces ?? []).map((item) => [
          item.quoteLineId,
          item.pricingTrace,
        ]),
      ),
      manualOverrides: [
        { quoteLineId: line.quoteLineId, amount: correctedAmount },
      ],
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    const next = corrected.quote.lines[0];
    expect(next?.amount).toBe(correctedAmount);
    expect(next?.pricingSource).toBe('MANUAL');
    expect(next?.pricingTrace?.pricingMethod).toBe('manual');
    expect(next?.pricingTrace?.catalogBasePriceMx).toBeUndefined();
    expect(next?.pricingTrace?.premiumFactor).toBeUndefined();
    expect(corrected.quote.total).toBe(correctedAmount);
    expect(snapshot).toEqual(snapshotBefore);
    expect(snapshot.canonicalFreeze?.total).toBe(line.amount);
    expect(
      snapshot.canonicalFreeze?.traces?.[0]?.pricingTrace.pricingMethod,
    ).toBe('catalog_piece');

    const unchanged = buildCanonicalQuoteV1({
      peritaje: peritajeFromLegacyAnalysis({
        conversationId: 'c_trace',
        tallerId: 't_trace',
        peritajeId: 'per_trace',
        now: '2026-11-25T00:00:00.000Z',
        canonicalizePanel: canonicalPhysicalPanelKey,
        analysis: { vehiculoDetectado: 'Mazda 2 2024', inventory: items },
      }),
      pricedInventory: items,
      snap,
      vehicleProfile: profile('Compacto'),
      quoteId: 'quo_trace',
      frozenByQuoteLineId: frozenAmountsFromSnapshot(snapshot),
      historicalTracesByQuoteLineId: new Map(
        (freeze.traces ?? []).map((item) => [
          item.quoteLineId,
          item.pricingTrace,
        ]),
      ),
      manualOverrides: [{ quoteLineId: line.quoteLineId, amount: line.amount }],
    });
    expect(unchanged.ok).toBe(true);
    if (!unchanged.ok) return;
    expect(unchanged.quote.lines[0]?.amount).toBe(line.amount);
    expect(unchanged.quote.lines[0]?.pricingTrace?.pricingMethod).toBe(
      'catalog_piece',
    );
    expect(snapshot.canonicalFreeze?.amounts[0]?.amount).toBe(line.amount);
  });
});
