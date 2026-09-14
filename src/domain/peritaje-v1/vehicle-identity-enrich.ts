import type { IdentitySource, VehicleIdentity } from './types';
import { isValidVehicleYear } from './pending-quote-requirement';

export type VehicleIdentityPatch = {
  make?: string;
  model?: string;
  year?: string;
  version?: string;
  variant?: string;
  displayLabel?: string;
  source?: IdentitySource;
  confirmedByUser?: boolean;
};

export type EnrichVehicleIdentityResult = {
  vehicle: VehicleIdentity;
  changed: boolean;
  identityAttrsChanged: boolean;
};

const CURRENT_YEAR_SLACK = 1;

export function validateVehicleYear(raw: unknown):
  | { ok: true; year: string }
  | { ok: false; error: string } {
  if (raw == null || raw === '') {
    return { ok: false, error: 'Falta el año del vehículo.' };
  }
  const year = String(raw).replace(/\D/g, '').slice(0, 4);
  if (!/^(19|20)\d{2}$/.test(year)) {
    return { ok: false, error: 'El año del vehículo no es válido.' };
  }
  const n = Number(year);
  const max = new Date().getFullYear() + CURRENT_YEAR_SLACK;
  if (n < 1900 || n > max) {
    return { ok: false, error: 'El año del vehículo está fuera de rango.' };
  }
  return { ok: true, year };
}

function cleanOptional(raw: unknown): string | undefined {
  const s = String(raw ?? '').trim();
  return s || undefined;
}

export function buildVehicleDisplayLabel(
  vehicle: Pick<
    VehicleIdentity,
    'make' | 'model' | 'year' | 'version' | 'variant' | 'displayLabel'
  >,
): string {
  const parts = [
    vehicle.make,
    vehicle.model,
    vehicle.year,
    vehicle.variant ?? vehicle.version,
  ]
    .map((p) => String(p ?? '').trim())
    .filter(Boolean);
  return parts.join(' ') || String(vehicle.displayLabel ?? '').trim();
}

export function vehicleIdentityVersion(
  vehicle: Pick<VehicleIdentity, 'make' | 'model' | 'year' | 'version' | 'variant'>,
): string {
  return [vehicle.make, vehicle.model, vehicle.year, vehicle.version, vehicle.variant]
    .map((p) =>
      String(p ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ''),
    )
    .join('|');
}

function attrKey(
  vehicle: Pick<VehicleIdentity, 'make' | 'model' | 'year' | 'version' | 'variant'>,
): string {
  return vehicleIdentityVersion(vehicle);
}

/**
 * Enriquece atributos de un VehicleIdentity existente.
 * NUNCA regenera vehicleId.
 */
export function enrichVehicleIdentity(
  existing: VehicleIdentity,
  patch: VehicleIdentityPatch,
): EnrichVehicleIdentityResult {
  const next: VehicleIdentity = { ...existing };
  if (patch.make !== undefined) {
    const make = cleanOptional(patch.make);
    if (make) next.make = make;
  }
  if (patch.model !== undefined) {
    const model = cleanOptional(patch.model);
    if (model) next.model = model;
  }
  if (patch.year !== undefined) {
    const year = cleanOptional(patch.year);
    if (year && isValidVehicleYear(year)) next.year = year;
  }
  if (patch.version !== undefined) {
    const version = cleanOptional(patch.version);
    if (version) next.version = version;
  }
  if (patch.variant !== undefined) {
    const variant = cleanOptional(patch.variant);
    if (variant) next.variant = variant;
  }
  next.displayLabel =
    cleanOptional(patch.displayLabel) || buildVehicleDisplayLabel(next);
  if (patch.source) next.source = patch.source;
  if (patch.confirmedByUser === true) next.confirmedByUser = true;
  next.vehicleId = existing.vehicleId;
  const identityAttrsChanged = attrKey(existing) !== attrKey(next);
  const changed =
    identityAttrsChanged ||
    existing.displayLabel !== next.displayLabel ||
    existing.confirmedByUser !== next.confirmedByUser ||
    existing.source !== next.source ||
    existing.version !== next.version ||
    existing.variant !== next.variant;
  return { vehicle: next, changed, identityAttrsChanged };
}

/**
 * Reusa el vehicleId canónico existente al enriquecer o corregir atributos.
 * Corregir Mazda 2 → Mazda 3 NO inventa un vehicleId nuevo.
 */
export function reusePriorVehicleIdentity(
  prior: VehicleIdentity,
  incoming: VehicleIdentity,
): VehicleIdentity {
  const enriched = enrichVehicleIdentity(prior, {
    make: incoming.make,
    model: incoming.model,
    year: incoming.year,
    version: incoming.version,
    variant: incoming.variant,
    displayLabel: incoming.displayLabel,
    source: incoming.source,
    confirmedByUser: incoming.confirmedByUser,
  });
  return {
    ...enriched.vehicle,
    vehicleId: prior.vehicleId,
    confirmedByUser: prior.confirmedByUser || incoming.confirmedByUser,
    confidence: incoming.confidence || prior.confidence,
  };
}

export function singleNonUnknownVehicle(
  vehicles: readonly VehicleIdentity[] | undefined,
): VehicleIdentity | undefined {
  const list = (vehicles ?? []).filter(
    (v) => String(v.vehicleId ?? '').trim() && v.vehicleId !== 'veh_unknown',
  );
  return list.length === 1 ? list[0] : undefined;
}
