import { createDamageItemId } from './ids';
import { vehicleIdentityFromLegacyLabel } from './from-legacy';
import { reusePriorVehicleIdentity, singleNonUnknownVehicle } from './vehicle-identity-enrich';
import type { DamageItem, VehicleIdentity } from './types';

/**
 * Marcas conocidas para distinguir multi-vehicle real vs inconsistencia Vision.
 * "Altima" suelto no cuenta como segunda marca.
 */
const KNOWN_MAKES = [
  'mercedes-benz',
  'mercedes',
  'volkswagen',
  'chevrolet',
  'mitsubishi',
  'land rover',
  'mazda',
  'nissan',
  'toyota',
  'honda',
  'ford',
  'kia',
  'hyundai',
  'bmw',
  'audi',
  'seat',
  'renault',
  'peugeot',
  'dodge',
  'jeep',
  'ram',
  'gmc',
  'subaru',
  'suzuki',
  'volvo',
  'lexus',
  'infiniti',
  'acura',
  'mini',
  'porsche',
  'tesla',
  'vw',
  'byd',
] as const;

function normalizeLabel(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractKnownMake(label: unknown): string | undefined {
  const n = normalizeLabel(label);
  if (!n) return undefined;
  const compact = n.replace(/\s+/g, '');
  let best: string | undefined;
  for (const brand of KNOWN_MAKES) {
    const b = brand.replace(/\s+/g, '');
    if (n === brand || n.startsWith(`${brand} `) || compact.startsWith(b)) {
      if (!best || brand.length > best.length) best = brand;
    }
  }
  return best === 'vw' ? 'volkswagen' : best;
}

export type VisionBurstVehicleMode = 'SINGLE' | 'MULTI';

export type VisionBurstVehiclePolicy = {
  mode: VisionBurstVehicleMode;
  reason:
    | 'prior_multi_vehicle'
    | 'explicit_multi_vehicle'
    | 'distinct_known_makes'
    | 'same_burst_single_vehicle'
    | 'same_known_make'
    | 'prior_single_vehicle';
  knownMakes: string[];
  canonical?: VehicleIdentity;
};

export function collectVisionBurstLabels(input: {
  rootLabel?: string | null;
  itemLabels?: readonly (string | null | undefined)[];
}): string[] {
  const out: string[] = [];
  const push = (raw: unknown) => {
    const s = String(raw ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  push(input.rootLabel);
  for (const label of input.itemLabels ?? []) push(label);
  return out;
}

/**
 * Un burst de Vision (varios lotes de ≤4 fotos) es un solo vehículo
 * salvo evidencia fuerte de multi-vehicle:
 * - el peritaje previo ya tiene 2+ vehicleId;
 * - flag explícito (express / carrito multi);
 * - 2+ marcas conocidas distintas en las etiquetas.
 *
 * Nissan Versa + Nissan Altima (misma marca, Vision incierta) → SINGLE.
 * Mazda 3 + Nissan Versa → MULTI.
 */
export function resolveVisionBurstVehiclePolicy(input: {
  priorVehicles?: readonly VehicleIdentity[] | null;
  rootLabel?: string | null;
  itemLabels?: readonly (string | null | undefined)[];
  explicitMultiVehicle?: boolean;
}): VisionBurstVehiclePolicy {
  const priorKnown = (input.priorVehicles ?? []).filter(
    (v) => v.vehicleId && v.vehicleId !== 'veh_unknown',
  );
  const labels = collectVisionBurstLabels({
    rootLabel: input.rootLabel,
    itemLabels: input.itemLabels,
  });
  const knownMakes = [
    ...new Set(
      labels
        .map((l) => extractKnownMake(l))
        .filter((m): m is string => Boolean(m)),
    ),
  ];

  if (priorKnown.length >= 2) {
    return {
      mode: 'MULTI',
      reason: 'prior_multi_vehicle',
      knownMakes,
    };
  }
  if (input.explicitMultiVehicle) {
    return {
      mode: 'MULTI',
      reason: 'explicit_multi_vehicle',
      knownMakes,
    };
  }
  if (knownMakes.length >= 2) {
    return {
      mode: 'MULTI',
      reason: 'distinct_known_makes',
      knownMakes,
    };
  }

  const prior = singleNonUnknownVehicle(priorKnown);
  const preferredLabel =
    input.rootLabel?.trim() ||
    labels.sort((a, b) => b.length - a.length)[0] ||
    '';
  const computed = vehicleIdentityFromLegacyLabel(preferredLabel || undefined, {
    source: 'vision',
    confirmedByUser: false,
  });
  const canonical = prior
    ? reusePriorVehicleIdentity(prior, computed)
    : computed;
  return {
    mode: 'SINGLE',
    reason: prior ? 'prior_single_vehicle' : knownMakes.length === 1
      ? 'same_known_make'
      : 'same_burst_single_vehicle',
    knownMakes,
    canonical,
  };
}

export function remapDamageToVehicle(
  damage: DamageItem,
  vehicleId: string,
): DamageItem {
  if (damage.vehicleId === vehicleId) return damage;
  return {
    ...damage,
    vehicleId,
    damageItemId: createDamageItemId({
      vehicleId,
      physicalPanelKey: damage.physicalPanelKey,
    }),
  };
}

export function stampDamagesOntoVehicle(
  damages: readonly DamageItem[],
  vehicleId: string,
): DamageItem[] {
  return damages.map((d) => remapDamageToVehicle(d, vehicleId));
}

/**
 * Etiquetas de ítem que, hasheadas solas, inventarían otro vehicleId.
 * En modo SINGLE eso es drift de Vision, no un segundo auto.
 */
export function collectSingleVehicleIdentityMismatches(input: {
  canonicalVehicleId: string;
  itemLabels?: readonly (string | null | undefined)[];
}): Array<{ label: string; candidateVehicleId: string }> {
  const out: Array<{ label: string; candidateVehicleId: string }> = [];
  for (const raw of input.itemLabels ?? []) {
    const label = String(raw ?? '').trim();
    if (!label) continue;
    const candidate = vehicleIdentityFromLegacyLabel(label, {
      source: 'vision',
      confirmedByUser: false,
    });
    if (
      candidate.vehicleId &&
      candidate.vehicleId !== 'veh_unknown' &&
      candidate.vehicleId !== input.canonicalVehicleId
    ) {
      out.push({ label, candidateVehicleId: candidate.vehicleId });
    }
  }
  return out;
}
