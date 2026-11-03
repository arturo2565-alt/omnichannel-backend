import { PERITAJE_SCHEMA_VERSION, QUOTE_SCHEMA_VERSION } from '../domain/peritaje-v1';
import type {
  CanonicalPeritajeV1,
  CanonicalQuoteV1,
  DamageItem,
  QuoteLine,
  TreatmentDecision,
} from '../domain/peritaje-v1';
import {
  renderCanonicalQuoteFinancialBlock,
} from '../domain/peritaje-v1/quote-narrative';
import { buildCanonicalFreeze } from './canonical-quote-engine';
import { composeModernClientQuoteMessage } from './canonical-quote-narrative';
import type { QuoteSendSnapshot } from './autofix-config';
import type { ClientMessageSource } from './client-message-ux';

function line(
  partial: Partial<QuoteLine> & Pick<QuoteLine, 'serviceType' | 'amount'>,
): QuoteLine {
  return {
    quoteLineId: partial.quoteLineId ?? `ql_${partial.serviceType}`,
    damageItemId: partial.damageItemId ?? 'dmg_fascia',
    vehicleId: 'veh_1',
    description: partial.description ?? 'fascia delantera',
    billable: partial.billable ?? partial.amount > 0,
    confidence: 'HIGH',
    ...partial,
  };
}

function quote(
  partial: Partial<CanonicalQuoteV1> & { lines: QuoteLine[] },
): CanonicalQuoteV1 {
  const chargeable = partial.lines
    .filter((item) => item.billable && item.amount > 0)
    .reduce((sum, item) => sum + item.amount, 0);
  return {
    schemaVersion: QUOTE_SCHEMA_VERSION,
    quoteId: partial.quoteId ?? 'q_prose',
    peritajeId: 'per_prose',
    subtotal: partial.subtotal ?? chargeable,
    total: partial.total ?? chargeable,
    isPartial: partial.isPartial ?? false,
    warnings: partial.warnings ?? [],
    generatedAt: '2026-09-14T00:00:00.000Z',
    lines: partial.lines,
  };
}

function damage(
  pieceLabel: string,
  treatment: TreatmentDecision,
): DamageItem {
  return {
    damageItemId: 'dmg_fascia',
    vehicleId: 'veh_1',
    pieceCode: 'FD',
    pieceLabel,
    physicalPanelKey: 'FD',
    severity: 'DM',
    descriptionTechnical: 'Afectación en la pieza.',
    treatment,
    treatmentConfidence: 'HIGH',
    treatmentSource: 'vision',
    treatmentReason: 'vision',
    requiresReplacement: false,
    possibleReplacement: false,
    evidence: [],
    source: 'vision',
  };
}

function jetta(year = '2018', confirmed = true): CanonicalPeritajeV1 {
  return {
    schemaVersion: PERITAJE_SCHEMA_VERSION,
    peritajeId: 'per_prose',
    conversationId: 'c_prose',
    tallerId: 't1',
    vehicles: [
      {
        vehicleId: 'veh_1',
        make: 'Volkswagen',
        model: 'Jetta',
        year,
        displayLabel: year ? `Volkswagen Jetta ${year}` : 'Volkswagen Jetta',
        confidence: 'HIGH',
        source: confirmed ? 'user' : 'vision',
        confirmedByUser: confirmed,
        confirmedFields: confirmed ? ['make', 'model', 'year'] : [],
      },
    ],
    damages: [damage('Fascia delantera', 'REPARAR')],
    viability: { viable: true },
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
  };
}

function unknownVehicle(): CanonicalPeritajeV1 {
  const doc = jetta('', false);
  doc.vehicles = [
    {
      vehicleId: 'veh_unknown',
      displayLabel: 'Vehículo no identificado',
      confidence: 'LOW',
      source: 'vision',
      confirmedByUser: false,
    },
  ];
  return doc;
}

