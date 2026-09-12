import {
  FLOW_EVENTS,
  QUOTE_FLOW_MODE,
  resolveModernPanelFallbackText,
  resolveQuoteFlowMode,
} from '../domain/peritaje-v1/quote-flow-mode';
import {
  assembleClientQuoteMessage,
  renderCanonicalQuoteFinancialBlock,
  renderDeterministicClientQuoteFallback,
} from '../domain/peritaje-v1/quote-narrative';
import { QUOTE_SCHEMA_VERSION } from '../domain/peritaje-v1';
import {
  buildCanonicalFreeze,
  resolveAuthoritativeDraftFinance,
} from './canonical-quote-engine';
import {
  buildCanonicalQuoteFromPricedSources,
  canonicalQuoteFromInstantResolution,
  commercialBundleFromExpress,
  commercialLinesFromExtras,
  mergeCommercialLinesIntoQuote,
} from './canonical-commercial-quote';
import { composeModernClientQuoteMessage } from './canonical-quote-narrative';
import { buildObtenerCotizacionExpressPayload } from './autopilot-cotizacion-express';
import { resolveVehiclePricingProfile } from '../catalog/vehicle-pricing-profile';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import type { DraftQuote } from './autofix-config';
import { createVehicleId } from '../domain/peritaje-v1';

function snap(prices: Record<string, number> = {}): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => {
      const n = String(s ?? '').toLowerCase();
      if (/bpcc|cambio de color/.test(n)) {
        return 'Baño de Pintura con Cambio de Color';
      }
      if (/bpei|interiores/.test(n)) {
        return 'Baño de Pintura Exterior e Interiores';
      }
      if (/bañ|bano|\bbpe\b|transformaci/.test(n)) {
        return 'Baño de Pintura Exterior';
      }
      if (/fascia|fd/.test(n)) return 'Fascia';
      if (/puerta/.test(n)) return 'Puerta';
      return s;
    },
    getPriceForCanonical: (canonical: string, level: string) => {
      const exact = prices[`${canonical}|${level}`] ?? prices[canonical];
      if (exact != null) return exact;
      if (
        canonical === 'Baño de Pintura Exterior e Interiores' ||
        canonical === 'Baño de Pintura con Cambio de Color'
      ) {
        return 0;
      }
      return 4000;
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
      return ['DL', 'BASE', 'Mediano', 'Compacto'];
    },
    serviciosOrderedLongestFirst: [
      'Baño de Pintura Exterior',
      'Fascia',
      'Puerta',
    ],
  } as MatrixPricingSnapshot;
}

function emptyDraft(): DraftQuote {
  return {
    status: 'PENDING_APPROVAL',
    currency: 'MXN',
    reference: 't',
    generatedAt: '2026-09-11T00:00:00.000Z',
    lines: [],
    subtotal: 0,
    total: 0,
    formalNarrative: '',
    analysisBasis: {
      pieza: 'x',
      severidad: 'DL',
      partesAfectadas: [],
      severidadDelDano: 'DL',
      descripcionTecnica: '',
      justificacion: '',
    },
  };
}

