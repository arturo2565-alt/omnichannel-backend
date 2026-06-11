import { createMatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import type { PriceMatrix } from '../catalog/entities/price-matrix.entity';
import {
  buildObtenerCotizacionExpressPayload,
  resolveExpressLineServicioLabel,
} from './autopilot-cotizacion-express';

function matrixRows(
  entries: Array<{ servicio: string; severidad: string; precio: number }>,
): PriceMatrix[] {
  return entries.map((e, i) => ({
    id: i + 1,
    servicio: e.servicio,
    severidad: e.severidad,
    precio: e.precio,
    diasEntrega: 3,
    isInstantService: true,
    tallerId: null,
  })) as PriceMatrix[];
}

describe('autopilot-cotizacion-express', () => {
  const snap = createMatrixPricingSnapshot(
    matrixRows([
      { servicio: 'Toldo', severidad: 'DL', precio: 4500 },
      { servicio: 'Fascia', severidad: 'DL', precio: 2900 },
      { servicio: 'Puerta', severidad: 'DL', precio: 3200 },
    ]),
  );

  it('resolveExpressLineServicioLabel rota Fascia genérica a delantera/trasera', () => {
    expect(resolveExpressLineServicioLabel('Fascia', 'Fascia', 0)).toBe(
      'Fascia delantera',
    );
    expect(resolveExpressLineServicioLabel('Fascia', 'Fascia', 1)).toBe(
      'Fascia trasera',
    );
  });

  it('Toldo + Fascia ×2 suma $10,300 (sin dedup por canonical)', () => {
    const result = buildObtenerCotizacionExpressPayload(
      snap,
      ['Toldo', 'Fascia', 'Fascia'],
      'Nissan March 2018',
      'Mediano',
    );

    expect(result.success).toBe(true);
    expect(result.totalMx).toBe(10300);
    expect(result.desglose).toEqual([
      { pieza: 'Toldo', severidad: 'DL', precioMx: 4500 },
      { pieza: 'Fascia delantera', severidad: 'DL', precioMx: 2900 },
      { pieza: 'Fascia trasera', severidad: 'DL', precioMx: 2900 },
    ]);
  });
});
