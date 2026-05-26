import {
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
  });
});
