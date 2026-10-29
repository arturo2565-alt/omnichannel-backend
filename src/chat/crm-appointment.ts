import type { AppointmentStatus } from './entities/appointment.entity';
import { isUsableAppointmentClientName, isUsableAppointmentPhone } from './appointment-client-guard';
import {
  parseServiceLines,
  pesosFromCents,
  serviceSummary,
  type ParsedServiceLine,
} from './crm-money';

export const PROSPECT_ORIGINS = [
  'facebook',
  'instagram',
  'google',
  'recomendacion',
  'recurrente',
  'otro',
  'desconocido',
] as const;

export type ProspectOrigin = (typeof PROSPECT_ORIGINS)[number];

export const ATTRIBUTION_KINDS = ['manual', 'verified', 'unknown'] as const;
export type AttributionKind = (typeof ATTRIBUTION_KINDS)[number];

export type CrmServiceLine = {
  id: string;
  name: string;
  quantityHundredths: number;
  unitPriceCents: number;
  subtotalCents: number;
};

export const VISIT_STATUSES = [
  'agendada',
  'realizada',
  'cancelada',
  'no_asistio',
] as const;

export type VisitStatus = (typeof VISIT_STATUSES)[number];

export const APPOINTMENT_SOURCES = ['manual', 'autopilot'] as const;
export type AppointmentSource = (typeof APPOINTMENT_SOURCES)[number];

const MAX_MONEY = 10_000_000;

export type AppointmentListItem = {
  id: string;
  clientName: string;
  vehicle: string | null;
  phone: string | null;
  quoteSummary: string | null;
  scheduledAt: string;
  status: AppointmentStatus;
  visitStatus: VisitStatus;
  conversationId: string | null;
  tallerId: string | null;
  contactId: string | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleYear: number | null;
  serviceRequested: string | null;
  quotedAmount: number | null;
  quotedTotalCents: number | null;
  lines: CrmServiceLine[];
  origin: ProspectOrigin | null;
  campaignName: string | null;
  adName: string | null;
  adExternalId: string | null;
  attributionKind: AttributionKind | null;
  notes: string | null;
  source: AppointmentSource | null;
  contractedAmount: number | null;
};

export type AppointmentRealtimePayload = {
  id: string;
  conversationId: string | null;
  clientName: string;
  vehicle: string | null;
  phone: string | null;
  quoteSummary: string | null;
  scheduledAt: string;
  status: string;
  visitStatus: VisitStatus;
  tallerId: string;
  source: AppointmentSource | null;
};

export function appointmentSocketRoom(
  tallerId: string | null | undefined,
): string | null {
  const id = String(tallerId ?? '').trim();
  if (!id) return null;
  return `taller:${id}`;
}

export function dbStatusToVisit(status: string | null | undefined): VisitStatus {
  switch (String(status ?? '').trim().toLowerCase()) {
    case 'finalizada':
    case 'realizada':
      return 'realizada';
    case 'cancelada':
      return 'cancelada';
    case 'no_asistio':
      return 'no_asistio';
    default:
      return 'agendada';
  }
}

export function visitToDbStatus(visit: string): AppointmentStatus | null {
  switch (String(visit ?? '').trim().toLowerCase()) {
    case 'agendada':
    case 'confirmada':
    case 'pendiente':
      return 'confirmada';
    case 'realizada':
    case 'finalizada':
      return 'finalizada';
    case 'cancelada':
      return 'cancelada';
    case 'no_asistio':
      return 'no_asistio';
    default:
      return null;
  }
}

export function resolveAppointmentDbStatus(body: {
  status?: string;
  visitStatus?: string;
}): AppointmentStatus | null {
  const visit = String(body.visitStatus ?? '').trim();
  if (visit) return visitToDbStatus(visit);
  return visitToDbStatus(String(body.status ?? ''));
}

export function isAppointmentVisibleToTaller(
  appointment: { tallerId?: string | null },
  conversation: { tallerId?: string | null } | null | undefined,
  tallerId: string,
): boolean {
  const requested = String(tallerId ?? '').trim();
  if (!requested) return false;
  const own = String(appointment.tallerId ?? '').trim();
  if (own) return own === requested;
  const viaConversation = String(conversation?.tallerId ?? '').trim();
  return Boolean(viaConversation) && viaConversation === requested;
}

export function shouldAttemptAppointmentReminder(input: {
  status?: string | null;
  conversationId?: string | null;
}): boolean {
  if (String(input.status ?? '').trim() !== 'confirmada') return false;
  return Boolean(String(input.conversationId ?? '').trim());
}

export function normalizePhoneDigits(phone: unknown): string {
  return String(phone ?? '').replace(/\D/g, '').slice(0, 20);
}

export function crmContactExternalId(phoneDigits: string): string {
  return `crm:${phoneDigits}`;
}

export function phoneSuffix(phoneDigits: string): string {
  return phoneDigits.length <= 10 ? phoneDigits : phoneDigits.slice(-10);
}

