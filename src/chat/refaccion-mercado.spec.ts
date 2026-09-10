import {
  looksLikeEvidentBreakage,
  looksLikeOpticaOrUnusablePart,
  precioAlClienteConMargen,
  buildRefaccionDisclaimer,
  buildConsolidatedRefaccionQuoteNote,
  buildRefaccionMarketQuery,
  selectViableMlPrices,
  buscarCostoRefaccionOnline,
  estimarCostoBasePorCategoria,
} from './refaccion-mercado';
import { extractMxnPricesFromText } from './refaccion-web-search';

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
      /pieza nueva/i,
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

  it('arma query web México/CDMX', () => {
    expect(
      buildRefaccionMarketQuery({
        pieza: 'Calavera_Izquierda',
        marca: 'Mazda',
        modelo: '2',
        anio: '2018',
      }),
    ).toBe('precio "Calavera izquierda" "Mazda 2" 2018 comprar mexico cdmx');
  });

  it('agrupa varias refacciones en un solo bloque', () => {
    const block = buildConsolidatedRefaccionQuoteNote([
      { label: 'Calavera izquierda', monto: 2850, fuente: 'web' },
      { label: 'Faro de niebla izquierdo', monto: 1450, fuente: 'web' },
    ]);
    expect((block.match(/Nota de Refacción/g) ?? []).length).toBe(1);
    expect(block).toMatch(/• Calavera izquierda — \$2,850/);
    expect(block).toMatch(/• Faro de niebla izquierdo — \$1,450/);
  });

  it('extrae MXN y excluye años', () => {
    const prices = extractMxnPricesFromText(
      'Calavera 2018 Mazda 2 en $1,850 MXN y otra en $2,200 pesos CDMX',
    );
    expect(prices).toEqual([1850, 2200]);
  });

  it('estima por gama Compacto para óptica', () => {
    expect(estimarCostoBasePorCategoria('Calavera_Izquierda', 'Compacto')).toBe(
      2200,
    );
    expect(precioAlClienteConMargen(2200)).toBe(2850);
  });

  it('toma 3 a 5 precios MXN y descarta otras monedas', () => {
    const prices = selectViableMlPrices([
      { price: 1800, currency_id: 'MXN' },
      { price: 2200, currency_id: 'USD' },
      { price: 2100, currency_id: 'MXN' },
      { price: 2500, currency_id: 'MXN' },
      { price: 50, currency_id: 'MXN' },
      { price: 2700, currency_id: 'MXN' },
      { price: 3000, currency_id: 'MXN' },
    ]);
    expect(prices).toEqual([1800, 2100, 2500, 2700, 3000]);
  });

  it('exige marca/modelo/año y si no hay web usa estimado por gama', async () => {
    const missing = await buscarCostoRefaccionOnline({
      pieza: 'Calavera_Izquierda',
      vehiculo: 'Jetta',
    });
    expect(missing.success).toBe(false);
    expect(missing.requiereAnioModelo).toBe(true);
    expect(missing.precioAlCliente).toBe(0);

    const origFetch = global.fetch;
    global.fetch = (async () =>
      ({
        ok: true,
        json: async () => ({ results: [] }),
      })) as typeof fetch;
    try {
      const fallback = await buscarCostoRefaccionOnline({
        pieza: 'Calavera_Izquierda',
        marca: 'Mazda',
        modelo: '2',
        anio: '2018',
        sizeTier: 'Compacto',
      });
      expect(fallback.success).toBe(true);
      expect(fallback.fuente).toBe('estimacion_categoria');
      expect(fallback.precioAlCliente).toBe(2850);
    } finally {
      global.fetch = origFetch;
    }
  });

  it('calcula mediana +30% redondeado a 50 con 3+ resultados', async () => {
    const origFetch = global.fetch;
    global.fetch = (async () =>
      ({
        ok: true,
        json: async () => ({
          results: [
            { price: 2000, currency_id: 'MXN' },
            { price: 2200, currency_id: 'MXN' },
            { price: 2400, currency_id: 'MXN' },
          ],
        }),
      })) as typeof fetch;
    try {
      const hit = await buscarCostoRefaccionOnline({
        pieza: 'Calavera_Izquierda',
        modelo: 'Jetta',
        anio: '2019',
      });
      expect(hit.success).toBe(true);
      expect(hit.costoBase).toBe(2200);
      expect(hit.precioAlCliente).toBe(2850);
      expect(hit.fuente).toBe('mercadolibre');
    } finally {
      global.fetch = origFetch;
    }
  });
});
