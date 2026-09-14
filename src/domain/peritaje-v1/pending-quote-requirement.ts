import { createHash } from 'node:crypto';
import type { CanonicalPeritajeV1, CanonicalQuoteV1, VehicleIdentity } from './types';

export const PENDING_QUOTE_REQUIREMENT_TYPES = ['VEHICLE_DATA'] as const;
export type PendingQuoteRequirementType =
  (typeof PENDING_QUOTE_REQUIREMENT_TYPES)[number];

export const PENDING_QUOTE_REQUIREMENT_REASONS = [
  'REFACCION_MARKET_LOOKUP',
] as const;
export type PendingQuoteRequirementReason =
  (typeof PENDING_QUOTE_REQUIREMENT_REASONS)[number];

export const PENDING_QUOTE_REQUIREMENT_STATUSES = ['OPEN', 'RESOLVED'] as const;
export type PendingQuoteRequirementStatus =
  (typeof PENDING_QUOTE_REQUIREMENT_STATUSES)[number];

export const REFACCION_REQUIRED_VEHICLE_FIELDS = [
  'make',
  'model',
  'year',
] as const;
export type RefaccionRequiredVehicleField =
  (typeof REFACCION_REQUIRED_VEHICLE_FIELDS)[number];

/**
 * Requisito persistente de una cotización canónica parcial.
 * Vive en DraftQuote.pendingRequirements (quotePayload jsonb).
 */
export interface PendingQuoteRequirement {
  requirementId: string;
  conversationId: string;
  quoteId: string;
  vehicleId: string;
  damageItemId: string;
  type: PendingQuoteRequirementType;
  requiredFields: string[];
  missingFields?: string[];
  confirmationFields?: string[];
  reason: PendingQuoteRequirementReason;
  status: PendingQuoteRequirementStatus;
  createdAt?: string;
  resolvedAt?: string;
}

export type RefaccionIdentityGaps = {
  missingFields: RefaccionRequiredVehicleField[];
  confirmationFields: RefaccionRequiredVehicleField[];
  requiredFields: RefaccionRequiredVehicleField[];
  readyForMarket: boolean;
};

const PLACEHOLDER_MODEL_RE =
  /^(tu\s+)?(veh[ií]culo|unidad|auto|coche|cliente|desconocido|unknown|n\/?a|sin\s+dato)s?$/i;