export function composeVehicleLabel(parts: {
  vehicleMake?: string | null;
  vehicleModel?: string | null;
  vehicleYear?: number | null;
}): string | null {
  const bits = [
    String(parts.vehicleMake ?? '').trim(),
    String(parts.vehicleModel ?? '').trim(),
    parts.vehicleYear ? String(parts.vehicleYear) : '',
  ].filter(Boolean);
  const label = bits.join(' ').trim();
  return label ? label.slice(0, 500) : null;
}

export function isProspectOrigin(value: string): value is ProspectOrigin {
  return (PROSPECT_ORIGINS as readonly string[]).includes(value);
}

export function isAttributionKind(value: unknown): value is AttributionKind {
  return (ATTRIBUTION_KINDS as readonly string[]).includes(String(value ?? ''));
}

export type ParsedManualAppointment = {
  clientRequestId: string;
  clientName: string;
  phone: string;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleYear: number | null;
  serviceRequested: string | null;
  quotedAmount: number | null;
  lines: ParsedServiceLine[] | null;
  origin: ProspectOrigin;
  campaignName: string | null;
  adName: string | null;
  adExternalId: string | null;
  attributionKind: AttributionKind;
  notes: string | null;
  scheduledAtIso: string;
};

export function parseManualAppointmentInput(
  body: Record<string, unknown>,
): { ok: true; value: ParsedManualAppointment } | { ok: false; error: string } {
  const clientRequestId = String(body.clientRequestId ?? '').trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(clientRequestId)) {
    return {
      ok: false,
      error: 'clientRequestId es obligatorio para evitar citas duplicadas.',
    };
  }

  const clientName = String(body.clientName ?? '').trim().slice(0, 200);
  if (!isUsableAppointmentClientName(clientName)) {
    return { ok: false, error: 'Indica el nombre real del cliente.' };
  }

  const phone = normalizePhoneDigits(body.phone);
  if (!isUsableAppointmentPhone(phone)) {
    return { ok: false, error: 'El teléfono necesita al menos 8 dígitos.' };
  }

  const scheduledAtIso = String(
    body.scheduledAtIso ?? body.scheduledAt ?? body.dateTime ?? '',
  ).trim();
  if (!scheduledAtIso) {
    return { ok: false, error: 'Indica fecha y hora de la cita.' };
  }

  const vehicleMake = optionalText(body.vehicleMake, 80);
  const vehicleModel = optionalText(body.vehicleModel, 80);
  const yearParsed = optionalYear(body.vehicleYear);
  if (!yearParsed.ok) return yearParsed;

  const notes = optionalText(body.notes, 2000);
  const parsedLines = 'lines' in body ? parseServiceLines(body.lines) : null;
  if (parsedLines && !parsedLines.ok) return parsedLines;
  const lines = parsedLines ? parsedLines.lines : null;
  const lineTotal =
    lines && lines.length
      ? lines.reduce((sum, line) => sum + line.subtotalCents, 0)
      : null;
  const money =
    lineTotal == null
      ? optionalMoney(body.quotedAmount)
      : { ok: true as const, amount: pesosFromCents(lineTotal) };
  if (!money.ok) return money;
  const serviceRequested =
    lines && lines.length
      ? serviceSummary(lines)
      : optionalText(body.serviceRequested, 200);

  const originRaw = String(body.origin ?? 'desconocido').trim().toLowerCase();
  const origin = originRaw || 'desconocido';
  if (!isProspectOrigin(origin)) {
    return {
      ok: false,
      error: `Origen inválido. Usa: ${PROSPECT_ORIGINS.join(', ')}.`,
    };
  }
  const attribution = parseAttribution(body);
  if (!attribution.ok) return attribution;

  return {
    ok: true,
    value: {
      clientRequestId,
      clientName,
      phone,
      vehicleMake,
      vehicleModel,
      vehicleYear: yearParsed.year,
      serviceRequested,
      quotedAmount: money.amount,
      lines,
      origin,
      campaignName: attribution.value.campaignName,
      adName: attribution.value.adName,
      adExternalId: attribution.value.adExternalId,
      attributionKind: attribution.value.attributionKind,
      notes,
      scheduledAtIso,
    },
  };
}

export function parseAttribution(
  body: Record<string, unknown>,
):
  | {
      ok: true;
      value: {
        campaignName: string | null;
        adName: string | null;
        adExternalId: string | null;
        attributionKind: AttributionKind;
      };
    }
  | { ok: false; error: string } {
  if (String(body.attributionKind ?? '').trim().toLowerCase() === 'verified') {
    return {
      ok: false,
      error: 'La atribución verificada no se captura a mano.',
    };
  }
  const campaignName = optionalText(body.campaignName, 120);
  const adName = optionalText(body.adName, 120);
  const adExternalId = optionalText(body.adExternalId, 128);
  return {
    ok: true,
    value: {
      campaignName,
      adName,
      adExternalId,
      attributionKind:
        campaignName || adName || adExternalId ? 'manual' : 'unknown',
    },
  };
}

