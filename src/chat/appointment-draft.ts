import { STAGING_TALLER_ID } from '../config/staging-synthetic';
import {
  hasWhatsAppWaId,
  isUsableAppointmentClientName,
  isUsableAppointmentPhone,
  isUsableAppointmentVehicle,
} from './appointment-client-guard';
import {
  WORKSHOP_TIMEZONE,
  addCalendarDaysYmd,
  civilWeekdaySun0,
  mexicoCityLocalToUtc,
  validateWorkshopSlotUtcDetailed,
  workshopLocalHourMinute,
  ymdInTimezone,
} from './appointment-intent';
import {
  formatAppointmentConfirmedMessage,
  stripAppointmentConfirmationClaims,
  textClaimsAppointmentBooked,
} from './appointment-scheduling-helpers';

/**
 * Aceptación abierta de AutoFix: cualquier horario futuro dentro de su atención,
 * sin cupo. No se aplica a otros talleres.
 */
export type WorkshopAppointmentPolicy = {
  id: 'autofix_open' | 'other';
  openAcceptance: boolean;
};

export type TrackedText = {
  value: string;
  source: 'client' | 'channel' | 'whatsapp' | 'vision';
  confirmed: boolean;
};

export type AppointmentScheduleStatus =
  | 'missing'
  | 'valid'
  | 'past'
  | 'outside_hours'
  | 'closed'
  | 'recorded';

export type AppointmentDraft = {
  clientName: TrackedText | null;
  phone: TrackedText | null;
  vehicleIdentity: TrackedText | null;
  /** Instante interpretado, aunque no se pueda agendar. */
  interpretedDateTime: string | null;
  /** Instante futuro y válido para AutoFix. */
  requestedDateTime: string | null;
  receptionAt: string | null;
  timeZone: typeof WORKSHOP_TIMEZONE;
  scheduleStatus: AppointmentScheduleStatus;
  availabilityStatus:
    | 'unknown'
    | 'accepted_open_hours'
    | 'unverified_other_workshop';
  appointmentStatus: 'draft' | 'confirmed' | 'rescheduled';
  appointmentId: string | null;
  offeredSlots: string[];
  /** El cliente pidió visita o dio una pista de horario. */
  wantsVisit: boolean;
};

export const APPOINTMENT_ASK_NAME = '¿Con qué nombre registro la cita?';
export const APPOINTMENT_ASK_PHONE = '¿A qué teléfono te aviso de la cita?';

const WEEKDAY_INDEX: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};

const WEEKDAY_LABEL = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
];

const MONTH_LABEL = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

const DAY_HOUR_REASK =
  /d[ií]a y la hora|confirmas el d[ií]a|qu[eé] d[ií]a y hora|hora exacta/i;

export function emptyAppointmentDraft(): AppointmentDraft {
  return {
    clientName: null,
    phone: null,
    vehicleIdentity: null,
    interpretedDateTime: null,
    requestedDateTime: null,
    receptionAt: null,
    timeZone: WORKSHOP_TIMEZONE,
    scheduleStatus: 'missing',
    availabilityStatus: 'unknown',
    appointmentStatus: 'draft',
    appointmentId: null,
    offeredSlots: [],
    wantsVisit: false,
  };
}

export function parseAppointmentDraft(raw: unknown): AppointmentDraft {
  const base = emptyAppointmentDraft();
  if (!raw || typeof raw !== 'object') return base;
  const row = raw as Partial<AppointmentDraft>;
  return {
    ...base,
    clientName: trackedOrNull(row.clientName),
    phone: trackedOrNull(row.phone),
    vehicleIdentity: trackedOrNull(row.vehicleIdentity),
    interpretedDateTime: isoOrNull(row.interpretedDateTime),
    requestedDateTime: isoOrNull(row.requestedDateTime),
    receptionAt: isoOrNull(row.receptionAt),
    timeZone: WORKSHOP_TIMEZONE,
    scheduleStatus: isScheduleStatus(row.scheduleStatus)
      ? row.scheduleStatus
      : base.scheduleStatus,
    availabilityStatus:
      row.availabilityStatus === 'accepted_open_hours' ||
      row.availabilityStatus === 'unverified_other_workshop'
        ? row.availabilityStatus
        : 'unknown',
    appointmentStatus:
      row.appointmentStatus === 'confirmed' ||
      row.appointmentStatus === 'rescheduled'
        ? row.appointmentStatus
        : 'draft',
    appointmentId:
      typeof row.appointmentId === 'string' && row.appointmentId.trim()
        ? row.appointmentId
        : null,
    offeredSlots: Array.isArray(row.offeredSlots)
      ? row.offeredSlots.filter((slot) => typeof slot === 'string')
      : [],
    wantsVisit: row.wantsVisit === true,
  };
}

