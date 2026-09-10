import {
  precioSugeridoAlCliente,
  redondearRefaccionA50,
} from './refaccion-catalog-pricing';

describe('refaccion-catalog-pricing', () => {
  it('aplica costo × (1 + margen/100) y redondea a peso', () => {
    expect(precioSugeridoAlCliente(2200, 30)).toBe(2860);
    expect(precioSugeridoAlCliente(3800, 30)).toBe(4940);
    expect(precioSugeridoAlCliente(1000, 0)).toBe(1000);
  });

  it('nunca devuelve NaN', () => {
    expect(precioSugeridoAlCliente(Number.NaN, 30)).toBe(0);
    expect(precioSugeridoAlCliente(1000, Number.NaN)).toBe(1300);
    expect(precioSugeridoAlCliente(undefined, undefined)).toBe(0);
    expect(precioSugeridoAlCliente('abc', 'x')).toBe(0);
    expect(Number.isFinite(precioSugeridoAlCliente(Infinity, 30))).toBe(true);
  });

  it('redondea mercado a múltiplos de 50', () => {
    expect(redondearRefaccionA50(2860)).toBe(2850);
    expect(redondearRefaccionA50(Number.NaN)).toBe(0);
    expect(redondearRefaccionA50(-10)).toBe(0);
  });
});
