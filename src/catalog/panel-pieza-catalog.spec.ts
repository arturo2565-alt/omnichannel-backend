import {
  canonicalizePanelCode,
  findPanelPiezaOption,
  normalizePanelPiezaCode,
  refaccionCatalogCodigoForPieza,
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
    expect(resolveCatalogPiezaForMatrixLookup('CERAMICO')).toBeNull();
    expect(resolveCatalogPiezaForMatrixLookup('ESTETICA_AUTO')).toBeNull();
  });

  it('canonicalizePanelCode cubre códigos y nombres naturales', () => {
    expect(canonicalizePanelCode('FD')).toBe('FD');
    expect(canonicalizePanelCode('fascia delantera')).toBe('FD');
    expect(canonicalizePanelCode('CTI')).toBe('CTI');
    expect(canonicalizePanelCode('costado derecho')).toBe('CTD');
    expect(canonicalizePanelCode('espejo izquierdo')).toBe('ESI');
    expect(canonicalizePanelCode('portón trasero')).toBe('Tapa Cajuela');
    expect(canonicalizePanelCode('BPE')).toBe('BPE');
    expect(canonicalizePanelCode('baño de pintura exterior')).toBe('BPE');
    expect(canonicalizePanelCode('BPCC')).toBe('BPCC');
    expect(resolveCatalogPiezaForMatrixLookup('CTI')).toBe('Salpicadera');
    expect(resolveCatalogPiezaForMatrixLookup('ESI')).toBe('Espejo');
    expect(resolveCatalogPiezaForMatrixLookup('BPE')).toBeNull();
  });

  it('refaccionCatalogCodigoForPieza mapea visión a código de catálogo', () => {
    expect(refaccionCatalogCodigoForPieza('Calavera_TI')).toBe('CAL_IZQ');
    expect(refaccionCatalogCodigoForPieza('calavera trasera derecha')).toBe(
      'CAL_DER',
    );
    expect(refaccionCatalogCodigoForPieza('FARO_IZQ')).toBe('FARO_IZQ');
    expect(refaccionCatalogCodigoForPieza('faro de niebla derecho')).toBe(
      'FARO_NIEBLA_DER',
    );
    expect(refaccionCatalogCodigoForPieza('Puerta')).toBe('PUERTA');
    expect(refaccionCatalogCodigoForPieza('Cofre')).toBe('COFRE');
    expect(refaccionCatalogCodigoForPieza('FD')).toBe('FASCIA_DEL');
    expect(refaccionCatalogCodigoForPieza('FT')).toBe('FASCIA_TRAS');
    expect(refaccionCatalogCodigoForPieza('Tapa Cajuela')).toBe('TAPA_CAJUELA');
    expect(refaccionCatalogCodigoForPieza('SI')).toBe('SALPICADERA');
  });

  it('resolveMatrixServicioRaw conserva texto libre si no hay mapeo', () => {
    expect(resolveMatrixServicioRaw('Puerta delantera izquierda')).toBe('Puerta');
    expect(resolveMatrixServicioRaw('Pieza rara XYZ')).toBe('Pieza rara XYZ');
    expect(resolveMatrixServicioRaw('FD')).toBe('Fascia');
  });
});
