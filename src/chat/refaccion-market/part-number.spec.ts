import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildPartNumberPivotQueries,
  extractPartNumbers,
  normalizePartNumber,
} from './part-number';
import { resolveMarketPartIdentity } from './resolved-market-part';
import { parseVehiclePartIdentity } from './parse-vehicle-part-identity';

const altima = parseVehiclePartIdentity({
  vehiculoText: 'Nissan Altima 2014',
  pieza: 'Calavera_Derecha',
});

describe('part-number discovery', () => {
  it('normaliza uppercase, espacios y guiones', () => {
    expect(normalizePartNumber('26550- 3tg0b')).toBe('26550-3TG0B');
    expect(normalizePartNumber(' 28667 ')).toBe('28667');
  });

  it('extrae aftermarket DEPO 28667 y genera pivot', () => {
    const found = extractPartNumbers(
      'DEPO 28667 Calavera derecha Altima 2013-2016',
    );
    expect(found).toEqual([
      { raw: '28667', normalized: '28667', kind: 'AFTERMARKET' },
    ]);
    const pivots = buildPartNumberPivotQueries('28667', {
      marca: 'Nissan',
      modelo: 'Altima',
    });
    expect(pivots).toContain('"28667"');
    expect(pivots).toContain('"28667" Nissan Altima');
    expect(pivots).toContain('"28667" México');
    const resolved = resolveMarketPartIdentity(altima, found);
    expect(resolved.aftermarketPartNumbers).toEqual(['28667']);
    expect(resolved.oemPartNumbers).toEqual([]);
  });

  it('extrae OEM 26550-3TG0B', () => {
    const found = extractPartNumbers('26550-3TG0B Nissan Altima Tail Lamp');
    expect(found).toEqual([
      { raw: '26550-3TG0B', normalized: '26550-3TG0B', kind: 'OEM' },
    ]);
    const resolved = resolveMarketPartIdentity(altima, found);
    expect(resolved.oemPartNumbers).toEqual(['26550-3TG0B']);
  });

  it('no hardcodea números de un vehículo concreto', () => {
    const src = readFileSync(join(__dirname, 'part-number.ts'), 'utf8');
    expect(src).not.toMatch(/26550-3TA0B/);
    expect(src).not.toMatch(/NI2801195/);
    expect(src).not.toContain('26550-3TG0B');
  });
});
