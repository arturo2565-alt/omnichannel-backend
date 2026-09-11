import {
  looksLikeEvidentBreakage,
  precioAlClienteConMargen,
  buildRefaccionDisclaimer,
  pickRefaccionClienteQuote,
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

  it('prioriza catálogo AutoFix sobre mercado y fallback', () => {
    const picked = pickRefaccionClienteQuote({
      catalogo: { precioAlCliente: 9900, costoReferenciaBase: 7600, nombre: 'Cofre OEM' },
      mercado: { precioAlCliente: 5850, costoBase: 4500, fuente: 'estimacion' },
      pieza: 'Cofre',
    });
    expect(picked.priceSource).toBe('AUTOFIX_CATALOG');
    expect(picked.precioAlCliente).toBe(9900);
  });
});
