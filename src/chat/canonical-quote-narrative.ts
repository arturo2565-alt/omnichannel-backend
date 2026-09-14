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
  sanitizeLlmNarrativeParts,
  validateFinalClientQuoteMessage,
  type ClientQuoteMessage,
  type LlmNarrativeParts,
  type NarrativeFlow,
  type NarrativeObservabilityEvent,
} from '../domain/peritaje-v1/quote-narrative';
import { traceFinalClientMessageSummary } from './canonical-trace';
import type { QuoteSendSnapshot } from './autofix-config';
import type { ClientMessageSource, ClientMessageMode, CtaType, QuoteDelta } from './client-message-ux';
import {
  assembleModeAwareClientQuoteParts,
  buildModeAwareNarrativeAppendix,
  extractLastUserText,
  resolveClientMessageUx,
  snapshotOfferedAppointmentCta,
  snapshotSharedLocation,
  traceClientMessageRendered,
  type ResolvedClientMessageUx,
} from './client-message-ux';

export type ComposedClientQuote = {
  flow: NarrativeFlow;
  finalMessage: string;
  financialBlock: string;
  warningsBlock: string;
  shownWarnings: string[];
  warningsRenderedCount?: number;
  llmUsed: boolean;
  fallbackUsed: boolean;
  events: NarrativeObservabilityEvent[];
  parts: ClientQuoteMessage;
  mode?: ClientMessageMode;
  shouldGreet?: boolean;
  quoteDelta?: QuoteDelta;
  ctaType?: CtaType;
  fullQuoteRendered?: boolean;
  deltaRendered?: boolean;
  postFilterInterventionsCount?: number;
  preFilterClean?: boolean;
};

