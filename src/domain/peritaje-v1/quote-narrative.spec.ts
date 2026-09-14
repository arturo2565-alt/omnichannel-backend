import { peritajeFromLegacyAnalysis } from './from-legacy';
import { QUOTE_SCHEMA_VERSION } from './types';
import type { CanonicalQuoteV1, QuoteLine } from './types';
import {
  CANONICAL_WARNING_COPY,
  NARRATIVE_EVENTS,
  REFACCION_AVAILABILITY_DISCLAIMER,
  assembleClientQuoteMessage,
  buildControlledQuoteLineLabel,
  buildNarrativeSnapshotFields,
  extractMonetaryAmounts,
  formatQuoteMoney,
  formatQuoteMoneyRange,
  formatPendingConceptsCopy,
  formatPartialQuoteFooter,
  isCanonicalNarrativeEligible,
  llmNarrativeContainsForbiddenMoney,
  renderCanonicalQuoteFinancialBlock,
  renderCanonicalQuoteWarningsBlock,
  renderDeterministicClientQuoteFallback,
  sanitizeLlmNarrativeParts,
  validateFinalClientQuoteMessage,
} from './quote-narrative';

function line(partial: Partial<QuoteLine> & Pick<QuoteLine, 'serviceType' | 'amount'>): QuoteLine {
  return {
    quoteLineId: partial.quoteLineId ?? `ql_${partial.serviceType}`,
    damageItemId: partial.damageItemId ?? 'dmg_fascia',
    vehicleId: partial.vehicleId ?? 'veh_1',
    description: partial.description ?? 'fascia delantera',
    billable: partial.billable ?? true,
    confidence: partial.confidence ?? 'HIGH',
    ...partial,
  };
}

function quote(partial: Partial<CanonicalQuoteV1> & { lines: QuoteLine[] }): CanonicalQuoteV1 {
  const chargeable = partial.lines
    .filter((l) => l.billable && l.amount > 0 && l.serviceType !== 'PENDIENTE' && l.serviceType !== 'ADVERTENCIA' && l.pricingStatus !== 'INSUFFICIENT_MARKET_SAMPLE')
    .reduce((s, l) => s + l.amount, 0);
  return {
    schemaVersion: QUOTE_SCHEMA_VERSION,
    quoteId: partial.quoteId ?? 'q_test',
    peritajeId: partial.peritajeId ?? 'per_test',
    subtotal: partial.subtotal ?? chargeable,
    total: partial.total ?? chargeable,
    isPartial: partial.isPartial ?? false,
    warnings: partial.warnings ?? [],
    generatedAt: partial.generatedAt ?? '2026-09-11T00:00:00.000Z',
    lines: partial.lines,
  };
}

