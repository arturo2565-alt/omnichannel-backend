import { createMatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import type { PriceMatrix } from '../catalog/entities/price-matrix.entity';
import {
  buildObtenerCotizacionExpressPayload,
  resolveExpressLineServicioLabel,
} from './autopilot-cotizacion-express';
import { resolveVehiclePricingProfile } from '../catalog/vehicle-pricing-profile';
import { mergeCatalogPricingRules } from '../catalog/catalog-pricing-rules';

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

  it('Toldo + Fascia ×2 aplica tier Mediano sobre base compacto', () => {
    const profile = resolveVehiclePricingProfile({
      modeloVehiculo: 'Nissan March 2018',
      sizeTier: 'Mediano',
      isPremium: false,
    });
    const result = buildObtenerCotizacionExpressPayload(
      snap,
      ['Toldo', 'Fascia', 'Fascia'],
      profile,
    );

    expect(result.success).toBe(true);
    expect(result.totalMx).toBe(10650);
    expect(result.desglose).toEqual([
      { pieza: 'Toldo', severidad: 'DL', precioMx: 4650 },
      { pieza: 'Fascia delantera', severidad: 'DL', precioMx: 3000 },
      { pieza: 'Fascia trasera', severidad: 'DL', precioMx: 3000 },
    ]);
  });

  it('baño de pintura usa base integral × tamaño (no celda Mediano Premium)', () => {
    const snap = createMatrixPricingSnapshot(
      matrixRows([
        {
          servicio: 'Baño de Pintura Exterior',
          severidad: 'BASE',
          precio: 28000,
        },
      ]),
    );
    const profile = resolveVehiclePricingProfile({
      modeloVehiculo: 'BMW Serie 3',
      sizeTier: 'Mediano',
      isPremium: true,
    });
    const rules = mergeCatalogPricingRules(null);
    const result = buildObtenerCotizacionExpressPayload(
      snap,
      ['baño de pintura'],
      profile,
      { pricingRules: rules },
    );
    expect(result.success).toBe(true);
    expect(result.totalMx).toBe(31850);
  });
});
