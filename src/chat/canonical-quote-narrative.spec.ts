import { QUOTE_SCHEMA_VERSION } from '../domain/peritaje-v1';
import type { CanonicalQuoteV1, QuoteLine } from '../domain/peritaje-v1';
import { formatQuoteMoney } from '../domain/peritaje-v1';
import {
  applyComposedNarrativeToDraft,
  composeModernClientQuoteMessage,
  NARRATIVE_FLOW,
  parseLlmNarrativeParts,
  previewModernFinancialBlock,
  renderCanonicalQuoteFinancialBlock,
} from './canonical-quote-narrative';
import type { DraftQuote } from './autofix-config';
import { buildClienteFormalNarrativeSinCita } from './draft-quote-resume';
import { NARRATIVE_EVENTS } from '../domain/peritaje-v1/quote-narrative';

function line(
  partial: Partial<QuoteLine> & Pick<QuoteLine, 'serviceType' | 'amount'>,
): QuoteLine {
  return {
    quoteLineId: partial.quoteLineId ?? `ql_${partial.serviceType}`,
    damageItemId: partial.damageItemId ?? 'dmg_fascia',
    vehicleId: 'veh_1',
    description: partial.description ?? 'fascia delantera',
    billable: partial.billable ?? true,
    confidence: 'HIGH',
    ...partial,
  };
}

function quote(
  partial: Partial<CanonicalQuoteV1> & { lines: QuoteLine[] },
): CanonicalQuoteV1 {
  const chargeable = partial.lines
    .filter(
      (l) =>
        l.billable &&
        l.amount > 0 &&
        l.serviceType !== 'PENDIENTE' &&
        l.serviceType !== 'ADVERTENCIA' &&
        l.pricingStatus !== 'INSUFFICIENT_MARKET_SAMPLE',
    )
    .reduce((s, l) => s + l.amount, 0);
  return {
    schemaVersion: QUOTE_SCHEMA_VERSION,
    quoteId: partial.quoteId ?? 'q_modern',
    peritajeId: 'per_1',
    subtotal: partial.subtotal ?? chargeable,
    total: partial.total ?? chargeable,
    isPartial: partial.isPartial ?? false,
    warnings: partial.warnings ?? [],
    generatedAt: '2026-09-11T00:00:00.000Z',
    lines: partial.lines,
  };
}

const montaje = line({
  quoteLineId: 'ql_m',
  serviceType: 'MONTAJE_PINTURA',
  amount: 3400,
});
const refaccion = line({
  quoteLineId: 'ql_r',
  serviceType: 'REFACCION',
  amount: 6500,
});