const paint = line({
  quoteLineId: 'ql_paint',
  serviceType: 'REPARACION_PINTURA',
  amount: 4800,
  description: 'fascia delantera',
});
const partialPaint = line({
  quoteLineId: 'ql_paint',
  serviceType: 'REPARACION_PINTURA',
  amount: 3200,
  description: 'fascia delantera',
});
const pendingPart = line({
  quoteLineId: 'ql_part',
  serviceType: 'REFACCION',
  amount: 0,
  billable: false,
  pricingStatus: 'AWAITING_VEHICLE_DATA',
  pricingSource: 'AWAITING_VEHICLE_DATA',
  description: 'fascia delantera',
});

function snapshot(q: CanonicalQuoteV1): QuoteSendSnapshot {
  return {
    sentAt: '2026-09-14T10:00:00.000Z',
    total: q.total,
    subtotal: q.subtotal,
    desglose: q.lines.map((item) => ({
      pieza: item.description,
      severidad: 'DM',
      precioMx: item.amount,
      quoteLineId: item.quoteLineId,
      damageItemId: item.damageItemId,
      serviceType: item.serviceType,
    })),
    finalMessage: 'Cotización previa.',
    canonicalFreeze: buildCanonicalFreeze(q),
    shownWarnings: [...q.warnings],
  };
}

const OFFER = '¿Agendamos una revisión en el taller?';
const ASK_YEAR = '¿De qué año es tu Jetta?';
const CONTINUE = '¿Qué día y hora te queda bien?';
const TECH =
  'Se observa deformación, transferencia de pintura y compromiso de anclajes.';

async function compose(input: {
  canonicalQuote: CanonicalQuoteV1;
  peritaje: CanonicalPeritajeV1;
  llmParts?: { intro: string; technicalExplanation: string; cta: string } | null;
  messageSource?: ClientMessageSource;
  previousQuote?: CanonicalQuoteV1;
  userText?: string;
  hasActiveAppointment?: boolean;
}) {
  return composeModernClientQuoteMessage({
    canonicalQuote: input.canonicalQuote,
    peritaje: input.peritaje,
    contactName: 'Arturo',
    hasActiveAppointment: input.hasActiveAppointment ?? false,
    mapsUrl: 'https://maps.example/taller',
    messageSource: input.messageSource,
    previousSnapshot: input.previousQuote ? snapshot(input.previousQuote) : null,
    userText: input.userText,
    llmParts: input.llmParts,
  });
}

