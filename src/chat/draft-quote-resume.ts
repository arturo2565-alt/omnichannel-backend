import { WORKSHOP_TIMEZONE } from './appointment-intent';

/** Fecha/hora de cita en español (México). */
export function formatAppointmentHumanDate(scheduledAt: Date): string {
  return scheduledAt.toLocaleString('es-MX', {
    timeZone: WORKSHOP_TIMEZONE,
    dateStyle: 'full',
    timeStyle: 'short',
  });
}

/** Línea de desglose con emoji 🛠️ (formato cotización express). */
export function formatDraftQuoteLineToolEmoji(
  pieza: string,
  precioMx: number,
): string {
  const label = String(pieza ?? '').trim() || 'Servicio';
  const amt = Math.max(0, Math.round(Number(precioMx) || 0));
  return `🛠️ ${label}: $${amt.toLocaleString('es-MX')} MXN`;
}

/** Convierte guiones del resumen autorizado a líneas 🛠️ para el modelo. */
export function normalizeAuthorizedQuoteSummaryLines(summary: string): string {
  return String(summary ?? '')
    .split('\n')
    .map((line) => {
      const m = line.match(/^\s*[-•]\s*(.+?):\s*\$?\s*([\d,.]+)\s*(?:MXN)?\s*$/i);
      if (!m) return line;
      const pieza = m[1]!.trim();
      const num = Number(String(m[2]).replace(/,/g, ''));
      if (!Number.isFinite(num)) return line;
      return formatDraftQuoteLineToolEmoji(pieza, num);
    })
    .join('\n');
}

export function buildDraftResumeAgendadoCriticalContext(
  appointmentHuman: string,
  vehiclePhrase: string,
): string {
  const vehicle = String(vehiclePhrase ?? '').trim() || 'su vehículo';
  const when = String(appointmentHuman ?? '').trim() || 'la fecha acordada';
  return [
    '',
    'CONTEXTO CRÍTICO: El cliente ya tiene una cita confirmada para el día',
    when + '.',
    'NO envíes la ubicación del taller, NO le preguntes si quiere agendar, ni uses cierres de venta genéricos.',
    `Presenta los precios de las nuevas piezas autorizadas de forma muy natural y dile amablemente que estos conceptos quedan agregados como un extra a su orden de servicio para cuando ingrese ${vehicle} (${when}).`,
    'Cierra preguntando si prefiere que lo sumemos al total estimado o si tiene alguna duda.',
  ].join(' ');
}

export function buildDraftResumeSinCitaSystemAppend(mapsUrl: string): string {
  const mapLink = String(mapsUrl ?? '').trim() || 'https://goo.gl/maps/tu-ubicacion-real';
  return [
    '',
    '[Reanudación tras autorización de cotización — cliente SIN cita confirmada]',
    'Tras presentar el desglose autorizado, incluye la ubicación del taller y pregunta qué día le queda mejor para ingresar su vehículo.',
    `Ubicación del taller (úsala tal cual en el mensaje al cliente): ${mapLink}`,
    'En el desglose usa una línea por pieza con emoji 🛠️ (ej. 🛠️ Puerta: $1,200 MXN). No uses viñetas con guion ni asteriscos como lista.',
    'Puedes cerrar invitando a agendar cuando encaje el tono (ej. espacios esta semana).',
  ].join('\n');
}

export const DRAFT_RESUME_BASE_AUTH_HINT = [
  '',
  'Cuando recibas un mensaje de usuario que comience por "SISTEMA:" con una autorización de cotización del operador, trátalo como aviso interno: no lo repitas al cliente.',
  'Presenta la cotización de forma clara pero conversacional, con los montos exactos que figuren en ese aviso.',
  'En el desglose al cliente usa emoji 🛠️ antes de cada pieza/servicio con su precio en MXN; nunca listas con guiones.',
  'Si el historial o el contexto permiten inferir o recordar el vehículo del cliente, intégralo de forma natural y amigable.',
  'Cuando encaje en el tono menciona beneficios como la garantía por escrito.',
].join('\n');