describe('Fase 6 — compositor canónico', () => {
  it('2. LLM devuelve $99,000: el mensaje final nunca lo envía', async () => {
    const q = quote({ lines: [montaje] });
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: q,
      contactName: 'Juan',
      hasActiveAppointment: false,
      llmParts: {
        intro: 'El total es $99,000 MXN',
        technicalExplanation: 'Golpe frontal',
        cta: '¿Agendamos?',
      },
    });
    expect(composed.finalMessage).not.toContain('$99,000');
    expect(composed.finalMessage).toContain('$3,400');
    expect(composed.fallbackUsed).toBe(true);
    expect(
      composed.events.some((e) => e.event === NARRATIVE_EVENTS.LLM_NARRATIVE_REJECTED),
    ).toBe(true);
  });

  it('11. LLM omite una línea: el renderer final la conserva', async () => {
    const q = quote({
      lines: [refaccion, montaje],
      total: 9900,
      subtotal: 9900,
    });
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: q,
      contactName: 'Juan',
      hasActiveAppointment: false,
      llmParts: {
        intro: 'Hola, ya revisamos las fotos de tu Mazda 3 2020',
        technicalExplanation: 'El impacto comprometió la fascia.',
        cta: '¿Qué día te queda mejor?',
      },
    });
    expect(composed.llmUsed).toBe(true);
    expect(composed.finalMessage).toContain('Refacción fascia delantera');
    expect(composed.finalMessage).toContain('Montaje y pintura fascia delantera');
    expect(composed.finalMessage).toContain('$6,500');
    expect(composed.finalMessage).toContain('$3,400');
  });

  it('12. LLM añade una línea: no aparece', async () => {
    const q = quote({ lines: [montaje] });
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: q,
      contactName: 'Juan',
      hasActiveAppointment: false,
      llmParts: {
        intro: 'También incluimos faro por $5,000',
        technicalExplanation: '',
        cta: 'Avísame',
      },
    });
    expect(composed.finalMessage).not.toContain('$5,000');
    expect(composed.fallbackUsed).toBe(true);
  });

  it('13. LLM cambia amount: no aparece el amount alterado', async () => {
    const q = quote({ lines: [montaje] });
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: q,
      contactName: 'Juan',
      hasActiveAppointment: false,
      llmParts: {
        intro: 'El montaje queda en $4,100',
        technicalExplanation: '',
        cta: 'CTA',
      },
    });
    expect(composed.finalMessage).not.toContain('$4,100');
    expect(composed.finalMessage).toContain('$3,400');
  });

  it('14. LLM cambia total: no aparece el total alterado', async () => {
    const q = quote({
      lines: [refaccion, montaje],
      total: 9900,
      subtotal: 9900,
    });
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: q,
      contactName: 'Juan',
      hasActiveAppointment: false,
      llmParts: {
        intro: 'Inversión total $11,500',
        technicalExplanation: '',
        cta: 'CTA',
      },
    });
    expect(composed.finalMessage).not.toContain('$11,500');
    expect(composed.finalMessage).toContain(formatQuoteMoney(9900));
  });

  it('15. LLM falla: fallback determinista correcto', async () => {
    const q = quote({ lines: [montaje] });
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: q,
      contactName: 'Juan',
      hasActiveAppointment: false,
      mapsUrl: 'https://maps.example',
      openai: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('openai timeout');
            },
          },
        },
      } as never,
      chatAppointmentSystemPrompt: 'Eres asesor.',
    });
    expect(composed.fallbackUsed).toBe(true);
    expect(composed.finalMessage).toContain('$3,400');
    expect(composed.finalMessage).toContain('Montaje y pintura fascia delantera');
    expect(
      composed.events.some((e) => e.event === NARRATIVE_EVENTS.DETERMINISTIC_FALLBACK_USED),
    ).toBe(true);
  });

  it('16. LLM devuelve vacío: fallback determinista correcto', async () => {
    const q = quote({ lines: [montaje] });
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: q,
      contactName: 'Ana',
      hasActiveAppointment: true,
      appointmentFormatted: 'viernes a las 10:00',
      llmParts: { intro: '', technicalExplanation: '', cta: '' },
    });
    expect(composed.fallbackUsed).toBe(true);
    expect(composed.finalMessage).toContain('$3,400');
    expect(composed.finalMessage).toMatch(/10:00/);
  });

  it('23. preview panel: mismo financialBlock que producción', async () => {
    const q = quote({
      lines: [refaccion, montaje],
      total: 9900,
      subtotal: 9900,
    });
    const production = await composeModernClientQuoteMessage({
      canonicalQuote: q,
      contactName: 'Juan',
      hasActiveAppointment: false,
      llmParts: {
        intro: 'Hola Juan',
        technicalExplanation: 'Fascia comprometida.',
        cta: '¿Agendamos?',
      },
    });
    expect(previewModernFinancialBlock(q)).toBe(production.financialBlock);
    expect(previewModernFinancialBlock(q)).toBe(
      renderCanonicalQuoteFinancialBlock(q).text,
    );
  });

  it('24. legacy sin canonical: flujo anterior sigue funcionando', () => {
    const legacy = buildClienteFormalNarrativeSinCita({
      contactName: 'Luis',
      lineRows: [{ pieza: 'Puerta', precioMx: 4500 }],
      total: 4500,
      mapsUrl: 'https://maps.example',
      damageIntro: 'Ya analizamos tus fotos.',
    });
    expect(legacy).toContain('$4,500');
    expect(legacy).toMatch(/Inversión Total Estimada/);
  });

  it('sincroniza clientMessage como narrativa final autoritativa', async () => {
    const q = quote({ lines: [montaje] });
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: q,
      contactName: 'Juan',
      hasActiveAppointment: false,
      llmParts: {
        intro: 'Hola',
        technicalExplanation: 'Golpe leve.',
        cta: 'Dime un día',
      },
    });
    const draft: DraftQuote = {
      status: 'PENDING_APPROVAL',
      currency: 'MXN',
      reference: 'r',
      generatedAt: '2026-09-11T00:00:00.000Z',
      lines: [],
      subtotal: 3400,
      total: 3400,
      formalNarrative: '',
      analysisBasis: {
        pieza: 'x',
        severidad: 'DM',
        partesAfectadas: [],
        severidadDelDano: 'DM',
        descripcionTecnica: '',
        justificacion: '',
      },
    };
    applyComposedNarrativeToDraft(draft, composed);
    expect(draft.clientMessage).toBe(composed.finalMessage);
    expect(draft.formalNarrative).toBe(draft.clientMessage);
    expect(draft.generatedMessage).toBe(draft.clientMessage);
    expect(draft.narrativeFlow).toBe(NARRATIVE_FLOW.CANONICAL);
    expect(draft.renderedFinancialBlock).toBe(composed.financialBlock);
  });

  it('parseLlmNarrativeParts acepta JSON y rechaza vacío', () => {
    expect(
      parseLlmNarrativeParts('{"intro":"Hola","technicalExplanation":"x","cta":"ok"}'),
    ).toEqual({
      intro: 'Hola',
      technicalExplanation: 'x',
      cta: 'ok',
    });
    expect(parseLlmNarrativeParts('')).toBeNull();
    expect(parseLlmNarrativeParts('no-json')).toBeNull();
  });
});