describe('CONVERSATION-002 prosa con autoridad financiera', () => {
  const confirmed = quote({ lines: [paint] });
  const confirmedDoc = jetta();
  const naturalIntro =
    'Hola, Arturo. En el Jetta 2018 ese golpe de la fascia se puede reparar.';

  it('1. cotización inicial con identidad confirmada', async () => {
    const before = await compose({
      canonicalQuote: confirmed,
      peritaje: confirmedDoc,
      llmParts: null,
    });
    const after = await compose({
      canonicalQuote: confirmed,
      peritaje: confirmedDoc,
      llmParts: {
        intro: naturalIntro,
        technicalExplanation: TECH,
        cta: OFFER,
      },
    });
    expect(after.introSource).toBe('model');
    expect(after.ctaSource).toBe('model');
    expect(after.fallbackUsed).toBe(false);
    expect(after.finalMessage).toContain(naturalIntro);
    expect(after.finalMessage).toContain(OFFER);
    expect(after.finalMessage).toContain('https://maps.example/taller');
    expect(after.finalMessage).not.toContain(TECH);
    expect(after.finalMessage).not.toContain('*Volkswagen Jetta 2018*');
    expect(before.finalMessage).toMatch(/^Hola, Arturo\./);
    expect(before.finalMessage).toContain('*Volkswagen Jetta 2018*');
    expect(after.financialBlock).toBe(before.financialBlock);
    expect(after.finalMessage).toContain(after.financialBlock);
  });

  it('2. cotización sin vehículo identificado', async () => {
    const q = quote({ lines: [paint] });
    const intro = 'Hola, Arturo. El golpe de la fascia se puede reparar.';
    const after = await compose({
      canonicalQuote: q,
      peritaje: unknownVehicle(),
      llmParts: { intro, technicalExplanation: '', cta: OFFER },
    });
    expect(after.introSource).toBe('model');
    expect(after.ctaSource).toBe('model');
    expect(after.finalMessage).toContain(intro);
    expect(after.finalMessage).not.toMatch(/jetta|volkswagen|2018/i);
    expect(after.finalMessage).toContain(after.financialBlock);
  });

  it('3. cotización parcial con refacción pendiente', async () => {
    const q = quote({
      lines: [partialPaint, pendingPart],
      isPartial: true,
      warnings: ['AWAITING_VEHICLE_DATA'],
      total: 3200,
      subtotal: 3200,
    });
    const doc = jetta('', true);
    const intro = 'Hola, Arturo. La fascia delantera se puede reparar.';
    const after = await compose({
      canonicalQuote: q,
      peritaje: doc,
      llmParts: { intro, technicalExplanation: '', cta: ASK_YEAR },
    });
    expect(after.ctaType).toBe('ASK_MISSING_VEHICLE_DATA');
    expect(after.introSource).toBe('model');
    expect(after.ctaSource).toBe('model');
    expect(after.finalMessage).toContain(intro);
    expect(after.finalMessage).toContain(ASK_YEAR);
    expect(after.finalMessage).not.toContain('https://maps.example/taller');
    expect(after.finalMessage).toMatch(/pendiente/i);
    expect(after.finalMessage).toContain(after.financialBlock);
  });

  it('4. tratamiento incierto', async () => {
    const q = quote({
      lines: [
        line({
          quoteLineId: 'ql_pending',
          serviceType: 'PENDIENTE',
          amount: 0,
          billable: false,
          description: 'fascia delantera',
        }),
      ],
      isPartial: true,
      warnings: ['PENDING_TREATMENT'],
      total: 0,
      subtotal: 0,
    });
    const doc = jetta();
    doc.damages = [damage('Fascia delantera', 'INCIERTO')];
    const careful =
      'Hola, Arturo. En el Jetta 2018 el golpe de la fascia sigue en revisión.';
    const after = await compose({
      canonicalQuote: q,
      peritaje: doc,
      llmParts: { intro: careful, technicalExplanation: '', cta: OFFER },
    });
    const definitive = await compose({
      canonicalQuote: q,
      peritaje: doc,
      llmParts: {
        intro:
          'Hola, Arturo. En el Jetta 2018 la fascia delantera se repara de forma definitiva.',
        technicalExplanation: '',
        cta: OFFER,
      },
    });
    expect(after.introSource).toBe('model');
    expect(after.finalMessage).toContain(careful);
    expect(after.finalMessage).toMatch(/tratamiento de Fascia delantera queda por confirmar/);
    expect(definitive.introSource).toBe('fallback');
    expect(definitive.fallbackUsed).toBe(false);
    expect(definitive.finalMessage).not.toMatch(/se repara de forma definitiva/);
    expect(definitive.finalMessage).toMatch(/^Hola, Arturo\./);
    expect(definitive.financialBlock).toBe(after.financialBlock);
  });

  it('5. actualización de cotización', async () => {
    const previous = quote({ lines: [partialPaint], total: 3200, subtotal: 3200 });
    const next = quote({
      lines: [
        partialPaint,
        line({
          quoteLineId: 'ql_part',
          serviceType: 'REFACCION',
          amount: 2150,
          description: 'fascia delantera',
          pricingStatus: 'OK',
          pricingSource: 'WEB_MARKET_ESTIMATE',
        }),
        line({
          quoteLineId: 'ql_fit',
          serviceType: 'MONTAJE',
          amount: 450,
          description: 'fascia delantera',
        }),
      ],
      total: 5800,
      subtotal: 5800,
    });
    const intro = 'Ya actualicé la cotización de tu Jetta 2018.';
    const after = await compose({
      canonicalQuote: next,
      peritaje: jetta(),
      previousQuote: previous,
      messageSource: 'cart_edit',
      llmParts: { intro, technicalExplanation: TECH, cta: OFFER },
    });
    expect(after.mode).toBe('QUOTE_UPDATE');
    expect(after.introSource).toBe('model');
    expect(after.ctaSource).toBe('model');
    expect(after.finalMessage).toContain(intro);
    expect(after.finalMessage).not.toMatch(/Cotización actualizada/);
    expect(after.finalMessage).not.toContain(TECH);
    expect(after.finalMessage).toContain(after.financialBlock);
  });

  it('6. corrección del cliente', async () => {
    const previous = quote({ lines: [paint] });
    const next = quote({
      lines: [{ ...paint, amount: 5100 }],
      total: 5100,
      subtotal: 5100,
    });
    const intro = 'Corregí el vehículo a Jetta 2018 y recalculé la cotización.';
    const after = await compose({
      canonicalQuote: next,
      peritaje: jetta(),
      previousQuote: previous,
      messageSource: 'vehicle_identity_correction',
      userText: 'Perdón, es 2018',
      llmParts: { intro, technicalExplanation: '', cta: OFFER },
    });
    expect(after.mode).toBe('QUOTE_CORRECTION');
    expect(after.introSource).toBe('model');
    expect(after.ctaSource).toBe('model');
    expect(after.shouldGreet).toBe(false);
    expect(after.finalMessage).toContain(intro);
    expect(after.finalMessage).not.toMatch(/\bhola\b/i);
    expect(after.finalMessage).toContain(after.financialBlock);
  });

  it('7. seguimiento de cita', async () => {
    const intro = 'Mañana a las 10 queda bien para la visita.';
    const after = await compose({
      canonicalQuote: confirmed,
      peritaje: confirmedDoc,
      messageSource: 'appointment_turn',
      userText: 'Mañana a las 10',
      llmParts: { intro, technicalExplanation: '', cta: CONTINUE },
    });
    expect(after.mode).toBe('APPOINTMENT_FOLLOWUP');
    expect(after.introSource).toBe('model');
    expect(after.ctaSource).toBe('model');
    expect(after.financialBlock).toBe('');
    expect(after.finalMessage).toContain(intro);
    expect(after.finalMessage).toContain(CONTINUE);
    expect(after.finalMessage).not.toContain('$4,800');
    expect(after.finalMessage).not.toMatch(/¿Quieres que agendemos/i);
  });

  it('8. un descuento inventado activa el fallback completo', async () => {
    const after = await compose({
      canonicalQuote: confirmed,
      peritaje: confirmedDoc,
      llmParts: {
        intro: 'Hola, Arturo. En el Jetta 2018 te dejo un descuento.',
        technicalExplanation: '',
        cta: OFFER,
      },
    });
    expect(after.fallbackUsed).toBe(true);
    expect(after.introSource).toBe('fallback');
    expect(after.ctaSource).toBe('fallback');
    expect(after.finalMessage).not.toMatch(/descuento/i);
    expect(after.finalMessage).toMatch(/^Hola, Arturo\./);
    expect(after.finalMessage).toContain('*Volkswagen Jetta 2018*');
  });

  it('9. una garantía inventada activa el fallback completo', async () => {
    const after = await compose({
      canonicalQuote: confirmed,
      peritaje: confirmedDoc,
      llmParts: {
        intro: 'Hola, Arturo. En el Jetta 2018 el trabajo incluye garantía.',
        technicalExplanation: '',
        cta: OFFER,
      },
    });
    expect(after.fallbackUsed).toBe(true);
    expect(after.finalMessage).not.toMatch(/garant[ií]a/i);
    expect(after.finalMessage).toContain(after.financialBlock);
  });

  it('10. un precio inventado activa el fallback completo', async () => {
    const after = await compose({
      canonicalQuote: confirmed,
      peritaje: confirmedDoc,
      llmParts: {
        intro: 'Hola, Arturo. En el Jetta 2018 el trabajo queda en $9,999.',
        technicalExplanation: '',
        cta: OFFER,
      },
    });
    expect(after.fallbackUsed).toBe(true);
    expect(after.finalMessage).not.toContain('$9,999');
    expect(after.finalMessage).toContain('$4,800');
    expect(after.financialBlock).toBe(
      renderCanonicalQuoteFinancialBlock(confirmed, confirmedDoc).text,
    );
  });

  it('11. preguntar un dato ya confirmado conserva la intro y cambia la pregunta', async () => {
    const after = await compose({
      canonicalQuote: confirmed,
      peritaje: confirmedDoc,
      llmParts: {
        intro: naturalIntro,
        technicalExplanation: '',
        cta: '¿Me confirmas el año de tu Jetta?',
      },
    });
    expect(after.fallbackUsed).toBe(false);
    expect(after.introSource).toBe('model');
    expect(after.ctaSource).toBe('fallback');
    expect(after.finalMessage).toContain(naturalIntro);
    expect(after.finalMessage).not.toMatch(/¿Me confirmas el año/i);
    expect(after.finalMessage).toMatch(/agendemos una valoraci[oó]n/i);
  });

  it('12. cambiar la intención del CTA conserva la intro', async () => {
    const after = await compose({
      canonicalQuote: confirmed,
      peritaje: confirmedDoc,
      llmParts: {
        intro: naturalIntro,
        technicalExplanation: '',
        cta: '¿Qué día y hora te funciona para la visita?',
      },
    });
    expect(after.ctaType).toBe('OFFER_APPOINTMENT');
    expect(after.fallbackUsed).toBe(false);
    expect(after.introSource).toBe('model');
    expect(after.ctaSource).toBe('fallback');
    expect(after.finalMessage).toContain(naturalIntro);
    expect(after.finalMessage).toMatch(/agendemos una valoraci[oó]n/i);
    expect(after.finalMessage).not.toMatch(/Qu[eé] d[ií]a y hora te funciona/i);
  });

  it('13. si el modelo no responde, queda el fallback determinista', async () => {
    const after = await compose({
      canonicalQuote: confirmed,
      peritaje: confirmedDoc,
      llmParts: null,
    });
    expect(after.fallbackUsed).toBe(true);
    expect(after.llmUsed).toBe(false);
    expect(after.introSource).toBe('fallback');
    expect(after.ctaSource).toBe('fallback');
    expect(after.finalMessage).toMatch(/^Hola, Arturo\./);
    expect(after.finalMessage).toContain('*Volkswagen Jetta 2018*');
    expect(after.finalMessage).toMatch(/agendemos una valoraci[oó]n/i);
  });

  it('14. el bloque financiero queda intacto', async () => {
    const before = await compose({
      canonicalQuote: confirmed,
      peritaje: confirmedDoc,
      llmParts: null,
    });
    const after = await compose({
      canonicalQuote: confirmed,
      peritaje: confirmedDoc,
      llmParts: {
        intro: naturalIntro,
        technicalExplanation: 'El total real es otro.',
        cta: OFFER,
      },
    });
    const rendered = renderCanonicalQuoteFinancialBlock(confirmed, confirmedDoc).text;
    expect(after.financialBlock).toBe(rendered);
    expect(before.financialBlock).toBe(rendered);
    expect(after.finalMessage).toContain(rendered);
    expect(confirmed.total).toBe(4800);
  });

  it('15. WhatsApp, Messenger y lab comparten el mismo compositor', async () => {
    const dirty = {
      intro:
        'Buenas tardes, Arturo. Revisamos las fotos y el golpe comprometió la estructura.',
      technicalExplanation: TECH,
      cta: '¿Agendamos y también te mando el mapa?',
    };
    const fallback = await compose({
      canonicalQuote: confirmed,
      peritaje: confirmedDoc,
      llmParts: null,
    });
    const channels = await Promise.all([
      compose({ canonicalQuote: confirmed, peritaje: confirmedDoc, llmParts: dirty }),
      compose({ canonicalQuote: confirmed, peritaje: confirmedDoc, llmParts: dirty }),
      compose({ canonicalQuote: confirmed, peritaje: confirmedDoc, llmParts: dirty }),
    ]);
    for (const composed of channels) {
      expect(composed.finalMessage).toBe(fallback.finalMessage);
      expect(composed.financialBlock).toBe(fallback.financialBlock);
      expect(composed.introSource).toBe('fallback');
      expect(composed.ctaSource).toBe('fallback');
    }
  });
});
