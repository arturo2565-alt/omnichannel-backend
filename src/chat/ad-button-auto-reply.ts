import { normalizeTextForMatch } from './autofix-config';

/** Intenciones de botones de publicidad (Messenger / WhatsApp). */
export type AdButtonIntent =
  | 'reparacion_golpe'
  | 'banio_pintura'
  | 'ubicacion'
  | 'agendar_cita';

export type AdButtonAutoReplyMatch = {
  intent: AdButtonIntent;
  reply: string;
  /** Campo que disparó el match (`payload` o `text`). */
  matchedVia: 'payload' | 'text';
};

/** Respuestas fijas alineadas al copy de los botones del anuncio. */
export const AD_BUTTON_AUTO_REPLIES: Record<AdButtonIntent, string> = {
  reparacion_golpe:
    'Claro 🛠️ ¿Podrías enviarme fotos claras de las piezas dañadas? 📸 Con eso podemos orientarte mejor y decirte si requiere hojalatería, pintura o cambio de pieza.',
  banio_pintura:
    '¡Claro! Con gusto 👨‍🏭. Para darte el precio estimado, ¿qué auto o camioneta tienes? 🚗',
  ubicacion: [
    'Nos ubicamos en *Av. Aztecas 368*, muy cerca de Av. División del Norte y Perisur. 📍',
    '',
    'Google Maps: 👉 https://maps.app.goo.gl/a3tEimJquzaJAwSD9?g_st=ipc',
    '',
    '🕒 Lunes a viernes 9:00–18:00, sábados 9:00–14:00.',
  ].join('\n'),
  agendar_cita: [
    '¡Perfecto! Te agendamos de inmediato. 🚗 Por favor ayúdanos con estos datos:',
    '',
    'Tu nombre',
    '',
    'Modelo de tu auto',
    '',
    'Día y hora en que nos visitas',
    '',
    '⏰ Horarios: Lun a Vie de 9:00 a 18:00 h y Sáb de 9:00 a 14:00 h.',
  ].join('\n'),
};

/** Payloads estables opcionales (si se configuran en Meta). */
const PAYLOAD_TO_INTENT: Record<string, AdButtonIntent> = {
  btn_reparacion_golpe: 'reparacion_golpe',
  reparacion_golpe: 'reparacion_golpe',
  btn_banio_pintura: 'banio_pintura',
  banio_pintura: 'banio_pintura',
  bano_pintura: 'banio_pintura',
  btn_ubicacion: 'ubicacion',
  ubicacion: 'ubicacion',
  btn_agendar_cita: 'agendar_cita',
  agendar_cita: 'agendar_cita',
};

/** Etiquetas de botón normalizadas (sin emojis / acentos) → intención. */
const LABEL_TO_INTENT: Record<string, AdButtonIntent> = {
  'reparacion golpe': 'reparacion_golpe',
  'bano de pintura': 'banio_pintura',
  ubicacion: 'ubicacion',
  'agendar cita': 'agendar_cita',
};

/** Quita emojis / símbolos decorativos típicos de CTAs de ads. */
export function stripAdButtonDecorations(raw: string): string {
  return String(raw ?? '')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/[🛠️🎨📍🏁👉🕒⏰]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeAdButtonKey(raw: string): string {
  return normalizeTextForMatch(stripAdButtonDecorations(raw));
}

function intentFromPayload(payload: string): AdButtonIntent | null {
  const key = normalizeAdButtonKey(payload).replace(/[\s-]+/g, '_');
  if (!key) return null;
  return PAYLOAD_TO_INTENT[key] ?? null;
}

function intentFromLabelText(text: string): AdButtonIntent | null {
  const key = normalizeAdButtonKey(text);
  if (!key) return null;
  // Solo match exacto: evita "Baño de pintura para un Jetta".
  return LABEL_TO_INTENT[key] ?? null;
}

/**
 * Detecta si el mensaje entrante es un click puro de botón de publicidad.
 * Prioriza `payload` / id de Meta; cae a texto visible (título del botón).
 */
export function matchAdButtonAutoReply(input: {
  text?: string | null;
  payload?: string | null;
}): AdButtonAutoReplyMatch | null {
  const payload = String(input.payload ?? '').trim();
  if (payload) {
    const fromPayload = intentFromPayload(payload);
    if (fromPayload) {
      return {
        intent: fromPayload,
        reply: AD_BUTTON_AUTO_REPLIES[fromPayload],
        matchedVia: 'payload',
      };
    }
    // Payload desconocido pero igual al título de un botón.
    const fromPayloadAsLabel = intentFromLabelText(payload);
    if (fromPayloadAsLabel) {
      return {
        intent: fromPayloadAsLabel,
        reply: AD_BUTTON_AUTO_REPLIES[fromPayloadAsLabel],
        matchedVia: 'payload',
      };
    }
  }

  const text = String(input.text ?? '').trim();
  if (!text) return null;
  const fromText = intentFromLabelText(text);
  if (!fromText) return null;
  return {
    intent: fromText,
    reply: AD_BUTTON_AUTO_REPLIES[fromText],
    matchedVia: 'text',
  };
}

/** True si todos los textos del lote mapean a la misma intención de botón. */
export function matchAdButtonAutoReplyForBatch(
  texts: readonly string[],
): AdButtonAutoReplyMatch | null {
  if (!texts.length) return null;
  let first: AdButtonAutoReplyMatch | null = null;
  for (const t of texts) {
    const hit = matchAdButtonAutoReply({ text: t });
    if (!hit) return null;
    if (!first) {
      first = hit;
      continue;
    }
    if (hit.intent !== first.intent) return null;
  }
  return first;
}
