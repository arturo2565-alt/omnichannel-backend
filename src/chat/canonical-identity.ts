/**
 * Identidad canónica → proyección inventory.
 * CanonicalPeritajeV1 genera vehicleId/damageItemId; inventory solo los hereda.
 */
import type { CanonicalPeritajeV1, DamageItem } from '../domain/peritaje-v1';
import type { DetectedDamageItem } from './entities/chat.entity';
import type { VehicleDamageAnalysis } from './entities/chat.entity';
import {
  CANONICAL_TRACE_EVENTS,
  pegCanonicalTrace,
} from './canonical-trace';
import {
  cloneDetectedDamageItem,
  deriveStableVehicleId,
  inventoryPhysicalPanelKey,
} from './piece-treatment';

export function inventoryItemFromCanonicalDamage(
  damage: DamageItem,
): DetectedDamageItem {
  return {
    pieza: damage.pieceCode,
    severidad: damage.severity,
    descripcionTecnica: damage.descriptionTechnical,
    urls_origen: (damage.evidence ?? []).map((e) => e.url).filter(Boolean),
    vehicleId: damage.vehicleId,
    damageItemId: damage.damageItemId,
    physicalPanelKey: damage.physicalPanelKey,
    tratamiento: damage.treatment,
    treatmentSource: damage.treatmentSource,
    treatmentReason: damage.treatmentReason,
    ...(damage.possibleReplacement ? { posibleReemplazoRefaccion: true } : {}),
    ...(damage.possibleHiddenDamage
      ? { possibleHiddenDamage: damage.possibleHiddenDamage }
      : {}),
    ...(damage.moldingPosition
      ? { moldingPosition: damage.moldingPosition }
      : {}),
    ...(damage.finishType ? { finishType: damage.finishType } : {}),
    ...(damage.damageEvidenceStatus
      ? { damageEvidenceStatus: damage.damageEvidenceStatus }
      : {}),
    ...(damage.visionBatchIndex != null
      ? { visionBatchIndex: damage.visionBatchIndex }
      : {}),
    ...(damage.visionBatchIndexes?.length
      ? { visionBatchIndexes: [...damage.visionBatchIndexes] }
      : {}),
    ...(damage.pieceCodeRaw
      ? { pieceCodeRaw: damage.pieceCodeRaw, pieceCodeCanonical: damage.physicalPanelKey }
      : {}),
  };
}

function panelOf(item: DetectedDamageItem): string {
  return inventoryPhysicalPanelKey(item);
}

function projectCanonicalIdentity(
  item: DetectedDamageItem,
  match: DamageItem,
): DetectedDamageItem {
  const inventoryPanel = inventoryPhysicalPanelKey(item);
  const canonicalPanel = String(match.physicalPanelKey ?? '').trim();
  const existingId = String(item.damageItemId ?? '').trim();
  if (
    existingId &&
    existingId === match.damageItemId &&
    inventoryPanel &&
    canonicalPanel &&
    inventoryPanel !== canonicalPanel
  ) {
    pegCanonicalTrace(
      CANONICAL_TRACE_EVENTS.CANONICAL_IDENTITY_PROJECTION_MISMATCH,
      {
        damageItemId: match.damageItemId,
        pieceCode: match.pieceCode,
        inventoryPhysicalPanelKey: inventoryPanel,
        canonicalPhysicalPanelKey: canonicalPanel,
      },
    );
  }
  return {
    ...item,
    vehicleId: match.vehicleId,
    damageItemId: match.damageItemId,
    pieza: match.pieceCode || item.pieza,
    physicalPanelKey: match.physicalPanelKey,
    ...(match.moldingPosition
      ? { moldingPosition: match.moldingPosition }
      : {}),
    ...(match.finishType ? { finishType: match.finishType } : {}),
    ...(match.damageEvidenceStatus
      ? { damageEvidenceStatus: match.damageEvidenceStatus }
      : {}),
  };
}

function resolveStampVehicleId(
  item: DetectedDamageItem,
  peritaje: CanonicalPeritajeV1,
): string | undefined {
  const explicit = String(item.vehicleId ?? '').trim();
  if (explicit) return explicit;
  const derived = deriveStableVehicleId(item);
  if (derived) return derived;
  if (peritaje.vehicles.length === 1) {
    return peritaje.vehicles[0]!.vehicleId;
  }
  return undefined;
}

function matchCanonicalDamage(
  item: DetectedDamageItem,
  peritaje: CanonicalPeritajeV1,
): DamageItem | undefined {
  const existingId = String(item.damageItemId ?? '').trim();
  if (existingId.startsWith('dmg_')) {
    const byId = peritaje.damages.find((d) => d.damageItemId === existingId);
    if (byId) return byId;
  }
  const panel = panelOf(item);
  if (!panel) return undefined;
  const vehicleId = resolveStampVehicleId(item, peritaje);
  if (!vehicleId) {
    if (peritaje.vehicles.length > 1) {
      pegCanonicalTrace(CANONICAL_TRACE_EVENTS.MISSING_CANONICAL_DAMAGE_ID, {
        pieceCode: item.pieza,
        reason: 'multi_vehicle_without_identity',
      });
    }
    return undefined;
  }
  const matches = peritaje.damages.filter(
    (d) => d.vehicleId === vehicleId && d.physicalPanelKey === panel,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Propaga vehicleId/damageItemId desde CanonicalPeritaje. No recalcula. */
export function stampInventoryFromCanonicalPeritaje(
  inventory: readonly DetectedDamageItem[],
  peritaje: CanonicalPeritajeV1 | null | undefined,
): DetectedDamageItem[] {
  if (!peritaje?.damages.length) {
    return inventory.map((it) => cloneDetectedDamageItem(it));
  }
  return inventory.map((raw) => {
    const it = cloneDetectedDamageItem(raw);
    const match = matchCanonicalDamage(it, peritaje);
    if (!match) return it;
    pegCanonicalTrace(CANONICAL_TRACE_EVENTS.CANONICAL_IDENTITY_STAMPED, {
      pieceCode: match.pieceCode,
      vehicleId: match.vehicleId,
      damageItemId: match.damageItemId,
      physicalPanelKey: match.physicalPanelKey,
      moldingPosition: match.moldingPosition ?? null,
      finishType: match.finishType ?? null,
    });
    return projectCanonicalIdentity(it, match);
  });
}

export function stampAnalysisFromCanonicalPeritaje(
  analysis: VehicleDamageAnalysis,
  peritaje: CanonicalPeritajeV1 | null | undefined,
): VehicleDamageAnalysis {
  if (!analysis.inventory?.length || !peritaje) return analysis;
  return {
    ...analysis,
    inventory: stampInventoryFromCanonicalPeritaje(analysis.inventory, peritaje),
  };
}
