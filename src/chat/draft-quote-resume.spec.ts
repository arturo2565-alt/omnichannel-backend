import {
  buildDamagePhotoIntroForCliente,
  filterLineRowsForPiezaCodes,
  lineRowMatchesPiezaCode,
  resolvePiezaDisplayLabel,
} from './draft-quote-resume';

describe('draft-quote-resume pieza matching', () => {
  it('resolvePiezaDisplayLabel traduce códigos de panel', () => {
    expect(resolvePiezaDisplayLabel('FD')).toMatch(/fascia/i);
    expect(resolvePiezaDisplayLabel('Cofre')).toBe('Cofre');
  });

  it('lineRowMatchesPiezaCode enlaza código FD con Fascia delantera', () => {
    expect(
      lineRowMatchesPiezaCode(
        { pieza: 'Fascia delantera' },
        'FD',
      ),
    ).toBe(true);
    expect(
      lineRowMatchesPiezaCode({ pieza: 'Puerta' }, 'FD'),
    ).toBe(false);
  });

  it('filterLineRowsForPiezaCodes devuelve solo piezas nuevas del complemento', () => {
    const rows = [
      { pieza: 'Fascia delantera', precioMx: 3200 },
      { pieza: 'Puerta', precioMx: 3100 },
      { pieza: 'Cofre', precioMx: 4500 },
    ];
    const filtered = filterLineRowsForPiezaCodes(rows, ['Cofre']);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.pieza).toBe('Cofre');
    expect(filtered[0]?.precioMx).toBe(4500);
  });

  it('buildDamagePhotoIntroForCliente usa nombres legibles sin duplicar códigos', () => {
    const intro = buildDamagePhotoIntroForCliente(
      {
        inventory: [
          { pieza: 'FD' },
          { pieza: 'FT' },
          { pieza: 'PDI' },
          { pieza: 'Cofre' },
        ],
        pieza: 'FD + FT (+2 más)',
      },
      2,
    );
    expect(intro).toContain('Fascia delantera');
    expect(intro).toContain('Fascia trasera');
    expect(intro).not.toContain('FD + FT');
    expect(intro).not.toMatch(/FD.*FD/);
  });
});
