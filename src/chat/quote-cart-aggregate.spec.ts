import {
  buildActiveCartViewFromEntity,
  cartDiffersFromSendSnapshot,
} from './quote-cart-aggregate';

describe('quote-cart-aggregate', () => {
  it('expone desglose y total del carrito activo', () => {
    const cart = {
      id: 'c1',
      estimateAmount: 5800,
      damageAnalysis: { quoteCartMeta: { cartRole: 'primary' } },
      items: [
        { pieza: 'FD', severidad: 'DL', precioMx: 2900, sortOrder: 0 },
        { pieza: 'FT', severidad: 'DL', precioMx: 2900, sortOrder: 1 },
      ],
      quotePayload: { lines: [], sendCount: 0 },
    } as unknown as Parameters<typeof buildActiveCartViewFromEntity>[0];

    const view = buildActiveCartViewFromEntity(cart);

    expect(view.totalGlobal).toBe(5800);
    expect(view.estadoCarrito).toBe('activo');
    expect(view.desglose).toHaveLength(2);
    expect(view.sendCount).toBe(0);
  });

  it('marca activo_modificado cuando el carrito difiere del último envío', () => {
    const cart = {
      id: 'c1',
      estimateAmount: 11100,
      items: [
        { pieza: 'FD', severidad: 'DL', precioMx: 3300, sortOrder: 0 },
        { pieza: 'FT', severidad: 'DL', precioMx: 2900, sortOrder: 1 },
        { pieza: 'Cofre', severidad: 'DM', precioMx: 5000, sortOrder: 2 },
      ],
      quotePayload: {
        lines: [],
        sendCount: 1,
        lastSendSnapshot: {
          sentAt: '2026-06-10T12:00:00.000Z',
          total: 14100,
          subtotal: 14100,
          desglose: [
            { pieza: 'Fascia delantera', severidad: 'DL', precioMx: 3300 },
            { pieza: 'Fascia trasera', severidad: 'DL', precioMx: 2900 },
            { pieza: 'Cofre', severidad: 'DM', precioMx: 5000 },
            { pieza: 'Salpicadera izquierda', severidad: 'DL', precioMx: 2900 },
          ],
        },
      },
      damageAnalysis: {},
    } as unknown as Parameters<typeof buildActiveCartViewFromEntity>[0];

    expect(cartDiffersFromSendSnapshot(cart!, cart!.quotePayload!.lastSendSnapshot)).toBe(
      true,
    );

    const view = buildActiveCartViewFromEntity(cart);
    expect(view.estadoCarrito).toBe('activo_modificado');
    expect(view.hayCambiosDesdeUltimoEnvio).toBe(true);
    expect(view.totalGlobal).toBe(11100);
  });
});
