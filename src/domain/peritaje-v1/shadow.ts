import {
  UNKNOWN_VEHICLE_ID,
  createDamageItemId,
  createImageEvidence,
  createPeritajeId,
  normalizePhysicalPanelKey,
  physicalMergeKey,
} from './ids';
import {
  damageItemFromLegacy,
  vehicleIdentityFromLegacyLabel,
  type LegacyDetectedDamageShape,
  type LegacyViabilityShape,
} from './from-legacy';
import { parseStructuredTreatment, resolveLockedTreatment } from './treatment';
import { validateCanonicalPeritajeV1 } from './invariants';
import {
  PERITAJE_SCHEMA_VERSION,
  type CanonicalPeritajeV1,
  type DamageEvidence,
  type DamageItem,
  type IdentitySource,
  type InvariantViolation,
  type TreatmentDecision,
  type VehicleIdentity,
} from './types';

export const SHADOW_DIFF_TYPES = [
  'TREATMENT_MISSING_IN_LEGACY',
  'TREATMENT_DIFFERENCE',
  'VEHICLE_MISSING',
  'HIDDEN_DAMAGE_LOST',
  'PHYSICAL_IDENTITY_COLLISION',
  'EVIDENCE_LOST',
] as const;

export type ShadowDiffType = (typeof SHADOW_DIFF_TYPES)[number];

export type ShadowDifference = {
  type: ShadowDiffType;
  damageItemId?: string;
  vehicleId?: string;
  pieceCode?: string;
  treatmentCanonical?: string;
  treatmentLegacy?: string;
};

export type CanonicalShadowComparison = {
  conversationId: string;
  draftQuoteId?: string;
  peritajeId: string;
  tallerId?: string | null;
  status: 'CANONICAL_VALID' | 'CANONICAL_INVALID';
  differences: ShadowDifference[];
};

export type LegacyProjectionShape = {
  inventory?: Array<{
    pieza?: string;
    tratamiento?: string;
    vehiculoDetectado?: string;
    possibleHiddenDamage?: { detected?: boolean };
    urls_origen?: string[];
    urls_asociadas?: string[];
  }>;
  vehiculoDetectado?: string;
  lines?: Array<{
    tratamiento?: string;
    physicalPanelKey?: string;
    description?: string;
  }>;
  analysisBasisInventory?: Array<{
    pieza?: string;
    tratamiento?: string;
    urls_origen?: string[];
    possibleHiddenDamage?: { detected?: boolean };
    vehiculoDetectado?: string;
  }>;
};

export type ShadowVehicleHints = {
  userConfirmedLabel?: string | null;
  cartStructuredLabel?: string | null;
  cartTierSource?: string | null;
  visionDetectedLabel?: string | null;
  pricingProfileLabel?: string | null;
};

function trim(raw: unknown): string {
  return String(raw ?? '').trim();
}

function mapTierSource(tier?: string | null): IdentitySource | undefined {
  const t = trim(tier).toLowerCase();
  if (t === 'cliente') return 'user';
  if (t === 'operador') return 'operator';
  if (t === 'vision') return 'vision';
  if (t === 'llm' || t === 'inferido') return 'inferred';
  return undefined;
}

/**
 * Prioridad honesta. confirmedByUser solo con evidencia de confirmación
 * (label del usuario o perfil con tierSource=cliente). Año+modelo no basta.
 */