export function resolveWorkshopAppointmentPolicy(taller: {
  id?: string | null;
  nombre?: string | null;
}): WorkshopAppointmentPolicy {
  const id = String(taller.id ?? '').trim().toLowerCase();
  const nombre = fold(String(taller.nombre ?? ''));
  if (
    id === STAGING_TALLER_ID ||
    nombre === 'taller de ensayo' ||
    nombre.includes('autofix')
  ) {
    return { id: 'autofix_open', openAcceptance: true };
  }
  return { id: 'other', openAcceptance: false };
}

export function absorbClientMessage(
  draft: AppointmentDraft,
  input: {
    text: string;
    receivedAt: Date;
    policy: WorkshopAppointmentPolicy;
    platform?: string | null;
    externalId?: string | null;
    contactPhone?: string | null;
    contactName?: string | null;
    vehicle?: { label: string; source: 'client' | 'vision' } | null;
  },
): AppointmentDraft {
  let next = cloneDraft(draft);
  next = applyChannelIdentity(next, input);
  const declaredName = extractDeclaredName(input.text);
  if (declaredName) {
    next.clientName = {
      value: declaredName,
      source: 'client',
      confirmed: true,
    };
  }
  const declaredPhone = extractDeclaredPhone(input.text);
  if (declaredPhone) {
    next.phone = {
      value: declaredPhone,
      source: 'client',
      confirmed: true,
    };
  }
  const declaredVehicle = extractDeclaredVehicle(input.text);
  if (declaredVehicle) {
    next = applyVehicle(next, {
      label: declaredVehicle,
      source: 'client',
    });
  }
  if (input.vehicle?.label) {
    next = applyVehicle(next, input.vehicle);
  }
  if (mentionsVisit(fold(input.text))) next.wantsVisit = true;

  const schedule = interpretSchedulePhrase(input.text, input.receivedAt);
  if (schedule.kind === 'instant') {
    next = rememberInterpretedInstant(
      next,
      schedule.instant,
      input.receivedAt,
      input.policy,
    );
  } else if (schedule.kind === 'partial') {
    next.requestedDateTime = null;
    next.interpretedDateTime = null;
    next.scheduleStatus = 'missing';
    next.availabilityStatus = input.policy.openAcceptance
      ? 'unknown'
      : 'unverified_other_workshop';
    next.receptionAt = input.receivedAt.toISOString();
    next.offeredSlots = [];
  }
  return next;
}

export function applyVehicle(
  draft: AppointmentDraft,
  vehicle: { label: string; source: 'client' | 'vision' },
): AppointmentDraft {
  const label = String(vehicle.label ?? '').trim().slice(0, 120);
  if (!label || !isUsableAppointmentVehicle(label)) return draft;
  const next = cloneDraft(draft);
  if (
    vehicle.source === 'vision' &&
    next.vehicleIdentity?.source === 'client' &&
    next.vehicleIdentity.confirmed
  ) {
    return next;
  }
  next.vehicleIdentity = {
    value: label,
    source: vehicle.source,
    confirmed: vehicle.source === 'client',
  };
  return next;
}

/** Texto al cliente. La inferencia de visión no se nombra como auto confirmado. */
export function confirmedVehicleLabel(draft: AppointmentDraft): string | null {
  if (draft.vehicleIdentity?.confirmed && draft.vehicleIdentity.source === 'client') {
    return draft.vehicleIdentity.value;
  }
  return null;
}

