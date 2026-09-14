import { createVehicleId } from './ids';
import { vehicleIdentityFromLegacyLabel } from './from-legacy';
import {
  collectSingleVehicleIdentityMismatches,
  extractKnownMake,
  resolveVisionBurstVehiclePolicy,
  stampDamagesOntoVehicle,
} from './case-vehicle-identity';
import type { DamageItem } from './types';

function damage(piece: string, vehicleId: string): DamageItem {
  return {
    damageItemId: `dmg_${piece}`,
    vehicleId,
    pieceCode: piece,
    pieceLabel: piece,
    physicalPanelKey: piece,
    severity: 'DL',
    descriptionTechnical: 'dano',
    treatment: 'REPARAR',
    treatmentConfidence: 'HIGH',
    treatmentSource: 'vision',
    treatmentReason: 'vision',
    requiresReplacement: false,
    possibleReplacement: false,
    evidence: [],
    source: 'vision',
  };
}

describe('identidad vehicular de burst Vision', () => {
  it('Nissan Versa vs Nissan Altima (misma marca) → SINGLE', () => {
    const policy = resolveVisionBurstVehiclePolicy({
      rootLabel: 'Nissan Versa',
      itemLabels: ['Nissan Versa', 'Nissan', 'Nissan Altima'],
    });
    expect(policy.mode).toBe('SINGLE');
    expect(policy.reason).toBe('same_known_make');
    expect(policy.knownMakes).toEqual(['nissan']);
    expect(policy.canonical?.vehicleId).toBeTruthy();
  });

  it('Mazda 3 + Nissan Versa → MULTI por marcas distintas', () => {
    const policy = resolveVisionBurstVehiclePolicy({
      itemLabels: ['Mazda 3 2020', 'Nissan Versa 2018'],
    });
    expect(policy.mode).toBe('MULTI');
    expect(policy.reason).toBe('distinct_known_makes');
    expect(policy.knownMakes).toEqual(expect.arrayContaining(['mazda', 'nissan']));
  });

  it('prior con 2+ vehicleId → MULTI, no unifica', () => {
    const mazda = vehicleIdentityFromLegacyLabel('Mazda 3 2020', {
      source: 'vision',
    });
    const nissan = vehicleIdentityFromLegacyLabel('Nissan Versa 2018', {
      source: 'vision',
    });
    const policy = resolveVisionBurstVehiclePolicy({
      priorVehicles: [mazda, nissan],
      itemLabels: ['Mazda 3 2020'],
    });
    expect(policy.mode).toBe('MULTI');
    expect(policy.reason).toBe('prior_multi_vehicle');
  });

  it('flag explícito → MULTI', () => {
    const policy = resolveVisionBurstVehiclePolicy({
      itemLabels: ['Nissan Versa', 'Nissan Altima'],
      explicitMultiVehicle: true,
    });
    expect(policy.mode).toBe('MULTI');
    expect(policy.reason).toBe('explicit_multi_vehicle');
  });

  it('reusa el vehicleId prior en SINGLE aunque el label del lote cambie', () => {
    const prior = vehicleIdentityFromLegacyLabel('Nissan Versa', {
      source: 'vision',
    });
    const policy = resolveVisionBurstVehiclePolicy({
      priorVehicles: [prior],
      rootLabel: 'Nissan',
      itemLabels: ['Nissan'],
    });
    expect(policy.mode).toBe('SINGLE');
    expect(policy.reason).toBe('prior_single_vehicle');
    expect(policy.canonical?.vehicleId).toBe(prior.vehicleId);
  });

  it('label corto “Nissan” hashea distinto que “Nissan Versa” — mismatch observable', () => {
    const versa = vehicleIdentityFromLegacyLabel('Nissan Versa', {
      source: 'vision',
    });
    const solo = vehicleIdentityFromLegacyLabel('Nissan', { source: 'vision' });
    expect(versa.vehicleId).not.toBe(solo.vehicleId);
    expect(createVehicleId({ make: 'Nissan', displayLabel: 'Nissan' })).toBe(
      solo.vehicleId,
    );
    const mismatches = collectSingleVehicleIdentityMismatches({
      canonicalVehicleId: versa.vehicleId,
      itemLabels: ['Nissan Versa', 'Nissan'],
    });
    expect(mismatches.map((m) => m.label)).toContain('Nissan');
  });

  it('stamp unifica damages al vehicleId canónico', () => {
    const canonical = 'veh_canonical';
    const stamped = stampDamagesOntoVehicle(
      [
        damage('Calavera_Derecha', 'veh_a'),
        damage('TapaCajuela', 'veh_b'),
      ],
      canonical,
    );
    expect(stamped.every((d) => d.vehicleId === canonical)).toBe(true);
  });

  it('extractKnownMake no trata Altima como marca', () => {
    expect(extractKnownMake('Altima')).toBeUndefined();
    expect(extractKnownMake('Nissan Altima')).toBe('nissan');
  });
});