describe('Fase 6 — renderer y conciliación financiera', () => {
  const montaje3400 = line({
    quoteLineId: 'ql_montaje',
    serviceType: 'MONTAJE_PINTURA',
    amount: 3400,
    description: 'fascia delantera',
  });
  const refaccion6500 = line({
    quoteLineId: 'ql_ref',
    serviceType: 'REFACCION',
    amount: 6500,
    description: 'fascia delantera',
  });

  it('1. línea $3,400: el mensaje final contiene $3,400', () => {
    const q = quote({ lines: [montaje3400] });
    const block = renderCanonicalQuoteFinancialBlock(q);
    expect(block.text).toContain('$3,400');
    const message = assembleClientQuoteMessage({
      intro: 'Hola',
      technicalExplanation: '',
      financialBlock: block.text,
      warningsBlock: '',
      cta: '¿Agendamos?',
    });
    expect(message).toContain('$3,400');
  });

  it('3. canonical total $9,900: el total del mensaje es exactamente $9,900', () => {
    const q = quote({
      lines: [refaccion6500, montaje3400],
      total: 9900,
      subtotal: 9900,
    });
    const block = renderCanonicalQuoteFinancialBlock(q);
    expect(block.totalText).toContain('$9,900');
    expect(block.text).toContain('Refacción fascia delantera: $6,500 MXN');
    expect(block.text).toContain('Montaje y pintura fascia delantera: $3,400 MXN');
    const v = validateFinalClientQuoteMessage({
      canonicalQuote: q,
      renderedFinancialBlock: block.text,
      finalMessage: `Intro\n\n${block.text}\n\nCTA`,
    });
    expect(v.ok).toBe(true);
  });

  it('4. SUSTITUIR: REFACCION + MONTAJE aparecen ambas', () => {
    const q = quote({ lines: [refaccion6500, montaje3400], total: 9900, subtotal: 9900 });
    const block = renderCanonicalQuoteFinancialBlock(q);
    expect(block.text).toMatch(/Refacción fascia delantera/);
    expect(block.text).toMatch(/Montaje y pintura fascia delantera/);
  });

  it('disclaimer de disponibilidad solo en REFACCION de mercado', () => {
    const marketRef = line({
      serviceType: 'REFACCION',
      amount: 3650,
      description: 'Calavera derecha',
      pricingSource: 'WEB_MARKET_ESTIMATE',
      priceRange: { min: 3300, max: 3650, central: 3650 },
    });
    const install = line({
      quoteLineId: 'ql_montaje_only',
      serviceType: 'MONTAJE',
      amount: 800,
      description: 'Calavera derecha',
    });
    const q = quote({
      lines: [marketRef, install],
      total: 4450,
      subtotal: 4450,
    });
    const block = renderCanonicalQuoteFinancialBlock(q);
    expect(block.text).toContain('Refacción Calavera derecha');
    expect(block.text).toContain(`_${REFACCION_AVAILABILITY_DISCLAIMER}_`);
    expect(block.text).toContain('Montaje Calavera derecha: $800 MXN');
    expect(block.text).not.toMatch(
      /Montaje Calavera derecha:[\s\S]*Precio aproximado sujeto a disponibilidad/,
    );
    const paintOnly = quote({ lines: [montaje3400], total: 3400, subtotal: 3400 });
    const paintBlock = renderCanonicalQuoteFinancialBlock(paintOnly);
    expect(paintBlock.text).not.toContain(REFACCION_AVAILABILITY_DISCLAIMER);
  });

  it('5. REPARAR: no aparece REFACCION', () => {
    const q = quote({
      lines: [
        line({
          serviceType: 'REPARACION_PINTURA',
          amount: 4500,
          description: 'fascia delantera',
        }),
      ],
    });
    const block = renderCanonicalQuoteFinancialBlock(q);
    expect(block.text).toContain('Reparación y pintura fascia delantera');
    expect(block.text).not.toMatch(/Refacción/);
  });

  it('6. PENDIENTE: no se imprime como cargo', () => {
    const q = quote({
      lines: [
        montaje3400,
        line({
          quoteLineId: 'ql_pend',
          serviceType: 'PENDIENTE',
          amount: 8000,
          billable: false,
          description: 'puerta',
        }),
      ],
      warnings: ['PENDING_TREATMENT'],
    });
    const block = renderCanonicalQuoteFinancialBlock(q);
    expect(block.text).not.toContain('$8,000');
    expect(block.text).not.toMatch(/Pendiente de revisión puerta: \$/);
  });

  it('7. ADVERTENCIA: no se imprime como cargo', () => {
    const q = quote({
      lines: [
        montaje3400,
        line({
          quoteLineId: 'ql_adv',
          serviceType: 'ADVERTENCIA',
          amount: 2500,
          billable: false,
          description: 'daños internos',
        }),
      ],
      warnings: ['HIDDEN_DAMAGE'],
    });
    const block = renderCanonicalQuoteFinancialBlock(q);
    expect(block.text).not.toContain('$2,500');
  });

  it('8. hidden damage: warning obligatorio presente', () => {
    const q = quote({
      lines: [montaje3400],
      warnings: ['HIDDEN_DAMAGE'],
    });
    const warnings = renderCanonicalQuoteWarningsBlock(q);
    expect(warnings.text).toContain(CANONICAL_WARNING_COPY.HIDDEN_DAMAGE);
    const message = assembleClientQuoteMessage({
      intro: 'Hola',
      technicalExplanation: '',
      financialBlock: renderCanonicalQuoteFinancialBlock(q).text,
      warningsBlock: warnings.text,
      cta: 'CTA',
    });
    const v = validateFinalClientQuoteMessage({
      canonicalQuote: q,
      renderedFinancialBlock: renderCanonicalQuoteFinancialBlock(q).text,
      finalMessage: message,
      warningsBlock: warnings.text,
    });
    expect(v.ok).toBe(true);
  });

  it('9. refacción insuficiente + montaje: cotización parcial', () => {
    const q = quote({
      lines: [
        line({
          ...refaccion6500,
          amount: 0,
          billable: false,
          pricingStatus: 'INSUFFICIENT_MARKET_SAMPLE',
          pricingSource: 'INSUFFICIENT_MARKET_SAMPLE',
        }),
        montaje3400,
      ],
      isPartial: true,
      warnings: ['REFACCION_PENDIENTE_DE_COTIZAR'],
    });
    const block = renderCanonicalQuoteFinancialBlock(q);
    expect(block.isPartial).toBe(true);
    expect(block.text).toMatch(/precio pendiente de estimación/);
    expect(block.totalText).toMatch(/Subtotal actual/);
    expect(block.totalText).toMatch(/Cotización parcial/);
    expect(block.totalText).toContain('$3,400');
    expect(block.text).not.toMatch(/Inversión Total Estimada/);
    expect(block.totalText).not.toMatch(/falta el precio de refacci[oó]n/i);
    expect(block.totalText).not.toMatch(/montaje\/pintura no cubre/i);
  });

  it('9b. AWAITING_VEHICLE_DATA no truena si el peritaje no trae vehicles', () => {
    const q = quote({
      lines: [
        line({
          ...refaccion6500,
          amount: 0,
          billable: false,
          pricingStatus: 'AWAITING_VEHICLE_DATA',
          pricingSource: 'AWAITING_VEHICLE_DATA',
        }),
      ],
      isPartial: true,
      warnings: ['AWAITING_VEHICLE_DATA'],
    });
    const block = renderCanonicalQuoteFinancialBlock(q);
    expect(block.text).toMatch(/pendiente de datos del veh[ií]culo/);
    const fallback = renderDeterministicClientQuoteFallback({
      contactName: 'Cliente',
      canonicalQuote: q,
      hasActiveAppointment: false,
      damages: [
        {
          damageItemId: 'dmg_fascia',
          vehicleId: 'veh_1',
          pieceCode: 'FD',
          pieceLabel: 'Fascia delantera',
          physicalPanelKey: 'FD',
          severity: 'DMFuerte',
          descriptionTechnical: 'quebrada',
          treatment: 'SUSTITUIR',
          treatmentConfidence: 'HIGH',
          treatmentSource: 'vision',
          treatmentReason: 'vision',
          requiresReplacement: true,
          possibleReplacement: false,
          evidence: [],
          source: 'vision',
        },
      ],
    });
    expect(fallback.financialBlock).toMatch(/pendiente de datos del veh[ií]culo/);
  });

  it('10. billable=false amount positivo: no aparece como cargo', () => {
    const q = quote({
      lines: [
        montaje3400,
        line({
          quoteLineId: 'ql_nb',
          serviceType: 'REPARACION_PINTURA',
          amount: 12000,
          billable: false,
          description: 'cofre',
        }),
      ],
    });
    const block = renderCanonicalQuoteFinancialBlock(q);
    expect(block.text).not.toContain('$12,000');
    expect(block.text).not.toContain('Reparación y pintura cofre: $12,000');
  });

  it('17. "10 mil pesos" lo detecta el validador monetario', () => {
    expect(llmNarrativeContainsForbiddenMoney('El total ronda los 10 mil pesos')).toBe(
      true,
    );
    expect(
      extractMonetaryAmounts('El arreglo sale unos 10 mil').some(
        (h) => h.kind === 'spoken_thousands',
      ),
    ).toBe(true);
  });

  it('18. Año 2020 del vehículo no se confunde con monto', () => {
    expect(extractMonetaryAmounts('Ya vimos tu Mazda 3 2020')).toEqual([]);
  });

  it('19. Garantía 1 año no se confunde con monto', () => {
    expect(
      extractMonetaryAmounts('Incluye garantía de 1 año en mano de obra'),
    ).toEqual([]);
  });

  it('20. cita 10:00 no se confunde con monto', () => {
    expect(extractMonetaryAmounts('Te esperamos a las 10:00')).toEqual([]);
  });

  it('21. priceRange se imprime exactamente bajo regla determinista', () => {
    const q = quote({
      lines: [
        line({
          ...refaccion6500,
          priceRange: { min: 6000, max: 7500, central: 6500 },
        }),
      ],
    });
    const block = renderCanonicalQuoteFinancialBlock(q);
    expect(block.text).toContain(formatQuoteMoneyRange(6000, 7500));
    expect(block.text).toContain('$6,000–$7,500');
    expect(block.text).not.toMatch(/Refacción fascia delantera: \$6,500 MXN/);
    expect(block.text).not.toMatch(/Refacción fascia delantera: \$7,500 MXN/);
  });

  it('22. snapshot: texto + canonicalFreeze permanecen inmutables', () => {
    const q = quote({ lines: [montaje3400] });
    const block = renderCanonicalQuoteFinancialBlock(q);
    const snap = buildNarrativeSnapshotFields({
      finalMessage: `Hola\n\n${block.text}`,
      financialBlock: block.text,
      shownWarnings: ['HIDDEN_DAMAGE'],
      narrativeFlow: 'CANONICAL_NARRATIVE_FLOW',
      sentAt: '2026-09-11T18:00:00.000Z',
    });
    const frozenMessage = snap.finalMessage;
    const frozenBlock = snap.financialBlock;
    q.total = 1;
    q.lines[0].amount = 1;
    expect(snap.finalMessage).toBe(frozenMessage);
    expect(snap.financialBlock).toBe(frozenBlock);
    expect(snap.finalMessage).toContain('$3,400');
    expect(snap.sentAt).toBe('2026-09-11T18:00:00.000Z');
  });

  it('rechaza mensaje sin financialBlock o con total alterado', () => {
    const q = quote({ lines: [montaje3400] });
    const block = renderCanonicalQuoteFinancialBlock(q);
    const v = validateFinalClientQuoteMessage({
      canonicalQuote: q,
      renderedFinancialBlock: block.text,
      finalMessage: 'Hola, el total es $99,000 MXN',
    });
    expect(v.ok).toBe(false);
    expect(v.events.some((e) => e.event === NARRATIVE_EVENTS.NARRATIVE_FINANCIAL_MISMATCH)).toBe(
      true,
    );
  });

  it('sanitizeLlmNarrativeParts rechaza una segunda cotización', () => {
    const r = sanitizeLlmNarrativeParts({
      intro: '🛠️ Refacción fascia: $99,000',
      technicalExplanation: '',
      cta: 'Agendemos',
    });
    expect(r.ok).toBe(false);
  });

  it('etiquetas se construyen por serviceType, no por description libre', () => {
    expect(
      buildControlledQuoteLineLabel('REFACCION', 'fascia delantera'),
    ).toBe('Refacción fascia delantera');
    const q = quote({
      lines: [
        line({
          serviceType: 'REFACCION',
          amount: 6500,
          description: 'Reparar y pintar fascia delantera',
        }),
      ],
    });
    const block = renderCanonicalQuoteFinancialBlock(q);
    expect(block.text).toContain('Refacción fascia delantera');
    expect(block.text).not.toContain('Reparación y pintura fascia delantera:');
  });

  it('isCanonicalNarrativeEligible distingue legacy', () => {
    expect(isCanonicalNarrativeEligible(null)).toBe(false);
    expect(isCanonicalNarrativeEligible(quote({ lines: [montaje3400] }))).toBe(true);
  });

  it('PTD/STD/ED se humanizan en el bloque financiero y el total sigue $9,750', () => {
    const peritaje = peritajeFromLegacyAnalysis({
      conversationId: 'conv_smoke_ptd_std_ed',
      analysis: {
        inventory: [
          {
            pieza: 'PTD',
            severidad: 'DM',
            descripcionTecnica: 'Golpe en puerta trasera derecha',
            urls_origen: ['https://cdn.example/lado.jpg'],
            tratamiento: 'REPARAR',
          },
          {
            pieza: 'STD',
            severidad: 'DM',
            descripcionTecnica: 'Golpe en salpicadera trasera derecha',
            urls_origen: [],
            tratamiento: 'REPARAR',
          },
          {
            pieza: 'ED',
            severidad: 'DM',
            descripcionTecnica: 'Golpe en estribo derecho',
            urls_origen: [],
            tratamiento: 'REPARAR',
          },
        ],
      },
    });
    expect(peritaje.damages.map((d) => d.pieceCode)).toEqual([
      'PTD',
      'STD',
      'ED',
    ]);
    expect(peritaje.damages.map((d) => d.pieceLabel)).toEqual([
      'Puerta trasera derecha',
      'Salpicadera trasera derecha',
      'Estribo derecho',
    ]);

    const amounts = [3250, 3350, 3150] as const;
    const q = quote({
      lines: peritaje.damages.map((d, i) =>
        line({
          quoteLineId: `ql_${d.pieceCode}`,
          damageItemId: d.damageItemId,
          serviceType: 'REPARACION_PINTURA',
          amount: amounts[i]!,
          description: d.pieceCode,
        }),
      ),
      total: 9750,
      subtotal: 9750,
    });
    expect(q.total).toBe(9750);
    expect(q.lines.reduce((s, l) => s + l.amount, 0)).toBe(9750);

    const block = renderCanonicalQuoteFinancialBlock(q, peritaje);
    expect(block.text).toContain('Reparación y pintura Puerta trasera derecha');
    expect(block.text).toContain(
      'Reparación y pintura Salpicadera trasera derecha',
    );
    expect(block.text).toContain('Reparación y pintura Estribo derecho');
    expect(block.text).not.toMatch(/Reparación y pintura PTD/);
    expect(block.text).not.toMatch(/Reparación y pintura STD\b/);
    expect(block.text).not.toMatch(/Reparación y pintura ED\b/);
    expect(block.text).toContain('$9,750');
  });

  it('moldura negra pendiente NO menciona falta de precio de refacción', () => {
    const q = quote({
      lines: [
        line({
          serviceType: 'REPARACION_PINTURA',
          amount: 4650,
          description: 'salpicadera izquierda',
        }),
        line({
          quoteLineId: 'ql_moldura',
          damageItemId: 'dmg_moldura',
          serviceType: 'PENDIENTE',
          amount: 0,
          billable: false,
          description: 'Moldura arco delantero izquierdo',
        }),
      ],
      isPartial: true,
      warnings: [
        'PENDING_TREATMENT',
        'MOLDURA_NO_PINTABLE_REQUIERE_REVISION',
      ],
      total: 4650,
      subtotal: 4650,
    });
    const block = renderCanonicalQuoteFinancialBlock(q, {
      schemaVersion: 'peritaje.v1',
      peritajeId: 'per_m',
      conversationId: 'c1',
      tallerId: null,
      vehicles: [],
      viability: { viable: true },
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:00.000Z',
      damages: [
        {
          damageItemId: 'dmg_moldura',
          vehicleId: 'veh_1',
          pieceCode: 'MOLDURA',
          pieceLabel: 'Moldura arco delantero izquierdo',
          physicalPanelKey: 'MOLDURA::ARCO_DELANTERO_IZQUIERDO',
          moldingPosition: 'ARCO_DELANTERO_IZQUIERDO',
          finishType: 'NEGRA_TEXTURIZADA',
          severity: 'DF',
          descriptionTechnical: 'moldura negra desprendida',
          treatment: 'INCIERTO',
          treatmentConfidence: 'MEDIUM',
          treatmentSource: 'vision',
          treatmentReason: 'vision_structured',
          requiresReplacement: false,
          possibleReplacement: false,
          evidence: [],
          source: 'vision',
        },
      ],
    });
    expect(block.totalText).toMatch(/Cotización parcial/);
    expect(block.text).toMatch(/pendiente de revisi[oó]n/);
    expect(block.totalText).not.toMatch(/falta el precio de refacci[oó]n/i);
    expect(block.totalText).not.toMatch(/montaje\/pintura no cubre/i);
    expect(block.totalText).not.toMatch(/estimaci[oó]n de mercado/);
  });

  it('MOLDURA_PINTADA UNCONFIGURED explica tarifa no configurada', () => {
    const q = quote({
      lines: [
        line({
          quoteLineId: 'ql_mp',
          damageItemId: 'dmg_mp',
          serviceType: 'REPARACION_PINTURA',
          amount: 0,
          billable: false,
          pricingStatus: 'UNCONFIGURED',
          pricingSource: 'UNCONFIGURED',
          description: 'Moldura puerta',
        }),
      ],
      isPartial: true,
      total: 0,
      subtotal: 0,
    });
    const block = renderCanonicalQuoteFinancialBlock(q);
    expect(block.totalText).toMatch(/Cotización parcial/);
    expect(block.text).toMatch(/pendiente de configuraci[oó]n/i);
    expect(block.totalText).not.toMatch(/falta el precio de refacci[oó]n/i);
  });

  it('PENDING_TREATMENT genérico no inventa refacción', () => {
    const q = quote({
      lines: [
        line({
          quoteLineId: 'ql_pend',
          serviceType: 'PENDIENTE',
          amount: 0,
          billable: false,
          description: 'puerta',
        }),
      ],
      isPartial: true,
      warnings: ['PENDING_TREATMENT'],
      total: 0,
      subtotal: 0,
    });
    const block = renderCanonicalQuoteFinancialBlock(q);
    expect(block.totalText).toMatch(/Cotización parcial/);
    expect(block.text).toMatch(/pendiente de revisi[oó]n/);
    expect(block.totalText).not.toMatch(/refacci[oó]n/i);
  });

  it('partial copy singular', () => {
    expect(formatPendingConceptsCopy(['el montaje'])).toBe(
      'Cotización parcial: el montaje continúa pendiente.',
    );
    const q = quote({
      lines: [
        line({
          quoteLineId: 'ql_m',
          serviceType: 'MONTAJE',
          amount: 0,
          billable: false,
          pricingStatus: 'UNCONFIGURED',
          description: 'Calavera_Derecha',
        }),
      ],
      isPartial: true,
      total: 0,
      subtotal: 0,
    });
    expect(formatPartialQuoteFooter(q)).toBe(
      '_Cotización parcial: el montaje continúa pendiente._',
    );
  });

  it('partial copy plural + human labels', () => {
    expect(
      formatPendingConceptsCopy([
        'el montaje',
        'la refacción de la calavera derecha',
      ]),
    ).toBe(
      'Cotización parcial: el montaje y la refacción de la calavera derecha continúan pendientes.',
    );
    const q = quote({
      lines: [
        line({
          quoteLineId: 'ql_ref',
          damageItemId: 'dmg_cala',
          serviceType: 'REFACCION',
          amount: 0,
          billable: false,
          pricingStatus: 'INSUFFICIENT_MARKET_SAMPLE',
          description: 'Calavera_Derecha',
        }),
        line({
          quoteLineId: 'ql_m',
          damageItemId: 'dmg_cala',
          serviceType: 'MONTAJE',
          amount: 0,
          billable: false,
          pricingStatus: 'UNCONFIGURED',
          description: 'Calavera_Derecha',
        }),
      ],
      isPartial: true,
      total: 0,
      subtotal: 0,
    });
    const footer = formatPartialQuoteFooter(q);
    expect(footer).toMatch(/el montaje y la refacción de la calavera derecha continúan pendientes/);
    expect(footer).not.toContain('Calavera_Derecha');
    expect(footer).not.toMatch(/el montaje continúan pendientes/);
  });

  it('range visible vs amount canónico mantiene integridad', () => {
    const basePaint = line({
      quoteLineId: 'ql_paint',
      serviceType: 'REPARACION_PINTURA',
      amount: 6700,
      description: 'fascia trasera',
    });
    const refaccion = line({
      quoteLineId: 'ql_ref',
      serviceType: 'REFACCION',
      amount: 3350,
      description: 'calavera derecha',
      pricingSource: 'WEB_MARKET_ESTIMATE',
      pricingStatus: 'OK',
      priceRange: { min: 3000, max: 3650, central: 3350 },
    });
    const q = quote({
      lines: [basePaint, refaccion],
      total: 10050,
      subtotal: 10050,
    });
    expect(q.total).toBe(10050);
    expect(refaccion.amount).toBe(3350);
    expect(refaccion.priceRange).toEqual({ min: 3000, max: 3650, central: 3350 });
    const billableSum = q.lines
      .filter((l) => l.billable)
      .reduce((s, l) => s + l.amount, 0);
    expect(billableSum).toBe(10050);
    const block = renderCanonicalQuoteFinancialBlock(q);
    expect(block.text).toContain(formatQuoteMoneyRange(3000, 3650));
    expect(block.totalText).toContain(formatQuoteMoney(10050));
    const message = assembleClientQuoteMessage({
      intro: 'Hola',
      technicalExplanation: '',
      financialBlock: block.text,
      warningsBlock: '',
      cta: '¿Agendamos?',
    });
    const v = validateFinalClientQuoteMessage({
      canonicalQuote: q,
      renderedFinancialBlock: block.text,
      finalMessage: message,
    });
    expect(v.ok).toBe(true);
    const remainder = message.replace(block.text, '');
    expect(extractMonetaryAmounts(remainder)).toEqual([]);
  });
});