export function rememberInterpretedInstant(
  draft: AppointmentDraft,
  instant: Date,
  receivedAt: Date,
  policy: WorkshopAppointmentPolicy,
): AppointmentDraft {
  const next = cloneDraft(draft);
  const sameInstant =
    next.requestedDateTime != null &&
    new Date(next.requestedDateTime).getTime() === instant.getTime();
  if (sameInstant && next.receptionAt) {
    return next;
  }
  next.receptionAt = receivedAt.toISOString();
  next.timeZone = WORKSHOP_TIMEZONE;
  next.interpretedDateTime = instant.toISOString();
  next.offeredSlots = [];
  if (!policy.openAcceptance) {
    next.requestedDateTime = instant.toISOString();
    next.scheduleStatus = 'recorded';
    next.availabilityStatus = 'unverified_other_workshop';
    return next;
  }
  if (instant.getTime() <= receivedAt.getTime()) {
    next.requestedDateTime = null;
    next.scheduleStatus = 'past';
    next.availabilityStatus = 'unknown';
    return next;
  }
  const slot = validateWorkshopSlotUtcDetailed(instant);
  if (!slot.valid) {
    next.requestedDateTime = null;
    const ymd = ymdInTimezone(instant, WORKSHOP_TIMEZONE);
    next.scheduleStatus = civilWeekdaySun0(ymd) === 0 ? 'closed' : 'outside_hours';
    next.availabilityStatus = 'unknown';
    return next;
  }
  next.requestedDateTime = instant.toISOString();
  next.scheduleStatus = 'valid';
  next.availabilityStatus = 'accepted_open_hours';
  return next;
}

export function upcomingOpenSlots(from: Date, count = 2): Date[] {
  const startYmd = ymdInTimezone(from, WORKSHOP_TIMEZONE);
  const found: Date[] = [];
  for (let day = 0; day < 21 && found.length < count; day += 1) {
    const ymd = addCalendarDaysYmd(startYmd, day);
    const dow = civilWeekdaySun0(ymd);
    if (dow === 0) continue;
    const lastHour = dow === 6 ? 14 : 17;
    for (let hour = 9; hour <= lastHour && found.length < count; hour += 1) {
      const utc = mexicoCityLocalToUtc(ymd, hour, 0);
      if (!utc || utc.getTime() <= from.getTime()) continue;
      if (!validateWorkshopSlotUtcDetailed(utc).valid) continue;
      found.push(utc);
    }
  }
  return found;
}

export function formatWorkshopSlot(instant: Date): string {
  const ymd = ymdInTimezone(instant, WORKSHOP_TIMEZONE);
  const hm = workshopLocalHourMinute(instant);
  const day = Number(ymd.slice(8, 10));
  const month = MONTH_LABEL[Number(ymd.slice(5, 7)) - 1] ?? '';
  const weekday = WEEKDAY_LABEL[civilWeekdaySun0(ymd)] ?? '';
  const hh = String(hm?.hour ?? 0).padStart(2, '0');
  const mm = String(hm?.minute ?? 0).padStart(2, '0');
  return `${weekday} ${day} de ${month} a las ${hh}:${mm}`;
}

export type BookingReadiness = {
  ready: boolean;
  missing: Array<'clientName' | 'phone' | 'requestedDateTime'>;
  question: string | null;
};

export function bookingReadiness(
  draft: AppointmentDraft,
  policy: WorkshopAppointmentPolicy,
  now: Date,
  channel: { platform?: string | null; waId?: string | null },
): BookingReadiness {
  const missing: BookingReadiness['missing'] = [];
  if (!isUsableAppointmentClientName(draft.clientName?.value)) {
    missing.push('clientName');
  }
  const phoneOk =
    isUsableAppointmentPhone(draft.phone?.value) ||
    hasWhatsAppWaId(channel.platform, channel.waId);
  if (!phoneOk) missing.push('phone');
  if (
    !policy.openAcceptance ||
    draft.scheduleStatus !== 'valid' ||
    !draft.requestedDateTime
  ) {
    missing.push('requestedDateTime');
  }
  return {
    ready: missing.length === 0,
    missing,
    question: nextClientQuestion(draft, policy, now, channel),
  };
}

