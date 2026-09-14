import { applyCustomerMargin } from './refaccion-market/compute-market-range';
import { enrichInventoryWithMarketRefacciones } from './refaccion-market/enrich-inventory-with-market';
import { parseVehiclePartIdentity } from './refaccion-market/parse-vehicle-part-identity';
import { REFACCION_MARKET_EVENTS } from './refaccion-market/refaccion-market-events';
import type {
  RefaccionMarketEstimate,
  VehiclePartIdentity,
} from './refaccion-market/refaccion-market.types';
import { buildCanonicalQuoteV1 } from './canonical-quote-engine';
import { canonicalPhysicalPanelKey } from './piece-treatment';
import {
  createQuoteLineId,
  derivePartialQuoteReasons,
  peritajeFromLegacyAnalysis,
  renderCanonicalQuoteFinancialBlock,
} from '../domain/peritaje-v1';
import { stampInventoryFromCanonicalPeritaje } from './canonical-identity';
import {
  applyConfirmVehicleIdentity,
  parseConfirmVehicleIdentityArgs,
} from './confirm-vehicle-identity';
import {
  resumePendingQuotePricing,
  stampPendingRequirementsAfterQuote,
} from './resume-pending-quote-pricing';
import type { DetectedDamageItem } from './entities/chat.entity';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import type { DraftQuote } from './autofix-config';
import type { CanonicalPeritajeV1 } from '../domain/peritaje-v1';

const VEH = 'veh_9d239833f677515e';
const DMG_CALAVERA = 'dmg_2d5b0ed4802efdf7';
const DMG_SI = 'dmg_si_pintura_001';
const PHOTO = 'https://cdn.example/mazda-calavera.jpg';

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
    descripcionTecnica: 'quebrada',
    urls_origen: [PHOTO],
    tratamiento: 'SUSTITUIR',
    treatmentSource: 'vision',
    damageEvidenceStatus: 'CONFIRMED_VISIBLE',
    vehiculoDetectado: 'Mazda 2',
    ...overrides,
  };
}

