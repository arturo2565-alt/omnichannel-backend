import {
  parseWorkshopScheduledAtIso,
  parseWorkshopScheduledAtIsoForBooking,
  validateWorkshopSlotUtc,
} from './appointment-intent';
import {
  stripAppointmentConfirmationClaims,
  textClaimsAppointmentBooked,
} from './appointment-scheduling-helpers';

describe('parseWorkshopScheduledAtIsoForBooking', () => {
  it('asume tarde cuando 03:30 está fuera de horario pero 15:30 es válido', () => {
    const parsed = parseWorkshopScheduledAtIsoForBooking('2026-06-16T03:30:00');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.coercedFromPmAmbiguity).toBe(true);
    expect(validateWorkshopSlotUtc(parsed.date)).toBe(true);
    const expected = parseWorkshopScheduledAtIso('2026-06-16T15:30:00');
    expect(expected.ok).toBe(true);
    if (expected.ok) {
      expect(parsed.date.toISOString()).toBe(expected.date.toISOString());
    }
  });
});

describe('appointment-scheduling-helpers', () => {
  it('detecta confirmación falsa de cita', () => {
    expect(
      textClaimsAppointmentBooked(
        'He agendado tu cita para el martes a las 3:30 PM.',
      ),
    ).toBe(true);
    expect(textClaimsAppointmentBooked('¿Qué incluye la garantía?')).toBe(false);
  });

  it('elimina frases de cita agendada del texto', () => {
    const out = stripAppointmentConfirmationClaims(
      'He agendado tu cita para el martes. Sobre la garantía incluye 1 año.',
    );
    expect(out).not.toMatch(/agendad/i);
    expect(out).toMatch(/garantía/i);
  });
});
