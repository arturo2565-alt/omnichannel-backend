import OpenAI from 'openai';

/** Zona del taller para interpretar «mañana» y validar día/hora */
export const WORKSHOP_TIMEZONE = 'America/Mexico_City';

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
    return mins >= open && mins < close;
  }

  return false;
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
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Eres un extractor de intención de CITA / AGENDAR para un taller automotriz en México (zona horaria ${WORKSHOP_TIMEZONE}).

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
- Si da día de la semana o fecha explícita, usa explicitDateYmd cuando puedas (año actual implícito si no lo dice; usa la fecha de referencia ${refIso} como guía).
- hour24 y minute en formato 24h; si no indicó hora, null en ambos.
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

  const hour =
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
