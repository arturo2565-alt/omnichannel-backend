import {
  appointmentSocketRoom,
  composeVehicleLabel,
  crmContactExternalId,
  dbStatusToVisit,
  isAppointmentVisibleToTaller,
  parseContractedAmount,
  parseManualAppointmentInput,
  resolveAppointmentDbStatus,
  shouldAttemptAppointmentReminder,
  visitToDbStatus,
} from './crm-appointment';
import {
  APPOINTMENT_VISIBILITY_SQL,
  listAppointmentsForTaller,
} from './appointment-directory';

describe('crm-appointment', () => {
  const body = {
    clientRequestId: '11111111-2222-4333-8444-555555555555',
    clientName: 'Ana López',
    phone: '55 1234 5678',
    vehicleMake: 'Nissan',
    vehicleModel: 'Versa',
    vehicleYear: 2019,
    serviceRequested: 'Pintura de salpicadera',
    quotedAmount: 4500,
    origin: 'facebook',
    notes: 'Viene después del trabajo',
    scheduledAtIso: '2026-05-26T14:00:00',
  };

  it('acepta una captura manual sin conversación y normaliza el teléfono', () => {
    const parsed = parseManualAppointmentInput(body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.phone).toBe('5512345678');
    expect(parsed.value.quotedAmount).toBe(4500);
    expect(parsed.value.origin).toBe('facebook');
    expect(composeVehicleLabel(parsed.value)).toBe('Nissan Versa 2019');
    expect(crmContactExternalId(parsed.value.phone)).toBe('crm:5512345678');
  });

  it('no exige vehículo, servicio ni cotizado', () => {
    const parsed = parseManualAppointmentInput({
      clientRequestId: 'crm-request-01',
      clientName: 'Luis Pérez',
      phone: '5511112222',
      scheduledAtIso: '2026-05-26T10:00:00',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.vehicleMake).toBeNull();
    expect(parsed.value.quotedAmount).toBeNull();
    expect(parsed.value.origin).toBe('desconocido');
  });

  it('rechaza nombre genérico y teléfono corto', () => {
    expect(
      parseManualAppointmentInput({ ...body, clientName: 'cliente' }).ok,
    ).toBe(false);
    expect(parseManualAppointmentInput({ ...body, phone: '123' }).ok).toBe(
      false,
    );
  });

  it('mantiene confirmada del autopilot como agendada y no crea venta al cotizar', () => {
    expect(dbStatusToVisit('confirmada')).toBe('agendada');
    expect(dbStatusToVisit('pendiente')).toBe('agendada');
    expect(dbStatusToVisit('finalizada')).toBe('realizada');
    expect(visitToDbStatus('realizada')).toBe('finalizada');
    expect(visitToDbStatus('no_asistio')).toBe('no_asistio');
    expect(resolveAppointmentDbStatus({ visitStatus: 'cancelada' })).toBe(
      'cancelada',
    );
    expect(parseContractedAmount('').ok).toBe(false);
    expect(parseContractedAmount(0).ok).toBe(false);
    expect(parseContractedAmount(1800)).toEqual({ ok: true, amount: 1800 });
  });

  it('aísla citas por taller, incluidas las manuales sin conversación', () => {
    expect(
      isAppointmentVisibleToTaller({ tallerId: 'a' }, null, 'a'),
    ).toBe(true);
    expect(
      isAppointmentVisibleToTaller({ tallerId: 'a' }, null, 'b'),
    ).toBe(false);
    expect(
      isAppointmentVisibleToTaller(
        { tallerId: null },
        { tallerId: 'a' },
        'a',
      ),
    ).toBe(true);
    expect(
      isAppointmentVisibleToTaller(
        { tallerId: null },
        { tallerId: 'a' },
        'b',
      ),
    ).toBe(false);
    expect(isAppointmentVisibleToTaller({ tallerId: null }, null, 'a')).toBe(
      false,
    );
  });

  it('no manda recordatorio de canal si la cita no tiene conversación', () => {
    expect(
      shouldAttemptAppointmentReminder({
        status: 'confirmada',
        conversationId: null,
      }),
    ).toBe(false);
    expect(
      shouldAttemptAppointmentReminder({
        status: 'confirmada',
        conversationId: 'conv-1',
      }),
    ).toBe(true);
    expect(
      shouldAttemptAppointmentReminder({
        status: 'cancelada',
        conversationId: 'conv-1',
      }),
    ).toBe(false);
  });

  it('no abre una sala global si falta el taller', () => {
    expect(appointmentSocketRoom('')).toBeNull();
    expect(appointmentSocketRoom('  ')).toBeNull();
    expect(appointmentSocketRoom('taller-a')).toBe('taller:taller-a');
  });

  it('lista con left join y el mismo filtro de taller en la cita y el contrato', async () => {
    const query = jest.fn(async (sql: string) => {
      if (String(sql).includes('information_schema')) {
        return [{ hasTaller: true, hasContracts: true }];
      }
      return [];
    });
    await listAppointmentsForTaller({ query } as never, 'taller-a', {
      source: 'manual',
    });
    const listCall = query.mock.calls.find(
      (call) => !String(call[0]).includes('information_schema'),
    );
    const sql = String(listCall?.[0]);
    expect(sql).toContain(APPOINTMENT_VISIBILITY_SQL);
    expect(sql).toContain('LEFT JOIN conversation');
    expect(sql).not.toContain('INNER JOIN conversation');
    expect(sql).toContain('cw."tallerId" = $1');
    expect(listCall?.[1]).toEqual(['taller-a', 'manual']);
  });

  it('antes de la migración el calendario no consulta contracted_works', async () => {
    const query = jest.fn(async (sql: string) => {
      if (String(sql).includes('information_schema')) {
        return [{ hasTaller: false, hasContracts: false }];
      }
      return [];
    });
    await listAppointmentsForTaller({ query } as never, 'taller-a');
    const listCall = query.mock.calls.find(
      (call) => !String(call[0]).includes('information_schema'),
    );
    const sql = String(listCall?.[0]);
    expect(sql).toContain('INNER JOIN conversation');
    expect(sql).toContain('c."tallerId" = $1');
    expect(sql).not.toContain('contracted_works');
    expect(sql).not.toContain('a."tallerId"');
    expect(listCall?.[1]).toEqual(['taller-a']);
  });
});
