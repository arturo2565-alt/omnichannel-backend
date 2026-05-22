import type { DraftQuoteLine } from './autofix-config';
import { WORKSHOP_TIMEZONE } from './appointment-intent';

/** Narrativa legal del borrador (no es mensaje al cliente). */
export function isFormalDocumentNarrative(text: string): boolean {
  return String(text ?? '')
    .trimStart()
    .startsWith('Estimado cliente');
}

/** Etiqueta de pieza desde la descripción de línea del catálogo. */
export function piezaLabelFromDraftLineDescription(description: string): string {
  const d = String(description ?? '').trim();
  const idx = d.indexOf('—');
  return (idx >= 0 ? d.slice(0, idx) : d).trim() || 'Servicio';
}

export function formatDraftAppointmentCitaLong(scheduledAt: Date): string {
  return scheduledAt.toLocaleString('es-MX', {
    timeZone: WORKSHOP_TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function buildDamagePhotoIntroForCliente(
  analysis: {
    inventory?: { pieza: string }[];
    partesAfectadas?: string[];
    pieza?: string;
  },
  imageCount: number,
): string {
  const fromInv = (analysis.inventory ?? [])
    .map((i) => String(i.pieza ?? '').trim())
    .filter(Boolean);
  const fromPartes = (analysis.partesAfectadas ?? [])
    .map((p) => String(p).trim())
    .filter(Boolean);
  const unique = [...new Set([...fromInv, ...fromPartes])];
  if (analysis.pieza?.trim() && !unique.includes(analysis.pieza.trim())) {
    unique.unshift(analysis.pieza.trim());
  }
  if (unique.length === 1) {
    const p = unique[0]!.toLowerCase();
    return imageCount > 1
      ? `Ya analizamos las fotografías de tu ${p}.`
      : `Ya analizamos la fotografía de tu ${p}.`;
  }
  if (unique.length === 2) {
    return `Ya analizamos las fotografías de ${unique[0]} y ${unique[1]}.`;
  }
  if (unique.length > 2) {
    const tail = unique.slice(-1)[0];
    const head = unique.slice(0, -1).join(', ');
    return `Ya analizamos las fotografías de ${head} y ${tail}.`;
  }
  return imageCount > 1
    ? 'Ya analizamos las fotografías que nos enviaste.'
    : 'Ya analizamos la fotografía que nos enviaste.';
}

export function draftQuoteLinesToClientePiezaRows(
  lines: readonly DraftQuoteLine[],
): { pieza: string; precioMx: number }[] {
  return lines
    .filter((l) => l.subtotal > 0)
    .map((l) => ({
      pieza: piezaLabelFromDraftLineDescription(l.description),
      precioMx: Math.round(l.subtotal),
    }));
}

function formatClientePiezaLineExtra(pieza: string, precioMx: number): string {
  const label = String(pieza ?? '').trim() || 'Servicio';
  const amt = Math.max(0, Math.round(Number(precioMx) || 0));
  return `🛠️ Reparación y Pintura de ${label}: $${amt.toLocaleString('es-MX')} MXN`;
}

/** Mensaje al cliente cuando ya tiene cita (preview / formalNarrative). */
export function buildClienteFormalNarrativeAgendado(opts: {
  contactName: string;
  lineRows: readonly { pieza: string; precioMx: number }[];
  total: number;
  appointmentFormatted: string;
  damageIntro: string;
}): string {
  const name = String(opts.contactName ?? '').trim() || 'cliente';
  const linesText = opts.lineRows.map((r) => formatClientePiezaLineExtra(r.pieza, r.precioMx)).join('\n');
  const total = Math.max(0, Math.round(Number(opts.total) || 0));
  const when = String(opts.appointmentFormatted ?? '').trim() || 'el día acordado para tu visita';
  return [
    `👋 ¡Listo, ${name}! ${opts.damageIntro}`,
    `Aquí tienes el desglose del costo extra para dejar esa zona impecable:`,
    ``,
    linesText,
    `💰 **Inversión Extra Estimada: $${total.toLocaleString('es-MX')} MXN** *(Sujeto a revisión física. Incluye materiales premium Sikkens y garantía).*`,
    ``,
    `Anotamos estos conceptos como un extra en tu orden de servicio. **Los realizaremos este mismo ${when} que ingresas tu vehículo al taller.**`,
    ``,
    `¿Tienes alguna duda con las piezas o prefieres que lo sumemos al presupuesto inicial? 😊✨`,
  ].join('\n');
}

/** Mensaje al cliente sin cita (ubicación + invitación a agendar). */
export function buildClienteFormalNarrativeSinCita(opts: {
  contactName: string;
  lineRows: readonly { pieza: string; precioMx: number }[];
  total: number;
  mapsUrl: string;
  damageIntro: string;
}): string {
  const name = String(opts.contactName ?? '').trim() || 'cliente';
  const linesText = opts.lineRows
    .map((r) => formatDraftQuoteLineToolEmoji(r.pieza, r.precioMx))
    .join('\n');
  const total = Math.max(0, Math.round(Number(opts.total) || 0));
  const mapLink = String(opts.mapsUrl ?? '').trim() || 'https://goo.gl/maps/tu-ubicacion-real';
  return [
    `👋 ¡Listo, ${name}! ${opts.damageIntro}`,
    `Aquí tienes el desglose de tu cotización:`,
    ``,
    linesText,
    `💰 **Inversión Total Estimada: $${total.toLocaleString('es-MX')} MXN** *(Sujeto a revisión física. Incluye garantía y materiales premium Sikkens)*`,
    ``,
    `📍 Estamos aquí, fácil de llegar: ${mapLink}`,
    ``,
    `📅 Tenemos espacios esta semana. ¿Qué día te queda mejor para ingresar tu unidad?`,
  ].join('\n');
}

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
