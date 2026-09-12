import {
  createDamageItemId,
  createImageEvidence,
  createPeritajeId,
  createVehicleId,
  normalizePhysicalPanelKey,
  UNKNOWN_VEHICLE_ID,
} from './ids';
import { parseStructuredTreatment, treatmentImpliesReplacement } from './treatment';
import {
  PERITAJE_SCHEMA_VERSION,
  type CanonicalPeritajeV1,
  type DamageItem,
  type DamageItemSource,
  type IdentitySource,
  type PeritajeViability,
  type TreatmentSource,
  type VehicleIdentity,
} from './types';

/**
 * Forma estructural del inventario legacy.
 * No importa `DetectedDamageItem` para no acoplar el dominio a chat/.
 */
export type LegacyDetectedDamageShape = {
  pieza: string;
  severidad: string;
  descripcionTecnica?: string;
  descripcion?: string;
  urls_origen?: string[];
  urls_asociadas?: string[];
  vehiculoDetectado?: string;
  tratamiento?: string;
  posibleReemplazoRefaccion?: boolean;
  possibleHiddenDamage?: {
    detected: boolean;
    areas: string[];
    requiresDisassembly: boolean;
  };
};

export type LegacyAnalysisShape = {
  inventory?: LegacyDetectedDamageShape[];
  vehiculoDetectado?: string;
};

export type LegacyViabilityShape = {
  peritajeViable?: boolean;
  motivoInviable?: string;
  mensajeClienteAclaracion?: string;
};

function trim(raw: unknown): string {
  return String(raw ?? '').trim();
}

function parseYear(label: string): string | undefined {
  const m = label.match(/\b((?:19|20)\d{2})\b/);
  return m?.[1];
}

/**
 * Convierte la etiqueta libre `vehiculoDetectado` en VehicleIdentity.
 * No confirma al usuario: eso vive en gates legacy.
 */
export function vehicleIdentityFromLegacyLabel(
  label: string | undefined | null,
  opts?: { source?: IdentitySource; confirmedByUser?: boolean },
): VehicleIdentity {
  const displayLabel = trim(label);
  if (!displayLabel) {
    return {
      vehicleId: UNKNOWN_VEHICLE_ID,
      displayLabel: 'Vehículo no identificado',
      confidence: 'UNKNOWN',
      source: 'system',
      confirmedByUser: false,
    };
  }

  const year = parseYear(displayLabel);
  const withoutYear = displayLabel
    .replace(/\b((?:19|20)\d{2})\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = withoutYear.split(/\s+/).filter(Boolean);
  const make = parts[0];
  const model = parts.slice(1).join(' ') || undefined;

  return {
    vehicleId: createVehicleId({
      make,
      model,
      year,
      displayLabel,
    }),
    ...(make ? { make } : {}),
    ...(model ? { model } : {}),
    ...(year ? { year } : {}),
    displayLabel,
    confidence: year && model ? 'MEDIUM' : 'LOW',
    source: opts?.source ?? 'vision',
    confirmedByUser: opts?.confirmedByUser === true,
  };
}

export function damageItemFromLegacy(
  item: LegacyDetectedDamageShape,
  ctx: {
    vehicleId: string;
    source?: DamageItemSource;
    treatmentSource?: TreatmentSource;
    canonicalizePanel?: (raw: string) => string;
    sourceMessageId?: string;
  },
): DamageItem {
  const pieceCode = trim(item.pieza);
  const panelRaw = ctx.canonicalizePanel
    ? ctx.canonicalizePanel(pieceCode)
    : normalizePhysicalPanelKey(pieceCode);
  const physicalPanelKey = panelRaw || pieceCode;
  const descriptionTechnical =
    trim(item.descripcionTecnica) ||
    trim(item.descripcion) ||
    'Sin descripción técnica disponible.';
  const imageUrls = [
    ...((item.urls_origen ?? item.urls_asociadas ?? []).map(trim).filter(Boolean)),
  ];
  const locked = parseStructuredTreatment(item.tratamiento);

  return {
    damageItemId: createDamageItemId({
      vehicleId: ctx.vehicleId,
      physicalPanelKey,
    }),
    vehicleId: ctx.vehicleId,
    pieceCode,
    pieceLabel: pieceCode,
    physicalPanelKey,
    severity: trim(item.severidad),
    descriptionTechnical,
    treatment: locked ?? 'PENDIENTE',
    treatmentConfidence: locked ? 'MEDIUM' : 'UNKNOWN',
    treatmentSource: locked
      ? (ctx.treatmentSource ?? 'legacy')
      : 'legacy',
    treatmentReason: locked
      ? 'legacy_structured_treatment'
      : 'missing_structured_treatment',
    requiresReplacement: treatmentImpliesReplacement(locked ?? 'PENDIENTE'),
    possibleReplacement: item.posibleReemplazoRefaccion === true,
    ...(item.possibleHiddenDamage
      ? { possibleHiddenDamage: item.possibleHiddenDamage }
      : {}),
    evidence: imageUrls.map((url) =>
      createImageEvidence(url, { messageId: ctx.sourceMessageId }),
    ),
    source: ctx.source ?? 'legacy',
  };
}

export function peritajeFromLegacyAnalysis(input: {
  analysis: LegacyAnalysisShape;
  conversationId: string;
  tallerId?: string | null;
  peritajeId?: string;
  viability?: LegacyViabilityShape;
  now?: string;
  sourceMessageId?: string;
  canonicalizePanel?: (raw: string) => string;
}): CanonicalPeritajeV1 {
  const now = input.now ?? new Date().toISOString();
  const inventory = input.analysis.inventory ?? [];
  const rootVehicle = vehicleIdentityFromLegacyLabel(
    input.analysis.vehiculoDetectado || inventory.find((i) => i.vehiculoDetectado)
      ?.vehiculoDetectado,
  );

  const vehiclesById = new Map<string, VehicleIdentity>([
    [rootVehicle.vehicleId, rootVehicle],
  ]);
  const damages: DamageItem[] = [];

  for (const item of inventory) {
    const itemVehicle = item.vehiculoDetectado
      ? vehicleIdentityFromLegacyLabel(item.vehiculoDetectado)
      : rootVehicle;
    if (!vehiclesById.has(itemVehicle.vehicleId)) {
      vehiclesById.set(itemVehicle.vehicleId, itemVehicle);
    }
    damages.push(
      damageItemFromLegacy(item, {
        vehicleId: itemVehicle.vehicleId,
        source: 'vision',
        treatmentSource: 'vision',
        canonicalizePanel: input.canonicalizePanel,
        sourceMessageId: input.sourceMessageId,
      }),
    );
  }

  const viability: PeritajeViability = input.viability
    ? {
        viable: input.viability.peritajeViable !== false,
        ...(input.viability.motivoInviable
          ? { reasonCode: input.viability.motivoInviable }
          : {}),
        ...(input.viability.mensajeClienteAclaracion
          ? { clientClarification: input.viability.mensajeClienteAclaracion }
          : {}),
      }
    : { viable: true };

  return {
    schemaVersion: PERITAJE_SCHEMA_VERSION,
    peritajeId: input.peritajeId ?? createPeritajeId(),
    conversationId: input.conversationId,
    tallerId: input.tallerId ?? null,
    vehicles: [...vehiclesById.values()],
    damages,
    viability,
    createdAt: now,
    updatedAt: now,
  };
}
