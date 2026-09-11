import {
  pickRefaccionClienteQuote,
} from './refaccion-mercado';
import {
  quoteRowsFromDamageInventory,
  resolveMontajePinturaPrice,
} from './draft-quote-inventory-pricing';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';

function mockPricingSnap(
  prices: Record<string, number>,
): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: (canonical: string, level: string) =>
      prices[`${canonical}|${level}`] ?? 0,
    getAmount: (pieza: string, level: string) =>
      prices[`${pieza}|${level}`] ?? 0,
    getDiasEntregaForCanonical: () => 5,
    listSeveridadesForCanonical: () => ['DL', 'MONTAJE_PINTURA'],
  } as MatrixPricingSnapshot;
}

describe('substitution pricing sources', () => {
  it('si existe MONTAJE_PINTURA nunca usa DL', () => {
    const snap = mockPricingSnap({
      'Cofre|MONTAJE_PINTURA': 6900,
      'Cofre|DL': 4000,
      'Cofre|LEVE': 4500,
    });
    const resolved = resolveMontajePinturaPrice(snap, 'Cofre');
    expect(resolved.precio).toBe(6900);
    expect(resolved.priceSource).toBe('AUTOFIX_CATALOG');

    const rows = quoteRowsFromDamageInventory(
      [
        {
          pieza: 'Cofre',
          severidad: 'DMFuerte',
          descripcionTecnica: 'Cofre',
          urls_origen: [],
          tratamiento: 'SUSTITUIR',
          precioMx: 8500,
          priceSource: 'AUTOFIX_CATALOG',
        },
      ],
      snap,
    );
    const montaje = rows.find((r) => r.serviceType === 'MONTAJE_PINTURA');
    expect(montaje?.precioMx).toBe(6900);
    expect(montaje?.priceSource).toBe('AUTOFIX_CATALOG');
    expect(montaje?.severidad).toBe('MONTAJE_PINTURA');
  });

  it('si no existe MONTAJE_PINTURA identifica LEGACY_REPAIR_MATRIX_FALLBACK', () => {
    const snap = mockPricingSnap({
      'Fascia|DL': 2900,
      'Fascia|LEVE': 2900,
    });
    const resolved = resolveMontajePinturaPrice(snap, 'Fascia');
    expect(resolved.precio).toBe(2900);
    expect(resolved.priceSource).toBe('LEGACY_REPAIR_MATRIX_FALLBACK');

    const rows = quoteRowsFromDamageInventory(
      [
        {
          pieza: 'FD',
          severidad: 'DF',
          descripcionTecnica: 'Fascia',
          urls_origen: [],
          tratamiento: 'SUSTITUIR',
          precioMx: 3650,
          priceSource: 'FALLBACK',
        },
      ],
      snap,
    );
    const montaje = rows.find((r) => r.serviceType === 'MONTAJE_PINTURA');
    expect(montaje?.precioMx).toBe(2900);
    expect(montaje?.priceSource).toBe('LEGACY_REPAIR_MATRIX_FALLBACK');
    const refaccion = rows.find((r) => r.serviceType === 'REFACCION');
    expect(refaccion?.priceSource).toBe('FALLBACK');
  });

  it('precio AutoFix de refacción gana sobre mercado y fallback', () => {
    const picked = pickRefaccionClienteQuote({
      catalogo: {
        precioAlCliente: 11200,
        costoReferenciaBase: 8600,
        nombre: 'Cofre AutoFix',
      },
      mercado: { precioAlCliente: 7200, costoBase: 5500, fuente: 'mercadolibre' },
      pieza: 'Cofre',
    });
    expect(picked.priceSource).toBe('AUTOFIX_CATALOG');
    expect(picked.precioAlCliente).toBe(11200);
  });

  it('mercado gana sobre fallback', () => {
    const picked = pickRefaccionClienteQuote({
      catalogo: null,
      mercado: { precioAlCliente: 7200, costoBase: 5500, fuente: 'mercadolibre' },
      pieza: 'FD',
    });
    expect(picked.priceSource).toBe('MARKET');
    expect(picked.precioAlCliente).toBe(7200);
  });

  it('FALLBACK queda identificado y no se presenta como catálogo', () => {
    const picked = pickRefaccionClienteQuote({
      catalogo: null,
      mercado: { precioAlCliente: 5850, costoBase: 4500, fuente: 'estimacion' },
      pieza: 'Cofre',
    });
    expect(picked.priceSource).toBe('FALLBACK');
    expect(picked.precioAlCliente).toBe(5850);
  });
});
