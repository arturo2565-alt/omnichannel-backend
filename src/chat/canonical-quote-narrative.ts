/**
 * Fase 6 — compositor moderno: el LLM solo narra; el backend ensambla el dinero.
 */
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { openAiChatCompletionParams } from './openai-model-config';
import { createTrackedChatCompletion } from './tracked-chat-completion';
import { resolvePiezaDisplayLabel } from './draft-quote-resume';
import type { CanonicalPeritajeV1, CanonicalQuoteV1 } from '../domain/peritaje-v1';
import {
  NARRATIVE_EVENTS,
  NARRATIVE_FLOW,
  assembleClientQuoteMessage,
  isCanonicalNarrativeEligible,
  logNarrativeEvents,
  renderCanonicalQuoteFinancialBlock,
  renderCanonicalQuoteWarningsBlock,
  renderDeterministicClientQuoteFallback,
  sanitizeLlmNarrativeParts,
  validateFinalClientQuoteMessage,
  type ClientQuoteMessage,
  type LlmNarrativeParts,
  type NarrativeFlow,
  type NarrativeObservabilityEvent,
} from '../domain/peritaje-v1/quote-narrative';
import { traceFinalClientMessageSummary } from './canonical-trace';

export type ComposedClientQuote = {
  flow: NarrativeFlow;
  finalMessage: string;
  financialBlock: string;
  warningsBlock: string;
  shownWarnings: string[];
  llmUsed: boolean;
  fallbackUsed: boolean;
  events: NarrativeObservabilityEvent[];
  parts: ClientQuoteMessage;
};

export type ModernComposeInput = {
  canonicalQuote: CanonicalQuoteV1;
  peritaje?: CanonicalPeritajeV1 | null;
  contactName: string;
  hasActiveAppointment: boolean;
  appointmentFormatted?: string;
  mapsUrl?: string;
  damageIntro?: string;
  vehicleModel?: string;
  isComplement?: boolean;
  openai?: OpenAI | null;
  chatAppointmentSystemPrompt?: string;
  conversationTurns?: readonly ChatCompletionMessageParam[];
  temperature?: number;
  /** Inyección para tests. */
  llmParts?: LlmNarrativeParts | null;
};

const CANONICAL_NARRATIVE_APPENDIX = `
[Tarea: partes narrativas de cotización — SIN autoridad financiera]
Responde SOLO un JSON válido, sin markdown:
{"intro":"...","technicalExplanation":"...","cta":"..."}

Reglas:
- intro: saludo breve y contexto del vehículo/fotos. SIN precios, SIN totales, SIN desglose.
- technicalExplanation: explicación técnica no financiera. SIN importes. PROHIBIDO listar líneas de cotización.
- cta: invitación a agendar o confirmar visita según contextoOperativo. SIN precios.
- PROHIBIDO: $, pesos, MXN, "mil pesos", importes aproximados ("unos 10 mil"), decidir si es parcial, serviceType, cantidades cobrables.
- PROHIBIDO incluir IDs de plataforma o códigos internos de pieza.
- Puedes mencionar el año del vehículo, una hora de cita o "garantía de 1 año" si aplica; eso no es un importe.
`.trim();

function buildCanonicalNarrativeSystemPrompt(base: string): string {
  const prompt = String(base ?? '').trim();
  if (!prompt) {
    throw new Error('composeCanonicalLlmNarrativeParts: chatAppointmentPrompt vacío');
  }
  return `${prompt}\n\n${CANONICAL_NARRATIVE_APPENDIX}`;
}

function peritajeNarrativeContext(peritaje?: CanonicalPeritajeV1 | null) {
  return {
    vehiculo:
      peritaje?.vehicles?.[0]?.displayLabel ??
      peritaje?.vehicles
        ?.map((v) => [v.make, v.model, v.year].filter(Boolean).join(' '))
        .find(Boolean) ??
      '',
    inventario: (peritaje?.damages ?? []).map((d) => ({
      pieza: resolvePiezaDisplayLabel(d.pieceLabel || d.pieceCode),
      severidad: d.severity,
      descripcionTecnica: d.descriptionTechnical,
      treatment: d.treatment,
    })),
  };
}

