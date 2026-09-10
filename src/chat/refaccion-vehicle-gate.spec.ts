import {
  buildConsolidatedRefaccionAskNote,
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

  it('acepta Mazda 2 2018 sin pedir versión', () => {
    const id = parseVehicleYearAndModel('Mazda 2 2018');
    expect(id.marca).toBe('Mazda');
    expect(id.modelo).toBe('2');
    expect(id.anio).toBe('2018');
    expect(id.confirmed).toBe(true);
    expect(id.label).toBe('Mazda 2 2018');
  });

  it('acepta Mazda 2 2020', () => {
    const id = parseVehicleYearAndModel('Mazda 2 2020');
    expect(id.confirmed).toBe(true);
    expect(id.anio).toBe('2020');
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

  it('pregunta marca, modelo y año — nunca versión', () => {
    const one = buildConsolidatedRefaccionAskNote(['Calavera izquierda']);
    expect(one).toMatch(/Calavera izquierda/);
    expect(one).toMatch(/marca, modelo y año/);
    expect(one).toMatch(/Mazda 2 2018/);
    expect(one).not.toMatch(/versi[oó]n/i);
    expect(one).not.toMatch(/\$/);

    const many = buildConsolidatedRefaccionAskNote([
      'Calavera izquierda',
      'Faro de niebla izquierdo',
    ]);
    expect(many).toMatch(/• Calavera izquierda/);
    expect(many).toMatch(/• Faro de niebla izquierdo/);
    expect((many.match(/Nota de Refacción/g) ?? []).length).toBe(1);
  });
});
