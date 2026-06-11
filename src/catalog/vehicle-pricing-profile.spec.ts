import {
  applyPremiumMultiplier,
  applySizeTierToCompactoBase,
  inferIsPremiumBrand,
  inferSizeTierFromVehicleText,
  resolveVehiclePricingProfile,
  roundCommercialMx,
} from './vehicle-pricing-profile';
import { resolvePiecePriceForVehicleProfile } from './vehicle-piece-pricing';
import { createMatrixPricingSnapshot } from './matrix-pricing-snapshot';
import type { PriceMatrix } from './entities/price-matrix.entity';

function matrixRows(
  entries: Array<{ servicio: string; severidad: string; precio: number }>,
): PriceMatrix[] {
  return entries.map((e, i) => ({
    id: String(i + 1),
    servicio: e.servicio,
    severidad: e.severidad,
    precio: e.precio,
    diasEntrega: 3,
    isInstantService: false,
    tallerId: null,
  })) as PriceMatrix[];
}

describe('vehicle-pricing-profile', () => {
  it('infiera premium por marca y tamaño por modelo', () => {
    expect(inferIsPremiumBrand('BMW Serie 3 2019')).toBe(true);
    expect(inferIsPremiumBrand('Chevrolet Aveo 2015')).toBe(false);
    expect(inferSizeTierFromVehicleText('Chevrolet Aveo')).toBe('Compacto');
    expect(inferSizeTierFromVehicleText('Cadillac Escalade')).toBe('XL');
  });

  it('aplica factor tamaño y premium sobre base compacto', () => {
    const base = 2900;
    const medianoStd = applySizeTierToCompactoBase(base, 'Mediano');
    expect(medianoStd).toBe(3000);
    const bmwProfile = resolveVehiclePricingProfile({
      modeloVehiculo: 'BMW Serie 3',
      sizeTier: 'Mediano',
      isPremium: true,
    });
    expect(applyPremiumMultiplier(medianoStd, bmwProfile)).toBe(3300);
    const xlStd = applySizeTierToCompactoBase(base, 'XL');
    expect(xlStd).toBe(3700);
  });
});

describe('vehicle-piece-pricing', () => {
  const snap = createMatrixPricingSnapshot(
    matrixRows([{ servicio: 'Fascia', severidad: 'DL', precio: 2900 }]),
  );

  it('fascia DL varía por tamaño y premium', () => {
    const aveo = resolveVehiclePricingProfile({
      modeloVehiculo: 'Chevrolet Aveo',
      sizeTier: 'Compacto',
      isPremium: false,
    });
    const bmw = resolveVehiclePricingProfile({
      modeloVehiculo: 'BMW Serie 3',
      sizeTier: 'Mediano',
      isPremium: true,
    });
    const escalade = resolveVehiclePricingProfile({
      modeloVehiculo: 'Cadillac Escalade',
      sizeTier: 'XL',
      isPremium: true,
    });

    expect(
      resolvePiecePriceForVehicleProfile(snap, 'Fascia', 'DL', aveo),
    ).toBe(2900);
    expect(
      resolvePiecePriceForVehicleProfile(snap, 'Fascia', 'DL', bmw),
    ).toBe(3300);
    expect(
      resolvePiecePriceForVehicleProfile(snap, 'Fascia', 'DL', escalade),
    ).toBe(roundCommercialMx(3700 * 1.1));
  });
});
