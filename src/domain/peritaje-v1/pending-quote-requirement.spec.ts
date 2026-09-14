import {
  refaccionIdentityGaps,
  resolvePendingRequirementsForVehicle,
  syncPendingQuoteRequirements,
} from './pending-quote-requirement';
import type { CanonicalPeritajeV1, CanonicalQuoteV1, VehicleIdentity } from './types';

const visionNissan: VehicleIdentity = {
  vehicleId: 'veh_nissan',
  make: 'Nissan',
  model: 'Versa',
  displayLabel: 'Nissan Versa',
  source: 'vision',
  confirmedByUser: false,
  confidence: 'LOW',
};

describe('refaccionIdentityGaps', () => {
  it('Vision make/model sin year → missing year + confirmación make/model', () => {
    const gaps = refaccionIdentityGaps(visionNissan);
    expect(gaps.missingFields).toEqual(['year']);
    expect(gaps.confirmationFields).toEqual(['make', 'model']);
    expect(gaps.requiredFields).toEqual(['year', 'make', 'model']);
    expect(gaps.readyForMarket).toBe(false);
  });

  it('year Vision tampoco basta si no está confirmado', () => {
    const gaps = refaccionIdentityGaps({
      ...visionNissan,
      year: '2014',
    });
    expect(gaps.missingFields).toEqual([]);
    expect(gaps.confirmationFields).toEqual(['make', 'model', 'year']);
    expect(gaps.readyForMarket).toBe(false);
  });

  it('solo year confirmado no abre mercado sobre modelo Vision', () => {
    const gaps = refaccionIdentityGaps({
      ...visionNissan,
      year: '2014',
      confirmedFields: ['year'],
    });
    expect(gaps.missingFields).toEqual([]);
    expect(gaps.confirmationFields).toEqual(['make', 'model']);
    expect(gaps.readyForMarket).toBe(false);
  });

  it('make+model+year confirmados → readyForMarket', () => {
    const gaps = refaccionIdentityGaps({
      ...visionNissan,
      year: '2014',
      confirmedByUser: true,
      confirmedFields: ['make', 'model', 'year'],
    });
    expect(gaps.readyForMarket).toBe(true);
    expect(gaps.requiredFields).toEqual([]);
  });

  it('requirement year-only no se resuelve si el modelo sigue sin confirmar', () => {
    const { next, resolved } = resolvePendingRequirementsForVehicle(
      [
        {
          requirementId: 'req_1',
          conversationId: 'c',
          quoteId: 'q',
          vehicleId: 'veh_nissan',
          damageItemId: 'dmg_1',
          type: 'VEHICLE_DATA',
          requiredFields: ['year'],
          missingFields: ['year'],
          confirmationFields: ['make', 'model'],
          reason: 'REFACCION_MARKET_LOOKUP',
          status: 'OPEN',
        },
      ],
      { ...visionNissan, year: '2014', confirmedFields: ['year'] },
    );
    expect(resolved).toHaveLength(0);
    expect(next[0]?.status).toBe('OPEN');
  });

  it('sync escribe missingFields y confirmationFields', () => {
    const peritaje = {
      schemaVersion: 'peritaje.v1',
      peritajeId: 'per_1',
      conversationId: 'c',
      vehicles: [visionNissan],
      damages: [],
      viability: { viable: true },
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:00.000Z',
    } as CanonicalPeritajeV1;
    const quote = {
      schemaVersion: 'quote.v1',
      quoteId: 'quo_1',
      peritajeId: 'per_1',
      conversationId: 'c',
      lines: [
        {
          quoteLineId: 'ql_1',
          damageItemId: 'dmg_calavera',
          vehicleId: 'veh_nissan',
          serviceType: 'REFACCION',
          pricingStatus: 'AWAITING_VEHICLE_DATA',
          billable: false,
          amount: 0,
        },
      ],
      total: 0,
      isPartial: true,
    } as CanonicalQuoteV1;
    const synced = syncPendingQuoteRequirements({
      conversationId: 'c',
      quoteId: 'quo_1',
      peritaje,
      quote,
    });
    expect(synced.created[0]?.missingFields).toEqual(['year']);
    expect(synced.created[0]?.confirmationFields).toEqual(['make', 'model']);
  });
});
