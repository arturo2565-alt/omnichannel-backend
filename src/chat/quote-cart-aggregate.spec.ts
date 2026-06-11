import { buildAggregatedCartViewFromEntities } from './quote-cart-aggregate';

describe('quote-cart-aggregate', () => {
  it('suma aprobado + complemento pendiente en totalGlobal', () => {
    const approved = [
      {
        id: 'a1',
        estimateAmount: 4500,
        items: [
          { pieza: 'Toldo', severidad: 'DL', precioMx: 4500, sortOrder: 0 },
        ],
        quotePayload: { lines: [] },
        damageAnalysis: {},
      },
    ] as unknown as Parameters<typeof buildAggregatedCartViewFromEntities>[1][number][];

    const pending = {
      id: 'p1',
      estimateAmount: 3200,
      damageAnalysis: {
        quoteCartMeta: { cartRole: 'complement', complementOfDraftId: 'a1' },
      },
      items: [
        { pieza: 'PDI', severidad: 'DL', precioMx: 3200, sortOrder: 0 },
      ],
      quotePayload: { lines: [] },
    } as unknown as Parameters<typeof buildAggregatedCartViewFromEntities>[0];

    const view = buildAggregatedCartViewFromEntities(pending, approved);

    expect(view.totalGlobal).toBe(7700);
    expect(view.estadoCarrito).toBe('complemento_pendiente');
    expect(view.totalAprobado).toBe(4500);
    expect(view.totalComplemento).toBe(3200);
    expect(view.desgloseAprobado).toHaveLength(1);
    expect(view.desgloseComplemento).toHaveLength(1);
  });
});