export async function composeCanonicalLlmNarrativeParts(
  openai: OpenAI,
  chatAppointmentSystemPrompt: string,
  input: Pick<
    ModernComposeInput,
    | 'contactName'
    | 'hasActiveAppointment'
    | 'appointmentFormatted'
    | 'mapsUrl'
    | 'damageIntro'
    | 'vehicleModel'
    | 'isComplement'
    | 'peritaje'
    | 'temperature'
  >,
  conversationTurns: readonly ChatCompletionMessageParam[] = [],
): Promise<LlmNarrativeParts> {
  const payload = {
    reportePericial: peritajeNarrativeContext(input.peritaje),
    contextoOperativo: {
      contactName: input.contactName,
      damageIntro: input.damageIntro ?? '',
      vehicleModel: input.vehicleModel ?? '',
      hasActiveAppointment: input.hasActiveAppointment,
      appointmentFormatted: input.appointmentFormatted ?? '',
      mapsUrl: input.mapsUrl ?? '',
      isComplement: Boolean(input.isComplement),
    },
    restricciones: {
      noMoney: true,
      noLineItems: true,
      noTotals: true,
    },
  };

  const history = conversationTurns.filter(
    (m) =>
      (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string' &&
      String(m.content).trim().length > 0,
  );

  const completion = await createTrackedChatCompletion(
    openai,
    {
      ...openAiChatCompletionParams({
        tier: 'narrative',
        maxOutputTokens: 800,
        temperature: Math.max(0.4, Number(input.temperature) || 0.6),
      }),
      messages: [
        {
          role: 'system',
          content: buildCanonicalNarrativeSystemPrompt(chatAppointmentSystemPrompt),
        },
        ...history,
        {
          role: 'user',
          content: [
            'Redacta SOLO intro, technicalExplanation y cta para este borrador.',
            'NO inventes precios ni desglose. El backend insertará el bloque financiero.',
            JSON.stringify(payload, null, 2),
          ].join('\n\n'),
        },
      ],
    },
    { purpose: 'narrative_canonical_parts' },
  );

  const raw = String(completion.choices[0]?.message?.content ?? '').trim();
  const parsed = parseLlmNarrativeParts(raw);
  if (!parsed) {
    throw new Error('composeCanonicalLlmNarrativeParts: JSON inválido o vacío');
  }
  return parsed;
}

export function parseLlmNarrativeParts(raw: string): LlmNarrativeParts | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    const obj = JSON.parse(unfenced) as Partial<LlmNarrativeParts>;
    const intro = String(obj.intro ?? '').trim();
    const technicalExplanation = String(obj.technicalExplanation ?? '').trim();
    const cta = String(obj.cta ?? '').trim();
    if (!intro && !technicalExplanation && !cta) return null;
    return { intro, technicalExplanation, cta };
  } catch {
    return null;
  }
}

export function applyComposedNarrativeToDraft(
  draft: {
    formalNarrative: string;
    generatedMessage?: string;
    clientMessage?: string;
    narrativeFlow?: NarrativeFlow;
    renderedFinancialBlock?: string;
    shownWarnings?: string[];
  },
  composed: ComposedClientQuote,
): void {
  draft.formalNarrative = composed.finalMessage;
  draft.generatedMessage = composed.finalMessage;
  draft.clientMessage = composed.finalMessage;
  draft.narrativeFlow = composed.flow;
  draft.renderedFinancialBlock = composed.financialBlock;
  draft.shownWarnings = composed.shownWarnings;
}

/**
 * Única función de composición moderna (producción, preview y playground).
 */
