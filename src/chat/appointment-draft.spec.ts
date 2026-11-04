import { readFileSync } from 'fs';
import { join } from 'path';
import { STAGING_TALLER_ID } from '../config/staging-synthetic';
import { textClaimsAppointmentBooked } from './appointment-scheduling-helpers';
import {
  civilWeekdaySun0,
  validateWorkshopSlotUtcDetailed,
  ymdInTimezone,
} from './appointment-intent';
import {
  APPOINTMENT_ASK_NAME,
  APPOINTMENT_ASK_PHONE,
  absorbClientMessage,
  appointmentPhoneRequest,
  applyVehicle,
  bookingReadiness,
  confirmedVehicleLabel,
  decideAppointmentPersistence,
  emptyAppointmentDraft,
  formatWorkshopSlot,
  guardClientReply,
  isOneActiveAppointmentConflict,
  nextClientQuestion,
  parseAppointmentDraft,
  planConfirmedWrite,
  resolveWorkshopAppointmentPolicy,
  upcomingOpenSlots,
  withOfferedSlots,
  type WorkshopAppointmentPolicy,
} from './appointment-draft';

const receivedAt = new Date('2026-11-04T00:23:00.000Z');
const autofix: WorkshopAppointmentPolicy = {
  id: 'autofix_open',
  openAcceptance: true,
};
const lab = { platform: 'lab', waId: null };

function turn(text: string, policy = autofix) {
  return absorbClientMessage(emptyAppointmentDraft(), {
    text,
    receivedAt,
    policy,
    platform: 'lab',
  });
}

