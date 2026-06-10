import { createMatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import type { PriceMatrix } from '../catalog/entities/price-matrix.entity';
import { buildObtenerCotizacionExpressPayload } from './autopilot-cotizacion-express';

function mockRows(): PriceMatrix[] {
  const base = {
    diasEntrega: 3,
    isInstantService: true,
    tallerId: 't1',
  } as Partial<PriceMatrix>;
  return [
    { ...base, servicio: 'Toldo', severidad: 'DL', precio: 4500 } as PriceMatrix,
    { ...base, servicio: 'Fascia', severidad: 'DL', precio: 2900 } as PriceMatrix,
    { ...base, servicio: 'Cofre', severidad: 'DL', precio: 3200 } as PriceMatrix,
  ];
}

describe('buildObtenerCotizacionExpressPayload', () => {
  it('suma cada repetición de pieza genérica (Toldo + Fascia × 2 = 10300)', () => {
    const snap = createMatrixPricingSnapshot(mockRows());
    const result = buildObtenerCotizacionExpressPayload(
      snap,
      ['Toldo', 'Fascia', 'Fascia'],
      'Chevrolet Suburban 2020',
      'Grande',
    );

    expect(result.success).toBe(true);
    expect(result.lines).toHaveLength(3);
    expect(result.desglose).toEqual([
      { pieza: 'Toldo', precio: 4500 },
      { pieza: 'Fascia delantera', precio: 2900 },
      { pieza: 'Fascia trasera', precio: 2900 },
    ]);
    expect(result.subtotalMx).toBe(10300);
    expect(result.totalMx).toBe(10300);
    expect(result.totalGlobal).toBe(10300);
  });
});
