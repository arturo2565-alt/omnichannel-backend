import {
  buildRefaccionYearAskNote,
  extractVehicleYear,
  hasConfirmedYearAndModel,
  parseVehicleYearAndModel,
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
});
