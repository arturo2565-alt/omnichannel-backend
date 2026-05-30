import {
  findPanelPiezaOption,
  normalizePanelPiezaCode,
  resolveCatalogPiezaForMatrixLookup,
  resolveMatrixServicioRaw,
} from './panel-pieza-catalog';

describe('panel-pieza-catalog', () => {
  it('resuelve siglas del panel a pieza base del catálogo', () => {
    expect(resolveCatalogPiezaForMatrixLookup('SI')).toBe('Salpicadera');
    expect(resolveCatalogPiezaForMatrixLookup('PDI')).toBe('Puerta');
    expect(resolveCatalogPiezaForMatrixLookup('PTD')).toBe('Puerta');
    expect(resolveCatalogPiezaForMatrixLookup('EI')).toBe('Estribo');
    expect(resolveCatalogPiezaForMatrixLookup('FD')).toBe('Fascia');
    expect(resolveCatalogPiezaForMatrixLookup('FT')).toBe('Fascia');
    expect(resolveCatalogPiezaForMatrixLookup('POD')).toBe('Poste');
  });

  it('FD permanece Fascia Delantera (no FT) en todo el mapeo', () => {
    expect(normalizePanelPiezaCode('FD')).toBe('FD');
    expect(findPanelPiezaOption('FD')?.code).toBe('FD');
    expect(findPanelPiezaOption('Fascia delantera')?.code).toBe('FD');
    expect(normalizePanelPiezaCode('Fascia')).not.toBe('FT');
  });

  it('FT mapea solo a fascia trasera', () => {
    expect(normalizePanelPiezaCode('FT')).toBe('FT');
    expect(findPanelPiezaOption('Fascia trasera')?.code).toBe('FT');
  });

  it('salpicaderas y postes conservan lateralidad', () => {
    expect(normalizePanelPiezaCode('SD')).toBe('SD');
    expect(normalizePanelPiezaCode('SI')).toBe('SI');
    expect(normalizePanelPiezaCode('STD')).toBe('STD');
    expect(normalizePanelPiezaCode('STI')).toBe('STI');
    expect(normalizePanelPiezaCode('POI')).toBe('POI');
    expect(normalizePanelPiezaCode('POD')).toBe('POD');
  });

  it('no mapea líneas especiales a matriz', () => {
    expect(resolveCatalogPiezaForMatrixLookup('PDI_INT')).toBeNull();
    expect(resolveCatalogPiezaForMatrixLookup('Posibles daños internos')).toBeNull();
    expect(resolveCatalogPiezaForMatrixLookup('REFACCION')).toBeNull();
    expect(resolveCatalogPiezaForMatrixLookup('Refacción: Faro')).toBeNull();
  });

  it('resolveMatrixServicioRaw conserva texto libre si no hay mapeo', () => {
    expect(resolveMatrixServicioRaw('Puerta delantera izquierda')).toBe('Puerta');
    expect(resolveMatrixServicioRaw('Pieza rara XYZ')).toBe('Pieza rara XYZ');
    expect(resolveMatrixServicioRaw('FD')).toBe('Fascia');
  });
});