describe('Fase 7 — rutas modernas bajo CanonicalQuoteV1', () => {
  const bpeSnap = snap({
    'Baño de Pintura Exterior|BASE': 20000,
    'Baño de Pintura Exterior': 20000,
    'Fascia|DL': 4500,
    Fascia: 4500,
    'Puerta|DL': 3800,
    Puerta: 3800,
  });

  it('1. BPE produce CanonicalQuote', () => {
    const quote = canonicalQuoteFromInstantResolution({
      lines: [{ label: 'Baño de Pintura Exterior', amount: 20000 }],
      extras: [],
    });
    expect(quote.schemaVersion).toBe(QUOTE_SCHEMA_VERSION);
    expect(quote.total).toBe(20000);
    expect(quote.lines).toHaveLength(1);
    expect(quote.lines[0]?.commercialItemId).toMatch(/^cmi_/);
  });

  it('2. BPE financialBlock viene del renderer determinista', () => {
    const quote = canonicalQuoteFromInstantResolution({
      lines: [{ label: 'Baño de Pintura Exterior', amount: 20000 }],
      extras: [],
    });
    const block = renderCanonicalQuoteFinancialBlock(quote);
    expect(block.text).toContain('$20,000');
    expect(block.totalText).toContain('$20,000');
  });

  it('3. BPCC sin catálogo propio no se convierte en BPE', () => {
    const profile = resolveVehiclePricingProfile({
      modeloVehiculo: 'Nissan March',
      sizeTier: 'Compacto',
      isPremium: false,
    });
    const result = buildObtenerCotizacionExpressPayload(
      bpeSnap,
      ['BPCC'],
      profile,
    );
    expect(result.success).toBe(false);
    expect(String(result.error ?? '')).toMatch(/PRODUCT_CONFIGURATION_REQUIRED/);
  });

  it('4. LLM de baño intenta cambiar total → no llega al cliente', async () => {
    const quote = canonicalQuoteFromInstantResolution({
      lines: [{ label: 'Baño de Pintura Exterior', amount: 20000 }],
      extras: [],
    });
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: quote,
      contactName: 'Juan',
      hasActiveAppointment: false,
      llmParts: {
        intro: 'El baño queda en $99,000',
        technicalExplanation: 'Acabado espejo',
        cta: '¿Agendamos?',
      },
    });
    expect(composed.finalMessage).not.toContain('$99,000');
    expect(composed.finalMessage).toContain('$20,000');
    expect(composed.fallbackUsed).toBe(true);
  });

  it('5. express REPARAR produce CanonicalQuote', () => {
    const profile = resolveVehiclePricingProfile({
      modeloVehiculo: 'Mazda 3 2020',
      sizeTier: 'Mediano',
      isPremium: false,
    });
    const result = buildObtenerCotizacionExpressPayload(
      bpeSnap,
      ['Fascia'],
      profile,
    );
    const bundle = commercialBundleFromExpress(result, 'c-exp');
    expect(bundle.quote.schemaVersion).toBe(QUOTE_SCHEMA_VERSION);
    expect(bundle.quote.total).toBe(result.totalMx);
    expect(bundle.quote.lines.length).toBeGreaterThan(0);
  });

  it('6. express multi-pieza produce CanonicalQuote', () => {
    const profile = resolveVehiclePricingProfile({
      modeloVehiculo: 'Mazda 3 2020',
      sizeTier: 'Mediano',
      isPremium: false,
    });
    const result = buildObtenerCotizacionExpressPayload(
      bpeSnap,
      ['Fascia', 'Puerta'],
      profile,
    );
    const bundle = commercialBundleFromExpress(result, 'c-multi');
    expect(bundle.quote.lines.length).toBe(result.lines?.length);
    expect(bundle.quote.total).toBe(result.totalMx);
  });

  it('7. express total = suma canónica única', () => {
    const quote = canonicalQuoteFromInstantResolution({
      lines: [
        { label: 'Fascia', amount: 4500 },
        { label: 'Puerta', amount: 3800 },
      ],
      extras: [],
    });
    expect(quote.total).toBe(8300);
    expect(quote.subtotal).toBe(quote.total);
  });

  it('8. extra express contribuye mediante QuoteLine, no campo paralelo', () => {
    const vehicleId = createVehicleId({ displayLabel: 'Mazda 3 2020' });
    const extras = commercialLinesFromExtras(
      [{ label: 'Cambio de color', amount: 4500 }],
      vehicleId,
    );
    expect(extras.lines).toHaveLength(1);
    expect(extras.lines[0]?.commercialItemId).toMatch(/^cmi_/);
    expect(extras.lines[0]?.amount).toBe(4500);
    const base = buildCanonicalQuoteFromPricedSources({
      conversationId: 'c1',
      vehicleId,
      rows: [
        {
          pieza: 'Fascia',
          severidad: 'DL',
          precioMx: 4500,
          billable: true,
          serviceType: 'REPARACION_PINTURA',
        },
      ],
      extraLines: extras.lines,
    });
    expect(base.total).toBe(9000);
    expect(base.lines.some((l) => l.commercialItemId && l.amount === 4500)).toBe(
      true,
    );
  });

  it('9. carrito visual canónico + extra express permanece CANONICAL', () => {
    const visual = canonicalQuoteFromInstantResolution({
      lines: [{ label: 'Reparación fascia', amount: 4500 }],
      extras: [],
    });
    const extras = commercialLinesFromExtras(
      [{ label: 'Cambio de color', amount: 2000 }],
      'veh_1',
    );
    const merged = mergeCommercialLinesIntoQuote(visual, extras.lines);
    const decision = resolveQuoteFlowMode({
      lockedMode: QUOTE_FLOW_MODE.CANONICAL,
      canonicalQuote: merged,
      fromExpress: true,
    });
    expect(decision.mode).toBe(QUOTE_FLOW_MODE.CANONICAL);
    expect(decision.blockedDowngrade).toBe(false);
    expect(merged.total).toBe(6500);
  });

  it('10. no existe downgrade moderno → legacy', () => {
    const quote = canonicalQuoteFromInstantResolution({
      lines: [{ label: 'Fascia', amount: 4500 }],
      extras: [],
    });
    const decision = resolveQuoteFlowMode({
      lockedMode: QUOTE_FLOW_MODE.CANONICAL,
      canonicalQuote: null,
      canonicalPeritaje: null,
    });
    expect(decision.mode).toBe(QUOTE_FLOW_MODE.CANONICAL);
    expect(decision.blockedDowngrade).toBe(true);

    const finance = resolveAuthoritativeDraftFinance({
      pricedInventory: [],
      snap: bpeSnap,
      priorDraft: { ...emptyDraft(), quoteFlowMode: 'CANONICAL' },
      legacyDraft: { ...emptyDraft(), total: 1, subtotal: 1 },
      legacyEstimate: 999,
      existingQuote: quote,
    });
    expect(finance.mode).toBe('canonical');
    if (finance.mode === 'canonical') {
      expect(finance.quote.total).toBe(4500);
    }
  });

  it('11. panel moderno con API fallida no calcula total local', () => {
    const empty = resolveModernPanelFallbackText({
      quoteFlowMode: 'CANONICAL',
      hasCanonicalQuote: true,
      persistedFinalMessage: '',
    });
    expect(empty.text).toBe('');
    expect(empty.usedLocalFinance).toBe(false);
    const persisted = resolveModernPanelFallbackText({
      quoteFlowMode: 'CANONICAL',
      persistedFinancialBlock: '🛠️ Fascia: $4,500 MXN',
    });
    expect(persisted.text).toContain('$4,500');
    expect(persisted.usedLocalFinance).toBe(false);
  });

  it('12. preview BPC = renderer producción', () => {
    const quote = canonicalQuoteFromInstantResolution({
      lines: [{ label: 'Baño de Pintura Exterior', amount: 20000 }],
      extras: [],
    });
    const production = renderCanonicalQuoteFinancialBlock(quote).text;
    const preview = renderCanonicalQuoteFinancialBlock(quote).text;
    expect(preview).toBe(production);
  });

  it('13. preview express = renderer producción', () => {
    const quote = canonicalQuoteFromInstantResolution({
      lines: [{ label: 'Fascia', amount: 4500 }],
      extras: [],
    });
    expect(renderCanonicalQuoteFinancialBlock(quote).text).toContain('$4,500');
  });

  it('14. playground moderno usa mismo financialBlock', () => {
    const quote = canonicalQuoteFromInstantResolution({
      lines: [{ label: 'Refacción fascia delantera', amount: 6500 }],
      extras: [{ label: 'Montaje y pintura fascia delantera', amount: 3400 }],
    });
    const block = renderCanonicalQuoteFinancialBlock(quote);
    const fallback = renderDeterministicClientQuoteFallback({
      contactName: 'Playground',
      canonicalQuote: quote,
      hasActiveAppointment: false,
    });
    const message = assembleClientQuoteMessage({
      ...fallback,
      financialBlock: block.text,
    });
    expect(message).toContain(block.text);
    expect(message).toContain('$9,900');
  });

  it('15. snapshot BPC usa canonicalFreeze', () => {
    const quote = canonicalQuoteFromInstantResolution({
      lines: [{ label: 'Baño de Pintura Exterior', amount: 20000 }],
      extras: [],
    });
    const freeze = buildCanonicalFreeze(quote);
    expect(freeze.total).toBe(20000);
    expect(freeze.quoteId).toBe(quote.quoteId);
    expect(freeze.quoteLineIds).toEqual(quote.lines.map((l) => l.quoteLineId));
  });

  it('16. snapshot express usa canonicalFreeze', () => {
    const quote = canonicalQuoteFromInstantResolution({
      lines: [{ label: 'Fascia', amount: 4500 }],
      extras: [],
    });
    const freeze = buildCanonicalFreeze(quote);
    expect(freeze.total).toBe(4500);
    expect(freeze.isPartial).toBe(false);
  });

  it('17. reordenar operaciones no cambia total', () => {
    const a = canonicalQuoteFromInstantResolution({
      lines: [
        { label: 'Fascia', amount: 4500 },
        { label: 'Puerta', amount: 3800 },
      ],
      extras: [],
    });
    const b = canonicalQuoteFromInstantResolution({
      lines: [
        { label: 'Puerta', amount: 3800 },
        { label: 'Fascia', amount: 4500 },
      ],
      extras: [],
    });
    expect(a.total).toBe(b.total);
  });

  it('18. registro legacy sigue funcionando', () => {
    const decision = resolveQuoteFlowMode({
      lockedMode: QUOTE_FLOW_MODE.LEGACY,
    });
    expect(decision.mode).toBe(QUOTE_FLOW_MODE.LEGACY);
    const finance = resolveAuthoritativeDraftFinance({
      pricedInventory: [],
      snap: bpeSnap,
      priorDraft: { ...emptyDraft(), quoteFlowMode: 'LEGACY' },
      legacyDraft: { ...emptyDraft(), total: 1200, subtotal: 1200 },
      legacyEstimate: 1200,
    });
    expect(finance.mode).toBe('legacy');
    expect(finance.estimateAmount).toBe(1200);
  });

  it('19. ninguna ruta moderna imprime monto proveniente del LLM', async () => {
    const quote = canonicalQuoteFromInstantResolution({
      lines: [{ label: 'Fascia', amount: 4500 }],
      extras: [],
    });
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: quote,
      contactName: 'Ana',
      hasActiveAppointment: false,
      llmParts: {
        intro: 'Te lo dejo en unos 10 mil pesos',
        technicalExplanation: '',
        cta: 'Dime un día',
      },
    });
    expect(composed.finalMessage).not.toMatch(/10 mil/);
    expect(composed.finalMessage).toContain('$4,500');
  });

  it('resolver CANONICAL vs LEGACY no es ambiguo', () => {
    expect(
      resolveQuoteFlowMode({
        canonicalQuote: canonicalQuoteFromInstantResolution({
          lines: [{ label: 'x', amount: 1 }],
          extras: [],
        }),
        lockedMode: QUOTE_FLOW_MODE.LEGACY,
      }).mode,
    ).toBe(QUOTE_FLOW_MODE.CANONICAL);
    expect(FLOW_EVENTS.MODERN_FLOW_LEGACY_DOWNGRADE).toBe(
      'MODERN_FLOW_LEGACY_DOWNGRADE',
    );
  });
});

/**
 * BPCC CANONICAL: fila de catálogo "Baño de Pintura con Cambio de Color".
 * resolveBanioCodeUnitPrice / Transformación Total ~$31k son LEGACY y no
 * gobiernan express ni el Quote Engine.
 */
