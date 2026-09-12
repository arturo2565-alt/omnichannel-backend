import {
  buildCanonicalQuoteV1,
  projectCanonicalQuoteOntoDraft,
  resolveAuthoritativeDraftFinance,
} from './canonical-quote-engine';
import { quoteRowsFromDamageInventory } from './draft-quote-inventory-pricing';
import { ensureDamageIdentity } from './piece-treatment';
import {
  createDamageItemId,
  createVehicleId,
  peritajeFromLegacyAnalysis,
  sumChargeableAmount,
} from '../domain/peritaje-v1';
import { canonicalPhysicalPanelKey } from './piece-treatment';
import type { DetectedDamageItem } from './entities/chat.entity';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import type { DraftQuote } from './autofix-config';
import { isBanioPinturaCompletoVisionInventory } from './vision-bpc-inventory';
import { resolveIntegralPriceForVehicleProfile } from '../catalog/vehicle-integral-pricing';
import { resolveBañoCanonicalFromSnap } from './instant-quote-from-text';

function snap(prices: Record<string, number> = {}): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => {
      if (/bpcc|cambio de color/i.test(s)) {
        return 'Baño de Pintura con Cambio de Color';
      }
      if (/bpei|interiores/i.test(s)) {
        return 'Baño de Pintura Exterior e Interiores';
      }
      if (/bañ|bano|\bbpe\b/i.test(s)) return 'Baño de Pintura Exterior';
      return s;
    },
    getPriceForCanonical: (canonical: string, level: string) => {
      const exact = prices[`${canonical}|${level}`] ?? prices[canonical];
      if (exact != null) return exact;
      if (canonical === 'Baño de Pintura Exterior' || canonical === 'Fascia' || canonical === 'Cofre') {
        return 4000;
      }
      return 0;
    },
    getAmount: (pieza: string, level: string) =>
      prices[`${pieza}|${level}`] ?? prices[pieza] ?? 4000,
    getDiasEntregaForCanonical: () => 5,
    listSeveridadesForCanonical: (canonical: string) => {
      if (
        canonical === 'Baño de Pintura Exterior e Interiores' ||
        canonical === 'Baño de Pintura con Cambio de Color'
      ) {
        return [];
      }
      return ['DL', 'DM', 'BASE', 'Mediano'];
    },
    serviciosOrderedLongestFirst: [
      'Baño de Pintura Exterior',
      'Fascia',
      'Cofre',
    ],
  } as MatrixPricingSnapshot;
}

function item(
  overrides: Partial<DetectedDamageItem> & Pick<DetectedDamageItem, 'pieza'>,
): DetectedDamageItem {
  return {
    severidad: 'DM',
    descripcionTecnica: 'golpe',
    urls_origen: ['https://cdn.example/a.jpg'],
    ...overrides,
  };
}

function peritajeFrom(items: DetectedDamageItem[]) {
  return peritajeFromLegacyAnalysis({
    conversationId: 'c1',
    tallerId: 't1',
    peritajeId: 'per_test',
    now: '2026-09-11T00:00:00.000Z',
    canonicalizePanel: canonicalPhysicalPanelKey,
    analysis: {
      vehiculoDetectado: 'Mazda 3 2020',
      inventory: items,
    },
  });
}

function emptyDraft(): DraftQuote {
  return {
    status: 'PENDING_APPROVAL',
    currency: 'MXN',
    reference: 'COT-AF-TEST',
    generatedAt: '2026-09-11T00:00:00.000Z',
    lines: [],
    subtotal: 0,
    total: 0,
    formalNarrative: 'Estimado cliente,',
    analysisBasis: {
      pieza: 'x',
      severidad: 'DM',
      partesAfectadas: [],
      severidadDelDano: 'DM',
      descripcionTecnica: '',
      justificacion: '',
    },
  };
}