export function resolveShadowVehicleIdentity(
  hints: ShadowVehicleHints,
): VehicleIdentity {
  const userLabel = trim(hints.userConfirmedLabel);
  if (userLabel) {
    return vehicleIdentityFromLegacyLabel(userLabel, {
      source: 'user',
      confirmedByUser: true,
    });
  }

  const cartLabel = trim(hints.cartStructuredLabel);
  const cartSource = mapTierSource(hints.cartTierSource);
  if (cartLabel && cartSource === 'user') {
    return vehicleIdentityFromLegacyLabel(cartLabel, {
      source: 'user',
      confirmedByUser: true,
    });
  }
  if (cartLabel && cartSource === 'operator') {
    return vehicleIdentityFromLegacyLabel(cartLabel, {
      source: 'operator',
      confirmedByUser: false,
    });
  }

  const visionLabel = trim(hints.visionDetectedLabel);
  if (visionLabel) {
    return vehicleIdentityFromLegacyLabel(visionLabel, {
      source: 'vision',
      confirmedByUser: false,
    });
  }

  if (cartLabel) {
    return vehicleIdentityFromLegacyLabel(cartLabel, {
      source: cartSource ?? 'inferred',
      confirmedByUser: false,
    });
  }

  const profileLabel = trim(hints.pricingProfileLabel);
  if (profileLabel) {
    return vehicleIdentityFromLegacyLabel(profileLabel, {
      source: 'inferred',
      confirmedByUser: false,
    });
  }

  return vehicleIdentityFromLegacyLabel(null);
}

export function normalizeEvidenceList(raw: unknown): DamageEvidence[] {
  if (!Array.isArray(raw)) {
    if (raw && typeof raw === 'object') {
      const bag = raw as { imageUrls?: unknown; url?: unknown };
      if (Array.isArray(bag.imageUrls)) {
        return bag.imageUrls
          .map((u) => trim(u))
          .filter(Boolean)
          .map((url) => createImageEvidence(url));
      }
      if (typeof bag.url === 'string' && bag.url.trim()) {
        return [createImageEvidence(bag.url)];
      }
    }
    return [];
  }
  const out: DamageEvidence[] = [];
  const seen = new Set<string>();
  for (const el of raw) {
    if (!el || typeof el !== 'object') continue;
    const rec = el as Partial<DamageEvidence> & { imageUrls?: string[] };
    if (typeof rec.url === 'string' && rec.url.trim()) {
      const url = rec.url.trim();
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({
        evidenceId: rec.evidenceId || createImageEvidence(url).evidenceId,
        type: 'IMAGE',
        url,
        source: rec.source ?? 'customer',
        ...(rec.messageId ? { messageId: rec.messageId } : {}),
      });
      continue;
    }
    for (const url of rec.imageUrls ?? []) {
      const clean = trim(url);
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      out.push(createImageEvidence(clean));
    }
  }
  return out;
}

export function mergeDamageEvidence(
  prior: readonly DamageEvidence[],
  incomingUrls: readonly string[],
  messageId?: string,
): DamageEvidence[] {
  const byUrl = new Map<string, DamageEvidence>();
  for (const ev of normalizeEvidenceList(prior)) {
    if (ev.url) byUrl.set(ev.url, ev);
  }
  for (const raw of incomingUrls) {
    const url = trim(raw);
    if (!url) continue;
    const existing = byUrl.get(url);
    if (existing) {
      if (!existing.messageId && messageId) {
        byUrl.set(url, { ...existing, messageId });
      }
      continue;
    }
    byUrl.set(url, createImageEvidence(url, { messageId }));
  }
  return [...byUrl.values()];
}

function shadowTreatment(
  existing?: TreatmentDecision,
  incoming?: TreatmentDecision,
): ReturnType<typeof resolveLockedTreatment> {
  if (existing === 'PENDIENTE' && incoming && incoming !== 'PENDIENTE') {
    return resolveLockedTreatment({
      existing,
      incoming,
      mode: 'explicit_replace',
      incomingSource: 'vision',
    });
  }
  if (existing && incoming && existing !== incoming) {
    return resolveLockedTreatment({
      existing,
      incoming,
      mode: 'combine_stronger',
      incomingSource: 'vision',
    });
  }
  return resolveLockedTreatment({
    existing,
    incoming,
    mode: 'preserve',
    incomingSource: 'vision',
  });
}

