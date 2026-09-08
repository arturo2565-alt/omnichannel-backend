/** Respuesta estructurada que el LLM debe interpretar para pedir datos faltantes. */
export const APPOINTMENT_MISSING_REQUIRED_DATA = {
  success: false as const,
  error: 'MISSING_REQUIRED_DATA' as const,
  message:
    'No se puede registrar la cita. Falta el nombre real del cliente o el número de teléfono. Pídelos amablemente al usuario antes de reintentar.',
};

const FORBIDDEN_NAME_TOKENS = new Set([
  'desconocido',
  'cliente',
  'none',
  'null',
  'na',
  'whatsapp',
]);

const GENERIC_VEHICLE_TOKENS = new Set([
  'auto',
  'carro',
  'coche',
  'vehiculo',
  'camioneta',
  'none',
  'null',
  'desconocido',
  'n',
  'na',
]);

function tokenizeEs(value: string): string[] {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isUsableAppointmentClientName(
  name: unknown,
): boolean {
  const s = String(name ?? '').trim();
  if (s.length <= 2) return false;
  const tokens = tokenizeEs(s);
  if (tokens.length === 0) return false;
  if (tokens.some((t) => FORBIDDEN_NAME_TOKENS.has(t))) return false;
  return true;
}

export function isUsableAppointmentPhone(phone: unknown): boolean {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length >= 8;
}

export function hasWhatsAppWaId(
  platform: string | null | undefined,
  waId: string | null | undefined,
): boolean {
  if (!String(platform ?? '').toLowerCase().includes('whatsapp')) {
    return false;
  }
  return String(waId ?? '').replace(/\D/g, '').length >= 8;
}

/** Al menos marca o modelo; rechaza vacíos, solo año o genéricos ("auto"). */
export function isUsableAppointmentVehicle(info: unknown): boolean {
  const s = String(info ?? '').trim();
  if (s.length < 2) return false;
  const tokens = tokenizeEs(s);
  const meaningful = tokens.filter(
    (t) => !GENERIC_VEHICLE_TOKENS.has(t) && !/^\d{2,4}$/.test(t),
  );
  return meaningful.length >= 1;
}

export type AppointmentClientGuardInput = {
  clientName: unknown;
  phone: unknown;
  vehicleInfo: unknown;
  platform?: string | null;
  waId?: string | null;
};

export function evaluateAppointmentRequiredClientData(
  input: AppointmentClientGuardInput,
):
  | { ok: true }
  | { ok: false; payload: typeof APPOINTMENT_MISSING_REQUIRED_DATA } {
  const phoneOk =
    isUsableAppointmentPhone(input.phone) ||
    hasWhatsAppWaId(input.platform, input.waId);
  if (
    !isUsableAppointmentClientName(input.clientName) ||
    !phoneOk ||
    !isUsableAppointmentVehicle(input.vehicleInfo)
  ) {
    return { ok: false, payload: APPOINTMENT_MISSING_REQUIRED_DATA };
  }
  return { ok: true };
}