describe('Fase 5 — damageItemId estable', () => {
  const mazda = createVehicleId({ displayLabel: 'Mazda 3 2020' });
  const versa = createVehicleId({ displayLabel: 'Nissan Versa 2018' });

  it('mismo vehículo + panel, descripción distinta → mismo damageItemId', () => {
    expect(
      createDamageItemId({ vehicleId: mazda, physicalPanelKey: 'FD' }),
    ).toBe(createDamageItemId({ vehicleId: mazda, physicalPanelKey: 'FD' }));
    const a = ensureDamageIdentity(
      item({ pieza: 'FD', vehicleId: mazda, descripcionTecnica: 'rayón/deformación' }),
    );
    const b = ensureDamageIdentity(
      item({ pieza: 'FD', vehicleId: mazda, descripcionTecnica: 'fractura inferior' }),
    );
    expect(a.damageItemId).toBe(b.damageItemId);
  });

  it('severidad distinta → mismo damageItemId', () => {
    const a = ensureDamageIdentity(item({ pieza: 'FD', vehicleId: mazda, severidad: 'DL' }));
    const b = ensureDamageIdentity(item({ pieza: 'FD', vehicleId: mazda, severidad: 'DF' }));
    expect(a.damageItemId).toBe(b.damageItemId);
  });

  it('treatment distinto → mismo damageItemId', () => {
    const a = ensureDamageIdentity(
      item({ pieza: 'FD', vehicleId: mazda, tratamiento: 'REPARAR' }),
    );
    const b = ensureDamageIdentity(
      item({ pieza: 'FD', vehicleId: mazda, tratamiento: 'SUSTITUIR' }),
    );
    expect(a.damageItemId).toBe(b.damageItemId);
  });

  it('vehículo distinto → damageItemId distinto', () => {
    expect(
      createDamageItemId({ vehicleId: mazda, physicalPanelKey: 'FD' }),
    ).not.toBe(createDamageItemId({ vehicleId: versa, physicalPanelKey: 'FD' }));
  });

  it('panel distinto → damageItemId distinto', () => {
    expect(
      createDamageItemId({ vehicleId: mazda, physicalPanelKey: 'FD' }),
    ).not.toBe(createDamageItemId({ vehicleId: mazda, physicalPanelKey: 'Cofre' }));
  });
});