function mergeShadowDamage(prior: DamageItem, incoming: DamageItem): DamageItem {
  const resolved = shadowTreatment(prior.treatment, incoming.treatment);
  return {
    ...prior,
    damageItemId: prior.damageItemId,
    vehicleId: prior.vehicleId || incoming.vehicleId,
    pieceCode: incoming.pieceCode || prior.pieceCode,
    pieceLabel: incoming.pieceLabel || prior.pieceLabel,
    physicalPanelKey: prior.physicalPanelKey,
    severity: incoming.severity || prior.severity,
    descriptionTechnical:
      incoming.descriptionTechnical || prior.descriptionTechnical,
    treatment: resolved.treatment,
    treatmentConfidence: incoming.treatmentConfidence || prior.treatmentConfidence,
    treatmentSource: resolved.source,
    treatmentReason: resolved.reason,
    requiresReplacement: resolved.treatment === 'SUSTITUIR',
    possibleReplacement:
      prior.possibleReplacement || incoming.possibleReplacement,
    ...(incoming.possibleHiddenDamage || prior.possibleHiddenDamage
      ? {
          possibleHiddenDamage:
            incoming.possibleHiddenDamage ?? prior.possibleHiddenDamage,
        }
      : {}),
    evidence: mergeDamageEvidence(
      prior.evidence,
      incoming.evidence.map((e) => e.url),
      incoming.evidence.find((e) => e.messageId)?.messageId,
    ),
    source: incoming.source || prior.source,
  };
}

export function mergeShadowPeritaje(input: {
  prior: CanonicalPeritajeV1 | null | undefined;
  incoming: CanonicalPeritajeV1;
  replaceInventory?: boolean;
  now?: string;
}): CanonicalPeritajeV1 {
  const now = input.now ?? new Date().toISOString();
  const prior = input.prior;
  if (!prior) {
    return { ...input.incoming, updatedAt: now };
  }

  const vehicles = new Map<string, VehicleIdentity>();
  for (const v of prior.vehicles) vehicles.set(v.vehicleId, v);
  for (const v of input.incoming.vehicles) {
    const existing = vehicles.get(v.vehicleId);
    if (!existing) {
      vehicles.set(v.vehicleId, v);
      continue;
    }
    if (existing.confirmedByUser && !v.confirmedByUser) continue;
    vehicles.set(v.vehicleId, {
      ...existing,
      ...v,
      confirmedByUser: existing.confirmedByUser || v.confirmedByUser,
      vehicleId: existing.vehicleId,
    });
  }

  const byKey = new Map<string, DamageItem>();
  if (!input.replaceInventory) {
    for (const d of prior.damages) {
      byKey.set(
        physicalMergeKey({
          vehicleId: d.vehicleId,
          physicalPanelKey: d.physicalPanelKey,
        }),
        d,
      );
    }
  }

  for (const incoming of input.incoming.damages) {
    const key = physicalMergeKey({
      vehicleId: incoming.vehicleId,
      physicalPanelKey: incoming.physicalPanelKey,
    });
    const existing = byKey.get(key);
    byKey.set(key, existing ? mergeShadowDamage(existing, incoming) : incoming);
  }

  return {
    schemaVersion: PERITAJE_SCHEMA_VERSION,
    peritajeId: prior.peritajeId,
    conversationId: incomingOrPrior(
      input.incoming.conversationId,
      prior.conversationId,
    ),
    tallerId: input.incoming.tallerId ?? prior.tallerId,
    vehicles: [...vehicles.values()],
    damages: [...byKey.values()],
    viability: input.incoming.viability ?? prior.viability,
    createdAt: prior.createdAt,
    updatedAt: now,
  };
}

function incomingOrPrior(a: string, b: string): string {
  return trim(a) || b;
}

