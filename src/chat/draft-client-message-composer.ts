import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { openAiChatCompletionParams } from './openai-model-config';
import { createTrackedChatCompletion } from './tracked-chat-completion';

export type DraftClientMessageLineRow = {
  pieza: string;
  precioMx: number;
  precioMaximo?: number;
};

export type DraftClientMessagePeritajeItem = {
  pieza: string;
  severidad?: string;
  descripcionTecnica?: string;
};

export type DraftClientMessageComposeInput = {
  contactName: string;
  lineRows: DraftClientMessageLineRow[];
  total: number;
  currency: string;
  hasActiveAppointment: boolean;
  appointmentFormatted: string;
  mapsUrl: string;
  damageIntro: string;
  vehicleModel: string;
  reference?: string;
  isComplement: boolean;
  previousPiezas: string[];
  newPiezas: string[];
  pricingMode: 'bpc' | 'piezas' | 'unknown';
  peritaje: {
    inventario: DraftClientMessagePeritajeItem[];
    descripcionTecnica?: string;
    justificacion?: string;
    vehiculoDetectado?: string;
    imageCount?: number;
  };
};

const DRAFT_CLIENT_MESSAGE_TECH_APPENDIX = `
[Tarea: mensaje al cliente — borrador de cotización desde panel con peritaje visual]
Responde SOLO el texto final listo para WhatsApp/Messenger (sin JSON, sin meta-explicación, sin markdown de código).

Reglas obligatorias:
- Usa EXACTAMENTE los montos de "cotizacion.lineRows" y "cotizacion.total"; PROHIBIDO calcular, redondear distinto o inventar precios.
- El bloque "reportePericial" viene del análisis de fotos; úsalo para contexto técnico, NO para cambiar precios.
- Si "contextoOperativo.hasActiveAppointment" es true, indica que el monto puede sumarse a la orden de la cita confirmada.
- Si es false, invita cordialmente a elegir día para ingresar la unidad e incluye mapsUrl si está presente.
- Si "contextoOperativo.isComplement" es true, menciona que son piezas/conceptos adicionales al presupuesto previo.
- PROHIBIDO incluir IDs numéricos de plataforma (UID/PSID/Messenger ID).
- Mismo formato y tono para baño de pintura completo (BPC) y piezas sueltas: una sola voz comercial premium.
- Sigue el estilo, emojis y estructura definidos en el system prompt principal (ChatAppointmentPrompt).`.trim();

export function buildDraftClientMessageSystemPrompt(
  chatAppointmentSystemPrompt: string,
): string {
  const base = String(chatAppointmentSystemPrompt ?? '').trim();
  if (!base) {
    throw new Error(
      'buildDraftClientMessageSystemPrompt: chatAppointmentPrompt vacío',
    );
  }
  return `${base}\n\n${DRAFT_CLIENT_MESSAGE_TECH_APPENDIX}`;
}

export function buildDraftClientMessageStructuredPayload(
  input: DraftClientMessageComposeInput,
): Record<string, unknown> {
  return {
    reportePericial: {
      inventario: input.peritaje.inventario,
      descripcionTecnica: input.peritaje.descripcionTecnica ?? '',
      justificacion: input.peritaje.justificacion ?? '',
      vehiculoDetectado: input.peritaje.vehiculoDetectado ?? input.vehicleModel,
      fotosAnalizadas: input.peritaje.imageCount ?? 0,
      pricingMode: input.pricingMode,
    },
    cotizacion: {
      lineRows: input.lineRows,
      total: input.total,
      currency: input.currency,
      reference: input.reference ?? '',
    },
    contextoOperativo: {
      contactName: input.contactName,
      damageIntro: input.damageIntro,
      hasActiveAppointment: input.hasActiveAppointment,
      appointmentFormatted: input.appointmentFormatted,
      mapsUrl: input.mapsUrl,
      vehicleModel: input.vehicleModel,
      isComplement: input.isComplement,
      previousPiezas: input.previousPiezas,
      newPiezas: input.newPiezas,
    },
  };
}

export function containsClientFacingNumericId(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  return (
    /messenger\s*[#:.-]?\s*\d{4,}/i.test(t) ||
    /\b(?:uid|psid|id)\s*[:#-]?\s*\d{6,}\b/i.test(t)
  );
}

export function validateDraftClientMessageOutput(text: string): boolean {
  const out = String(text ?? '').trim();
  if (!out || out.length < 40) return false;
  if (containsClientFacingNumericId(out)) return false;
  return true;
}

export function peritajeFromDamageAnalysisLike(analysis: {
  inventory?: DraftClientMessagePeritajeItem[];
  pieza?: string;
  severidad?: string;
  descripcionTecnica?: string;
  justificacion?: string;
  vehiculoDetectado?: string;
  partesAfectadas?: string[];
}): DraftClientMessageComposeInput['peritaje'] {
  const inventario =
    analysis.inventory?.length ?
      analysis.inventory.map((it) => ({
        pieza: String(it.pieza ?? '').trim(),
        severidad: String(it.severidad ?? '').trim() || undefined,
        descripcionTecnica: String(it.descripcionTecnica ?? '').trim() || undefined,
      }))
    : analysis.pieza ?
      [
        {
          pieza: String(analysis.pieza).trim(),
          severidad: String(analysis.severidad ?? '').trim() || undefined,
          descripcionTecnica: String(analysis.descripcionTecnica ?? '').trim() || undefined,
        },
      ]
    : (analysis.partesAfectadas ?? []).map((p) => ({
        pieza: String(p).trim(),
      }));

  return {
    inventario,
    descripcionTecnica: analysis.descripcionTecnica,
    justificacion: analysis.justificacion,
    vehiculoDetectado: analysis.vehiculoDetectado,
  };
}

/**
 * Redacta el mensaje al cliente con ChatAppointmentPrompt + historial + peritaje/cotización.
 */
export async function composeDraftClientMessageWithLlm(
  openai: OpenAI,
  chatAppointmentSystemPrompt: string,
  input: DraftClientMessageComposeInput,
  conversationTurns: readonly ChatCompletionMessageParam[],
  options?: { temperature?: number },
): Promise<string> {
  const payload = buildDraftClientMessageStructuredPayload(input);
  const history = conversationTurns.filter(
    (m) =>
      (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string' &&
      String(m.content).trim().length > 0,
  );

  const temperature = Math.max(0.5, Number(options?.temperature) || 0.7);

  const completion = await createTrackedChatCompletion(
    openai,
    {
      ...openAiChatCompletionParams({
        tier: 'narrative',
        maxOutputTokens: 1200,
        temperature,
      }),
      messages: [
        {
          role: 'system',
          content: buildDraftClientMessageSystemPrompt(chatAppointmentSystemPrompt),
        },
        ...history,
        {
          role: 'user',
          content: [
            'Redacta el mensaje NUEVO al cliente para este borrador de cotización.',
            'Usa el historial de conversación para continuidad de tono y contexto.',
            'Datos estructurados (NO inventes precios ni piezas fuera de este JSON):',
            JSON.stringify(payload, null, 2),
          ].join('\n\n'),
        },
      ],
    },
    { purpose: 'narrative' },
  );

  const text = String(completion.choices[0]?.message?.content ?? '').trim();
  if (!validateDraftClientMessageOutput(text)) {
    throw new Error('composeDraftClientMessageWithLlm: respuesta inválida o vacía');
  }

  console.log(
    '[DraftClientMessage]',
    JSON.stringify({
      pricingMode: input.pricingMode,
      lineCount: input.lineRows.length,
      total: input.total,
      historyTurns: history.length,
      chars: text.length,
    }),
  );

  return text;
}
