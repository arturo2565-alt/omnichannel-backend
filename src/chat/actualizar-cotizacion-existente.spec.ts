import {
  parseActualizarCotizacionExistenteArgs,
  resolverPiezaEnCatalogo,
} from './actualizar-cotizacion-existente';
import { createMatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';

describe('actualizar-cotizacion-existente', () => {
  const snap = createMatrixPricingSnapshot([
    { servicio: 'Fascia', severidad: 'DL', precio: 3500, diasEntrega: 3, isInstantService: true },
    { servicio: 'Puerta', severidad: 'DL', precio: 4200, diasEntrega: 3, isInstantService: true },
  ]);

  it('parsea cotizacionId y piezaOServicio', () => {
    const parsed = parseActualizarCotizacionExistenteArgs(
      JSON.stringify({
        cotizacionId: 'abc-123',
        piezaOServicio: 'fascia trasera',
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.cotizacionId).toBe('abc-123');
      expect(parsed.data.piezaOServicio).toBe('fascia trasera');
    }
  });

  it('resuelve FT con precio de catálogo', () => {
    const r = resolverPiezaEnCatalogo('fascia trasera', snap, {
      descripcionDano: 'solo rayada',
    });
    expect(r.panelCode).toBe('FT');
    expect(r.precioCatalogo).toBe(3500);
    expect(r.requiereRevisionManual).toBe(false);
  });

  it('marca revisión manual sin match en catálogo', () => {
    const r = resolverPiezaEnCatalogo('pieza inventada xyz', snap);
    expect(r.requiereRevisionManual).toBe(true);
    expect(r.precioCatalogo).toBe(0);
  });
});
