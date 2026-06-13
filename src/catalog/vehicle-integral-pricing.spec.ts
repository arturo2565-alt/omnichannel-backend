import { createMatrixPricingSnapshot } from './matrix-pricing-snapshot';
import type { PriceMatrix } from './entities/price-matrix.entity';
import {
  resolveIntegralBaseFromSnap,
  resolveIntegralPriceForVehicleProfile,
} from './vehicle-integral-pricing';
import { resolveVehiclePricingProfile } from './vehicle-pricing-profile';
import { mergeCatalogPricingRules } from './catalog-pricing-rules';

function matrixRows(
  entries: Array<{ servicio: string; severidad: string; precio: number }>,
): PriceMatrix[] {
  return entries.map((e, i) => ({
    id: String(i + 1),
    servicio: e.servicio,
    severidad: e.severidad,
    precio: e.precio,
    diasEntrega: 5,
    isInstantService: true,
    tallerId: null,
  })) as PriceMatrix[];
}

describe('vehicle-integral-pricing', () => {
  it('resolveIntegralBaseFromSnap prioriza BASE sobre Chico legacy', () => {
    const snap = createMatrixPricingSnapshot(
      matrixRows([
        { servicio: 'Estética Automotriz', severidad: 'Chico', precio: 3000 },
        { servicio: 'Estética Automotriz', severidad: 'BASE', precio: 3500 },
      ]),
    );
    const base = resolveIntegralBaseFromSnap(snap, 'Estética Automotriz');
    expect(base?.basePrice).toBe(3500);
    expect(base?.matrixSeverity).toBe('BASE');
  });

  it('resolveIntegralPriceForVehicleProfile aplica motor tamaño × premium', () => {
    const snap = createMatrixPricingSnapshot(
      matrixRows([
        { servicio: 'Baño de Pintura Exterior', severidad: 'BASE', precio: 28000 },
      ]),
    );
    const profile = resolveVehiclePricingProfile({
      modeloVehiculo: 'Escalade',
      sizeTier: 'XL',
      isPremium: true,
    });
    const rules = mergeCatalogPricingRules(null);
    const out = resolveIntegralPriceForVehicleProfile(
      snap,
      'Baño de Pintura Exterior',
      profile,
      rules,
    );
    expect(out?.unitPrice).toBe(39300);
  });
});
