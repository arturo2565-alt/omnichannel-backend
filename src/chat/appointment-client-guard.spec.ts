import {
  APPOINTMENT_MISSING_REQUIRED_DATA,
  evaluateAppointmentRequiredClientData,
  isUsableAppointmentClientName,
  isUsableAppointmentPhone,
  isUsableAppointmentVehicle,
} from './appointment-client-guard';

describe('appointment-client-guard', () => {
  it('rechaza nombres placeholder o cortos', () => {
    expect(isUsableAppointmentClientName('')).toBe(false);
    expect(isUsableAppointmentClientName('Al')).toBe(false);
    expect(isUsableAppointmentClientName('cliente')).toBe(false);
    expect(isUsableAppointmentClientName('Cliente Desconocido')).toBe(false);
    expect(isUsableAppointmentClientName('none')).toBe(false);
    expect(isUsableAppointmentClientName('null')).toBe(false);
    expect(isUsableAppointmentClientName('WhatsApp +52155')).toBe(false);
    expect(isUsableAppointmentClientName('Ana')).toBe(true);
    expect(isUsableAppointmentClientName('Arturo Peña')).toBe(true);
  });

  it('exige al menos 8 dígitos telefónicos', () => {
    expect(isUsableAppointmentPhone('555123')).toBe(false);
    expect(isUsableAppointmentPhone('+52 55 1234 5678')).toBe(true);
  });

  it('exige marca o modelo, no genéricos', () => {
    expect(isUsableAppointmentVehicle('')).toBe(false);
    expect(isUsableAppointmentVehicle('auto')).toBe(false);
    expect(isUsableAppointmentVehicle('2018')).toBe(false);
    expect(isUsableAppointmentVehicle('Jetta')).toBe(true);
    expect(isUsableAppointmentVehicle('Nissan March 2018')).toBe(true);
  });

  it('acepta WhatsApp con wa_id aunque el phone vaya vacío', () => {
    const r = evaluateAppointmentRequiredClientData({
      clientName: 'Laura',
      phone: '',
      vehicleInfo: 'Aveo 2016',
      platform: 'whatsapp',
      waId: '5215512345678',
    });
    expect(r.ok).toBe(true);
  });

  it('devuelve MISSING_REQUIRED_DATA sin pasar', () => {
    const r = evaluateAppointmentRequiredClientData({
      clientName: 'Cliente',
      phone: '123',
      vehicleInfo: 'auto',
      platform: 'messenger',
    });
    expect(r).toEqual({
      ok: false,
      payload: APPOINTMENT_MISSING_REQUIRED_DATA,
    });
  });
});