export function buildVisionCanonicalShadow(input: {
  conversationId: string;
  tallerId?: string | null;
  messageId?: string;
  incomingInventory: readonly LegacyDetectedDamageShape[];
  priorInventory?: readonly LegacyDetectedDamageShape[];
  priorCanonical?: CanonicalPeritajeV1 | null;
  visionVehicleLabel?: string | null;
  analysisVehicleLabel?: string | null;
  cartVehicleLabel?: string | null;
  cartVehicleSource?: string | null;
  userConfirmedVehicleLabel?: string | null;
  pricingProfileLabel?: string | null;
  replaceInventory?: boolean;
  canonicalizePanel?: (raw: string) => string;
  now?: string;
  viability?: LegacyViabilityShape;
}): CanonicalPeritajeV1 {
  const now = input.now ?? new Date().toISOString();
  const rootVehicle = resolveShadowVehicleIdentity({
    userConfirmedLabel: input.userConfirmedVehicleLabel,
    cartStructuredLabel: input.cartVehicleLabel,
    cartTierSource: input.cartVehicleSource,
    visionDetectedLabel:
      input.visionVehicleLabel || input.analysisVehicleLabel,
    pricingProfileLabel: input.pricingProfileLabel,
  });

  const adapt = (
    items: readonly LegacyDetectedDamageShape[],
    source: 'vision' | 'legacy',
  ): DamageItem[] =>
    items.map((item) => {
      const itemVehicle = item.vehiculoDetectado
        ? vehicleIdentityFromLegacyLabel(item.vehiculoDetectado, {
            source: source === 'vision' ? 'vision' : 'inferred',
            confirmedByUser: false,
          })
        : rootVehicle;
      const adapted = damageItemFromLegacy(item, {
        vehicleId: itemVehicle.vehicleId,
        source,
        treatmentSource: source === 'vision' ? 'vision' : 'legacy',
        canonicalizePanel: input.canonicalizePanel ?? normalizePhysicalPanelKey,
        sourceMessageId: input.messageId,
      });
      return {
        ...adapted,
        damageItemId: createDamageItemId({
          vehicleId: adapted.vehicleId,
          physicalPanelKey: adapted.physicalPanelKey,
        }),
      };
    });

  const incomingDamages = adapt(input.incomingInventory, 'vision');
  const priorDamages =
    input.priorCanonical?.damages ??
    adapt(input.priorInventory ?? [], 'legacy');

  const vehiclesById = new Map<string, VehicleIdentity>([
    [rootVehicle.vehicleId, rootVehicle],
  ]);
  if (input.priorCanonical) {
    for (const v of input.priorCanonical.vehicles) {
      if (!vehiclesById.has(v.vehicleId)) vehiclesById.set(v.vehicleId, v);
    }
  }
  for (const item of [
    ...(input.incomingInventory ?? []),
    ...(input.priorInventory ?? []),
  ]) {
    if (!item.vehiculoDetectado) continue;
    const v = vehicleIdentityFromLegacyLabel(item.vehiculoDetectado, {
      source: 'vision',
      confirmedByUser: false,
    });
    if (!vehiclesById.has(v.vehicleId)) vehiclesById.set(v.vehicleId, v);
  }

  const incomingDoc: CanonicalPeritajeV1 = {
    schemaVersion: PERITAJE_SCHEMA_VERSION,
    peritajeId: input.priorCanonical?.peritajeId ?? createPeritajeId(),
    conversationId: input.conversationId,
    tallerId: input.tallerId ?? null,
    vehicles: [...vehiclesById.values()],
    damages: incomingDamages,
    viability: input.viability
      ? {
          viable: input.viability.peritajeViable !== false,
          ...(input.viability.motivoInviable
            ? { reasonCode: input.viability.motivoInviable }
            : {}),
          ...(input.viability.mensajeClienteAclaracion
            ? { clientClarification: input.viability.mensajeClienteAclaracion }
            : {}),
        }
      : { viable: true },
    createdAt: input.priorCanonical?.createdAt ?? now,
    updatedAt: now,
  };

  const priorDoc: CanonicalPeritajeV1 | null = input.priorCanonical
    ? input.priorCanonical
    : priorDamages.length
      ? {
          ...incomingDoc,
          peritajeId: incomingDoc.peritajeId,
          damages: priorDamages,
        }
      : null;

  const merged = mergeShadowPeritaje({
    prior: priorDoc,
    incoming: incomingDoc,
    replaceInventory: input.replaceInventory === true,
    now,
  });
  const usedVehicleIds = new Set(merged.damages.map((d) => d.vehicleId));
  const vehicles = merged.vehicles.filter((v) => usedVehicleIds.has(v.vehicleId));
  if (!vehicles.length && merged.vehicles.length) {
    return merged;
  }
  return {
    ...merged,
    vehicles: vehicles.length ? vehicles : merged.vehicles,
  };
}

