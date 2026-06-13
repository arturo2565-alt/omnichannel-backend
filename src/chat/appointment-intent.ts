import OpenAI from 'openai';
import { openAiChatCompletionParams } from './openai-model-config';

/** Zona del taller para interpretar «mañana» y validar día/hora */
export const WORKSHOP_TIMEZONE = 'America/Mexico_City';

/**
 * Fragmento para system prompts: instante del servidor (ISO UTC en UTC + calendario legible en inglés en zona del taller).
 * Necesario para interpretar «este miércoles», mañana, etc.
 *
 * @param now Por defecto `new Date()`; en tests puedes fijar el instante de referencia.
 */
export function buildLlmServerTimeSystemPrefix(now = new Date()): string {
  const isoUtc = now.toISOString();
  const humanWorkshop = now.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: WORKSHOP_TIMEZONE,
    timeZoneName: 'short',
  });
  return [
    `Current time is ${humanWorkshop} (workshop calendar in ${WORKSHOP_TIMEZONE}).`,
    `Server instant ISO 8601 (UTC): ${isoUtc}.`,
    `Treat these lines as authoritative “now” when resolving relative dates (“this Wednesday”, “tomorrow”, “este miércoles”).`,
  ].join('\n');
}

export type AppointmentIntentResult = {
  isBookingIntent: boolean;
  /** ISO 8601 del turno confirmado solo si pasa validación de horario del taller */
  confirmedDate?: string;
  needsClarification: boolean;
};

type LlmExtract = {
  isBookingIntent: boolean;
  /** mañana | hoy | pasado_mañana | explicit | unknown */
  relativeDay?: string | null;
  /** YYYY-MM-DD si el usuario dio fecha concreta */
  explicitDateYmd?: string | null;
  hour24?: number | null;
  minute?: number | null;
  needsClarification?: boolean;
};

function ymdInTimezone(d: Date, timeZone: string): string {
  return d.toLocaleDateString('en-CA', { timeZone });
}

function addCalendarDaysYmd(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const u = Date.UTC(y, m - 1, d + delta);
  const nd = new Date(u);
  const yy = nd.getUTCFullYear();
  const mm = String(nd.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(nd.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Día civil ISO (YYYY-MM-DD): weekday 0=Dom … 6=Sáb */
function civilWeekdaySun0(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Instante UTC equivalente a `ymd` HH:mm en México (offset fijo -06 para CDMX post-2022).
 * Evita dependencias extra; suficiente para citas del taller en MX central.
 */
function mexicoCityLocalToUtc(
  ymd: string,
  hour: number,
  minute: number,
): Date | null {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return null;
  }
  const OFF_H = 6;
  const utcH = hour + OFF_H;
  const utcMin = minute;
  return new Date(Date.UTC(y, m - 1, d, utcH, utcMin, 0, 0));
}

/** Hora y minuto en {@link WORKSHOP_TIMEZONE} (24 h). */
export function workshopLocalHourMinute(
  instant: Date,
): { hour: number; minute: number } | null {
  if (Number.isNaN(instant.getTime())) return null;
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: WORKSHOP_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);
  const m = /^(\d{1,2}):(\d{2})$/.exec(formatted);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  return { hour, minute };
}

function isWithinBusinessHours(
  ymd: string,
  hour: number,
  minute: number,
): boolean {
  const dow = civilWeekdaySun0(ymd);
  const mins = hour * 60 + minute;

  if (dow === 0) return false;

  if (dow >= 1 && dow <= 5) {
    const open = 9 * 60;
    const close = 18 * 60;
    return mins >= open && mins < close;
  }

  if (dow === 6) {
    const open = 9 * 60;
    const close = 14 * 60;
    return mins >= open && mins <= close;
  }

  return false;
}

const NAIVE_WORKSHOP_ISO_RE =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,3})?$/;

function hasExplicitTimezoneInIso(iso: string): boolean {
  const s = iso.trim();
  return /(?:Z|z|[+-]\d{2}:?\d{2})$/.test(s);
}

function formatHm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const WEEKDAY_NAMES_ES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;

/**
 * Interpreta `scheduledAtIso` para createAppointment.
 * Sin zona horaria explícita → hora civil en {@link WORKSHOP_TIMEZONE} (evita que un servidor UTC trate 14:00 como UTC).
 */
