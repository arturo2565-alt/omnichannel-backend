import {
  isAutoAprobableSeveridad,
  normalizeSeveridadInferida,
  parseActualizarCotizacionExistenteArgs,
  resolverPiezaEnCatalogo,
} from './actualizar-cotizacion-existente';
import { createMatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';

describe('actualizar-cotizacion-existente', () => {
  const snap = createMatrixPricingSnapshot([
    { servicio: 'Fascia', severidad: 'DL', precio: 3500, diasEntrega: 3, isInstantService: true },
    { servicio: 'Fascia', severidad: 'DM', precio: 8500, diasEntrega: 5, isInstantService: false },
    { servicio: 'Puerta', severidad: 'DL', precio: 4200, diasEntrega: 3, isInstantService: true },
  ]);

  it('parsea piezasOServicios con severidadInferida obligatoria', () => {
    const parsed = parseActualizarCotizacionExistenteArgs(
      JSON.stringify({
        piezasOServicios: ['fascia trasera', 'puerta delantera'],
        severidadInferida: 'DL',
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.piezasOServicios).toEqual([
        'fascia trasera',
        'puerta delantera',
      ]);
      expect(parsed.data.severidadInferida).toBe('DL');
    }
  });

  it('rechaza args sin severidadInferida', () => {
    const parsed = parseActualizarCotizacionExistenteArgs(
      JSON.stringify({ piezaOServicio: 'fascia trasera' }),
    );
    expect(parsed.ok).toBe(false);
  });

  it('ignora cotizacionId alucinado y acepta piezaOServicio única', () => {
    const parsed = parseActualizarCotizacionExistenteArgs(
      JSON.stringify({
        cotizacionId: '12345',
        quoteId: '999',
        piezaOServicio: 'fascia trasera',
        severidadInferida: 'DL',
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.piezasOServicios).toEqual(['fascia trasera']);
      expect('cotizacionId' in parsed.data).toBe(false);
    }
  });

  it('normaliza severidad legacy a DM/DF', () => {
    expect(normalizeSeveridadInferida('DML')).toBe('DM');
    expect(normalizeSeveridadInferida('DMFuerte')).toBe('DF');
    expect(isAutoAprobableSeveridad('DL')).toBe(true);
    expect(isAutoAprobableSeveridad('DM')).toBe(false);
  });

  it('resuelve FT con precio DL cuando severidadInferida es DL', () => {
    const r = resolverPiezaEnCatalogo('fascia trasera', snap, {
      severidadInferida: 'DL',
      descripcionDano: 'solo rayada',
    });
    expect(r.panelCode).toBe('FT');
    expect(r.precioCatalogo).toBe(3500);
    expect(r.autoAprobable).toBe(true);
    expect(r.requiereRevisionManual).toBe(false);
  });

  it('DM usa precio catálogo como base pero requiere revisión humana', () => {
    const r = resolverPiezaEnCatalogo('fascia trasera', snap, {
      severidadInferida: 'DM',
    });
    expect(r.precioCatalogo).toBe(8500);
    expect(r.autoAprobable).toBe(false);
    expect(r.requiereRevisionManual).toBe(true);
  });

  it('marca revisión manual sin match en catálogo', () => {
    const r = resolverPiezaEnCatalogo('pieza inventada xyz', snap, {
      severidadInferida: 'DL',
    });
    expect(r.requiereRevisionManual).toBe(true);
    expect(r.precioCatalogo).toBe(0);
  });
});
