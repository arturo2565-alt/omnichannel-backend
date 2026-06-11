import {
  WORKSHOP_TIMEZONE,
  workshopLocalHourMinute,
} from './appointment-intent';

/** ¿El texto afirma que ya se agendó/registró una cita? */
export function textClaimsAppointmentBooked(text: string): boolean {
  const t = String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(he|ha|hemos|ya)\s+(agendad|programad|registrad|reservad)/.test(t) ||
    /\b(tu|su)\s+cita\s+(quedo|esta|ha sido)\s+(agendad|confirmad|registrad)/.test(
      t,
    ) ||
    /\bcita\s+(confirmad|agendad|registrad)/.test(t) ||
    /\bquedo\s+agendad/.test(t)
  );
}

/** Quita frases que afirman cita registrada (evita alucinación al cliente). */
export function stripAppointmentConfirmationClaims(text: string): string {
  const raw = String(text ?? '').trim();
  if (!raw) return raw;
  const sentences = raw.split(/(?<=[.!?])\s+|\n+/);
  const kept = sentences.filter((s) => !textClaimsAppointmentBooked(s));
  return kept.join(' ').trim() || raw;
}

export function formatAppointmentConfirmedMessage(scheduledAtIso: string): string {
  try {
    const d = new Date(scheduledAtIso);
    const human = d.toLocaleString('es-MX', {
      timeZone: WORKSHOP_TIMEZONE,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });
    return `¡Listo! Tu cita quedó registrada para el ${human}. ¡Te esperamos en el taller! 📆`;
  } catch {
    return '¡Listo! Tu cita quedó registrada. ¡Te esperamos en el taller! 📆';
  }
}

/** Construye contexto reciente de agendamiento (usuario + asistente). */
export function buildSchedulingContextFromTurns(
  turns: ReadonlyArray<{ role: string; text: string }>,
  maxTurns = 8,
): string {
  const slice = turns.slice(-maxTurns);
  return slice
    .map((t) => {
      const role =
        String(t.role).toLowerCase() === 'assistant' ? 'Asesor' : 'Cliente';
      const body = String(t.text ?? '').trim();
      return body ? `${role}: ${body}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** ISO naive CDMX (YYYY-MM-DDTHH:mm:ss) desde instante UTC. */
export function workshopNaiveIsoFromUtc(instant: Date): string | null {
  const hm = workshopLocalHourMinute(instant);
  if (!hm) return null;
  const ymd = instant.toLocaleDateString('en-CA', {
    timeZone: WORKSHOP_TIMEZONE,
  });
  const h = String(hm.hour).padStart(2, '0');
  const m = String(hm.minute).padStart(2, '0');
  return `${ymd}T${h}:${m}:00`;
}
