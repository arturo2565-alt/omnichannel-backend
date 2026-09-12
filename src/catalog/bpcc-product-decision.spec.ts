/**
 * BPCC cerrado: la autoridad comercial es la fila de catálogo $39,000 BASE.
 * resolveBanioCodeUnitPrice / Transformación Total ~$31k quedan LEGACY.
 */
import { resolveBanioCodeUnitPrice } from './vehicle-piece-pricing';
import { buildObtenerCotizacionExpressPayload } from '../chat/autopilot-cotizacion-express';
import { resolveVehiclePricingProfile } from './vehicle-pricing-profile';
import {
  BANIO_OFFICIAL_BASE_MXN,
  lookupBanioCatalogBase,
  officialBanioCatalogSnap,
} from './banio-service-identity';

describe('BPCC decisión comercial cerrada', () => {
  it('CANONICAL usa catálogo 39000, no la fórmula legacy 31000', () => {
    const snap = officialBanioCatalogSnap();
    const lookup = lookupBanioCatalogBase(snap, 'BPCC');
    expect(lookup.status).toBe('READY');
    expect(lookup.basePrice).toBe(BANIO_OFFICIAL_BASE_MXN.BPCC);

    const profile = resolveVehiclePricingProfile({
      modeloVehiculo: 'Nissan March',
      sizeTier: 'Compacto',
      isPremium: false,
    });
    const express = buildObtenerCotizacionExpressPayload(snap, ['BPCC'], profile);
    expect(express.success).toBe(true);
    expect(express.totalMx).toBe(39000);
    expect(express.lines?.[0]?.canonical).toBe(
      'Baño de Pintura con Cambio de Color',
    );

    const legacy = resolveBanioCodeUnitPrice(20_000, 'BPCC', 'Mediano');
    expect(legacy).toBe(31_000);
    expect(express.totalMx).not.toBe(legacy);
  });
});
