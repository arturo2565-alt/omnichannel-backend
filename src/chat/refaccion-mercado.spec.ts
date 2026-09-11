import {
  looksLikeEvidentBreakage,
  precioAlClienteConMargen,
  buildRefaccionDisclaimer,
} from './refaccion-mercado';

describe('refaccion-mercado', () => {
  it('aplica +30% y redondea a 50', () => {
    expect(precioAlClienteConMargen(1000)).toBe(1300);
    expect(precioAlClienteConMargen(1100)).toBe(1450);
  });

  it('detecta rotura solo en DF/DMFuerte', () => {
    expect(looksLikeEvidentBreakage('DL', 'pieza rota')).toBe(false);
    expect(looksLikeEvidentBreakage('DF', 'fascia partida')).toBe(true);
    expect(looksLikeEvidentBreakage('DMFuerte', '')).toBe(true);
  });

  it('arma el disclaimer comercial', () => {
    expect(buildRefaccionDisclaimer('Fascia delantera', 1450)).toMatch(
      /Fascia delantera/,
    );
    expect(buildRefaccionDisclaimer('Fascia delantera', 1450)).toMatch(/1,450/);
  });

  it('INSUFFICIENT_MARKET_SAMPLE no inventa precio de unidad', () => {
    expect(
      buildRefaccionDisclaimer('Cofre', 0, 'INSUFFICIENT_MARKET_SAMPLE'),
    ).toMatch(/muestras de mercado suficientes/);
    expect(
      buildRefaccionDisclaimer('Cofre', 0, 'INSUFFICIENT_MARKET_SAMPLE'),
    ).not.toMatch(/5,850|4500/);
  });
});
