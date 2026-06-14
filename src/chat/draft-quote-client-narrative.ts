import type OpenAI from 'openai';
import type { VehicleDamageAnalysis } from './entities/chat.entity';
import { AUTO_FIX_CURRENCY } from './autofix-config';
import { openAiChatCompletionParams } from './openai-model-config';
import { visionItemsIndicateBanioCompleto } from './vision-bpc-inventory';

export type DraftClientNarrativeDialogueTurn = {
  role: 'user' | 'assistant';
  content: string;
};

export type DraftClientNarrativeReport = {
  inventory: Array<{
    pieza: string;
    severidad?: string;
    descripcionTecnica?: string;
  }>;
  vehiculoDetectado?: string;
  pieza?: string;
  severidad?: string;
  partesAfectadas?: string[];
  descripcionTecnica?: string;
  justificacion?: string;
  intencionBanioCompleto?: boolean;
};

export type DraftClientNarrativeQuoteLine = {
  pieza: string;
  precioMx: number;
  precioMaximo?: number;
  detallesRefaccion?: string;
};

export type DraftClientNarrativeQuote = {
  reference?: string;
  lineas: DraftClientNarrativeQuoteLine[];
  totalMx: number;
  moneda: string;
};

export type DraftClientNarrativeContext = {
  contactName: string;
  hasActiveAppointment: boolean;
  appointmentFormatted?: string;
  mapsUrl?: string;
  damageIntro?: string;
  isComplement?: boolean;
  previousPiezas?: string[];
  newPiezas?: string[];
  origenVision?: boolean;
  fotosAnalizadas?: number;
};

export function containsClientFacingNumericId(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  return (
    /messenger\s*[#:.-]?\s*\d{4,}/i.test(t) ||
    /\b(?:uid|psid|id)\s*[:#-]?\s*\d{6,}\b/i.test(t)
  );
}

export function buildDraftClientNarrativeReportFromAnalysis(
  analysis: VehicleDamageAnalysis,
): DraftClientNarrativeReport {
  return {
    inventory: (analysis.inventory ?? []).map((it) => ({
      pieza: String(it.pieza ?? '').trim(),
      severidad: String(it.severidad ?? '').trim() || undefined,
      descripcionTecnica: String(it.descripcionTecnica ?? '').trim() || undefined,
    })),
    vehiculoDetectado: String(analysis.vehiculoDetectado ?? '').trim() || undefined,
    pieza: String(analysis.pieza ?? '').trim() || undefined,
    severidad: String(analysis.severidad ?? '').trim() || undefined,
    partesAfectadas: [...(analysis.partesAfectadas ?? [])].filter(Boolean),
    descripcionTecnica: String(analysis.descripcionTecnica ?? '').trim() || undefined,
    justificacion: String(analysis.justificacion ?? '').trim() || undefined,
    intencionBanioCompleto:
      analysis.banioPinturaGate?.intencionBanioCompleto === true ||
      visionItemsIndicateBanioCompleto(analysis.inventory ?? []) ||
      (analysis.inventory ?? []).some(
        (it) => String(it.pieza ?? '').trim().toUpperCase() === 'BPC',
      ),
  };
}

export function buildDraftClientNarrativeReportFromPieces(
  piezaLabels: string[],
  vehicleModel?: string,
): DraftClientNarrativeReport {
  const labels = piezaLabels.map((p) => String(p ?? '').trim()).filter(Boolean);
  return {
    inventory: labels.map((pieza) => ({ pieza })),
    vehiculoDetectado: String(vehicleModel ?? '').trim() || undefined,
    partesAfectadas: labels,
  };
}

export function buildDraftClientNarrativeQuote(input: {
  reference?: string;
  lineRows: DraftClientNarrativeQuoteLine[];
  total: number;
}): DraftClientNarrativeQuote {
  return {
    reference: String(input.reference ?? '').trim() || undefined,
    lineas: input.lineRows,
    totalMx: Math.max(0, Math.round(Number(input.total) || 0)),
    moneda: AUTO_FIX_CURRENCY,
  };
}

export function buildDraftClientNarrativeFinalUserMessage(
  report: DraftClientNarrativeReport,
  quote: DraftClientNarrativeQuote,
  ctx: DraftClientNarrativeContext,
): string {
  return [
    'El peritaje visual y la cotización del borrador están listos.',
    'Redacta el mensaje final al cliente para enviar por WhatsApp/Messenger.',
    '',
    JSON.stringify(
      {
        reportePericial: report,
        cotizacion: quote,
        contexto: ctx,
      },
      null,
      2,
    ),
  ].join('\n');
}

export function dialogueTurnsToChatMessages(
  dialogue: readonly DraftClientNarrativeDialogueTurn[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const turn of dialogue) {
    const content = String(turn.content ?? '').trim();
    if (!content || content.includes('cloudinary')) continue;
    if (turn.role !== 'user' && turn.role !== 'assistant') continue;
    out.push({ role: turn.role, content });
  }
  return out;
}

/**
 * Redacta el mensaje al cliente usando únicamente ChatAppointmentPrompt como system
 * y el historial reciente de la conversación + payload estructurado del peritaje/cotización.
 */
export async function composeDraftClientMessageWithChatAppointmentPrompt(
  openai: OpenAI,
  chatAppointmentSystemPrompt: string,
  dialogue: readonly DraftClientNarrativeDialogueTurn[],
  report: DraftClientNarrativeReport,
  quote: DraftClientNarrativeQuote,
  ctx: DraftClientNarrativeContext,
  options?: { temperature?: number; maxOutputTokens?: number },
): Promise<string | null> {
  const system = String(chatAppointmentSystemPrompt ?? '').trim();
  if (!system) return null;

  const history = dialogueTurnsToChatMessages(dialogue);
  const finalUser = buildDraftClientNarrativeFinalUserMessage(report, quote, ctx);

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> =
    [{ role: 'system', content: system }, ...history, { role: 'user', content: finalUser }];

  try {
    const completion = await openai.chat.completions.create({
      ...openAiChatCompletionParams({
        tier: 'narrative',
        maxOutputTokens: options?.maxOutputTokens ?? 1200,
        temperature: options?.temperature ?? 0.7,
      }),
      messages,
    });
    const out = String(completion.choices[0]?.message?.content ?? '').trim();
    if (!out || out.length < 40) return null;
    if (containsClientFacingNumericId(out)) return null;
    return out;
  } catch (err) {
    console.error('composeDraftClientMessageWithChatAppointmentPrompt:', err);
    return null;
  }
}