export function parseWorkshopScheduledAtIso(
  iso: string,
):
  | { ok: true; date: Date }
  | { ok: false; error: string } {
  const s = String(iso ?? '').trim();
  if (!s) {
    return {
      ok: false,
      error:
        'Falta scheduledAtIso. Ejemplo para cita a las 14:00 en CDMX: 2026-05-26T14:00:00 (sin sufijo Z) o 2026-05-26T20:00:00.000Z.',
    };
  }

  if (!hasExplicitTimezoneInIso(s)) {
    const m = NAIVE_WORKSHOP_ISO_RE.exec(s);
    if (!m) {
      return {
        ok: false,
        error:
          'Formato no reconocido. Usa YYYY-MM-DDTHH:mm interpretado en America/Mexico_City sin Z (ej. 2026-05-26T14:00:00), o ISO con offset -06:00.',
      };
    }
    const ymd = m[1];
    const hour = Number(m[2]);
    const minute = Number(m[3]);
    const second = m[4] != null ? Number(m[4]) : 0;
    if (
      !Number.isFinite(hour) ||
      hour < 0 ||
      hour > 23 ||
      !Number.isFinite(minute) ||
      minute < 0 ||
      minute > 59 ||
      !Number.isFinite(second) ||
      second < 0 ||
      second > 59
    ) {
      return {
        ok: false,
        error: `Hora inválida en scheduledAtIso (${m[2]}:${m[3]}). Use hora 24 h entre 00:00 y 23:59.`,
      };
    }
    const utc = mexicoCityLocalToUtc(ymd, hour, minute);
    if (!utc || Number.isNaN(utc.getTime())) {
      return {
        ok: false,
        error: `Fecha civil inválida en scheduledAtIso: ${ymd}.`,
      };
    }
    if (second > 0) {
      utc.setUTCSeconds(second, 0);
    }
    return { ok: true, date: utc };
  }

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    return {
      ok: false,
      error: `No se pudo interpretar scheduledAtIso "${s}". Verifica ISO 8601; para 14:00 en CDMX sin offset: 2026-05-26T14:00:00.`,
    };
  }
  return { ok: true, date: d };
}

const NAIVE_ISO_HOUR_COERCE_RE =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,3})?$/;

/**
 * Igual que {@link parseWorkshopScheduledAtIso} pero si la hora 01:00–07:59
 * cae fuera de horario y +12h sí es válido, asume tarde (ej. 03:30 → 15:30).
 */
export function parseWorkshopScheduledAtIsoForBooking(
  iso: string,
):
  | { ok: true; date: Date; coercedFromPmAmbiguity?: boolean }
  | { ok: false; error: string } {
  const first = parseWorkshopScheduledAtIso(iso);
  if (!first.ok) return first;

  const slot = validateWorkshopSlotUtcDetailed(first.date);
  if (slot.valid) {
    return { ok: true, date: first.date };
  }

  const s = String(iso ?? '').trim();
  if (hasExplicitTimezoneInIso(s)) {
    return { ok: false, error: slot.error };
  }

  const m = NAIVE_ISO_HOUR_COERCE_RE.exec(s);
  if (!m) {
    return { ok: false, error: slot.error };
  }

  const ymd = m[1]!;
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (
    !Number.isFinite(hour) ||
    hour < 1 ||
    hour > 7 ||
    !Number.isFinite(minute)
  ) {
    return { ok: false, error: slot.error };
  }

  const pmHour = hour + 12;
  if (!isWithinBusinessHours(ymd, pmHour, minute)) {
    return { ok: false, error: slot.error };
  }

  const utc = mexicoCityLocalToUtc(ymd, pmHour, minute);
  if (!utc || Number.isNaN(utc.getTime())) {
    return { ok: false, error: slot.error };
  }

  return { ok: true, date: utc, coercedFromPmAmbiguity: true };
}

function parseLlmJson(content: string): LlmExtract {
  try {
    const o = JSON.parse(content) as Record<string, unknown>;
    return {
      isBookingIntent: Boolean(o['isBookingIntent']),
      relativeDay:
        typeof o['relativeDay'] === 'string' ? o['relativeDay'] : null,
      explicitDateYmd:
        typeof o['explicitDateYmd'] === 'string' ? o['explicitDateYmd'] : null,
      hour24:
        typeof o['hour24'] === 'number' && Number.isFinite(o['hour24'])
          ? o['hour24']
          : null,
      minute:
        typeof o['minute'] === 'number' && Number.isFinite(o['minute'])
          ? o['minute']
          : null,
      needsClarification:
        typeof o['needsClarification'] === 'boolean'
          ? o['needsClarification']
          : undefined,
    };
  } catch {
    return { isBookingIntent: false };
  }
}