describe('appointment-draft', () => {
  it('conserva mañana a las 9 am y no vuelve a pedir día y hora', () => {
    const draft = turn('Sí me interesa, ¿tienes espacio para mañana a las 9 am?');
    expect(draft.requestedDateTime).toBe('2026-11-04T15:00:00.000Z');
    expect(draft.interpretedDateTime).toBe('2026-11-04T15:00:00.000Z');
    expect(draft.receptionAt).toBe(receivedAt.toISOString());
    expect(draft.timeZone).toBe('America/Mexico_City');
    expect(draft.scheduleStatus).toBe('valid');
    expect(draft.availabilityStatus).toBe('accepted_open_hours');
    const question = nextClientQuestion(draft, autofix, receivedAt, lab);
    expect(question).toBe(APPOINTMENT_ASK_NAME);
    expect(question).not.toMatch(/d[ií]a|hora/i);
  });

  it('si falta el nombre, pregunta solo el nombre', () => {
    const draft = absorbClientMessage(turn('mañana a las 9 am'), {
      text: 'mañana a las 9 am',
      receivedAt,
      policy: autofix,
      contactPhone: '5512345678',
      platform: 'lab',
    });
    expect(draft.requestedDateTime).toBe('2026-11-04T15:00:00.000Z');
    expect(nextClientQuestion(draft, autofix, receivedAt, lab)).toBe(
      APPOINTMENT_ASK_NAME,
    );
    expect(
      bookingReadiness(draft, autofix, receivedAt, lab).missing,
    ).toEqual(['clientName']);
  });

  it('si falta el teléfono, pregunta solo el teléfono', () => {
    const draft = absorbClientMessage(emptyAppointmentDraft(), {
      text: 'Me llamo Ana. Mañana a las 9 am.',
      receivedAt,
      policy: autofix,
      platform: 'messenger',
    });
    expect(draft.clientName?.value).toBe('Ana');
    expect(draft.requestedDateTime).toBe('2026-11-04T15:00:00.000Z');
    expect(nextClientQuestion(draft, autofix, receivedAt, lab)).toBe(
      APPOINTMENT_ASK_PHONE,
    );
  });

  it('un nombre suelto no vuelve a pedirse y conserva la hora', () => {
    const scheduled = absorbClientMessage(emptyAppointmentDraft(), {
      text: '¿Puedo llevar mi auto mañana a las 9?',
      receivedAt,
      policy: autofix,
      platform: 'lab',
    });
    const named = absorbClientMessage(scheduled, {
      text: 'Ana Ensayo',
      receivedAt,
      policy: autofix,
      platform: 'lab',
    });
    expect(named.clientName?.value).toBe('Ana Ensayo');
    expect(named.requestedDateTime).toBe(scheduled.requestedDateTime);
    expect(nextClientQuestion(named, autofix, receivedAt, lab)).toBe(
      APPOINTMENT_ASK_PHONE,
    );
    const reply = guardClientReply({
      modelText:
        'Ana Ensayo, ¿me compartes un teléfono de contacto para completar el registro de tu cita?',
      confirmedIso: null,
      persisted: false,
      draft: named,
      policy: autofix,
      now: receivedAt,
      channel: lab,
    });
    expect(reply).toBe(appointmentPhoneRequest('Ana Ensayo'));
    expect(reply).toBe(
      'Gracias, Ana. 😊 ¿Me compartes un teléfono de contacto para completar tu cita?',
    );
    expect(reply).not.toMatch(/nombre/i);
    const kept = guardClientReply({
      modelText: 'El miércoles a las 9 sigue apartado. ¿Me pasas tu teléfono?',
      confirmedIso: null,
      persisted: false,
      draft: named,
      policy: autofix,
      now: receivedAt,
      channel: lab,
    });
    expect(kept).toMatch(/miércoles a las 9/i);
    expect(kept).not.toMatch(/nombre registro/i);
    expect(
      decideAppointmentPersistence({
        draft: named,
        activeScheduledAt: null,
        currentText: 'Ana Ensayo',
        policy: autofix,
        now: receivedAt,
        channel: lab,
      }).confirmToClient,
    ).toBe(false);
  });

  it('con nombre y teléfono registra sin repreguntar', () => {
    const draft = absorbClientMessage(emptyAppointmentDraft(), {
      text: 'Me llamo Ana López. Mi teléfono es 55 1234 5678. Mañana a las 9 am.',
      receivedAt,
      policy: autofix,
      platform: 'lab',
    });
    const ready = bookingReadiness(draft, autofix, receivedAt, lab);
    expect(ready.ready).toBe(true);
    expect(ready.question).toBeNull();
    expect(draft.clientName?.value).toBe('Ana López');
    expect(draft.phone?.value).toBe('5512345678');
    const reply = guardClientReply({
      modelText: 'Perfecto, te esperamos.',
      confirmedIso: draft.requestedDateTime,
      persisted: true,
      draft,
      policy: autofix,
      now: receivedAt,
      channel: lab,
    });
    expect(textClaimsAppointmentBooked(reply)).toBe(true);
    expect(reply).not.toMatch(/qu[eé] d[ií]a|tel[eé]fono|nombre/i);
  });

  it('acepta el sábado dentro del horario de AutoFix', () => {
    const draft = absorbClientMessage(emptyAppointmentDraft(), {
      text: 'Me llamo Ana. Teléfono 5512345678. El sábado a las 10.',
      receivedAt,
      policy: autofix,
      platform: 'lab',
    });
    expect(draft.requestedDateTime).toBe('2026-11-07T16:00:00.000Z');
    expect(draft.scheduleStatus).toBe('valid');
    expect(
      validateWorkshopSlotUtcDetailed(new Date(draft.requestedDateTime!)).valid,
    ).toBe(true);
    expect(bookingReadiness(draft, autofix, receivedAt, lab).ready).toBe(true);
  });

  it('el domingo propone dos opciones válidas', () => {
    const draft = absorbClientMessage(emptyAppointmentDraft(), {
      text: 'Me llamo Ana. Teléfono 5512345678. El domingo a las 10.',
      receivedAt,
      policy: autofix,
      platform: 'lab',
    });
    expect(draft.requestedDateTime).toBeNull();
    expect(draft.interpretedDateTime).not.toBeNull();
    expect(draft.scheduleStatus).toBe('closed');
    const saved = withOfferedSlots(draft, autofix, receivedAt);
    expect(saved.offeredSlots).toHaveLength(2);
    for (const iso of saved.offeredSlots) {
      const slot = validateWorkshopSlotUtcDetailed(new Date(iso));
      expect(slot.valid).toBe(true);
      expect(
        civilWeekdaySun0(ymdInTimezone(new Date(iso), 'America/Mexico_City')),
      ).not.toBe(0);
      expect(new Date(iso).getTime()).toBeGreaterThan(receivedAt.getTime());
    }
    expect(nextClientQuestion(draft, autofix, receivedAt, lab)).toBe(
      'El domingo no abrimos. Puedo apartarte el miércoles 4 de noviembre a las 09:00 o el miércoles 4 de noviembre a las 10:00.',
    );
  });

  it('un horario pasado pide otro y conserva la interpretación', () => {
    const draft = absorbClientMessage(emptyAppointmentDraft(), {
      text: 'Me llamo Ana. Teléfono 5512345678. Hoy a las 9 am.',
      receivedAt,
      policy: autofix,
      platform: 'lab',
    });
    expect(draft.scheduleStatus).toBe('past');
    expect(draft.requestedDateTime).toBeNull();
    expect(draft.interpretedDateTime).toBe('2026-11-03T15:00:00.000Z');
    expect(draft.receptionAt).toBe(receivedAt.toISOString());
    expect(nextClientQuestion(draft, autofix, receivedAt, lab)).toBe(
      'Esa hora ya pasó. Puedo apartarte el miércoles 4 de noviembre a las 09:00 o el miércoles 4 de noviembre a las 10:00.',
    );
  });

  it('sin fecha ni hora propone dos opciones próximas', () => {
    const draft = absorbClientMessage(emptyAppointmentDraft(), {
      text: 'Me llamo Ana. Teléfono 5512345678. Sí me interesa.',
      receivedAt,
      policy: autofix,
      platform: 'lab',
    });
    expect(draft.scheduleStatus).toBe('missing');
    const slots = upcomingOpenSlots(receivedAt, 2);
    expect(slots.map(formatWorkshopSlot)).toEqual([
      'miércoles 4 de noviembre a las 09:00',
      'miércoles 4 de noviembre a las 10:00',
    ]);
    expect(nextClientQuestion(draft, autofix, receivedAt, lab)).toBe(
      'Puedo apartarte el miércoles 4 de noviembre a las 09:00 o el miércoles 4 de noviembre a las 10:00. ¿Cuál prefieres?',
    );
  });

  it('si createAppointment no persiste, no confirma la cita', () => {
    const draft = turn('mañana a las 9 am');
    const reply = guardClientReply({
      modelText:
        'Tu cita quedó confirmada. Para registrar tu cita en el sistema, ¿me confirmas el día y la hora exacta?',
      confirmedIso: null,
      persisted: false,
      draft,
      policy: autofix,
      now: receivedAt,
      channel: lab,
    });
    expect(textClaimsAppointmentBooked(reply)).toBe(false);
    expect(reply).toBe(APPOINTMENT_ASK_NAME);
    expect(reply).not.toMatch(/hora exacta/i);
    expect(draft.requestedDateTime).toBe('2026-11-04T15:00:00.000Z');
  });

  it('un reagendamiento persiste la hora nueva', () => {
    const previous = '2026-11-04T15:00:00.000Z';
    const requested = '2026-11-05T17:00:00.000Z';
    const plan = planConfirmedWrite({
      activeScheduledAt: previous,
      requestedDateTime: requested,
      ready: true,
    });
    expect(plan.action).toBe('reschedule');
    expect(plan.persistAt).toBe(requested);
    expect(plan.previousScheduledAt).toBe(previous);
    expect(plan.persistAt).not.toBe(plan.previousScheduledAt);
  });

  it('no presenta el vehículo inferido como confirmado y conserva el del cliente', () => {
    let draft = applyVehicle(emptyAppointmentDraft(), {
      label: 'Mazda 2 2020',
      source: 'vision',
    });
    expect(draft.vehicleIdentity?.confirmed).toBe(false);
    expect(confirmedVehicleLabel(draft)).toBeNull();
    expect(nextClientQuestion(draft, autofix, receivedAt, lab) ?? '').not.toMatch(
      /Mazda/,
    );
    const reply = guardClientReply({
      modelText: 'Tu Mazda 2 2020 está confirmado.',
      confirmedIso: null,
      persisted: false,
      draft,
      policy: autofix,
      now: receivedAt,
      channel: lab,
    });
    expect(reply).not.toMatch(/Mazda/);
    draft = absorbClientMessage(draft, {
      text: 'Es un Jetta 2018',
      receivedAt,
      policy: autofix,
      platform: 'lab',
    });
    expect(confirmedVehicleLabel(draft)).toBe('Jetta 2018');
    draft = applyVehicle(draft, { label: 'Mazda 2 2020', source: 'vision' });
    expect(confirmedVehicleLabel(draft)).toBe('Jetta 2018');
    expect(draft.vehicleIdentity?.source).toBe('client');
  });

  it('no altera un total de cotización que viaja junto al turno', () => {
    const quote = { total: 8250, lines: [4800, 3450] };
    const before = JSON.stringify(quote);
    absorbClientMessage(emptyAppointmentDraft(), {
      text: 'Me llamo Ana. Mañana a las 9 am.',
      receivedAt,
      policy: autofix,
      platform: 'lab',
    });
    expect(JSON.stringify(quote)).toBe(before);
    expect(quote.total).toBe(8250);
  });

  it('la aceptación libre no aplica a otro taller', () => {
    expect(
      resolveWorkshopAppointmentPolicy({
        id: STAGING_TALLER_ID,
        nombre: 'Taller de ensayo',
      }).openAcceptance,
    ).toBe(true);
    expect(
      resolveWorkshopAppointmentPolicy({ nombre: 'AutoFix' }).openAcceptance,
    ).toBe(true);
    const other = resolveWorkshopAppointmentPolicy({
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      nombre: 'Taller Norte',
    });
    expect(other.openAcceptance).toBe(false);
    const draft = absorbClientMessage(emptyAppointmentDraft(), {
      text: 'Me llamo Ana. Teléfono 5512345678. El sábado a las 10.',
      receivedAt,
      policy: other,
      platform: 'lab',
    });
    expect(draft.requestedDateTime).toBe('2026-11-07T16:00:00.000Z');
    expect(draft.availabilityStatus).toBe('unverified_other_workshop');
    expect(draft.scheduleStatus).not.toBe('valid');
    const question = nextClientQuestion(draft, other, receivedAt, lab);
    expect(question).not.toMatch(/puedo apartarte/i);
    expect(bookingReadiness(draft, other, receivedAt, lab).ready).toBe(false);
    expect(withOfferedSlots(draft, other, receivedAt).offeredSlots).toEqual([]);
  });

  it('el jueves un gracias no mueve la cita del miércoles', () => {
    const tuesday = receivedAt;
    let draft = absorbClientMessage(emptyAppointmentDraft(), {
      text: 'Me llamo Ana. Teléfono 5512345678. Mañana a las 9 am.',
      receivedAt: tuesday,
      policy: autofix,
      platform: 'lab',
    });
    const wednesday = '2026-11-04T15:00:00.000Z';
    expect(draft.requestedDateTime).toBe(wednesday);
    const reception = draft.receptionAt;
    const thursday = new Date('2026-11-06T00:23:00.000Z');
    draft = absorbClientMessage(draft, {
      text: 'gracias',
      receivedAt: thursday,
      policy: autofix,
      platform: 'lab',
    });
    expect(draft.requestedDateTime).toBe(wednesday);
    expect(draft.receptionAt).toBe(reception);
    expect(draft.timeZone).toBe('America/Mexico_City');
    expect(
      decideAppointmentPersistence({
        draft,
        activeScheduledAt: wednesday,
        currentText: 'perfecto',
        policy: autofix,
        now: thursday,
        channel: lab,
      }),
    ).toEqual({ action: 'unchanged', confirmToClient: false });
  });

  it('un cambio explícito a viernes reagenda', () => {
    const tuesday = receivedAt;
    let draft = absorbClientMessage(emptyAppointmentDraft(), {
      text: 'Me llamo Ana. Teléfono 5512345678. Mañana a las 9 am.',
      receivedAt: tuesday,
      policy: autofix,
      platform: 'lab',
    });
    const thursday = new Date('2026-11-06T00:23:00.000Z');
    draft = absorbClientMessage(draft, {
      text: 'Mejor el viernes a las 9 am.',
      receivedAt: thursday,
      policy: autofix,
      platform: 'lab',
    });
    expect(draft.requestedDateTime).toBe('2026-11-06T15:00:00.000Z');
    expect(
      decideAppointmentPersistence({
        draft,
        activeScheduledAt: '2026-11-04T15:00:00.000Z',
        currentText: 'Mejor el viernes a las 9 am.',
        policy: autofix,
        now: thursday,
        channel: lab,
      }).action,
    ).toBe('reschedule');
  });

  it('un mensaje duplicado no pide otra cita ni otra confirmación', () => {
    const draft = absorbClientMessage(emptyAppointmentDraft(), {
      text: 'Me llamo Ana. Teléfono 5512345678. Mañana a las 9 am.',
      receivedAt,
      policy: autofix,
      platform: 'lab',
    });
    const again = absorbClientMessage(draft, {
      text: 'Me llamo Ana. Teléfono 5512345678. Mañana a las 9 am.',
      receivedAt,
      policy: autofix,
      platform: 'lab',
    });
    expect(again.requestedDateTime).toBe(draft.requestedDateTime);
    expect(again.receptionAt).toBe(draft.receptionAt);
    expect(
      decideAppointmentPersistence({
        draft: again,
        activeScheduledAt: again.requestedDateTime,
        currentText: 'Me llamo Ana. Teléfono 5512345678. Mañana a las 9 am.',
        policy: autofix,
        now: receivedAt,
        channel: lab,
      }),
    ).toEqual({ action: 'unchanged', confirmToClient: false });
  });

  it('dos decisiones simultáneas chocan en el índice de una cita activa', () => {
    const draft = absorbClientMessage(emptyAppointmentDraft(), {
      text: 'Me llamo Ana. Teléfono 5512345678. Mañana a las 9 am.',
      receivedAt,
      policy: autofix,
      platform: 'lab',
    });
    const decisions = [0, 1].map(() =>
      decideAppointmentPersistence({
        draft,
        activeScheduledAt: null,
        currentText: 'Me llamo Ana. Teléfono 5512345678. Mañana a las 9 am.',
        policy: autofix,
        now: receivedAt,
        channel: lab,
      }),
    );
    expect(decisions.map((item) => item.action)).toEqual(['create', 'create']);
    expect(
      isOneActiveAppointmentConflict({
        code: '23505',
        constraint: 'UQ_appointments_one_active_conversation',
      }),
    ).toBe(true);
    expect(
      isOneActiveAppointmentConflict({
        code: '23505',
        constraint: 'UQ_appointments_client_request',
      }),
    ).toBe(false);
    const sql = readFileSync(
      join(__dirname, 'migrations/007_appointment_draft.sql'),
      'utf8',
    );
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "appointmentDraft" jsonb');
    expect(sql).not.toMatch(/appointmentDraft" jsonb NOT NULL/);
    expect(sql).toContain('UQ_appointments_one_active_conversation');
    expect(sql).toContain('"conversationId"');
    expect(sql).not.toContain('ON appointments ("tallerId")');
    expect(sql).toContain("'pendiente', 'confirmada'");
  });

  it('un borrador nulo se lee como vacío', () => {
    expect(parseAppointmentDraft(null).requestedDateTime).toBeNull();
    expect(parseAppointmentDraft(undefined).appointmentStatus).toBe('draft');
  });

  it('rechaza un nombre genérico de laboratorio', () => {
    const draft = absorbClientMessage(emptyAppointmentDraft(), {
      text: 'Mañana a las 9 am',
      receivedAt,
      policy: autofix,
      platform: 'lab',
      contactName: 'Cliente de laboratorio',
    });
    expect(draft.clientName).toBeNull();
    expect(nextClientQuestion(draft, autofix, receivedAt, lab)).toBe(
      APPOINTMENT_ASK_NAME,
    );
  });
});