function slugField(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function isUsableModel(raw: unknown): boolean {
  const model = String(raw ?? '').trim();
  if (!model) return false;
  return !PLACEHOLDER_MODEL_RE.test(model);
}

export function isValidVehicleYear(raw: unknown): boolean {
  const year = String(raw ?? '').replace(/\D/g, '').slice(0, 4);
  if (!/^(19|20)\d{2}$/.test(year)) return false;
  const n = Number(year);
  const max = new Date().getFullYear() + 1;
  return n >= 1900 && n <= max;
}

export function missingRefaccionVehicleFields(input: {
  make?: string | null;
  model?: string | null;
  year?: string | null;
  marca?: string | null;
  modelo?: string | null;
  anio?: string | null;
}): RefaccionRequiredVehicleField[] {
  const make = String(input.make ?? input.marca ?? '').trim();
  const model = String(input.model ?? input.modelo ?? '').trim();
  const year = String(input.year ?? input.anio ?? '').replace(/\D/g, '').slice(0, 4);
  const missing: RefaccionRequiredVehicleField[] = [];
  if (!make) missing.push('make');
  if (!isUsableModel(model)) missing.push('model');
  if (!isValidVehicleYear(year)) missing.push('year');
  return missing;
}

export function refaccionIdentityGaps(vehicle?: {
  make?: string | null;
  model?: string | null;
  year?: string | null;
  marca?: string | null;
  modelo?: string | null;
  anio?: string | null;
  confirmedByUser?: boolean;
  confirmedFields?: readonly string[];
  source?: string;
} | null): RefaccionIdentityGaps {
  const missing = missingRefaccionVehicleFields(vehicle ?? {});
  const confirmed = new Set(
    (vehicle?.confirmedFields ?? []).map((f) => String(f).toLowerCase()),
  );
  const fullyConfirmed = vehicle?.confirmedByUser === true;
  const confirmation: RefaccionRequiredVehicleField[] = [];
  if (!fullyConfirmed) {
    const make = String(vehicle?.make ?? vehicle?.marca ?? '').trim();
    const model = String(vehicle?.model ?? vehicle?.modelo ?? '').trim();
    const year = String(vehicle?.year ?? vehicle?.anio ?? '').replace(/\D/g, '').slice(0, 4);
    if (make && !confirmed.has('make') && !missing.includes('make')) {
      confirmation.push('make');
    }
    if (isUsableModel(model) && !confirmed.has('model') && !missing.includes('model')) {
      confirmation.push('model');
    }
    if (
      isValidVehicleYear(year) &&
      !confirmed.has('year') &&
      !missing.includes('year')
    ) {
      confirmation.push('year');
    }
  }
  const required = [...new Set([...missing, ...confirmation])];
  return {
    missingFields: missing,
    confirmationFields: confirmation,
    requiredFields: required,
    readyForMarket: required.length === 0,
  };
}

export function vehicleHasRefaccionIdentity(
  input: Parameters<typeof missingRefaccionVehicleFields>[0] & {
    confirmedByUser?: boolean;
    confirmedFields?: readonly string[];
    source?: string;
  },
): boolean {
  return refaccionIdentityGaps(input).readyForMarket;
}

export function createPendingRequirementId(input: {
  conversationId: string;
  quoteId: string;
  vehicleId: string;
  damageItemId: string;
  type?: string;
  reason?: string;
}): string {
  const payload = [
    input.conversationId,
    input.quoteId,
    input.vehicleId,
    input.damageItemId,
    input.type ?? 'VEHICLE_DATA',
    input.reason ?? 'REFACCION_MARKET_LOOKUP',
  ]
    .map((p) => slugField(p))
    .join('|');
  return `req_${createHash('sha1').update(payload).digest('hex').slice(0, 16)}`;
}

export function upsertOpenVehicleDataRequirement(
  existing: readonly PendingQuoteRequirement[] | undefined,
  next: Omit<PendingQuoteRequirement, 'status' | 'createdAt'> & {
    status?: PendingQuoteRequirementStatus;
    createdAt?: string;
  },
  now = new Date().toISOString(),
): PendingQuoteRequirement[] {
  const requirementId =
    next.requirementId ||
    createPendingRequirementId({
      conversationId: next.conversationId,
      quoteId: next.quoteId,
      vehicleId: next.vehicleId,
      damageItemId: next.damageItemId,
      type: next.type,
      reason: next.reason,
    });
  const list = [...(existing ?? [])];
  const idx = list.findIndex((r) => r.requirementId === requirementId);
  if (idx >= 0) {
    const prev = list[idx]!;
    if (prev.status === 'OPEN') {
      list[idx] = {
        ...prev,
        requiredFields: [...next.requiredFields],
        missingFields: next.missingFields ? [...next.missingFields] : prev.missingFields,
        confirmationFields: next.confirmationFields
          ? [...next.confirmationFields]
          : prev.confirmationFields,
        quoteId: next.quoteId || prev.quoteId,
      };
      return list;
    }
    return list;
  }
  list.push({
    ...next,
    requirementId,
    status: 'OPEN',
    createdAt: next.createdAt ?? now,
  });
  return list;
}

export function resolvePendingRequirementsForVehicle(
  existing: readonly PendingQuoteRequirement[] | undefined,
  vehicle: VehicleIdentity,
  now = new Date().toISOString(),
): {
  next: PendingQuoteRequirement[];
  resolved: PendingQuoteRequirement[];
} {
  const resolved: PendingQuoteRequirement[] = [];
  const next = (existing ?? []).map((req) => {
    if (req.status !== 'OPEN') return req;
    if (req.vehicleId !== vehicle.vehicleId) return req;
    if (req.type !== 'VEHICLE_DATA') return req;
    const gaps = refaccionIdentityGaps(vehicle);
    const stillOpen = gaps.requiredFields.filter((f) =>
      (req.requiredFields ?? []).includes(f),
    );
    if (stillOpen.length || !gaps.readyForMarket) return req;
    const done: PendingQuoteRequirement = {
      ...req,
      status: 'RESOLVED',
      resolvedAt: now,
    };
    resolved.push(done);
    return done;
  });
  return { next, resolved };
}

/**
 * Sincroniza requirements OPEN con líneas REFACCION AWAITING.
 * No duplica: requirementId es determinista.
 * No reabre RESOLVED si la línea ya no está AWAITING.
 */
export function syncPendingQuoteRequirements(input: {
  existing?: readonly PendingQuoteRequirement[] | undefined;
  conversationId: string;
  quoteId: string;
  peritaje: CanonicalPeritajeV1;
  quote: CanonicalQuoteV1;
  now?: string;
}): {
  requirements: PendingQuoteRequirement[];
  created: PendingQuoteRequirement[];
} {
  const now = input.now ?? new Date().toISOString();
  const vehicles = new Map(
    (input.peritaje.vehicles ?? []).map((v) => [v.vehicleId, v]),
  );
  let list = [...(input.existing ?? [])];
  const created: PendingQuoteRequirement[] = [];
  const awaitingIds = new Set<string>();

  for (const line of input.quote.lines) {
    if (line.serviceType !== 'REFACCION') continue;
    if (line.pricingStatus !== 'AWAITING_VEHICLE_DATA') continue;
    const vehicle = vehicles.get(line.vehicleId);
    const gaps = refaccionIdentityGaps(vehicle);
    if (gaps.readyForMarket) continue;
    awaitingIds.add(line.damageItemId);
    const before = list.length;
    const requirementId = createPendingRequirementId({
      conversationId: input.conversationId,
      quoteId: input.quoteId,
      vehicleId: line.vehicleId,
      damageItemId: line.damageItemId,
    });
    const hadOpen = list.some(
      (r) => r.requirementId === requirementId && r.status === 'OPEN',
    );
    list = upsertOpenVehicleDataRequirement(
      list,
      {
        requirementId,
        conversationId: input.conversationId,
        quoteId: input.quoteId,
        vehicleId: line.vehicleId,
        damageItemId: line.damageItemId,
        type: 'VEHICLE_DATA',
        requiredFields: [...gaps.requiredFields],
        missingFields: [...gaps.missingFields],
        confirmationFields: [...gaps.confirmationFields],
        reason: 'REFACCION_MARKET_LOOKUP',
      },
      now,
    );
    if (!hadOpen && list.length > before) {
      const added = list.find((r) => r.requirementId === requirementId);
      if (added) created.push(added);
    }
  }

  list = list.map((req) => {
    if (req.status !== 'OPEN') return req;
    if (req.reason !== 'REFACCION_MARKET_LOOKUP') return req;
    if (awaitingIds.has(req.damageItemId)) return req;
    const line = input.quote.lines.find(
      (l) =>
        l.damageItemId === req.damageItemId && l.serviceType === 'REFACCION',
    );
    if (!line) return req;
    if (line.pricingStatus === 'AWAITING_VEHICLE_DATA') return req;
    return { ...req, status: 'RESOLVED' as const, resolvedAt: now };
  });

  return { requirements: list, created };
}

export function openPendingQuoteRequirements(
  existing: readonly PendingQuoteRequirement[] | undefined,
): PendingQuoteRequirement[] {
  return (existing ?? []).filter((r) => r.status === 'OPEN');
}

export function formatPendingCanonicalRequirementsContext(input: {
  requirements: readonly PendingQuoteRequirement[];
  peritaje?: CanonicalPeritajeV1 | null;
}): string {
  const open = openPendingQuoteRequirements(input.requirements);
  if (!open.length) return '';
  const damages = new Map(
    (input.peritaje?.damages ?? []).map((d) => [d.damageItemId, d]),
  );
  const vehicles = new Map(
    (input.peritaje?.vehicles ?? []).map((v) => [v.vehicleId, v]),
  );
  const lines = open.map((req) => {
    const damage = damages.get(req.damageItemId);
    const vehicle = vehicles.get(req.vehicleId);
    const piece =
      damage?.pieceLabel?.trim() || damage?.pieceCode || req.damageItemId;
    const vehicleLabel = [vehicle?.make, vehicle?.model, vehicle?.year]
      .filter(Boolean)
      .join(' ')
      .trim() || vehicle?.displayLabel || req.vehicleId;
    return [
      `- reason: ${req.reason}`,
      `- piece: ${piece}`,
      `- vehicle: ${vehicleLabel}`,
      `- missingFields: ${(req.missingFields ?? req.requiredFields).join(', ') || '—'}`,
      `- confirmationFields: ${(req.confirmationFields ?? []).join(', ') || '—'}`,
    ].join('\n');
  });
  return `PENDING_CANONICAL_REQUIREMENTS:\n${lines.join('\n')}`;
}