function withoutUnconfirmedVehicle(
  text: string,
  draft: AppointmentDraft,
): string {
  const vehicle = draft.vehicleIdentity;
  if (!text || !vehicle || vehicle.confirmed || vehicle.source === 'client') {
    return text;
  }
  const needle = vehicle.value.toLowerCase();
  if (!needle) return text;
  const kept = text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => !sentence.toLowerCase().includes(needle));
  return kept.join(' ').trim();
}

function mentionsVisit(folded: string): boolean {
  return (
    hasScheduleCue(folded) ||
    /\b(me interesa|agendar|agenda|cita|tienes espacio|hay espacio|visitar|pasamos|pasar al taller)\b/.test(
      folded,
    )
  );
}

export function nextClientQuestion(
  draft: AppointmentDraft,
  policy: WorkshopAppointmentPolicy,
  now: Date,
  channel: { platform?: string | null; waId?: string | null } = {},
): string | null {
  const scheduling =
    draft.wantsVisit ||
    draft.scheduleStatus !== 'missing' ||
    Boolean(draft.interpretedDateTime) ||
    Boolean(draft.requestedDateTime);
  if (!scheduling) return null;
  if (!isUsableAppointmentClientName(draft.clientName?.value)) {
    return APPOINTMENT_ASK_NAME;
  }
  const phoneOk =
    isUsableAppointmentPhone(draft.phone?.value) ||
    hasWhatsAppWaId(channel.platform, channel.waId);
  if (!phoneOk) return APPOINTMENT_ASK_PHONE;
  if (!policy.openAcceptance) {
    if (draft.requestedDateTime || draft.interpretedDateTime) {
      return 'Anoté la fecha y la hora. Este taller no confirma la cita con la aceptación abierta de AutoFix.';
    }
    return '¿Qué día y hora quieres? La confirmación depende de este taller, no de la agenda abierta de AutoFix.';
  }
  if (draft.scheduleStatus === 'valid' && draft.requestedDateTime) {
    return null;
  }
  const slots = upcomingOpenSlots(now, 2);
  const labels = slots.map((slot) => formatWorkshopSlot(slot));
  if (labels.length < 2) {
    return '¿Qué día y hora dentro del horario de atención te queda?';
  }
  const pair = `el ${labels[0]} o el ${labels[1]}`;
  if (draft.scheduleStatus === 'closed') {
    return `El domingo no abrimos. Puedo apartarte ${pair}.`;
  }
  if (draft.scheduleStatus === 'past') {
    return `Esa hora ya pasó. Puedo apartarte ${pair}.`;
  }
  if (draft.scheduleStatus === 'outside_hours') {
    return `Ese horario está fuera de atención. Puedo apartarte ${pair}.`;
  }
  return `Puedo apartarte ${pair}. ¿Cuál prefieres?`;
}

export function withOfferedSlots(
  draft: AppointmentDraft,
  policy: WorkshopAppointmentPolicy,
  now: Date,
): AppointmentDraft {
  if (!policy.openAcceptance) return { ...draft, offeredSlots: [] };
  if (draft.scheduleStatus === 'valid') return { ...draft, offeredSlots: [] };
  return {
    ...draft,
    offeredSlots: upcomingOpenSlots(now, 2).map((slot) => slot.toISOString()),
  };
}

export function currentMessageChangesSchedule(text: string): boolean {
  return hasScheduleCue(fold(text));
}

export function currentMessageSuppliesIdentity(text: string): boolean {
  return Boolean(extractDeclaredName(text) || extractDeclaredPhone(text));
}

export type AppointmentPersistenceDecision = {
  action: 'skip' | 'create' | 'reschedule' | 'unchanged';
  confirmToClient: boolean;
};

/**
 * El historial no se reinterpreta. Solo el mensaje actual puede crear,
 * reagendar o dejar la cita quieta.
 */
