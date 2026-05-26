import {
  parseWorkshopScheduledAtIso,
  validateWorkshopSlotUtc,
  validateWorkshopSlotUtcDetailed,
  WORKSHOP_TIMEZONE,
} from './appointment-intent';

describe('appointment-intent (createAppointment)', () => {
  it('interpreta ISO sin zona como hora civil en CDMX (servidor UTC)', () => {
    const parsed = parseWorkshopScheduledAtIso('2026-05-25T14:00:00');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.date.toISOString()).toBe('2026-05-25T20:00:00.000Z');
    expect(validateWorkshopSlotUtc(parsed.date)).toBe(true);
  });

  it('rechaza 14:00Z como 08:00 CDMX en día laboral (antes de abrir)', () => {
    const parsed = parseWorkshopScheduledAtIso('2026-05-25T14:00:00.000Z');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const slot = validateWorkshopSlotUtcDetailed(parsed.date);
    expect(slot.valid).toBe(false);
    if (slot.valid) return;
    expect(slot.error).toContain(WORKSHOP_TIMEZONE);
    expect(slot.error).toMatch(/08:00|fuera de horario/i);
  });

  it('acepta sábado a las 14:00 en CDMX', () => {
    const parsed = parseWorkshopScheduledAtIso('2026-05-30T14:00:00');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateWorkshopSlotUtc(parsed.date)).toBe(true);
  });

  it('rechaza sábado después de las 14:00', () => {
    const parsed = parseWorkshopScheduledAtIso('2026-05-30T14:01:00');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const slot = validateWorkshopSlotUtcDetailed(parsed.date);
    expect(slot.valid).toBe(false);
    if (slot.valid) return;
    expect(slot.error).toMatch(/Sábado|sábado/i);
  });

  it('devuelve error descriptivo si falta scheduledAtIso', () => {
    const parsed = parseWorkshopScheduledAtIso('');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/Falta scheduledAtIso|14:00/i);
  });
});