export type ModernComposeInput = {
  canonicalQuote: CanonicalQuoteV1;
  peritaje?: CanonicalPeritajeV1 | null;
  previousPeritaje?: CanonicalPeritajeV1 | null;
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
  previousSnapshot?: QuoteSendSnapshot | null;
  messageSource?: ClientMessageSource;
  userText?: string;
  appointmentCtaAlreadyOffered?: boolean;
  locationAlreadyShared?: boolean;
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
- PROHIBIDO explicar la causa de cotización parcial o mencionar "falta el precio de refacción". El bloque financiero ya declara la razón.
- Puedes mencionar piezas pendientes de revisión (desalineación o posible involucramiento) sin importes. PROHIBIDO presentarlas como cargo confirmado.
- PROHIBIDO incluir IDs de plataforma o códigos internos de pieza.
- Puedes mencionar el año del vehículo, una hora de cita o "garantía de 1 año" si aplica; eso no es un importe.
`.trim();

function buildCanonicalNarrativeSystemPrompt(
  base: string,
  appendix = CANONICAL_NARRATIVE_APPENDIX,
): string {
  const prompt = String(base ?? '').trim();
  if (!prompt) {
    throw new Error('composeCanonicalLlmNarrativeParts: chatAppointmentPrompt vacío');
  }
  return `${prompt}\n\n${appendix}`;
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
  > & { ux?: ResolvedClientMessageUx },
  conversationTurns: readonly ChatCompletionMessageParam[] = [],
): Promise<LlmNarrativeParts> {
  const omitVisualDump =
    input.ux &&
    (input.ux.technicalExplanation === 'omitted' || !input.ux.shouldGreet);
  const payload = {
    reportePericial: omitVisualDump
      ? {
          vehiculo:
            input.ux?.vehicleLabel ||
            peritajeNarrativeContext(input.peritaje).vehiculo,
        }
      : peritajeNarrativeContext(input.peritaje),
    contextoOperativo: {
      contactName: input.contactName,
      damageIntro: omitVisualDump ? '' : input.damageIntro ?? '',
      vehicleModel: input.vehicleModel ?? input.ux?.vehicleLabel ?? '',
      hasActiveAppointment: input.hasActiveAppointment,
      appointmentFormatted: input.appointmentFormatted ?? '',
      mapsUrl: input.ux?.shouldShareLocation ? input.mapsUrl ?? '' : '',
      isComplement: Boolean(input.isComplement),
      mode: input.ux?.mode,
      shouldGreet: input.ux?.shouldGreet ?? true,
      ctaType: input.ux?.ctaType,
    },
    restricciones: {
      noMoney: true,
      noLineItems: true,
      noTotals: true,
      noGreeting: input.ux ? !input.ux.shouldGreet : false,
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
          content: buildCanonicalNarrativeSystemPrompt(
            chatAppointmentSystemPrompt,
            input.ux
              ? buildModeAwareNarrativeAppendix(input.ux)
              : CANONICAL_NARRATIVE_APPENDIX,
          ),
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

  const userText =
    input.userText ?? extractLastUserText(input.conversationTurns);
  const ux = resolveClientMessageUx({
    quote: input.canonicalQuote,
    peritaje: input.peritaje,
    previousPeritaje: input.previousPeritaje,
    previousSnapshot: input.previousSnapshot,
    source: input.messageSource,
    userText,
    hasActiveAppointment: input.hasActiveAppointment,
    appointmentCtaAlreadyOffered:
      input.appointmentCtaAlreadyOffered ??
      snapshotOfferedAppointmentCta(input.previousSnapshot),
    locationAlreadyShared:
      input.locationAlreadyShared ??
      snapshotSharedLocation(input.previousSnapshot),
    contactName: input.contactName,
  });

  const events: NarrativeObservabilityEvent[] = [];
  const packFromLlm = (llm?: LlmNarrativeParts | null) =>
    assembleModeAwareClientQuoteParts({
      ctx: ux,
      peritaje: input.peritaje,
      llmIntro: llm?.intro,
      llmTechnicalExplanation: llm?.technicalExplanation,
      llmCta: llm?.cta,
      hasActiveAppointment: input.hasActiveAppointment,
      appointmentFormatted: input.appointmentFormatted,
      mapsUrl: input.mapsUrl,
      damageIntro: ux.shouldGreet ? input.damageIntro : '',
    });

  const finish = (
    composed: ComposedClientQuote,
    financialIntegrityValid: boolean,
  ): ComposedClientQuote => {
    traceClientMessageRendered({
      quoteId: input.canonicalQuote.quoteId,
      mode: ux.mode,
      fullQuoteRendered: Boolean(composed.fullQuoteRendered ?? ux.presentation === 'FULL'),
      deltaRendered: Boolean(composed.deltaRendered ?? ux.presentation === 'DELTA'),
      deltaCount: ux.changedLines.length,
      greetingRendered: ux.shouldGreet,
      technicalExplanationRendered: Boolean(
        composed.parts.technicalExplanation && ux.technicalExplanation === 'allowed',
      ),
      warningsRenderedCount: composed.warningsRenderedCount ?? 0,
      ctaType: ux.ctaType,
    });
    traceFinalClientMessageSummary({
      composed,
      canonicalQuote: input.canonicalQuote,
      financialIntegrityValid,
    });
    return {
      ...composed,
      mode: ux.mode,
      shouldGreet: ux.shouldGreet,
      quoteDelta: ux.quoteDelta,
      ctaType: ux.ctaType,
    };
  };

  const useFallback = (reason: string, extra?: NarrativeObservabilityEvent[]) => {
    events.push({
      event: NARRATIVE_EVENTS.DETERMINISTIC_FALLBACK_USED,
      quoteId: input.canonicalQuote.quoteId,
      detail: reason,
    });
    if (extra) events.push(...extra);
    logNarrativeEvents(events);
    const packed = packFromLlm(null);
    const finalMessage = assembleClientQuoteMessage(packed.parts);
    return finish(
      {
        flow: NARRATIVE_FLOW.CANONICAL,
        finalMessage,
        financialBlock: packed.financialBlock,
        warningsBlock: packed.warningsBlock,
        shownWarnings: packed.shownWarnings,
        warningsRenderedCount: packed.warningsRenderedCount,
        llmUsed: false,
        fallbackUsed: true,
        events,
        parts: packed.parts,
        fullQuoteRendered: packed.fullQuoteRendered,
        deltaRendered: packed.deltaRendered,
        postFilterInterventionsCount: packed.postFilterInterventionsCount,
        preFilterClean: packed.preFilterClean,
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
        { ...input, ux },
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

  const packed = packFromLlm(sanitized.parts);
  const finalMessage = assembleClientQuoteMessage(packed.parts);
  const validation = validateFinalClientQuoteMessage({
    canonicalQuote: input.canonicalQuote,
    renderedFinancialBlock: packed.financialBlock,
    finalMessage,
    warningsBlock: packed.warningsBlock,
    peritaje: input.peritaje,
    scope: {
      presentation: ux.presentation,
      requiredQuoteLineIds: ux.requiredQuoteLineIds,
    },
  });
  if (!validation.ok) {
    return useFallback('reconciliation_failed', validation.events);
  }

  return finish(
    {
      flow: NARRATIVE_FLOW.CANONICAL,
      finalMessage,
      financialBlock: packed.financialBlock,
      warningsBlock: packed.warningsBlock,
      shownWarnings: packed.shownWarnings,
      warningsRenderedCount: packed.warningsRenderedCount,
      llmUsed: true,
      fallbackUsed: false,
      events,
      parts: packed.parts,
      fullQuoteRendered: packed.fullQuoteRendered,
      deltaRendered: packed.deltaRendered,
      postFilterInterventionsCount: packed.postFilterInterventionsCount,
      preFilterClean: packed.preFilterClean,
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
