import {
  classifyQuoteRow,
  quoteRowSubtotalForTotal,
  sumQuoteRowsSubtotal,
} from './draft-quote-inventory-pricing';

describe('draft-quote-inventory-pricing', () => {
  it('suma el mínimo en daños internos y el precio manual en refacciones', () => {
    const lines = [
      {
        pieza: 'Posibles daños internos',
        severidad: 'N/A',
        precioMx: 3000,
        precioMaximo: 8000,
      },
      {
        pieza: 'Refacción: Calavera',
        severidad: 'N/A',
        precioMx: 1500,
        detallesRefaccion: 'Calavera',
      },
      { pieza: 'PDI', severidad: 'DM', precioMx: 4200 },
    ];
    expect(sumQuoteRowsSubtotal(lines)).toBe(3000 + 1500 + 4200);
    expect(classifyQuoteRow(lines[0])).toBe('internal_damage');
    expect(classifyQuoteRow(lines[1])).toBe('refaccion');
    expect(quoteRowSubtotalForTotal(lines[0])).toBe(3000);
  });
});
