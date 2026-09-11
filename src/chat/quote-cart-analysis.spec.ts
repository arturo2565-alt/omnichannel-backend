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

  it('elimina BPC previo al acumular piezas sueltas desde visión', () => {
    const prior = [
      {
        pieza: 'BPC',
        severidad: 'DM',
        descripcionTecnica: 'Baño completo previo.',
        urls_origen: [],
      },
    ];
    const incoming = [
      {
        pieza: 'Toldo',
        severidad: 'DL',
        descripcionTecnica: 'Cliente pidió solo toldo.',
        urls_origen: [],
      },
    ];

    const result = mergeVisionIntoPriorInventory(prior, incoming);

    expect(result.mergedInventory.map((i) => i.pieza)).toEqual(['Toldo']);
    expect(result.complementMeta?.previousPiezas ?? []).not.toContain('BPC');
  });

  it('conserva tratamiento en el merge inicial sin carrito previo', () => {
    const result = mergeVisionIntoPriorInventory(
      [],
      [
        {
          pieza: 'FD',
          severidad: 'DMFuerte',
          descripcionTecnica: 'Fascia',
          urls_origen: [],
          tratamiento: 'SUSTITUIR',
        },
        {
          pieza: 'Cofre',
          severidad: 'DMFuerte',
          descripcionTecnica: 'posible reemplazo de refacción',
          urls_origen: [],
          tratamiento: 'REPARAR',
          posibleReemplazoRefaccion: true,
        },
      ],
    );
    const fd = result.mergedInventory.find((i) => i.pieza === 'FD');
    const cofre = result.mergedInventory.find((i) => i.pieza === 'Cofre');
    expect(fd?.tratamiento).toBe('SUSTITUIR');
    expect(cofre?.tratamiento).toBe('REPARAR');
    expect(cofre?.posibleReemplazoRefaccion).toBe(true);
  });
});
