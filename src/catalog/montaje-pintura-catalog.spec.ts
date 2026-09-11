import { aggregateMontajePinturaRows } from './montaje-pintura-catalog';

describe('montaje-pintura-catalog', () => {
  it('agrega celdas dedicadas y marca hasDedicatedRate', () => {
    const rows = aggregateMontajePinturaRows([
      {
        id: '1',
        servicio: 'Cofre',
        severidad: 'MONTAJE_PINTURA',
        precio: 6900,
        diasEntrega: 4,
      },
      {
        id: '2',
        servicio: 'Fascia',
        severidad: 'DL',
        precio: 2900,
        diasEntrega: 4,
      },
    ]);
    const cofre = rows.find((r) => r.servicio === 'Cofre');
    const fascia = rows.find((r) => r.servicio === 'Fascia');
    expect(cofre?.hasDedicatedRate).toBe(true);
    expect(cofre?.precio).toBe(6900);
    expect(fascia?.hasDedicatedRate).toBe(false);
    expect(fascia?.precio).toBe(0);
  });
});
