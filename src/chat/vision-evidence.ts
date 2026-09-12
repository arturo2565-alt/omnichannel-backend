import type { DetectedDamageItem } from './entities/chat.entity';

export const EVIDENCE_EVENTS = {
  EVIDENCE_RECOVERED_SINGLE_INPUT: 'EVIDENCE_RECOVERED_SINGLE_INPUT',
  EVIDENCE_MISSING_FROM_VISION: 'EVIDENCE_MISSING_FROM_VISION',
  UNKNOWN_INPUT_URL: 'UNKNOWN_INPUT_URL',
} as const;

export type EvidenceEventCode =
  (typeof EVIDENCE_EVENTS)[keyof typeof EVIDENCE_EVENTS];

export type VisionEvidenceEvent = {
  event: EvidenceEventCode;
  pieza?: string;
  url?: string;
  inputCount?: number;
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

export function logVisionEvidenceEvents(
  events: readonly VisionEvidenceEvent[],
): void {
  for (const ev of events) {
    console.log('[VisionEvidence]', JSON.stringify(ev));
  }
}

/**
 * Reglas de evidencia post-parser, pre-CanonicalPeritaje.
 *
 * - Una URL de entrada puede pertenecer a varios DamageItems (copia, no consume).
 * - Batch de 1 imagen: ítem sin urls_origen recibe esa URL (sin ambigüedad).
 * - Batch de 2+ imágenes: no adivinar; evidence vacío se queda vacío.
 * - URLs que Vision inventó (fuera del input) no se confían.
 */
export function applyVisionEvidenceRules(
  items: readonly DetectedDamageItem[],
  inputUrls: readonly string[],
): { items: DetectedDamageItem[]; events: VisionEvidenceEvent[] } {
  const input = uniqueTrimmedUrls(inputUrls);
  const inputSet = new Set(input);
  const events: VisionEvidenceEvent[] = [];

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
        pieza: it.pieza,
        url,
        inputCount: input.length,
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
          pieza: it.pieza,
          url: only,
          inputCount: 1,
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
        pieza: it.pieza,
        inputCount: input.length,
      });
    }
  }

  return { items: sanitized, events };
}

/**
 * Aplica las reglas y deja el inventario listo para CanonicalPeritaje.
 * No muta treatment ni precios.
 */
export function recoverVisionEvidenceForPeritaje(
  items: readonly DetectedDamageItem[],
  inputUrls: readonly string[],
): DetectedDamageItem[] {
  const { items: next, events } = applyVisionEvidenceRules(items, inputUrls);
  logVisionEvidenceEvents(events);
  return next;
}
