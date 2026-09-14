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
import { stampDamagesOntoVehicle } from '../domain/peritaje-v1/case-vehicle-identity';
import { invalidateMarketPricingOnItem } from './refaccion-market/apply-awaiting-vehicle-data';
import {
  hasMarketRelevantVehicleIdentityChange,
  marketCacheKey,
  parseVehiclePartIdentity,
  type MarketRelevantVehicleIdentityChange,
} from './refaccion-market/parse-vehicle-part-identity';
import {
  CANONICAL_TRACE_EVENTS,
  pegCanonicalTrace,
  summarizeVehicleIdentity,
} from './canonical-trace';

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
  marketIdentityChange: MarketRelevantVehicleIdentityChange;
  displayLabel: string;
};

function marketKeyForItem(
  vehicle: VehicleIdentity,
  item: DetectedDamageItem,
): string {
  return marketCacheKey(
    parseVehiclePartIdentity({
      vehiculoText: vehicle.displayLabel,
      marca: vehicle.make,
      modelo: vehicle.model,
      anio: vehicle.year,
      version: vehicle.version ?? vehicle.variant,
      pieza: item.pieza,
      moldingPosition: item.moldingPosition,
      finishType: item.finishType,
    }),
  );
}

export { hasMarketRelevantVehicleIdentityChange };

/**
 * Confirma/enriquece la identidad existente. No regenera vehicleId.
 * Una corrección de make/model/year/version invalida precios de mercado.
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
  const confirmedFields = [
    ...new Set([
      ...(input.args.make ? (['make'] as const) : []),
      ...(input.args.model ? (['model', 'make'] as const) : []),
      ...(input.args.year ? (['year'] as const) : []),
    ]),
  ];
  const patch: VehicleIdentityPatch = {
    ...(input.args.make ? { make: input.args.make } : {}),
    ...(input.args.model ? { model: input.args.model } : {}),
    ...(input.args.year ? { year: input.args.year } : {}),
    ...(input.args.version ? { version: input.args.version } : {}),
    ...(input.args.variant ? { variant: input.args.variant } : {}),
    source: 'user',
    confirmedFields,
  };
  const enriched = enrichVehicleIdentity(vehicle, patch);
  const marketIdentityChange = hasMarketRelevantVehicleIdentityChange(
    vehicle,
    enriched.vehicle,
  );
  const now = input.now ?? new Date().toISOString();
  const knownVehicles = input.peritaje.vehicles.filter(
    (v) => v.vehicleId && v.vehicleId !== 'veh_unknown',
  );
  const unifySingle = knownVehicles.length <= 1;
  let damages = input.peritaje.damages;
  if (unifySingle) {
    damages = stampDamagesOntoVehicle(damages, vehicle.vehicleId);
  }
  const nextVehicle: VehicleIdentity = {
    ...enriched.vehicle,
    vehicleId: vehicle.vehicleId,
  };
  const peritaje: CanonicalPeritajeV1 = {
    ...input.peritaje,
    vehicles: input.peritaje.vehicles.map((v) =>
      v.vehicleId === vehicle.vehicleId ? nextVehicle : v,
    ),
    damages,
    updatedAt: now,
  };
  const resolvedReqs = resolvePendingRequirementsForVehicle(
    input.requirements,
    nextVehicle,
    now,
  );
  let inventory = input.inventory.map((it) => {
    if (!unifySingle && it.vehicleId && it.vehicleId !== vehicle.vehicleId) {
      return it;
    }
    return {
      ...it,
      vehiculoDetectado: nextVehicle.displayLabel,
      vehicleId: vehicle.vehicleId,
    };
  });
  if (marketIdentityChange.invalidateAffectedMarketPricing) {
    pegCanonicalTrace(CANONICAL_TRACE_EVENTS.VEHICLE_IDENTITY_CORRECTED, {
      vehicleId: vehicle.vehicleId,
      before: summarizeVehicleIdentity(vehicle),
      after: summarizeVehicleIdentity(nextVehicle),
      changedFields: marketIdentityChange.changedFields,
    });
    inventory = inventory.map((it) => {
      if (it.vehicleId && it.vehicleId !== vehicle.vehicleId) return it;
      if (String(it.tratamiento ?? '').toUpperCase() !== 'SUSTITUIR') {
        return it;
      }
      const oldMarketIdentityKey =
        it.marketIdentityKey || marketKeyForItem(vehicle, it);
      const newMarketIdentityKey = marketKeyForItem(nextVehicle, it);
      pegCanonicalTrace(
        CANONICAL_TRACE_EVENTS.MARKET_INVALIDATED_BY_VEHICLE_CORRECTION,
        {
          vehicleId: vehicle.vehicleId,
          damageItemId: it.damageItemId,
          oldMarketIdentityKey,
          newMarketIdentityKey,
          changedFields: marketIdentityChange.changedFields,
        },
      );
      return invalidateMarketPricingOnItem(it);
    });
  }
  return {
    ok: true,
    result: {
      peritaje,
      inventory,
      vehicle: nextVehicle,
      requirements: resolvedReqs.next,
      resolved: resolvedReqs.resolved,
      identityAttrsChanged:
        enriched.identityAttrsChanged || marketIdentityChange.changed,
      marketIdentityChange,
      displayLabel: nextVehicle.displayLabel,
    },
  };
}