export function decideAppointmentPersistence(input: {
  draft: AppointmentDraft;
  activeScheduledAt: string | null;
  currentText: string;
  policy: WorkshopAppointmentPolicy;
  now: Date;
  channel: { platform?: string | null; waId?: string | null };
}): AppointmentPersistenceDecision {
  const schedule = currentMessageChangesSchedule(input.currentText);
  const identity = currentMessageSuppliesIdentity(input.currentText);
  if (!input.policy.openAcceptance) {
    return { action: 'skip', confirmToClient: false };
  }
  if (!schedule && !identity) {
    return {
      action: input.activeScheduledAt ? 'unchanged' : 'skip',
      confirmToClient: false,
    };
  }
  if (!schedule && input.activeScheduledAt) {
    return { action: 'unchanged', confirmToClient: false };
  }
  const ready = bookingReadiness(
    input.draft,
    input.policy,
    input.now,
    input.channel,
  ).ready;
  const plan = planConfirmedWrite({
    activeScheduledAt: input.activeScheduledAt,
    requestedDateTime: input.draft.requestedDateTime,
    ready,
  });
  if (plan.action === 'same') {
    return { action: 'unchanged', confirmToClient: false };
  }
  if (plan.action === 'reschedule') {
    return { action: 'reschedule', confirmToClient: true };
  }
  if (plan.action === 'create') {
    return { action: 'create', confirmToClient: true };
  }
  return { action: 'skip', confirmToClient: false };
}

export function isOneActiveAppointmentConflict(driver: {
  code?: string;
  constraint?: string;
} | null): boolean {
  return (
    driver?.code === '23505' &&
    driver.constraint === 'UQ_appointments_one_active_conversation'
  );
}

export type AppointmentWritePlan = {
  action: 'create' | 'reschedule' | 'same' | 'hold';
  persistAt: string | null;
  previousScheduledAt: string | null;
};

/** La hora nueva no se sustituye por la cita anterior. */
export function planConfirmedWrite(input: {
  activeScheduledAt: string | null;
  requestedDateTime: string | null;
  ready: boolean;
}): AppointmentWritePlan {
  if (!input.ready || !input.requestedDateTime) {
    return { action: 'hold', persistAt: null, previousScheduledAt: input.activeScheduledAt };
  }
  if (!input.activeScheduledAt) {
    return {
      action: 'create',
      persistAt: input.requestedDateTime,
      previousScheduledAt: null,
    };
  }
  const delta = Math.abs(
    new Date(input.activeScheduledAt).getTime() -
      new Date(input.requestedDateTime).getTime(),
  );
  if (delta < 60_000) {
    return {
      action: 'same',
      persistAt: input.activeScheduledAt,
      previousScheduledAt: input.activeScheduledAt,
    };
  }
  return {
    action: 'reschedule',
    persistAt: input.requestedDateTime,
    previousScheduledAt: input.activeScheduledAt,
  };
}

export function guardClientReply(input: {
  modelText: string | null;
  confirmedIso: string | null;
  persisted: boolean;
  draft: AppointmentDraft;
  policy: WorkshopAppointmentPolicy;
  now: Date;
  channel?: { platform?: string | null; waId?: string | null };
}): string {
  const model = withoutUnconfirmedVehicle(
    String(input.modelText ?? '').trim(),
    input.draft,
  );
  const question = nextClientQuestion(
    input.draft,
    input.policy,
    input.now,
    input.channel ?? {},
  );
  if (input.persisted && input.confirmedIso) {
    const confirmation = formatAppointmentConfirmedMessage(input.confirmedIso);
    const stripped = stripAppointmentConfirmationClaims(model);
    if (!stripped || textClaimsAppointmentBooked(model)) return confirmation;
    if (textClaimsAppointmentBooked(stripped)) return stripped;
    return `${stripped}\n\n${confirmation}`;
  }
  const stripped = stripAppointmentConfirmationClaims(model);
  if (!question) return stripped;
  if (
    !stripped ||
    DAY_HOUR_REASK.test(model) ||
    textClaimsAppointmentBooked(model)
  ) {
    return question;
  }
  if (stripped.includes(question)) return stripped;
  return `${stripped}\n\n${question}`;
}

