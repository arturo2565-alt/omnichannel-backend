import {
  enrichDesgloseWithInternalRanges,
  findSentPriceForInventoryPieza,
  parseInternalDamageRangeFromText,
  quoteRowsPreservingLastSend,
  resolvePrecioMaximoFromDraftLines,
} from './quote-cart-send-price-preservation';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';

function mockPricingSnap(
  prices: Record<string, number>,
): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: (canonical: string, level: string) =>
      prices[`${canonical}|${level}`] ??
      prices[canonical] ??
      0,
    getAmount: (pieza: string, level: string) =>
      prices[`${pieza}|${level}`] ?? 0,
  } as MatrixPricingSnapshot;
}

describe('quote-cart-send-price-preservation', () => {
  const sentSnapshot = {
    sentAt: '2026-06-10T14:00:00.000Z',
    total: 18900,
    subtotal: 18900,
    desglose: [
      { pieza: 'Fascia delantera', severidad: 'DL', precioMx: 3600 },
      { pieza: 'Salpicadera izquierda', severidad: 'DL', precioMx: 3750 },
      {
        pieza: 'Posibles daños internos',
        severidad: 'N/A',
        precioMx: 1500,
        precioMaximo: 3000,
      },
      { pieza: 'Puerta delantera izquierda', severidad: 'DL', precioMx: 3450 },
      {
        pieza: 'Salpicadera trasera izquierda',
        severidad: 'DL',
        precioMx: 2900,
      },
      { pieza: 'Puerta trasera izquierda', severidad: 'DL', precioMx: 3700 },
    ],
  };

  const priorLines = [
    {
      priceItemId: 'panel:2:internal-damage',
      description:
        'Posibles daños internos — $1,500 - $3,000 MXN (sujeto a desarme)',
      quantity: 1,
      unitPrice: 1500,
      subtotal: 1500,
    },
  ];

  it('parsea rango de daños internos desde descripción', () => {
    expect(
      parseInternalDamageRangeFromText(
        'Posibles daños internos — $1,500 - $3,000 MXN (sujeto a desarme)',
      ),
    ).toEqual({ min: 1500, max: 3000 });
  });

  it('empareja inventario FD con snapshot Fascia delantera', () => {
    const sent = findSentPriceForInventoryPieza('FD', sentSnapshot.desglose);
    expect(sent?.precioMx).toBe(3600);
  });

  it('enriquece desglose con precioMaximo desde líneas del borrador', () => {
    const base = [
      {
        pieza: 'Posibles daños internos',
        severidad: 'N/A',
        precioMx: 1500,
      },
    ];
    const enriched = enrichDesgloseWithInternalRanges(base, priorLines);
    expect(enriched[0]?.precioMaximo).toBe(3000);
  });

  it('conserva precios enviados y solo cotiza matriz la pieza nueva', () => {
    const inventory = [
      { pieza: 'FD', severidad: 'DL', descripcionTecnica: 'x', urls_origen: [] },
      { pieza: 'SI', severidad: 'DL', descripcionTecnica: 'x', urls_origen: [] },
      {
        pieza: 'PDI_INT',
        severidad: 'N/A',
        descripcionTecnica: 'rango',
        urls_origen: [],
      },
      { pieza: 'PDI', severidad: 'DL', descripcionTecnica: 'x', urls_origen: [] },
      { pieza: 'STI', severidad: 'DL', descripcionTecnica: 'x', urls_origen: [] },
      { pieza: 'PTI', severidad: 'DL', descripcionTecnica: 'x', urls_origen: [] },
      {
        pieza: 'Cofre',
        severidad: 'DL',
        descripcionTecnica: 'rayones',
        urls_origen: [],
      },
    ];

    const snap = mockPricingSnap({
      'Cofre|DL': 4500,
      'Fascia|DL': 3250,
    });

    const rows = quoteRowsPreservingLastSend(
      inventory,
      snap,
      null,
      null,
      sentSnapshot,
      priorLines,
      { matrixPricePiezaCodes: ['Cofre'] },
    );

    expect(rows).toHaveLength(7);
    expect(rows[0]?.precioMx).toBe(3600);
    expect(rows[1]?.precioMx).toBe(3750);
    expect(rows[2]?.precioMx).toBe(1500);
    expect(rows[2]?.precioMaximo).toBe(3000);
    expect(rows[6]?.pieza).toBe('Cofre');
    expect(rows[6]?.precioMx).toBe(4500);

    const total = rows.reduce((acc, r) => acc + r.precioMx, 0);
    expect(total).toBe(18900 + 4500);
  });

  it('resolvePrecioMaximoFromDraftLines lee líneas internal-damage', () => {
    expect(resolvePrecioMaximoFromDraftLines(priorLines)).toBe(3000);
  });
});
