import {
  looksLikeEvidentBreakage,
  looksLikeOpticaOrUnusablePart,
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

  it('arma el disclaimer comercial de pieza nueva + montaje', () => {
    expect(buildRefaccionDisclaimer('Fascia delantera', 1450)).toMatch(
      /Fascia delantera/,
    );
    expect(buildRefaccionDisclaimer('Fascia delantera', 1450)).toMatch(/1,450/);
    expect(buildRefaccionDisclaimer('Calavera izquierda', 2860, 'catalogo')).toMatch(
      /pieza nueva/,
    );
    expect(buildRefaccionDisclaimer('Calavera izquierda', 2860, 'catalogo')).toMatch(
      /montaje/,
    );
  });

  it('detecta rotura de óptica con lenguaje de quiebre aunque no sea DF', () => {
    expect(
      looksLikeOpticaOrUnusablePart(
        'Calavera_Izquierda',
        'DM',
        'calavera estrellada e inservible',
      ),
    ).toBe(true);
    expect(looksLikeOpticaOrUnusablePart('Faro_Izquierdo', 'DF', '')).toBe(true);
    expect(looksLikeOpticaOrUnusablePart('FD', 'DL', 'pieza rota')).toBe(false);
  });
});
