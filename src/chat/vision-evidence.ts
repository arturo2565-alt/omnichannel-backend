import { randomUUID } from 'crypto';
import {
  mergeCanonicalTraceContext,
  traceVisionEvidenceRecovery,
} from './canonical-trace';
import type { DetectedDamageItem } from './entities/chat.entity';

export const EVIDENCE_EVENTS = {
  EVIDENCE_RECOVERED_SINGLE_INPUT: 'EVIDENCE_RECOVERED_SINGLE_INPUT',
  EVIDENCE_MISSING_FROM_VISION: 'EVIDENCE_MISSING_FROM_VISION',
  UNKNOWN_INPUT_URL: 'UNKNOWN_INPUT_URL',
} as const;

export type EvidenceEventCode =
  (typeof EVIDENCE_EVENTS)[keyof typeof EVIDENCE_EVENTS];

export type VisionEvidenceContext = {
  conversationId?: string | null;
  visionRunId?: string | null;
};

export type VisionEvidenceEvent = {
  event: EvidenceEventCode;
  pieceCode?: string;
  conversationId?: string;
  visionRunId?: string;
  cantidadInputImages?: number;
  /** Solo para tests; no se imprime en logs. */
  url?: string;
};

export function uniqueTrimmedUrls(
  urls: readonly string[] | undefined,
): string[] {
  return [
    ...new Set(
      (urls ?? []).map((u) => String(u ?? '').trim()).filter(Boolean),
    ),
  ];
}

function redactEvidenceUrlForLog(url: string): string {
  const s = String(url ?? '');
  if (/^data:image\//i.test(s)) return `[data-url ${s.length}]`;
  return s;
}

export function auditEvidenceRefs(
  items: readonly DetectedDamageItem[],
): Array<{ pieceCode: string; urls_origen: string[] }> {
  return items.map((it) => ({
    pieceCode: String(it.pieza ?? ''),
    urls_origen: uniqueTrimmedUrls(it.urls_origen).map(redactEvidenceUrlForLog),
  }));
}

export function logVisionEvidenceEvents(
  events: readonly VisionEvidenceEvent[],
): void {
  for (const ev of events) {
    const { url: _omit, ...safe } = ev;
    console.log('[VisionEvidence]', JSON.stringify(safe));
  }
}

/**
 * Recovery post-parser, pre-CanonicalPeritaje.
 * Una URL de entrada puede pertenecer a varios DamageItems (copia, no consume).
 */
export function applyVisionEvidenceRules(
  items: readonly DetectedDamageItem[],
  inputUrls: readonly string[],
  ctx: VisionEvidenceContext = {},
): { items: DetectedDamageItem[]; events: VisionEvidenceEvent[] } {
  const input = uniqueTrimmedUrls(inputUrls);
  const inputSet = new Set(input);
  const events: VisionEvidenceEvent[] = [];
  const conversationId = String(ctx.conversationId ?? '').trim() || undefined;
  const visionRunId = String(ctx.visionRunId ?? '').trim() || undefined;

  const baseMeta = {
    ...(conversationId ? { conversationId } : {}),
    ...(visionRunId ? { visionRunId } : {}),
    cantidadInputImages: input.length,
  };

  const sanitized = items.map((it) => {
    const raw = uniqueTrimmedUrls(it.urls_origen);
    const trusted: string[] = [];
    for (const url of raw) {
      if (inputSet.size === 0 || inputSet.has(url)) {
        trusted.push(url);
        continue;
      }
      events.push({
        event: EVIDENCE_EVENTS.UNKNOWN_INPUT_URL,
        pieceCode: it.pieza,
        url,
        ...baseMeta,
      });
    }
    return { ...it, urls_origen: trusted };
  });

  if (input.length === 1) {
    const only = input[0]!;
    return {
      items: sanitized.map((it) => {
        if (it.urls_origen.length > 0) return it;
        events.push({
          event: EVIDENCE_EVENTS.EVIDENCE_RECOVERED_SINGLE_INPUT,
          pieceCode: it.pieza,
          url: only,
          ...baseMeta,
          cantidadInputImages: 1,
        });
        return { ...it, urls_origen: [only] };
      }),
      events,
    };
  }

  if (input.length >= 2) {
    for (const it of sanitized) {
      if (it.urls_origen.length > 0) continue;
      events.push({
        event: EVIDENCE_EVENTS.EVIDENCE_MISSING_FROM_VISION,
        pieceCode: it.pieza,
        ...baseMeta,
      });
    }
  }

  return { items: sanitized, events };
}

export function recoverVisionEvidenceForPeritaje(
  items: readonly DetectedDamageItem[],
  inputUrls: readonly string[],
  ctx: VisionEvidenceContext = {},
): DetectedDamageItem[] {
  const visionRunId =
    String(ctx.visionRunId ?? '').trim() || `visrun_${randomUUID().slice(0, 8)}`;
  const nextCtx = { ...ctx, visionRunId };
  mergeCanonicalTraceContext({
    conversationId: String(ctx.conversationId ?? '').trim() || undefined,
    visionRunId,
  });
  const { items: next, events } = applyVisionEvidenceRules(
    items,
    inputUrls,
    nextCtx,
  );
  logVisionEvidenceEvents(events);
  traceVisionEvidenceRecovery({
    itemsBefore: items,
    itemsAfter: next,
    inputImageCount: uniqueTrimmedUrls(inputUrls).length,
    recoveredPieceCodes: events
      .filter((e) => e.event === EVIDENCE_EVENTS.EVIDENCE_RECOVERED_SINGLE_INPUT)
      .map((e) => String(e.pieceCode ?? '')),
    missingPieceCodes: events
      .filter((e) => e.event === EVIDENCE_EVENTS.EVIDENCE_MISSING_FROM_VISION)
      .map((e) => String(e.pieceCode ?? '')),
  });
  return next;
}
