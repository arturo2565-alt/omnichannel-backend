import { cartDiffersFromSendSnapshot } from './quote-cart-aggregate';

describe('cotización progresiva post-envío', () => {
  it('detecta quitar salpicadera tras snapshot de $14,100', () => {
    const snapshot = {
      sentAt: '2026-06-10T14:05:00.000Z',
      total: 14100,
      subtotal: 14100,
      desglose: [
        { pieza: 'Fascia delantera', severidad: 'DL', precioMx: 3300 },
        { pieza: 'Fascia trasera', severidad: 'DL', precioMx: 2900 },
        { pieza: 'Cofre', severidad: 'DM', precioMx: 5000 },
        { pieza: 'Salpicadera izquierda', severidad: 'DL', precioMx: 2900 },
      ],
    };

    const cartAfterRemove = {
      estimateAmount: 11100,
      items: [
        { pieza: 'FD', severidad: 'DL', precioMx: 3300 },
        { pieza: 'FT', severidad: 'DL', precioMx: 2900 },
        { pieza: 'Cofre', severidad: 'DM', precioMx: 5000 },
      ],
      quotePayload: { lastSendSnapshot: snapshot },
    };

    expect(
      cartDiffersFromSendSnapshot(
        cartAfterRemove as Parameters<typeof cartDiffersFromSendSnapshot>[0],
        snapshot,
      ),
    ).toBe(true);
  });
});