export function isCanonicalPeritajeV1(
  raw: unknown,
): raw is CanonicalPeritajeV1 {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Partial<CanonicalPeritajeV1>;
  return (
    o.schemaVersion === PERITAJE_SCHEMA_VERSION &&
    typeof o.peritajeId === 'string' &&
    Array.isArray(o.vehicles) &&
    Array.isArray(o.damages)
  );
}

export function selectCanonicalShadowToPersist(input: {
  prior?: CanonicalPeritajeV1 | null;
  incoming?: CanonicalPeritajeV1 | null;
}): {
  status: 'CANONICAL_VALID' | 'CANONICAL_INVALID' | 'CANONICAL_SKIPPED';
  persisted: CanonicalPeritajeV1 | null;
  violations: InvariantViolation[];
} {
  if (!input.incoming) {
    return {
      status: 'CANONICAL_SKIPPED',
      persisted: input.prior ?? null,
      violations: [],
    };
  }
  const violations = validateCanonicalPeritajeV1(input.incoming);
  if (violations.length) {
    const priorOk =
      input.prior && validateCanonicalPeritajeV1(input.prior).length === 0
        ? input.prior
        : null;
    return {
      status: 'CANONICAL_INVALID',
      persisted: priorOk,
      violations,
    };
  }
  return {
    status: 'CANONICAL_VALID',
    persisted: input.incoming,
    violations: [],
  };
}

function panelOf(raw: string | undefined, canonicalize?: (s: string) => string): string {
  const t = trim(raw);
  if (!t) return '';
  return canonicalize ? canonicalize(t) : normalizePhysicalPanelKey(t);
}