describe('Fase 5 — Canonical Quote Engine', () => {
  const pricing = snap({
    'Fascia|DL': 2900,
    'Fascia|DM': 3600,
    'Cofre|DL': 4000,
    'Cofre|DM': 5000,
    'Baño de Pintura Exterior|Mediano': 20000,
    'Baño de Pintura Exterior|BASE': 20000,
  });

  it('1. REPARAR: precio legacy = precio canonical', () => {
    const inv = [
      item({
        pieza: 'FD',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
        vehiculoDetectado: 'Mazda 3 2020',
      }),
    ];
    const legacy = quoteRowsFromDamageInventory(inv, pricing);
    const built = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(inv),
      pricedInventory: inv,
      snap: pricing,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.quote.total).toBe(legacy[0]!.precioMx);
    expect(built.quote.lines).toHaveLength(1);
  });

  it('2. SUSTITUIR: REFACCION + MONTAJE, total exacto', () => {
    const inv = [
      item({
        pieza: 'Cofre',
        tratamiento: 'SUSTITUIR',
        treatmentSource: 'vision',
        precioMx: 2500,
        vehiculoDetectado: 'Mazda 3 2020',
      }),
    ];
    const legacy = quoteRowsFromDamageInventory(inv, pricing);
    const built = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(inv),
      pricedInventory: inv,
      snap: pricing,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.quote.lines.map((l) => l.serviceType)).toEqual([
      'REFACCION',
      'MONTAJE_PINTURA',
    ]);
    expect(built.quote.total).toBe(
      legacy.filter((r) => r.billable !== false).reduce((a, r) => a + r.precioMx, 0),
    );
  });

  it('3. INCIERTO: misma política comercial existente', () => {
    const inv = [
      item({
        pieza: 'FD',
        tratamiento: 'INCIERTO',
        treatmentSource: 'vision',
        vehiculoDetectado: 'Mazda 3 2020',
      }),
    ];
    const legacy = quoteRowsFromDamageInventory(inv, pricing);
    const built = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(inv),
      pricedInventory: inv,
      snap: pricing,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.quote.lines[0]?.serviceType).toBe('REPARACION_PINTURA');
    expect(built.quote.total).toBe(legacy[0]!.precioMx);
    expect(built.quote.warnings).toContain('POSSIBLE_SUBSTITUTION');
  });

  it('4. PENDIENTE no suma', () => {
    const inv = [
      item({
        pieza: 'FD',
        tratamiento: 'PENDIENTE',
        treatmentSource: 'vision',
        vehiculoDetectado: 'Mazda 3 2020',
      }),
    ];
    const built = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(inv),
      pricedInventory: inv,
      snap: pricing,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.quote.total).toBe(0);
    expect(built.quote.lines[0]?.billable).toBe(false);
  });

  it('5. hidden damage: warning no suma', () => {
    const inv = [
      item({
        pieza: 'Posibles daños internos',
        tratamiento: 'PENDIENTE',
        treatmentSource: 'vision',
        vehiculoDetectado: 'Mazda 3 2020',
      }),
    ];
    const built = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(inv),
      pricedInventory: inv,
      snap: pricing,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.quote.total).toBe(0);
    expect(built.quote.warnings).toContain('HIDDEN_DAMAGE');
  });

  it('6. refacción sin muestra: isPartial true', () => {
    const inv = [
      item({
        pieza: 'Cofre',
        tratamiento: 'SUSTITUIR',
        treatmentSource: 'vision',
        pricingStatus: 'INSUFFICIENT_MARKET_SAMPLE',
        priceSource: 'INSUFFICIENT_MARKET_SAMPLE',
        vehiculoDetectado: 'Mazda 3 2020',
      }),
    ];
    const built = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(inv),
      pricedInventory: inv,
      snap: pricing,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.quote.isPartial).toBe(true);
    expect(built.quote.warnings).toContain('REFACCION_PENDIENTE_DE_COTIZAR');
  });

  it('7. refacción insuficiente + montaje no es cotización completa', () => {
    const inv = [
      item({
        pieza: 'Cofre',
        tratamiento: 'SUSTITUIR',
        treatmentSource: 'vision',
        pricingStatus: 'INSUFFICIENT_MARKET_SAMPLE',
        priceSource: 'INSUFFICIENT_MARKET_SAMPLE',
        vehiculoDetectado: 'Mazda 3 2020',
      }),
    ];
    const built = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(inv),
      pricedInventory: inv,
      snap: pricing,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const montaje = built.quote.lines.find((l) => l.serviceType === 'MONTAJE_PINTURA');
    expect(montaje?.amount).toBeGreaterThan(0);
    expect(built.quote.isPartial).toBe(true);
    expect(built.quote.total).toBe(montaje!.amount);
  });

  it('8. billable false + amount positivo accidental no suma', () => {
    const inv = [
      item({
        pieza: 'FD',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
        vehiculoDetectado: 'Mazda 3 2020',
      }),
    ];
    const built = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(inv),
      pricedInventory: inv,
      snap: pricing,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const mutated = {
      ...built.quote,
      lines: built.quote.lines.map((l) => ({
        ...l,
        billable: false,
        amount: 9999,
      })),
    };
    expect(sumChargeableAmount(mutated.lines)).toBe(0);
  });

  it('9. reordenar lines: total no cambia', () => {
    const inv = [
      item({
        pieza: 'FD',
        tratamiento: 'SUSTITUIR',
        treatmentSource: 'vision',
        precioMx: 1800,
        vehiculoDetectado: 'Mazda 3 2020',
      }),
      item({
        pieza: 'Cofre',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
        vehiculoDetectado: 'Mazda 3 2020',
      }),
    ];
    const built = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(inv),
      pricedInventory: inv,
      snap: pricing,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const reversed = sumChargeableAmount([...built.quote.lines].reverse());
    expect(reversed).toBe(built.quote.total);
  });

  it('10. reordenar DamageItems: total no cambia', () => {
    const a = item({
      pieza: 'FD',
      tratamiento: 'REPARAR',
      treatmentSource: 'vision',
      vehiculoDetectado: 'Mazda 3 2020',
    });
    const b = item({
      pieza: 'Cofre',
      tratamiento: 'REPARAR',
      treatmentSource: 'vision',
      vehiculoDetectado: 'Mazda 3 2020',
    });
    const first = buildCanonicalQuoteV1({
      peritaje: peritajeFrom([a, b]),
      pricedInventory: [a, b],
      snap: pricing,
    });
    const second = buildCanonicalQuoteV1({
      peritaje: peritajeFrom([b, a]),
      pricedInventory: [b, a],
      snap: pricing,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.quote.total).toBe(second.quote.total);
  });

  it('11-12. quotePayload.total y estimateAmount = canonical total', () => {
    const inv = [
      item({
        pieza: 'FD',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
        vehiculoDetectado: 'Mazda 3 2020',
      }),
    ];
    const built = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(inv),
      pricedInventory: inv,
      snap: pricing,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const projected = projectCanonicalQuoteOntoDraft(
      emptyDraft(),
      built.quote,
      pricing,
      built.rows,
    );
    expect(projected.total).toBe(built.quote.total);
    expect(projected.subtotal).toBe(built.quote.total);
    const finance = resolveAuthoritativeDraftFinance({
      peritaje: peritajeFrom(inv),
      pricedInventory: inv,
      snap: pricing,
      priorDraft: emptyDraft(),
      legacyDraft: { ...emptyDraft(), total: 1, subtotal: 1 },
      legacyEstimate: 999999,
    });
    expect(finance.mode).toBe('canonical');
    if (finance.mode !== 'canonical') return;
    expect(finance.estimateAmount).toBe(built.quote.total);
    expect(finance.draft.total).toBe(built.quote.total);
  });

  it('13. snapshot freeze conserva amounts si el carrito cambia', () => {
    const inv = [
      item({
        pieza: 'FD',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
        vehiculoDetectado: 'Mazda 3 2020',
      }),
    ];
    const first = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(inv),
      pricedInventory: inv,
      snap: pricing,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const qid = first.quote.lines[0]!.quoteLineId;
    const frozen = new Map([[qid, first.quote.lines[0]!.amount]]);
    const later = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(inv),
      pricedInventory: [
        item({
          pieza: 'FD',
          tratamiento: 'REPARAR',
          treatmentSource: 'vision',
          severidad: 'DF',
          vehiculoDetectado: 'Mazda 3 2020',
        }),
      ],
      snap: pricing,
      frozenByQuoteLineId: frozen,
    });
    expect(later.ok).toBe(true);
    if (!later.ok) return;
    expect(later.quote.lines[0]!.amount).toBe(first.quote.lines[0]!.amount);
    expect(later.quote.lines[0]!.quoteLineId).toBe(qid);
  });

  it('14. quoteLineId identifica preservación de precio', () => {
    const inv = [
      item({
        pieza: 'Cofre',
        tratamiento: 'SUSTITUIR',
        treatmentSource: 'vision',
        precioMx: 2500,
        vehiculoDetectado: 'Mazda 3 2020',
      }),
    ];
    const built = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(inv),
      pricedInventory: inv,
      snap: pricing,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const refaccion = built.quote.lines.find((l) => l.serviceType === 'REFACCION')!;
    const later = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(inv),
      pricedInventory: [
        item({
          pieza: 'Cofre',
          tratamiento: 'SUSTITUIR',
          treatmentSource: 'vision',
          precioMx: 8800,
          vehiculoDetectado: 'Mazda 3 2020',
        }),
      ],
      snap: pricing,
      frozenByQuoteLineId: new Map([[refaccion.quoteLineId, refaccion.amount]]),
    });
    expect(later.ok).toBe(true);
    if (!later.ok) return;
    expect(
      later.quote.lines.find((l) => l.quoteLineId === refaccion.quoteLineId)?.amount,
    ).toBe(refaccion.amount);
  });

  it('15. panel manual: pricingSource MANUAL y total consistente', () => {
    const inv = [
      item({
        pieza: 'FD',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
        vehiculoDetectado: 'Mazda 3 2020',
      }),
    ];
    const first = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(inv),
      pricedInventory: inv,
      snap: pricing,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const qid = first.quote.lines[0]!.quoteLineId;
    const built = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(inv),
      pricedInventory: inv,
      snap: pricing,
      manualOverrides: [{ quoteLineId: qid, amount: 7777 }],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.quote.lines[0]?.pricingSource).toBe('MANUAL');
    expect(built.quote.total).toBe(7777);
  });

  it('16. registro legacy sin canonical sigue funcionando', () => {
    const finance = resolveAuthoritativeDraftFinance({
      peritaje: null,
      pricedInventory: [item({ pieza: 'FD' })],
      snap: pricing,
      priorDraft: emptyDraft(),
      legacyDraft: { ...emptyDraft(), total: 3600, subtotal: 3600 },
      legacyEstimate: 3600,
    });
    expect(finance.mode).toBe('legacy');
    expect(finance.estimateAmount).toBe(3600);
  });

  it('17. moderno con canonical inválido no usa total legacy', () => {
    const inv = [
      item({
        pieza: 'REFACCION',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
        vehiculoDetectado: 'Mazda 3 2020',
      }),
    ];
    const finance = resolveAuthoritativeDraftFinance({
      peritaje: peritajeFrom(inv),
      pricedInventory: inv,
      snap: pricing,
      priorDraft: { ...emptyDraft(), total: 100 },
      legacyDraft: { ...emptyDraft(), total: 999999, subtotal: 999999 },
      legacyEstimate: 999999,
    });
    expect(finance.mode).toBe('canonical_blocked');
    expect(finance.estimateAmount).toBe(100);
    expect(finance.estimateAmount).not.toBe(999999);
  });

  it('18. BPE usa el resolver integral de su propio catálogo (sin fórmula BPEI/BPCC)', () => {
    const inv = [
      item({
        pieza: 'BPE',
        severidad: 'Mediano',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
        vehiculoDetectado: 'Mazda 3 2020',
      }),
    ];
    expect(isBanioPinturaCompletoVisionInventory(inv)).toBe(true);
    const profile = {
      vehicleLabel: 'Mazda 3 2020',
      sizeTier: 'Mediano' as const,
      isPremium: false,
      tierSource: 'vision' as const,
    };
    const built = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(inv),
      pricedInventory: inv,
      snap: pricing,
      vehicleProfile: profile,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const canonicalName =
      resolveBañoCanonicalFromSnap(pricing) ?? 'Baño de Pintura Exterior';
    const integral = resolveIntegralPriceForVehicleProfile(
      pricing,
      canonicalName,
      profile,
      null,
    );
    expect(built.quote.total).toBe(integral?.unitPrice ?? 0);
    expect(built.quote.lines[0]?.pricingSource).not.toBe('UNCONFIGURED');
  });

  it('19. BPCC sin precio propio no se cotiza como BPE + addon', () => {
    const inv = [
      item({
        pieza: 'BPCC',
        severidad: 'Mediano',
        tratamiento: 'REPARAR',
        treatmentSource: 'vision',
        vehiculoDetectado: 'Mazda 3 2020',
      }),
    ];
    const profile = {
      vehicleLabel: 'Mazda 3 2020',
      sizeTier: 'Mediano' as const,
      isPremium: false,
      tierSource: 'vision' as const,
    };
    const built = buildCanonicalQuoteV1({
      peritaje: peritajeFrom(inv),
      pricedInventory: inv,
      snap: pricing,
      vehicleProfile: profile,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.quote.lines[0]?.pricingSource).toBe('UNCONFIGURED');
    expect(built.quote.lines[0]?.billable).toBe(false);
    expect(built.quote.total).toBe(0);
    expect(built.quote.isPartial).toBe(true);
  });
});
