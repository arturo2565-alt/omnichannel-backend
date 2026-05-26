import {
  collapseVisionItemsToBpcIfNeeded,
  isVisionBpcPiezaCode,
  visionItemsIndicateBanioCompleto,
} from './vision-bpc-inventory';

describe('vision-bpc-inventory', () => {
  it('detecta BPC en pieza', () => {
    expect(isVisionBpcPiezaCode('BPC')).toBe(true);
    expect(isVisionBpcPiezaCode('bpc')).toBe(true);
    expect(isVisionBpcPiezaCode('Cofre')).toBe(false);
  });

  it('colapsa piezas sueltas cuando hay BPC', () => {
    const items = [
      {
        pieza: 'BPC',
        severidad: 'DM',
        descripcionTecnica: 'Baño completo',
        urls_origen: ['https://a/1.jpg'],
      },
      {
        pieza: 'Cofre',
        severidad: 'DMF',
        descripcionTecnica: 'Golpe cofre',
        urls_origen: ['https://a/2.jpg'],
      },
      {
        pieza: 'FD',
        severidad: 'DL',
        descripcionTecnica: 'Raya fascia',
        urls_origen: [],
      },
    ];
    const out = collapseVisionItemsToBpcIfNeeded(
      items,
      'Es un Volkswagen Passat 2020, quiero baño de pintura completo',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.pieza).toBe('BPC');
    expect(out[0]!.severidad).toBe('Grande');
    expect(out[0]!.urls_origen).toEqual(
      expect.arrayContaining(['https://a/1.jpg', 'https://a/2.jpg']),
    );
    expect(visionItemsIndicateBanioCompleto(out)).toBe(true);
  });

  it('respeta intencion_banio_completo_detectada sin sigla BPC', () => {
    const items = [
      {
        pieza: 'Cofre',
        severidad: 'DM',
        descripcionTecnica: 'x',
        urls_origen: [],
      },
    ];
    const out = collapseVisionItemsToBpcIfNeeded(items, 'baño completo', {
      intencion_banio_completo_detectada: true,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.pieza).toBe('BPC');
  });
});