export async function composeModernClientQuoteMessage(
  input: ModernComposeInput,
): Promise<ComposedClientQuote> {
  if (!isCanonicalNarrativeEligible(input.canonicalQuote)) {
    throw new Error('composeModernClientQuoteMessage: CanonicalQuoteV1 inválido');
  }

  const financial = renderCanonicalQuoteFinancialBlock(
    input.canonicalQuote,
    input.peritaje,
  );
  const warnings = renderCanonicalQuoteWarningsBlock(input.canonicalQuote);
  const events: NarrativeObservabilityEvent[] = [];
  const fallbackParts = renderDeterministicClientQuoteFallback({
    contactName: input.contactName,
    vehicle: input.peritaje?.vehicles?.[0],
    damages: input.peritaje?.damages,
    canonicalQuote: input.canonicalQuote,
    hasActiveAppointment: input.hasActiveAppointment,
    appointmentFormatted: input.appointmentFormatted,
    mapsUrl: input.mapsUrl,
    damageIntro: input.damageIntro,
    isComplement: input.isComplement,
  });

  const finish = (
    composed: ComposedClientQuote,
    financialIntegrityValid: boolean,
  ): ComposedClientQuote => {
    traceFinalClientMessageSummary({
      composed,
      canonicalQuote: input.canonicalQuote,
      financialIntegrityValid,
    });
    return composed;
  };

  const useFallback = (reason: string, extra?: NarrativeObservabilityEvent[]) => {
    events.push({
      event: NARRATIVE_EVENTS.DETERMINISTIC_FALLBACK_USED,
      quoteId: input.canonicalQuote.quoteId,
      detail: reason,
    });
    if (extra) events.push(...extra);
    logNarrativeEvents(events);
    const finalMessage = assembleClientQuoteMessage(fallbackParts);
    return finish(
      {
        flow: NARRATIVE_FLOW.CANONICAL,
        finalMessage,
        financialBlock: financial.text,
        warningsBlock: warnings.text,
        shownWarnings: warnings.shownWarnings,
        llmUsed: false,
        fallbackUsed: true,
        events,
        parts: fallbackParts,
      } satisfies ComposedClientQuote,
      reason !== 'reconciliation_failed',
    );
  };

  const llmInjected = Object.prototype.hasOwnProperty.call(input, 'llmParts');
  let llmParts: LlmNarrativeParts | null = llmInjected
    ? (input.llmParts ?? null)
    : null;
  if (!llmInjected && input.openai && input.chatAppointmentSystemPrompt) {
    try {
      llmParts = await composeCanonicalLlmNarrativeParts(
        input.openai,
        input.chatAppointmentSystemPrompt,
        input,
        input.conversationTurns ?? [],
      );
    } catch (err) {
      return useFallback(
        err instanceof Error ? err.message : 'openai_failed',
        [
          {
            event: NARRATIVE_EVENTS.LLM_NARRATIVE_REJECTED,
            quoteId: input.canonicalQuote.quoteId,
            detail: err instanceof Error ? err.message : 'openai_failed',
          },
        ],
      );
    }
  }

  if (!llmParts || (!llmParts.intro && !llmParts.technicalExplanation && !llmParts.cta)) {
    return useFallback(llmParts ? 'llm_empty' : 'llm_unavailable');
  }

  const sanitized = sanitizeLlmNarrativeParts(llmParts);
  if (!sanitized.ok) {
    return useFallback(sanitized.reason, [
      {
        event: NARRATIVE_EVENTS.LLM_NARRATIVE_REJECTED,
        quoteId: input.canonicalQuote.quoteId,
        detail: sanitized.reason,
      },
    ]);
  }

  const parts: ClientQuoteMessage = {
    intro: sanitized.parts.intro,
    technicalExplanation: sanitized.parts.technicalExplanation,
    financialBlock: financial.text,
    warningsBlock: warnings.text,
    cta: sanitized.parts.cta,
  };
  const finalMessage = assembleClientQuoteMessage(parts);
  const validation = validateFinalClientQuoteMessage({
    canonicalQuote: input.canonicalQuote,
    renderedFinancialBlock: financial.text,
    finalMessage,
    warningsBlock: warnings.text,
    peritaje: input.peritaje,
  });
  if (!validation.ok) {
    return useFallback('reconciliation_failed', validation.events);
  }

  return finish(
    {
      flow: NARRATIVE_FLOW.CANONICAL,
      finalMessage,
      financialBlock: financial.text,
      warningsBlock: warnings.text,
      shownWarnings: warnings.shownWarnings,
      llmUsed: true,
      fallbackUsed: false,
      events,
      parts,
    },
    true,
  );
}

export function previewModernFinancialBlock(
  canonicalQuote: CanonicalQuoteV1,
  peritaje?: CanonicalPeritajeV1 | null,
): string {
  return renderCanonicalQuoteFinancialBlock(canonicalQuote, peritaje).text;
}

export {
  isCanonicalNarrativeEligible,
  NARRATIVE_FLOW,
  renderCanonicalQuoteFinancialBlock,
};