/**
 * Interpreta si el texto es intención de agendar cita y extrae fecha/hora usando OpenAI.
 *
 * - «Mañana» → fecha civil en {@link WORKSHOP_TIMEZONE} = día de `referenceDate` + 1.
 * - Horario: L–V 9:00–18:00, Sáb 9:00–14:00, Dom cerrado.
 *
 * Firma: `parseAppointmentIntent(text, referenceDate)`. Usa `OPENAI_API_KEY`.
 * El tercer argumento opcional permite inyectar el cliente OpenAI en tests.
 *
 * @param text Mensaje del cliente
 * @param referenceDate Fecha/hora de referencia («hoy» / base para «mañana»)
 */
export async function parseAppointmentIntent(
  text: string,
  referenceDate: Date,
  openaiClient?: OpenAI,
): Promise<AppointmentIntentResult> {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    return { isBookingIntent: false, needsClarification: false };
  }

  const openai =
    openaiClient ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const refYmd = ymdInTimezone(referenceDate, WORKSHOP_TIMEZONE);
  const refIso = referenceDate.toISOString();

  const completion = await openai.chat.completions.create({
    ...openAiChatCompletionParams({ tier: 'fast', maxOutputTokens: 400 }),
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `${buildLlmServerTimeSystemPrefix(referenceDate)}

Eres un extractor de intención de CITA / AGENDAR para un taller automotriz en México (zona horaria ${WORKSHOP_TIMEZONE}).

Devuelve SOLO un JSON con esta forma:
{
  "isBookingIntent": boolean,
  "relativeDay": "mañana" | "hoy" | "pasado_mañana" | "explicit" | "unknown" | null,
  "explicitDateYmd": "YYYY-MM-DD" | null,
  "hour24": number | null,
  "minute": number | null,
  "needsClarification": boolean
}

Reglas:
- isBookingIntent = true solo si el usuario quiere RESERVAR / AGENDAR / CITA / VISITA / PASAR / VER AL TALLER / QUE LO ATIENDAN en fecha u hora (incluye \"¿tienen el martes?\", \"¿me agendan mañana a las 10?\").
- Si solo pregunta si trabajan fines de semana sin pedir cita concreta, isBookingIntent puede ser false.
- Si dice \"mañana\", relativeDay debe ser \"mañana\" (la fecha exacta la calcula el servidor sumando 1 día civil al día de referencia en ${WORKSHOP_TIMEZONE}).
- Si da día de la semana (lunes…domingo) sin fecha numérica, pon explicitDateYmd al próximo día con ese nombre en el calendario del taller (respecto a la fecha de referencia).
- hour24 y minute en formato 24h. Si el cliente dice "3:30" o "3:30 pm" para una cita de taller, interpreta como tarde (15:30) salvo que diga explícitamente AM/mañana.
- Si no indicó hora, null en ambos.
- needsClarification true si falta hora o hay ambigüedad fuerte (ej. \"algún día esta semana\" sin más datos).`,
      },
      {
        role: 'user',
        content: `Fecha/hora de referencia (ISO): ${refIso}\nDía civil actual en ${WORKSHOP_TIMEZONE}: ${refYmd}\n\nMensaje del cliente:\n"""${trimmed}"""`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  const ext = parseLlmJson(raw);

  if (!ext.isBookingIntent) {
    return { isBookingIntent: false, needsClarification: false };
  }

  let needsClarification = Boolean(ext.needsClarification);

  const relRaw = String(ext.relativeDay ?? '').trim();
  const rel = relRaw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  let targetYmd: string | null = null;

  const explicitOk =
    ext.explicitDateYmd &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(ext.explicitDateYmd).trim());

  if (explicitOk) {
    targetYmd = String(ext.explicitDateYmd).trim();
  } else if (rel.includes('pasado') && rel.includes('manana')) {
    targetYmd = addCalendarDaysYmd(refYmd, 2);
  } else if (rel.includes('manana')) {
    targetYmd = addCalendarDaysYmd(refYmd, 1);
  } else if (rel === 'hoy' || rel.includes('hoy')) {
    targetYmd = refYmd;
  } else {
    needsClarification = true;
  }

  let hour =
    ext.hour24 != null &&
    Number.isFinite(ext.hour24) &&
    ext.hour24 >= 0 &&
    ext.hour24 <= 23
      ? Math.floor(ext.hour24)
      : null;
  const minute =
    ext.minute != null &&
    Number.isFinite(ext.minute) &&
    ext.minute >= 0 &&
    ext.minute <= 59
      ? Math.floor(ext.minute)
      : null;

  if (hour === null || minute === null) {
    needsClarification = true;
  }

  if (
    targetYmd &&
    hour !== null &&
    minute !== null &&
    hour >= 1 &&
    hour <= 7 &&
    !isWithinBusinessHours(targetYmd, hour, minute) &&
    hour + 12 <= 23 &&
    isWithinBusinessHours(targetYmd, hour + 12, minute)
  ) {
    hour = hour + 12;
  }

  if (!targetYmd || hour === null || minute === null) {
    return {
      isBookingIntent: true,
      needsClarification: true,
    };
  }

  if (!isWithinBusinessHours(targetYmd, hour, minute)) {
    return {
      isBookingIntent: true,
      needsClarification: true,
    };
  }

  const utc = mexicoCityLocalToUtc(targetYmd, hour, minute);
  if (!utc || Number.isNaN(utc.getTime())) {
    return { isBookingIntent: true, needsClarification: true };
  }

  return {
    isBookingIntent: true,
    confirmedDate: utc.toISOString(),
    needsClarification: false,
  };
}

