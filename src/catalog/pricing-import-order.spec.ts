import '../chat/draft-quote-inventory-pricing';
import { createMatrixPricingSnapshot } from './matrix-pricing-snapshot';
import type { PriceMatrix } from './entities/price-matrix.entity';
import { resolvePiecePriceForVehicleProfile } from './vehicle-piece-pricing';
import { resolveVehiclePricingProfile } from './vehicle-pricing-profile';

/**
 * Este archivo carga primero el cotizador, que es la entrada del agente.
 * vehicle-pricing-profile.spec.ts carga primero el perfil.
 * Las dos rutas deben devolver el mismo importe.
 */
describe('orden de importación del precio por pieza', () => {
  it('Fascia Mediano premium sigue en 3300 cuando el cotizador carga primero', () => {
    const snap = createMatrixPricingSnapshot([
      {
        servicio: 'Fascia',
        severidad: 'DL',
        precio: 2900,
        diasEntrega: 3,
        isInstantService: false,
        id: '1',
        tallerId: null,
      } as PriceMatrix,
    ]);
    const bmw = resolveVehiclePricingProfile({
      modeloVehiculo: 'BMW Serie 3',
      sizeTier: 'Mediano',
      isPremium: true,
    });
    expect(resolvePiecePriceForVehicleProfile(snap, 'Fascia', 'DL', bmw)).toBe(
      3300,
    );
  });
});