export function formatAppointmentDraftContext(
  draft: AppointmentDraft,
  policy: WorkshopAppointmentPolicy,
  now: Date,
  channel: { platform?: string | null; waId?: string | null } = {},
): string {
  const question = nextClientQuestion(draft, policy, now, channel);
  const vehicle = draft.vehicleIdentity;
  const lines = [
    '[BORRADOR_DE_CITA]',
    `politica: ${policy.id}`,
    `zona: ${draft.timeZone}`,
    `recepcion: ${draft.receptionAt ?? '—'}`,
    `interpretada: ${draft.interpretedDateTime ?? '—'}`,
    `solicitada_valida: ${draft.requestedDateTime ?? '—'}`,
    `horario: ${draft.scheduleStatus}`,
    `nombre: ${draft.clientName?.value ?? 'falta'}`,
    `telefono: ${draft.phone?.value ? 'presente' : 'falta'}`,
    vehicle
      ? `vehiculo: ${vehicle.confirmed ? 'declarado por el cliente' : 'inferido por visión, no confirmado'}`
      : 'vehiculo: sin dato',
    question
      ? `pregunta_unica: ${question}`
      : 'pregunta_unica: ninguna; los datos para registrar ya están',
    'No vuelvas a pedir día y hora si solicitada_valida tiene un instante.',
    'Pregunta solo el dato de pregunta_unica.',
    'No digas que la cita quedó confirmada salvo success:true de createAppointment y una fila persistida.',
    'No presentes un vehículo inferido por visión como confirmado.',
    policy.openAcceptance
      ? 'AutoFix acepta cualquier horario futuro dentro de su atención, sin consultar cupos. No afirmes un cupo consultado.'
      : 'Este taller no usa la aceptación abierta de AutoFix. No confirmes la cita ni ofrezcas horarios calculados de AutoFix.',
  ];
  return lines.join('\n');
}

function applyChannelIdentity(
  draft: AppointmentDraft,
  input: {
    platform?: string | null;
    externalId?: string | null;
    contactPhone?: string | null;
    contactName?: string | null;
  },
): AppointmentDraft {
  const next = cloneDraft(draft);
  if (
    !next.clientName &&
    isUsableAppointmentClientName(input.contactName)
  ) {
    next.clientName = {
      value: String(input.contactName).trim(),
      source: 'channel',
      confirmed: true,
    };
  }
  if (!next.phone && isUsableAppointmentPhone(input.contactPhone)) {
    next.phone = {
      value: String(input.contactPhone).replace(/\s+/g, '').slice(0, 32),
      source: 'channel',
      confirmed: true,
    };
  }
  if (
    !next.phone &&
    hasWhatsAppWaId(input.platform, input.externalId)
  ) {
    next.phone = {
      value: String(input.externalId).replace(/\D/g, '').slice(0, 32),
      source: 'whatsapp',
      confirmed: true,
    };
  }
  return next;
}

function interpretSchedulePhrase(
  text: string,
  receivedAt: Date,
):
  | { kind: 'none' }
  | { kind: 'partial' }
  | { kind: 'instant'; instant: Date } {
  const folded = fold(text);
  if (!hasScheduleCue(folded)) return { kind: 'none' };
  const time = parseHourMinute(folded);
  const ymd = resolveYmd(folded, receivedAt, time);
  if (!ymd) return { kind: 'partial' };
  if (!time) return { kind: 'partial' };
  const instant = mexicoCityLocalToUtc(ymd, time.hour, time.minute);
  if (!instant) return { kind: 'partial' };
  return { kind: 'instant', instant };
}

function hasScheduleCue(folded: string): boolean {
  return (
    /\b(hoy|manana|pasado)\b/.test(folded) ||
    Object.keys(WEEKDAY_INDEX).some((day) => folded.includes(day)) ||
    /\ba las\b/.test(folded) ||
    /\b\d{1,2}\s*(?::\d{2})?\s*(am|pm)\b/.test(folded) ||
    /\b\d{1,2}:\d{2}\b/.test(folded)
  );
}