export type WorkshopSlotValidation =
  | { valid: true; ymd: string; hour: number; minute: number }
  | { valid: false; error: string };

/**
 * Valida que un instante UTC cae dentro del horario del taller en {@link WORKSHOP_TIMEZONE}
 * (L–V 09:00–18:00, Sáb 09:00–14:00 inclusive, Dom cerrado).
 */
export function validateWorkshopSlotUtcDetailed(
  instant: Date,
): WorkshopSlotValidation {
  if (Number.isNaN(instant.getTime())) {
    return {
      valid: false,
      error: 'Fecha u hora no válida (instante NaN).',
    };
  }
  const ymd = ymdInTimezone(instant, WORKSHOP_TIMEZONE);
  const hm = workshopLocalHourMinute(instant);
  if (!hm) {
    return {
      valid: false,
      error: `No se pudo leer la hora en ${WORKSHOP_TIMEZONE} para validar el turno.`,
    };
  }
  const { hour, minute } = hm;
  if (isWithinBusinessHours(ymd, hour, minute)) {
    return { valid: true, ymd, hour, minute };
  }

  const dow = civilWeekdaySun0(ymd);
  const hmLabel = formatHm(hour, minute);
  const dayLabel = WEEKDAY_NAMES_ES[dow] ?? 'día';

  if (dow === 0) {
    return {
      valid: false,
      error: `Domingo ${ymd} (${WORKSHOP_TIMEZONE}): el taller está cerrado. Propón lunes a viernes 09:00–18:00 o sábado 09:00–14:00.`,
    };
  }

  if (dow === 6) {
    return {
      valid: false,
      error: `Sábado ${ymd} a las ${hmLabel} (${WORKSHOP_TIMEZONE}) está fuera de horario. Sábados solo 09:00–14:00 (la cita de las 14:00 sí es válida).`,
    };
  }

  const hintUtcMisread =
    hour < 9
      ? ` Si enviaste scheduledAtIso con sufijo Z, recuerda que 14:00Z son las ${hmLabel} en CDMX, no las 14:00 locales. Para cita a las 14:00 en CDMX usa 2026-05-26T14:00:00 sin Z o el equivalente UTC.`
      : '';

  return {
    valid: false,
    error: `${dayLabel} ${ymd} a las ${hmLabel} (${WORKSHOP_TIMEZONE}) está fuera de horario. Lunes a viernes: 09:00–18:00 (última cita antes de las 18:00).${hintUtcMisread}`,
  };
}

/**
 * @deprecated preferir {@link validateWorkshopSlotUtcDetailed}
 */
export function validateWorkshopSlotUtc(instant: Date): boolean {
  return validateWorkshopSlotUtcDetailed(instant).valid;
}
