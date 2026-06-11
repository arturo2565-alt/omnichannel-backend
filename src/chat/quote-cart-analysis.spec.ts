import { mergeVisionIntoPriorInventory } from './quote-cart-analysis';

describe('quote-cart-analysis mergeVisionIntoPriorInventory', () => {
  it('conserva piezas de chat/express previas al llegar visión nueva', () => {
    const prior = [
      {
        pieza: 'Toldo',
        severidad: 'DL',
        descripcionTecnica: 'Cotización express — Toldo.',
        urls_origen: [],
      },
    ];
    const incoming = [
      {
        pieza: 'PDI',
        severidad: 'DM',
        descripcionTecnica: 'Rayón profundo puerta delantera izquierda.',
        urls_origen: ['https://cdn.example/photo1.jpg'],
      },
    ];

    const result = mergeVisionIntoPriorInventory(prior, incoming);

    expect(result.mergedInventory).toHaveLength(2);
    expect(result.mergedInventory.map((i) => i.pieza)).toEqual(
      expect.arrayContaining(['Toldo', 'PDI']),
    );
    expect(result.complementMeta?.newPiezas).toContain('PDI');
  });

  it('sube severidad si la misma pieza reaparece en visión', () => {
    const prior = [
      {
        pieza: 'PDI',
        severidad: 'DL',
        descripcionTecnica: 'Previo.',
        urls_origen: [],
      },
    ];
    const incoming = [
      {
        pieza: 'Puerta delantera izquierda',
        severidad: 'DM',
        descripcionTecnica: 'Golpe nuevo.',
        urls_origen: ['https://cdn.example/photo2.jpg'],
      },
    ];

    const result = mergeVisionIntoPriorInventory(prior, incoming);

    expect(result.mergedInventory).toHaveLength(1);
    expect(result.mergedInventory[0]!.severidad).toBe('DM');
    expect(result.mergedInventory[0]!.urls_origen).toContain(
      'https://cdn.example/photo2.jpg',
    );
  });
});