export function compareLegacyVsCanonical(input: {
  canonical: CanonicalPeritajeV1;
  conversationId: string;
  draftQuoteId?: string;
  tallerId?: string | null;
  status: 'CANONICAL_VALID' | 'CANONICAL_INVALID';
  legacy: LegacyProjectionShape;
  canonicalizePanel?: (raw: string) => string;
}): CanonicalShadowComparison {
  const differences: ShadowDifference[] = [];
  const inventory = input.legacy.inventory ?? [];
  const basis = input.legacy.analysisBasisInventory ?? [];
  const lines = input.legacy.lines ?? [];
  const canon = input.canonicalizePanel;

  for (const damage of input.canonical.damages) {
    const legacyItem =
      inventory.find(
        (it) =>
          panelOf(it.pieza, canon) === damage.physicalPanelKey ||
          trim(it.pieza) === damage.pieceCode,
      ) ??
      basis.find(
        (it) =>
          panelOf(it.pieza, canon) === damage.physicalPanelKey ||
          trim(it.pieza) === damage.pieceCode,
      );

    const legacyTreatment = parseStructuredTreatment(legacyItem?.tratamiento);
    const lineTreatment = parseStructuredTreatment(
      lines.find(
        (l) =>
          panelOf(l.physicalPanelKey, canon) === damage.physicalPanelKey ||
          (l.description ?? '').includes(damage.pieceCode),
      )?.tratamiento,
    );

    if (
      damage.treatment !== 'PENDIENTE' &&
      legacyItem &&
      legacyTreatment == null &&
      lineTreatment == null
    ) {
      differences.push({
        type: 'TREATMENT_MISSING_IN_LEGACY',
        damageItemId: damage.damageItemId,
        vehicleId: damage.vehicleId,
        pieceCode: damage.pieceCode,
        treatmentCanonical: damage.treatment,
      });
    }

    const observed = legacyTreatment ?? lineTreatment;
    if (observed && observed !== damage.treatment) {
      differences.push({
        type: 'TREATMENT_DIFFERENCE',
        damageItemId: damage.damageItemId,
        vehicleId: damage.vehicleId,
        pieceCode: damage.pieceCode,
        treatmentCanonical: damage.treatment,
        treatmentLegacy: observed,
      });
    }

    if (
      damage.possibleHiddenDamage?.detected &&
      legacyItem &&
      !legacyItem.possibleHiddenDamage?.detected
    ) {
      differences.push({
        type: 'HIDDEN_DAMAGE_LOST',
        damageItemId: damage.damageItemId,
        vehicleId: damage.vehicleId,
        pieceCode: damage.pieceCode,
      });
    }

    const legacyUrls = new Set(
      [
        ...(legacyItem?.urls_origen ?? []),
        ...(legacyItem?.urls_asociadas ?? []),
      ].map(trim).filter(Boolean),
    );
    const basisUrls = new Set(
      (basis.find((it) => panelOf(it.pieza, canon) === damage.physicalPanelKey)
        ?.urls_origen ?? []
      )
        .map(trim)
        .filter(Boolean),
    );
    const lost = damage.evidence.filter(
      (ev) => ev.url && !legacyUrls.has(ev.url) && basis.length > 0 && !basisUrls.has(ev.url),
    );
    if (lost.length && basis.length > 0 && legacyUrls.size + basisUrls.size >= 0) {
      const basisHit = basis.find(
        (it) => panelOf(it.pieza, canon) === damage.physicalPanelKey,
      );
      if (basisHit && damage.evidence.some((ev) => !basisUrls.has(ev.url))) {
        differences.push({
          type: 'EVIDENCE_LOST',
          damageItemId: damage.damageItemId,
          vehicleId: damage.vehicleId,
          pieceCode: damage.pieceCode,
        });
      }
    }
  }

  const canonicalHasVehicle = input.canonical.vehicles.some(
    (v) => v.vehicleId !== UNKNOWN_VEHICLE_ID && trim(v.displayLabel),
  );
  const legacyVehicle = trim(
    input.legacy.vehiculoDetectado ||
      inventory.find((i) => i.vehiculoDetectado)?.vehiculoDetectado,
  );
  if (canonicalHasVehicle && !legacyVehicle) {
    differences.push({
      type: 'VEHICLE_MISSING',
      vehicleId: input.canonical.vehicles[0]?.vehicleId,
    });
  }

  const byPanel = new Map<string, Set<string>>();
  for (const d of input.canonical.damages) {
    const set = byPanel.get(d.physicalPanelKey) ?? new Set();
    set.add(d.vehicleId);
    byPanel.set(d.physicalPanelKey, set);
  }
  for (const [panel, vehicleIds] of byPanel) {
    if (vehicleIds.size > 1) {
      differences.push({
        type: 'PHYSICAL_IDENTITY_COLLISION',
        pieceCode: panel,
      });
    }
  }

  return {
    conversationId: input.conversationId,
    ...(input.draftQuoteId ? { draftQuoteId: input.draftQuoteId } : {}),
    peritajeId: input.canonical.peritajeId,
    ...(input.tallerId !== undefined ? { tallerId: input.tallerId } : {}),
    status: input.status,
    differences,
  };
}

export function formatShadowLogPayload(
  comparison: CanonicalShadowComparison,
  extra?: { violationCodes?: string[] },
): Record<string, unknown> {
  return {
    conversationId: comparison.conversationId,
    ...(comparison.tallerId != null ? { tallerId: comparison.tallerId } : {}),
    ...(comparison.draftQuoteId ? { draftQuoteId: comparison.draftQuoteId } : {}),
    peritajeId: comparison.peritajeId,
    status: comparison.status,
    differenceCount: comparison.differences.length,
    differences: comparison.differences.map((d) => ({
      type: d.type,
      damageItemId: d.damageItemId,
      vehicleId: d.vehicleId,
      pieceCode: d.pieceCode,
      treatmentCanonical: d.treatmentCanonical,
      treatmentLegacy: d.treatmentLegacy,
    })),
    ...(extra?.violationCodes?.length
      ? { violationCodes: extra.violationCodes }
      : {}),
  };
}

export function tryBuildVisionCanonicalShadow(
  input: Parameters<typeof buildVisionCanonicalShadow>[0],
): CanonicalPeritajeV1 | null {
  try {
    return buildVisionCanonicalShadow(input);
  } catch {
    return null;
  }
}