function readyEstimate(
  identity: VehiclePartIdentity,
  central = 4200,
): RefaccionMarketEstimate {
  const market = {
    precioMinEstimado: 3800,
    precioMaxEstimado: 4600,
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

function stampMazdaIds(
  peritaje: CanonicalPeritajeV1,
  inventory: DetectedDamageItem[],
): { peritaje: CanonicalPeritajeV1; inventory: DetectedDamageItem[] } {
  const vehicles = peritaje.vehicles.map((v, i) =>
    i === 0 ? { ...v, vehicleId: VEH } : v,
  );
  const damages = peritaje.damages.map((d) => {
    if (/calavera/i.test(d.pieceCode) || /calavera/i.test(d.physicalPanelKey)) {
      return { ...d, vehicleId: VEH, damageItemId: DMG_CALAVERA };
    }
    if (d.pieceCode === 'SI' || d.physicalPanelKey === 'SI') {
      return { ...d, vehicleId: VEH, damageItemId: DMG_SI };
    }
    return { ...d, vehicleId: VEH };
  });
  const stampedInv = inventory.map((it) => {
    if (/calavera/i.test(it.pieza)) {
      return { ...it, vehicleId: VEH, damageItemId: DMG_CALAVERA };
    }
    if (it.pieza === 'SI') {
      return { ...it, vehicleId: VEH, damageItemId: DMG_SI };
    }
    return { ...it, vehicleId: VEH };
  });
  return {
    peritaje: { ...peritaje, vehicles, damages },
    inventory: stampInventoryFromCanonicalPeritaje(stampedInv, {
      ...peritaje,
      vehicles,
      damages,
    }),
  };
}

function mazdaCase(input?: {
  withPaint?: boolean;
  year?: string;
  vehicleLabel?: string;
}) {
  const label = input?.vehicleLabel ?? (input?.year ? `Mazda 2 ${input.year}` : 'Mazda 2');
  const inventory: DetectedDamageItem[] = [
    item({
      pieza: 'Calavera_Izquierda',
      vehiculoDetectado: label,
    }),
  ];
  if (input?.withPaint) {
    inventory.push(
      item({
        pieza: 'SI',
        tratamiento: 'REPARAR',
        severidad: 'DL',
        descripcionTecnica: 'roce',
        vehiculoDetectado: label,
      }),
    );
  }
  const raw = peritajeFromLegacyAnalysis({
    conversationId: 'conv_mazda',
    tallerId: 't1',
    peritajeId: 'per_mazda',
    now: '2026-09-13T00:00:00.000Z',
    canonicalizePanel: canonicalPhysicalPanelKey,
    analysis: { vehiculoDetectado: label, inventory },
  });
  return stampMazdaIds(raw, inventory);
}

function withConfirmedFields(
  peritaje: CanonicalPeritajeV1,
  fields: string[] = ['make', 'model', 'year'],
): CanonicalPeritajeV1 {
  return {
    ...peritaje,
    vehicles: peritaje.vehicles.map((v) => ({
      ...v,
      confirmedFields: [...fields],
      confirmedByUser:
        fields.includes('make') &&
        fields.includes('model') &&
        fields.includes('year') &&
        Boolean(v.year),
    })),
  };
}

function emptyDraft(): DraftQuote {
  return {
    status: 'PENDING_APPROVAL',
    currency: 'MXN',
    reference: 'AF-TEST',
    generatedAt: '2026-09-13T00:00:00.000Z',
    lines: [],
    subtotal: 0,
    total: 0,
    formalNarrative: '',
    analysisBasis: {
      pieza: 'Calavera_Izquierda',
      severidad: 'DMFuerte',
      partesAfectadas: ['Calavera_Izquierda'],
      severidadDelDano: 'DMFuerte',
      descripcionTecnica: '',
      justificacion: '',
    },
  };
}

const paintSnap = snap({
  'Salpicadera|DL': 2800,
  Salpicadera: 2800,
  SI: 2800,
  'SI|DL': 2800,
});

describe('RESUME DE COTIZACIÓN CANÓNICA PARCIAL', () => {
  it('1-3. SUSTITUIR + Vision make/model sin year → AWAITING, no market, pide year + confirmación', async () => {
    const { peritaje, inventory } = mazdaCase();
    let marketCalls = 0;
    const enriched = await enrichInventoryWithMarketRefacciones(
      {
        pieza: 'Calavera_Izquierda',
        severidad: 'DMFuerte',
        descripcionTecnica: '',
        justificacion: '',
        partesAfectadas: ['Calavera_Izquierda'],
        severidadDelDano: 'DMFuerte',
        vehiculoDetectado: 'Mazda 2',
        inventory,
      },
      {
        estimate: async () => {
          marketCalls += 1;
          throw new Error('no debe buscar mercado sin año');
        },
      } as never,
      () => undefined,
      { vehicles: peritaje.vehicles },
    );
    expect(marketCalls).toBe(0);
    expect(enriched.inventory?.[0]?.pricingStatus).toBe('AWAITING_VEHICLE_DATA');
    expect(enriched.inventory?.[0]?.precioMx).toBe(0);

    const built = buildCanonicalQuoteV1({
      peritaje,
      pricedInventory: enriched.inventory ?? [],
      snap: paintSnap,
      quoteId: 'quo_mazda',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const refaccion = built.quote.lines.find((l) => l.serviceType === 'REFACCION');
    expect(refaccion?.billable).toBe(false);
    expect(refaccion?.pricingStatus).toBe('AWAITING_VEHICLE_DATA');
    expect(built.quote.isPartial).toBe(true);

    const stamped = stampPendingRequirementsAfterQuote({
      draft: emptyDraft(),
      peritaje,
      quote: built.quote,
      conversationId: 'conv_mazda',
    });
    expect(stamped.created).toHaveLength(1);
    expect(stamped.created[0]?.missingFields).toEqual(['year']);
    expect(stamped.created[0]?.confirmationFields).toEqual(['make', 'model']);
    expect(stamped.created[0]?.requiredFields).toEqual(['year', 'make', 'model']);
    expect(stamped.created[0]?.vehicleId).toBe(VEH);
    expect(stamped.created[0]?.damageItemId).toBe(DMG_CALAVERA);
    expect(stamped.created[0]?.reason).toBe('REFACCION_MARKET_LOOKUP');
  });

  it('4. Cliente solo “2020” no confirma modelo Vision ni busca mercado', async () => {
    const { peritaje, inventory } = mazdaCase();
    const awaiting = await enrichInventoryWithMarketRefacciones(
      {
        pieza: 'Calavera_Izquierda',
        severidad: 'DMFuerte',
        descripcionTecnica: '',
        justificacion: '',
        partesAfectadas: ['Calavera_Izquierda'],
        severidadDelDano: 'DMFuerte',
        vehiculoDetectado: 'Mazda 2',
        inventory,
      },
      { estimate: async () => {
        throw new Error('no market sin año');
      } } as never,
      () => undefined,
      { vehicles: peritaje.vehicles },
    );
    const initial = buildCanonicalQuoteV1({
      peritaje,
      pricedInventory: awaiting.inventory ?? [],
      snap: paintSnap,
      quoteId: 'quo_mazda',
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const stamped = stampPendingRequirementsAfterQuote({
      draft: emptyDraft(),
      peritaje,
      quote: initial.quote,
      conversationId: 'conv_mazda',
    });
    const parsed = parseConfirmVehicleIdentityArgs({ year: 2020 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const confirmed = applyConfirmVehicleIdentity({
      peritaje,
      inventory: awaiting.inventory ?? [],
      requirements: stamped.requirements,
      args: parsed.args,
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.result.vehicle.vehicleId).toBe(VEH);
    expect(confirmed.result.vehicle.year).toBe('2020');
    expect(confirmed.result.vehicle.model).toBe('2');
    expect(confirmed.result.vehicle.confirmedByUser).toBe(false);
    expect(confirmed.result.vehicle.confirmedFields).toEqual(['year']);
    expect(confirmed.result.resolved).toHaveLength(0);

    const refaccionLineId = createQuoteLineId({
      damageItemId: DMG_CALAVERA,
      serviceType: 'REFACCION',
    });
    let visionCalls = 0;
    const identities: VehiclePartIdentity[] = [];
    const resumed = await resumePendingQuotePricing({
      conversationId: 'conv_mazda',
      peritaje: confirmed.result.peritaje,
      inventory: confirmed.result.inventory,
      existingQuote: initial.quote,
      draft: stamped.draft,
      requirements: confirmed.result.requirements,
      vehicle: confirmed.result.vehicle,
      marketService: {
        estimate: async (identity: VehiclePartIdentity) => {
          identities.push(identity);
          return readyEstimate(identity, 4000);
        },
      } as never,
      snap: paintSnap,
    });
    expect(resumed.visionCalled).toBe(false);
    expect(visionCalls).toBe(0);
    expect(resumed.marketSearches).toBe(0);
    expect(identities).toHaveLength(0);
    expect(resumed.peritaje.vehicles[0]?.vehicleId).toBe(VEH);
    expect(
      resumed.inventory.find((i) => i.damageItemId === DMG_CALAVERA)?.damageItemId,
    ).toBe(DMG_CALAVERA);
    const refaccion = resumed.quote.lines.find((l) => l.serviceType === 'REFACCION');
    expect(refaccion?.quoteLineId).toBe(refaccionLineId);
    expect(refaccion?.damageItemId).toBe(DMG_CALAVERA);
    expect(refaccion?.pricingStatus).toBe('AWAITING_VEHICLE_DATA');
    expect(refaccion?.billable).toBe(false);
    expect(resumed.quote.isPartial).toBe(true);
    expect(resumed.requirements.some((r) => r.status === 'OPEN')).toBe(true);
    expect(
      resumed.requirements.find((r) => r.status === 'OPEN')?.confirmationFields,
    ).toEqual(['make', 'model']);
  });

  it('4b. make/model ya confirmados + año → resume: IDs iguales, solo market, cobrable', async () => {
    const { peritaje: raw, inventory } = mazdaCase();
    const peritaje = withConfirmedFields(raw, ['make', 'model']);
    const awaiting = await enrichInventoryWithMarketRefacciones(
      {
        pieza: 'Calavera_Izquierda',
        severidad: 'DMFuerte',
        descripcionTecnica: '',
        justificacion: '',
        partesAfectadas: ['Calavera_Izquierda'],
        severidadDelDano: 'DMFuerte',
        vehiculoDetectado: 'Mazda 2',
        inventory,
      },
      { estimate: async () => {
        throw new Error('no market sin año');
      } } as never,
      () => undefined,
      { vehicles: peritaje.vehicles },
    );
    const initial = buildCanonicalQuoteV1({
      peritaje,
      pricedInventory: awaiting.inventory ?? [],
      snap: paintSnap,
      quoteId: 'quo_mazda_year_only',
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const stamped = stampPendingRequirementsAfterQuote({
      draft: emptyDraft(),
      peritaje,
      quote: initial.quote,
      conversationId: 'conv_mazda',
    });
    expect(stamped.created[0]?.missingFields).toEqual(['year']);
    expect(stamped.created[0]?.confirmationFields).toEqual([]);
    const parsed = parseConfirmVehicleIdentityArgs({ year: 2020 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const confirmed = applyConfirmVehicleIdentity({
      peritaje,
      inventory: awaiting.inventory ?? [],
      requirements: stamped.requirements,
      args: parsed.args,
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.result.vehicle.vehicleId).toBe(VEH);
    expect(confirmed.result.vehicle.confirmedByUser).toBe(true);
    expect(confirmed.result.resolved).toHaveLength(1);
    const refaccionLineId = createQuoteLineId({
      damageItemId: DMG_CALAVERA,
      serviceType: 'REFACCION',
    });
    const resumed = await resumePendingQuotePricing({
      conversationId: 'conv_mazda',
      peritaje: confirmed.result.peritaje,
      inventory: confirmed.result.inventory,
      existingQuote: initial.quote,
      draft: stamped.draft,
      requirements: confirmed.result.requirements,
      vehicle: confirmed.result.vehicle,
      marketService: {
        estimate: async (identity: VehiclePartIdentity) =>
          readyEstimate(identity, 4000),
      } as never,
      snap: paintSnap,
    });
    expect(resumed.visionCalled).toBe(false);
    expect(resumed.marketSearches).toBe(1);
    expect(resumed.peritaje.vehicles[0]?.vehicleId).toBe(VEH);
    const refaccion = resumed.quote.lines.find((l) => l.serviceType === 'REFACCION');
    expect(refaccion?.quoteLineId).toBe(refaccionLineId);
    expect(refaccion?.damageItemId).toBe(DMG_CALAVERA);
    expect(refaccion?.billable).toBe(true);
    expect(refaccion?.pricingStatus).toBe('OK');
    expect(resumed.quote.isPartial).toBe(false);
  });

  it('11-12. Identidad completa + sample insuficiente → INSUFFICIENT, no pide año', async () => {
    const { peritaje: raw, inventory } = mazdaCase({ year: '2020', vehicleLabel: 'Mazda 2 2020 HB' });
    const peritaje = withConfirmedFields(raw);
    const enriched = await enrichInventoryWithMarketRefacciones(
      {
        pieza: 'Calavera_Izquierda',
        severidad: 'DMFuerte',
        descripcionTecnica: '',
        justificacion: '',
        partesAfectadas: ['Calavera_Izquierda'],
        severidadDelDano: 'DMFuerte',
        vehiculoDetectado: 'Mazda 2 2020 HB',
        inventory,
      },
      {
        estimate: async (identity: VehiclePartIdentity) =>
          insufficientEstimate(identity),
      } as never,
      () => undefined,
      { vehicles: peritaje.vehicles },
    );
    expect(enriched.inventory?.[0]?.pricingStatus).toBe(
      'INSUFFICIENT_MARKET_SAMPLE',
    );
    const built = buildCanonicalQuoteV1({
      peritaje,
      pricedInventory: enriched.inventory ?? [],
      snap: paintSnap,
      quoteId: 'quo_mazda',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const reasons = derivePartialQuoteReasons(built.quote, peritaje);
    expect(reasons.some((r) => r.code === 'INSUFFICIENT_MARKET_SAMPLE')).toBe(
      true,
    );
    expect(reasons.some((r) => r.code === 'AWAITING_VEHICLE_DATA')).toBe(false);
    const block = renderCanonicalQuoteFinancialBlock(built.quote, peritaje);
    expect(block.totalText).toMatch(/pendiente de estimaci[oó]n de mercado/);
    expect(block.totalText).not.toMatch(/falta el a[nñ]o/i);
  });

  it('13-15. Recalcula total, limpia isPartial y no toca REPARACION_PINTURA', async () => {
    const { peritaje, inventory } = mazdaCase({ withPaint: true });
    const awaiting = await enrichInventoryWithMarketRefacciones(
      {
        pieza: 'Calavera_Izquierda',
        severidad: 'DMFuerte',
        descripcionTecnica: '',
        justificacion: '',
        partesAfectadas: ['Calavera_Izquierda', 'SI'],
        severidadDelDano: 'DMFuerte',
        vehiculoDetectado: 'Mazda 2',
        inventory,
      },
      { estimate: async () => {
        throw new Error('no market sin año');
      } } as never,
      () => undefined,
      { vehicles: peritaje.vehicles },
    );
    const initial = buildCanonicalQuoteV1({
      peritaje,
      pricedInventory: awaiting.inventory ?? [],
      snap: paintSnap,
      quoteId: 'quo_mazda',
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const paintBefore = initial.quote.lines.find(
      (l) => l.serviceType === 'REPARACION_PINTURA',
    );
    expect(paintBefore).toBeTruthy();
    const confirmed = applyConfirmVehicleIdentity({
      peritaje,
      inventory: awaiting.inventory ?? [],
      requirements: stampPendingRequirementsAfterQuote({
        draft: emptyDraft(),
        peritaje,
        quote: initial.quote,
        conversationId: 'conv_mazda',
      }).requirements,
      args: { make: 'Mazda', model: '2', year: '2020', variant: 'HB' },
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    const resumed = await resumePendingQuotePricing({
      conversationId: 'conv_mazda',
      peritaje: confirmed.result.peritaje,
      inventory: confirmed.result.inventory,
      existingQuote: initial.quote,
      draft: emptyDraft(),
      requirements: confirmed.result.requirements,
      vehicle: confirmed.result.vehicle,
      marketService: {
        estimate: async (identity: VehiclePartIdentity) =>
          readyEstimate(identity, 4000),
      } as never,
      snap: paintSnap,
    });
    const paintAfter = resumed.quote.lines.find(
      (l) => l.serviceType === 'REPARACION_PINTURA',
    );
    expect(paintAfter?.amount).toBe(paintBefore?.amount);
    expect(paintAfter?.quoteLineId).toBe(paintBefore?.quoteLineId);
    const refaccion = resumed.quote.lines.find((l) => l.serviceType === 'REFACCION');
    expect(resumed.quote.total).toBe(
      (refaccion?.amount ?? 0) + (paintAfter?.amount ?? 0),
    );
    expect(resumed.quote.isPartial).toBe(false);
    expect(confirmed.result.vehicle.displayLabel).toMatch(/HB/);
  });

  it('16. Repetir el mismo dato es idempotente (un solo market search)', async () => {
    const { peritaje, inventory } = mazdaCase();
    const awaiting = await enrichInventoryWithMarketRefacciones(
      {
        pieza: 'Calavera_Izquierda',
        severidad: 'DMFuerte',
        descripcionTecnica: '',
        justificacion: '',
        partesAfectadas: ['Calavera_Izquierda'],
        severidadDelDano: 'DMFuerte',
        vehiculoDetectado: 'Mazda 2',
        inventory,
      },
      { estimate: async () => {
        throw new Error('no market sin año');
      } } as never,
      () => undefined,
      { vehicles: peritaje.vehicles },
    );
    const initial = buildCanonicalQuoteV1({
      peritaje,
      pricedInventory: awaiting.inventory ?? [],
      snap: paintSnap,
      quoteId: 'quo_mazda_idemp',
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const firstConfirm = applyConfirmVehicleIdentity({
      peritaje,
      inventory: awaiting.inventory ?? [],
      requirements: stampPendingRequirementsAfterQuote({
        draft: emptyDraft(),
        peritaje,
        quote: initial.quote,
        conversationId: 'conv_mazda',
      }).requirements,
      args: { make: 'Mazda', model: '2', year: '2020' },
    });
    expect(firstConfirm.ok).toBe(true);
    if (!firstConfirm.ok) return;
    let searches = 0;
    const service = {
      estimate: async (identity: VehiclePartIdentity) => {
        searches += 1;
        return readyEstimate(identity, 4000);
      },
    };
    const first = await resumePendingQuotePricing({
      conversationId: 'conv_mazda',
      peritaje: firstConfirm.result.peritaje,
      inventory: firstConfirm.result.inventory,
      existingQuote: initial.quote,
      draft: emptyDraft(),
      requirements: firstConfirm.result.requirements,
      vehicle: firstConfirm.result.vehicle,
      marketService: service as never,
      snap: paintSnap,
    });
    const secondConfirm = applyConfirmVehicleIdentity({
      peritaje: first.peritaje,
      inventory: first.inventory,
      requirements: first.requirements,
      args: { year: '2020' },
    });
    expect(secondConfirm.ok).toBe(true);
    if (!secondConfirm.ok) return;
    await resumePendingQuotePricing({
      conversationId: 'conv_mazda',
      peritaje: secondConfirm.result.peritaje,
      inventory: secondConfirm.result.inventory,
      existingQuote: first.quote,
      draft: emptyDraft(),
      requirements: secondConfirm.result.requirements,
      vehicle: secondConfirm.result.vehicle,
      marketService: service as never,
      snap: paintSnap,
    });
    expect(searches).toBe(1);
    const reqIds = first.requirements.map((r) => r.requirementId);
    expect(new Set(reqIds).size).toBe(reqIds.length);
  });

  it('17. Corrección de vehículo invalida market previo y re-busca', async () => {
    const { peritaje: raw, inventory } = mazdaCase({
      year: '2020',
      vehicleLabel: 'Mazda 2 2020',
    });
    const peritaje = withConfirmedFields(raw);
    const priced = await enrichInventoryWithMarketRefacciones(
      {
        pieza: 'Calavera_Izquierda',
        severidad: 'DMFuerte',
        descripcionTecnica: '',
        justificacion: '',
        partesAfectadas: ['Calavera_Izquierda'],
        severidadDelDano: 'DMFuerte',
        vehiculoDetectado: 'Mazda 2 2020',
        inventory,
      },
      {
        estimate: async (identity: VehiclePartIdentity) =>
          readyEstimate(identity, 4000),
      } as never,
      () => undefined,
      { vehicles: peritaje.vehicles },
    );
    const initial = buildCanonicalQuoteV1({
      peritaje,
      pricedInventory: priced.inventory ?? [],
      snap: paintSnap,
      quoteId: 'quo_mazda_fix',
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const priorAmount = initial.quote.lines.find(
      (l) => l.serviceType === 'REFACCION',
    )?.amount;
    const corrected = applyConfirmVehicleIdentity({
      peritaje,
      inventory: priced.inventory ?? [],
      args: { make: 'Mazda', model: '3', year: '2020' },
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    expect(corrected.result.vehicle.vehicleId).toBe(VEH);
    expect(corrected.result.vehicle.model).toBe('3');
    expect(corrected.result.identityAttrsChanged).toBe(true);
    expect(corrected.result.inventory[0]?.pricingStatus).toBeUndefined();
    const queries: string[] = [];
    const resumed = await resumePendingQuotePricing({
      conversationId: 'conv_mazda',
      peritaje: corrected.result.peritaje,
      inventory: corrected.result.inventory,
      existingQuote: initial.quote,
      draft: emptyDraft(),
      vehicle: corrected.result.vehicle,
      marketService: {
        estimate: async (identity: VehiclePartIdentity) => {
          queries.push(`${identity.marca} ${identity.modelo} ${identity.anio}`);
          return readyEstimate(identity, 5500);
        },
      } as never,
      snap: paintSnap,
    });
    expect(queries[0]).toMatch(/mazda\s+3\s+2020/i);
    const after = resumed.quote.lines.find((l) => l.serviceType === 'REFACCION');
    expect(after?.damageItemId).toBe(DMG_CALAVERA);
    expect(after?.amount).not.toBe(priorAmount);
    expect(after?.quoteLineId).toBe(
      createQuoteLineId({ damageItemId: DMG_CALAVERA, serviceType: 'REFACCION' }),
    );
  });

  it('18. Legacy: confirmar identidad no rompe un flujo sin peritaje canónico', () => {
    const parsed = parseConfirmVehicleIdentityArgs({
      make: 'Nissan',
      model: 'March',
      year: 2018,
    });
    expect(parsed.ok).toBe(true);
    const identity = parseVehiclePartIdentity({
      vehiculoText: 'Nissan March',
      pieza: 'Fascia',
    });
    expect(identity.marca.toLowerCase()).toContain('nissan');
  });

  it('19. Caso Mazda real: year null → AWAITING; “Es Mazda 2 2020 HB” reanuda', async () => {
    const { peritaje, inventory } = mazdaCase();
    expect(peritaje.vehicles[0]?.year).toBeFalsy();
    const events: string[] = [];
    const awaiting = await enrichInventoryWithMarketRefacciones(
      {
        pieza: 'Calavera_Izquierda',
        severidad: 'DMFuerte',
        descripcionTecnica: '',
        justificacion: '',
        partesAfectadas: ['Calavera_Izquierda'],
        severidadDelDano: 'DMFuerte',
        vehiculoDetectado: 'Mazda 2',
        inventory,
      },
      { estimate: async () => {
        throw new Error('no market');
      } } as never,
      (event) => events.push(event),
      { vehicles: peritaje.vehicles },
    );
    expect(events).toContain(REFACCION_MARKET_EVENTS.AWAITING_VEHICLE_DATA);
    const initial = buildCanonicalQuoteV1({
      peritaje,
      pricedInventory: awaiting.inventory ?? [],
      snap: paintSnap,
      quoteId: 'quo_mazda_real',
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const parsed = parseConfirmVehicleIdentityArgs({
      make: 'Mazda',
      model: '2',
      year: 2020,
      variant: 'HB',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const confirmed = applyConfirmVehicleIdentity({
      peritaje,
      inventory: awaiting.inventory ?? [],
      requirements: stampPendingRequirementsAfterQuote({
        draft: emptyDraft(),
        peritaje,
        quote: initial.quote,
        conversationId: 'conv_mazda',
      }).requirements,
      args: parsed.args,
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.result.vehicle).toMatchObject({
      vehicleId: VEH,
      make: 'Mazda',
      model: '2',
      year: '2020',
      variant: 'HB',
      confirmedByUser: true,
    });
    const resumed = await resumePendingQuotePricing({
      conversationId: 'conv_mazda',
      peritaje: confirmed.result.peritaje,
      inventory: confirmed.result.inventory,
      existingQuote: initial.quote,
      draft: emptyDraft(),
      requirements: confirmed.result.requirements,
      vehicle: confirmed.result.vehicle,
      marketService: {
        estimate: async (identity: VehiclePartIdentity) => {
          expect(identity.anio).toBe('2020');
          expect(String(identity.version ?? '').toUpperCase()).toBe('HB');
          return readyEstimate(identity, 4100);
        },
      } as never,
      snap: paintSnap,
    });
    expect(resumed.visionCalled).toBe(false);
    expect(resumed.quote.quoteId).toBe(initial.quote.quoteId);
    const refaccion = resumed.quote.lines.find((l) => l.serviceType === 'REFACCION');
    expect(refaccion?.quoteLineId).toBe(
      initial.quote.lines.find((l) => l.serviceType === 'REFACCION')?.quoteLineId,
    );
  });

  it('20. Nissan Vision Versa: “Es Nissan Altima 2014” conserva vehicleId y no busca Versa', async () => {
    const inventory: DetectedDamageItem[] = [
      item({
        pieza: 'Calavera_Derecha',
        vehiculoDetectado: 'Nissan Versa',
      }),
    ];
    const raw = peritajeFromLegacyAnalysis({
      conversationId: 'conv_nissan',
      tallerId: 't1',
      peritajeId: 'per_nissan',
      now: '2026-09-13T00:00:00.000Z',
      canonicalizePanel: canonicalPhysicalPanelKey,
      analysis: { vehiculoDetectado: 'Nissan Versa', inventory },
    });
    const stampedIds = stampInventoryFromCanonicalPeritaje(inventory, raw);
    const vehicleId = raw.vehicles[0]!.vehicleId;
    const damageItemId = raw.damages[0]!.damageItemId;
    const awaiting = await enrichInventoryWithMarketRefacciones(
      {
        pieza: 'Calavera_Derecha',
        severidad: 'DMFuerte',
        descripcionTecnica: '',
        justificacion: '',
        partesAfectadas: ['Calavera_Derecha'],
        severidadDelDano: 'DMFuerte',
        vehiculoDetectado: 'Nissan Versa',
        inventory: stampedIds,
      },
      { estimate: async () => {
        throw new Error('no market sobre Versa no confirmado');
      } } as never,
      () => undefined,
      { vehicles: raw.vehicles },
    );
    expect(awaiting.inventory?.[0]?.pricingStatus).toBe('AWAITING_VEHICLE_DATA');
    const initial = buildCanonicalQuoteV1({
      peritaje: raw,
      pricedInventory: awaiting.inventory ?? [],
      snap: paintSnap,
      quoteId: 'quo_nissan',
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const parsed = parseConfirmVehicleIdentityArgs({
      make: 'Nissan',
      model: 'Altima',
      year: 2014,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const confirmed = applyConfirmVehicleIdentity({
      peritaje: raw,
      inventory: awaiting.inventory ?? [],
      requirements: stampPendingRequirementsAfterQuote({
        draft: emptyDraft(),
        peritaje: raw,
        quote: initial.quote,
        conversationId: 'conv_nissan',
      }).requirements,
      args: parsed.args,
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.result.vehicle.vehicleId).toBe(vehicleId);
    expect(confirmed.result.vehicle.model).toBe('Altima');
    expect(confirmed.result.vehicle.year).toBe('2014');
    expect(confirmed.result.vehicle.confirmedByUser).toBe(true);
    expect(confirmed.result.identityAttrsChanged).toBe(true);
    expect(confirmed.result.peritaje.damages.every((d) => d.vehicleId === vehicleId)).toBe(
      true,
    );
    expect(confirmed.result.inventory[0]?.damageItemId).toBe(damageItemId);
    const queries: string[] = [];
    const resumed = await resumePendingQuotePricing({
      conversationId: 'conv_nissan',
      peritaje: confirmed.result.peritaje,
      inventory: confirmed.result.inventory,
      existingQuote: initial.quote,
      draft: emptyDraft(),
      requirements: confirmed.result.requirements,
      vehicle: confirmed.result.vehicle,
      marketService: {
        estimate: async (identity: VehiclePartIdentity) => {
          queries.push(`${identity.marca} ${identity.modelo} ${identity.anio}`);
          return readyEstimate(identity, 4800);
        },
      } as never,
      snap: paintSnap,
    });
    expect(resumed.visionCalled).toBe(false);
    expect(queries[0]).toMatch(/nissan\s+altima\s+2014/i);
    expect(queries[0]).not.toMatch(/versa/i);
    const refaccion = resumed.quote.lines.find((l) => l.serviceType === 'REFACCION');
    expect(refaccion?.damageItemId).toBe(damageItemId);
    expect(refaccion?.quoteLineId).toBe(
      createQuoteLineId({ damageItemId, serviceType: 'REFACCION' }),
    );
    expect(refaccion?.pricingStatus).toBe('OK');
  });
});