export function parseContractedAmount(
  value: unknown,
): { ok: true; amount: number } | { ok: false; error: string } {
  if (value == null || value === '') {
    return { ok: false, error: 'Indica el importe contratado.' };
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_MONEY) {
    return {
      ok: false,
      error: 'El importe contratado debe ser un entero mayor a 0.',
    };
  }
  return { ok: true, amount: Math.round(n) };
}

export function isUniqueViolation(err: unknown): boolean {
  const anyErr = err as { code?: string; driverError?: { code?: string }; message?: string };
  const code = anyErr?.driverError?.code ?? anyErr?.code;
  if (code === '23505') return true;
  const msg = String(anyErr?.message ?? '').toLowerCase();
  return msg.includes('duplicate key') || msg.includes('unique constraint');
}

export function toAppointmentListItem(
  row: {
    id: string;
    clientName: string;
    vehicle?: string | null;
    phone?: string | null;
    quoteSummary?: string | null;
    scheduledAt: Date | string;
    status: string;
    conversationId?: string | null;
    tallerId?: string | null;
    contactId?: string | null;
    vehicleMake?: string | null;
    vehicleModel?: string | null;
    vehicleYear?: number | null;
    serviceRequested?: string | null;
    quotedAmount?: number | null;
    origin?: string | null;
    notes?: string | null;
    source?: string | null;
    campaignName?: string | null;
    adName?: string | null;
    adExternalId?: string | null;
    attributionKind?: string | null;
    lines?: CrmServiceLine[];
    quotedTotalCents?: number | null;
  },
  contractedAmount: number | null,
): AppointmentListItem {
  const when =
    row.scheduledAt instanceof Date
      ? row.scheduledAt
      : new Date(row.scheduledAt);
  const origin = String(row.origin ?? '').trim().toLowerCase();
  const source = String(row.source ?? '').trim().toLowerCase();
  return {
    id: row.id,
    clientName: row.clientName,
    vehicle: row.vehicle ?? null,
    phone: row.phone ?? null,
    quoteSummary: row.quoteSummary ?? null,
    scheduledAt: Number.isNaN(when.getTime()) ? '' : when.toISOString(),
    status: (row.status as AppointmentStatus) ?? 'confirmada',
    visitStatus: dbStatusToVisit(row.status),
    conversationId: row.conversationId ?? null,
    tallerId: row.tallerId ?? null,
    contactId: row.contactId ?? null,
    vehicleMake: row.vehicleMake ?? null,
    vehicleModel: row.vehicleModel ?? null,
    vehicleYear:
      row.vehicleYear == null || !Number.isFinite(Number(row.vehicleYear))
        ? null
        : Number(row.vehicleYear),
    serviceRequested: row.serviceRequested ?? null,
    quotedAmount:
      row.quotedAmount == null || !Number.isFinite(Number(row.quotedAmount))
        ? null
        : Math.round(Number(row.quotedAmount)),
    origin: isProspectOrigin(origin) ? origin : null,
    campaignName: row.campaignName ?? null,
    adName: row.adName ?? null,
    adExternalId: row.adExternalId ?? null,
    attributionKind: isAttributionKind(row.attributionKind)
      ? row.attributionKind
      : null,
    lines: row.lines ?? [],
    quotedTotalCents:
      row.quotedTotalCents == null ? null : Math.round(row.quotedTotalCents),
    notes: row.notes ?? null,
    source: source === 'manual' || source === 'autopilot' ? source : null,
    contractedAmount:
      contractedAmount == null || !Number.isFinite(Number(contractedAmount))
        ? null
        : Math.round(Number(contractedAmount)),
  };
}

export function toAppointmentRealtimePayload(
  tallerId: string,
  row: {
    id: string;
    conversationId?: string | null;
    clientName: string;
    vehicle?: string | null;
    phone?: string | null;
    quoteSummary?: string | null;
    scheduledAt: Date | string;
    status: string;
    source?: string | null;
  },
): AppointmentRealtimePayload {
  const item = toAppointmentListItem(row, null);
  return {
    id: item.id,
    conversationId: item.conversationId,
    clientName: item.clientName,
    vehicle: item.vehicle,
    phone: item.phone,
    quoteSummary: item.quoteSummary,
    scheduledAt: item.scheduledAt,
    status: item.status,
    visitStatus: item.visitStatus,
    tallerId,
    source: item.source,
  };
}

function optionalText(value: unknown, max: number): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.slice(0, max);
}

function optionalYear(
  value: unknown,
): { ok: true; year: number | null } | { ok: false; error: string } {
  if (value == null || value === '') return { ok: true, year: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1950 || n > 2100) {
    return { ok: false, error: 'El año del vehículo debe estar entre 1950 y 2100.' };
  }
  return { ok: true, year: n };
}

function optionalMoney(
  value: unknown,
): { ok: true; amount: number | null } | { ok: false; error: string } {
  if (value == null || value === '') return { ok: true, amount: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) {
    return { ok: false, error: 'El importe cotizado debe ser un número entre 0 y 10000000.' };
  }
  return { ok: true, amount: Math.round(n) };
}
