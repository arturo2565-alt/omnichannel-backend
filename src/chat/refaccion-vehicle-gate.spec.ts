import {
  buildRefaccionYearAskNote,
  clientNarrativeAlreadyCoversRefaccion,
  extractVehicleYear,
  hasConfirmedYearAndModel,
  parseVehicleYearAndModel,
  shouldAppendRefaccionNote,
  stripRedundantRefaccionAskFooter,
} from './refaccion-vehicle-gate';

describe('refaccion-vehicle-gate', () => {
  it('extrae año de respuestas cortas', () => {
    expect(extractVehicleYear('Es 2019')).toBe('2019');
    expect(extractVehicleYear('es un jetta 2018')).toBe('2018');
    expect(extractVehicleYear('no sé el año')).toBeNull();
  });

  it('exige año y modelo reales', () => {
    expect(hasConfirmedYearAndModel('2019', 'Jetta')).toBe(true);
    expect(hasConfirmedYearAndModel('2019', 'tu vehículo')).toBe(false);
    expect(hasConfirmedYearAndModel(null, 'Jetta')).toBe(false);
  });

  it('arma identidad desde visión + respuesta del cliente', () => {
    const id = parseVehicleYearAndModel('Volkswagen Jetta', 'Es 2019');
    expect(id.anio).toBe('2019');
    expect(id.modelo.toLowerCase()).toContain('jetta');
    expect(id.confirmed).toBe(true);
  });

  it('pregunta año y versión sin inventar precio', () => {
    const note = buildRefaccionYearAskNote('Calavera izquierda');
    expect(note).toMatch(/Calavera izquierda/);
    expect(note).toMatch(/año y versión/);
    expect(note).not.toMatch(/\$/);
  });

  it('no concatena nota si el cuerpo ya cubre rotura + taller', () => {
    const body =
      'También se observa calavera trasera izquierda rota, la cual se confirma al ingresar al taller. ¿Qué día te queda para agendar?';
    expect(clientNarrativeAlreadyCoversRefaccion(body)).toBe(true);
    expect(
      shouldAppendRefaccionNote(body, { vehicleConfirmed: false }),
    ).toBe(false);
    expect(
      shouldAppendRefaccionNote(body, { vehicleConfirmed: true }),
    ).toBe(false);
  });

  it('quita el pie Nota de Refacción que pide marca/modelo/año', () => {
    const text = [
      'Ya analizamos las fotos de tu fascia. ¿Qué día te queda para ingresar?',
      '',
      '🔍 *Nota de Refacción:* Notamos que tu *Calavera_TI* presenta rotura. ¿me confirmas *marca, modelo y año*?',
    ].join('\n');
    const cleaned = stripRedundantRefaccionAskFooter(text);
    expect(cleaned).toMatch(/fascia/i);
    expect(cleaned).not.toMatch(/Nota de Refacción/i);
    expect(cleaned).not.toMatch(/Calavera_TI/);
  });
});
