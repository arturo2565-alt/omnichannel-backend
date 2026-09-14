import type { DetectedDamageItem } from './entities/chat.entity';
import type {
  CanonicalPeritajeV1,
  PendingQuoteRequirement,
  VehicleIdentity,
} from '../domain/peritaje-v1';
import {
  enrichVehicleIdentity,
  validateVehicleYear,
  type VehicleIdentityPatch,
} from '../domain/peritaje-v1/vehicle-identity-enrich';
import { resolvePendingRequirementsForVehicle } from '../domain/peritaje-v1/pending-quote-requirement';
import { invalidateMarketPricingOnItem } from './refaccion-market/apply-awaiting-vehicle-data';

export type ConfirmVehicleIdentityArgs = {
  vehicleId?: string;
  make?: string;
  model?: string;
  year?: string;
  version?: string;
  variant?: string;
};

export function parseConfirmVehicleIdentityArgs(
  raw: Record<string, unknown>,
):
  | { ok: true; args: ConfirmVehicleIdentityArgs }
  | { ok: false; error: string } {
  const vehicleId = optionalTrim(raw.vehicleId, raw.vehicle_id);
  const make = optionalTrim(raw.make, raw.marca);
  const model = optionalTrim(raw.model, raw.modelo);
  const version = optionalTrim(raw.version);
  const variant = optionalTrim(raw.variant, raw.variante, raw.bodyStyle, raw.body_style);
  const yearRaw = raw.year ?? raw.anio ?? raw.año;
  let year: string | undefined;
  if (yearRaw != null && String(yearRaw).trim() !== '') {
    const validated = validateVehicleYear(yearRaw);
    if (!validated.ok) return validated;
    year = validated.year;
  }
  if (!make && !model && !year && !version && !variant && !vehicleId) {
    return { ok: false, error: 'No se recibieron datos vehiculares para confirmar.' };
  }
  return {
    ok: true,
    args: {
      ...(vehicleId ? { vehicleId } : {}),
      ...(make ? { make } : {}),
      ...(model ? { model } : {}),
      ...(year ? { year } : {}),
      ...(version ? { version } : {}),
      ...(variant ? { variant } : {}),
    },
  };
}

function optionalTrim(...values: unknown[]): string | undefined {
  for (const value of values) {
    const s = String(value ?? '').trim();
    if (s) return s;
  }
  return undefined;
}

export function pickVehicleForConfirm(
  vehicles: readonly VehicleIdentity[],
  vehicleId?: string,
): VehicleIdentity | undefined {
  if (vehicleId) {
    return vehicles.find((v) => v.vehicleId === vehicleId);
  }
  const known = vehicles.filter((v) => v.vehicleId !== 'veh_unknown');
  if (known.length === 1) return known[0];
  if (vehicles.length === 1) return vehicles[0];
  return undefined;
}

export type ApplyConfirmVehicleIdentityInput = {
  peritaje: CanonicalPeritajeV1;
  inventory: readonly DetectedDamageItem[];
  requirements?: readonly PendingQuoteRequirement[];
  args: ConfirmVehicleIdentityArgs;
  now?: string;
};

export type ApplyConfirmVehicleIdentityResult = {
  peritaje: CanonicalPeritajeV1;
  inventory: DetectedDamageItem[];
  vehicle: VehicleIdentity;
  requirements: PendingQuoteRequirement[];
  resolved: PendingQuoteRequirement[];
  identityAttrsChanged: boolean;
  displayLabel: string;
};

/**
 * Confirma/enriquece la identidad existente. No regenera vehicleId.
 * Una corrección de make/model invalida precios de mercado dependientes.
 */
export function applyConfirmVehicleIdentity(
  input: ApplyConfirmVehicleIdentityInput,
):
  | { ok: true; result: ApplyConfirmVehicleIdentityResult }
  | { ok: false; error: string } {
  const vehicle = pickVehicleForConfirm(
    input.peritaje.vehicles,
    input.args.vehicleId,
  );
  if (!vehicle) {
    return {
      ok: false,
      error: 'No se encontró el vehículo a confirmar.',
    };
  }
  const patch: VehicleIdentityPatch = {
    ...(input.args.make ? { make: input.args.make } : {}),
    ...(input.args.model ? { model: input.args.model } : {}),
    ...(input.args.year ? { year: input.args.year } : {}),
    ...(input.args.version ? { version: input.args.version } : {}),
    ...(input.args.variant ? { variant: input.args.variant } : {}),
    source: 'user',
    confirmedByUser: true,
  };
  const enriched = enrichVehicleIdentity(vehicle, patch);
  const now = input.now ?? new Date().toISOString();
  const peritaje: CanonicalPeritajeV1 = {
    ...input.peritaje,
    vehicles: input.peritaje.vehicles.map((v) =>
      v.vehicleId === vehicle.vehicleId ? enriched.vehicle : v,
    ),
    updatedAt: now,
  };
  const resolvedReqs = resolvePendingRequirementsForVehicle(
    input.requirements,
    enriched.vehicle,
    now,
  );
  let inventory = input.inventory.map((it) => {
    if (it.vehicleId && it.vehicleId !== vehicle.vehicleId) return it;
    return {
      ...it,
      vehiculoDetectado: enriched.vehicle.displayLabel,
      vehicleId: it.vehicleId || vehicle.vehicleId,
    };
  });
  if (enriched.identityAttrsChanged) {
    inventory = inventory.map((it) => {
      if (it.vehicleId && it.vehicleId !== vehicle.vehicleId) return it;
      if (String(it.tratamiento ?? '').toUpperCase() !== 'SUSTITUIR') {
        return it;
      }
      return invalidateMarketPricingOnItem(it);
    });
  }
  return {
    ok: true,
    result: {
      peritaje,
      inventory,
      vehicle: enriched.vehicle,
      requirements: resolvedReqs.next,
      resolved: resolvedReqs.resolved,
      identityAttrsChanged: enriched.identityAttrsChanged,
      displayLabel: enriched.vehicle.displayLabel,
    },
  };
}
