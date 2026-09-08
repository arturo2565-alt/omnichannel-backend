import {
  extractVisionViability,
  mergeVisionViability,
  resolveClienteAclaracion,
} from './vision-viability';

describe('vision-viability', () => {
  it('lee peritaje_viable false y motivo', () => {
    const v = extractVisionViability({
      peritaje_viable: false,
      motivo_inviable: 'FOTO_BORROSA',
      items: [],
    });
    expect(v.peritajeViable).toBe(false);
    expect(v.motivoInviable).toBe('FOTO_BORROSA');
    expect(resolveClienteAclaracion(v)).toMatch(/borrosa/i);
  });

  it('asume viable si el campo falta', () => {
    expect(extractVisionViability({ items: [{ pieza: 'FD' }] }).peritajeViable).toBe(
      true,
    );
  });

  it('merge: un lote viable gana', () => {
    const m = mergeVisionViability([
      {
        itemCount: 0,
        viability: { peritajeViable: false, motivoInviable: 'NO_ES_AUTO' },
      },
      { itemCount: 2, viability: { peritajeViable: true } },
    ]);
    expect(m.peritajeViable).toBe(true);
  });
});
