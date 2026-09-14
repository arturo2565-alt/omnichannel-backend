import { extractMxnPricesFromText } from './refaccion-web-search';

describe('extractMxnPricesFromText', () => {
  it('parsea fixtures comerciales MXN', () => {
    expect(extractMxnPricesFromText('$2,200')).toEqual([2200]);
    expect(extractMxnPricesFromText('$ 2,200.00 MXN')).toEqual([2200]);
    expect(extractMxnPricesFromText('MXN 2200')).toEqual([2200]);
    expect(extractMxnPricesFromText('2,200 pesos')).toEqual([2200]);
  });

  it('ignora años sueltos sin moneda', () => {
    expect(extractMxnPricesFromText('Nissan Altima 2014 compatible')).toEqual(
      [],
    );
  });

  it('rechaza montos fuera de rango', () => {
    expect(extractMxnPricesFromText('$50')).toEqual([]);
    expect(extractMxnPricesFromText('$90,000')).toEqual([]);
  });
});