function resolveYmd(
  folded: string,
  receivedAt: Date,
  time: { hour: number; minute: number } | null,
): string | null {
  const ref = ymdInTimezone(receivedAt, WORKSHOP_TIMEZONE);
  if (folded.includes('pasado') && folded.includes('manana')) {
    return addCalendarDaysYmd(ref, 2);
  }
  if (/\bmanana\b/.test(folded)) return addCalendarDaysYmd(ref, 1);
  if (/\bhoy\b/.test(folded)) return ref;
  for (const [name, dow] of Object.entries(WEEKDAY_INDEX)) {
    if (!folded.includes(name)) continue;
    return nextWeekdayYmd(ref, dow, time, receivedAt);
  }
  return null;
}

function nextWeekdayYmd(
  refYmd: string,
  targetDow: number,
  time: { hour: number; minute: number } | null,
  receivedAt: Date,
): string {
  const current = civilWeekdaySun0(refYmd);
  let delta = (targetDow - current + 7) % 7;
  if (delta === 0 && time) {
    const today = mexicoCityLocalToUtc(refYmd, time.hour, time.minute);
    if (!today || today.getTime() <= receivedAt.getTime()) delta = 7;
  } else if (delta === 0 && !time) {
    delta = 0;
  }
  return addCalendarDaysYmd(refYmd, delta);
}

function parseHourMinute(
  folded: string,
): { hour: number; minute: number } | null {
  const ampm = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(folded);
  const alas = /\ba las\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(folded);
  const clock = /\b(\d{1,2}):(\d{2})\b/.exec(folded);
  const hit = ampm ?? alas ?? clock;
  if (!hit) return null;
  let hour = Number(hit[1]);
  const minute = Number(hit[2] ?? 0);
  const mark = hit[3];
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  if (mark === 'pm' && hour < 12) hour += 12;
  if (mark === 'am' && hour === 12) hour = 0;
  if (!mark && hour >= 1 && hour <= 7) hour += 12;
  return { hour, minute };
}

function extractDeclaredName(text: string): string | null {
  const match =
    /(?:me llamo|mi nombre es|soy)\s+([A-Za-zÁÉÍÓÚÜáéíóúüÑñ]+(?:\s+[A-Za-zÁÉÍÓÚÜáéíóúüÑñ]+){0,3})/i.exec(
      text,
    );
  if (!match) return null;
  const name = match[1]!.trim();
  return isUsableAppointmentClientName(name) ? name : null;
}

function extractDeclaredPhone(text: string): string | null {
  const match = /(\+?\d[\d\s()-]{6,}\d)/.exec(text);
  if (!match) return null;
  const digits = match[1]!.replace(/\D/g, '');
  if (!isUsableAppointmentPhone(digits)) return null;
  return digits.slice(0, 32);
}

function extractDeclaredVehicle(text: string): string | null {
  const match =
    /(?:es un[ao]?|mi (?:auto|carro|coche) es|tengo un[ao]?)\s+([^?.!\n]{2,60})/i.exec(
      text,
    );
  if (!match) return null;
  const label = match[1]!.trim();
  return isUsableAppointmentVehicle(label) ? label : null;
}

function trackedOrNull(value: unknown): TrackedText | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<TrackedText>;
  const text = String(row.value ?? '').trim();
  if (!text) return null;
  const source = row.source;
  if (
    source !== 'client' &&
    source !== 'channel' &&
    source !== 'whatsapp' &&
    source !== 'vision'
  ) {
    return null;
  }
  return { value: text, source, confirmed: row.confirmed === true };
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isScheduleStatus(value: unknown): value is AppointmentScheduleStatus {
  return (
    value === 'missing' ||
    value === 'valid' ||
    value === 'past' ||
    value === 'outside_hours' ||
    value === 'closed' ||
    value === 'recorded'
  );
}

function cloneDraft(draft: AppointmentDraft): AppointmentDraft {
  return {
    ...draft,
    clientName: draft.clientName ? { ...draft.clientName } : null,
    phone: draft.phone ? { ...draft.phone } : null,
    vehicleIdentity: draft.vehicleIdentity ? { ...draft.vehicleIdentity } : null,
    offeredSlots: [...draft.offeredSlots],
    wantsVisit: draft.wantsVisit,
  };
}

function fold(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}
