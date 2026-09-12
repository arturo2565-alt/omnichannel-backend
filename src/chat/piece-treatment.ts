import type { DetectedDamageItem } from './entities/chat.entity';
import {
  coerceDamageLevelCode,
  damageLevelRank,
} from './autofix-config';
import {
  canonicalizePanelCode,
  isIntegralPanelPieza,
  isInternalDamageRangePieza,
  isRefaccionPieza,
  PANEL_PIEZA_INTERNAL_DAMAGES_CODE,
  PANEL_PIEZA_REFACCION_CODE,
  refaccionCatalogCodigoForPieza,
  resolveCatalogPiezaForMatrixLookup,
} from '../catalog/panel-pieza-catalog';
import {
  UNKNOWN_VEHICLE_ID,
  createDamageItemId,
  resolveModernVehicleIdentity,
  isStructuredTreatment,
  mergeLockedTreatments,
  parseStructuredTreatment,
  type TreatmentResolution,
} from '../domain/peritaje-v1';
const BREAKAGE_RE =
  /\b(rota|roto|rotura|quebrada|quebrado|partida|partido|destruida|destruido|desprendida|desprendido|faltante|hueco|perforad|estrellad|hecha\s+pedazos)\b/i;

export const TREATMENT_DECISIONS = [
  'REPARAR',
  'SUSTITUIR',
  'INCIERTO',
  'PENDIENTE',
] as const;

export type TreatmentDecision = (typeof TREATMENT_DECISIONS)[number];

export const QUOTE_SERVICE_TYPES = [
  'REPARACION_PINTURA',
  'REFACCION',
  'MONTAJE_PINTURA',
  'PENDIENTE',
  'ADVERTENCIA',
] as const;

export type QuoteServiceType = (typeof QUOTE_SERVICE_TYPES)[number];

export const REFACCION_PRICE_SOURCES = [
  'AUTOFIX_CATALOG',
  'MARKET',
  'FALLBACK',
  'LEGACY_REPAIR_MATRIX_FALLBACK',
  'WEB_MARKET_ESTIMATE',
  'INSUFFICIENT_MARKET_SAMPLE',
  'MANUAL',
  'UNCONFIGURED',
] as const;

export type RefaccionPriceSource = (typeof REFACCION_PRICE_SOURCES)[number];
export type QuotePriceSource = RefaccionPriceSource;

export type PossibleHiddenDamage = {
  detected: boolean;
  areas: string[];
  requiresDisassembly: boolean;
};

export const INCIERTO_SUBSTITUTION_DISCLAIMER =
  'A reserva de revisión física. Si los anclajes o la estructura de la pieza están comprometidos, podría requerirse sustitución y el precio se actualizará.';

export const HIDDEN_DAMAGE_CLIENT_DISCLAIMER =
  'Por la magnitud del impacto podrían existir daños internos no visibles. El presupuesto final queda sujeto a desmontaje y revisión física.';

const REPLACE_CUE_RE =
  /\b(colapsad|aplastad|irrecuperable|inservible|no\s+reparable|sustitu|reemplaz|cambio\s+de\s+pieza|hecha\s+pedazos)\w*\b/i;

const POSIBLE_REEMPLAZO_PHRASE_RE =
  /posible[_ ]+reemplazo(?:[_ ]+de[_ ]+refacci[oó]n)?/gi;

export function stripPosibleReemplazoPhrases(text: string): string {
  return String(text ?? '')
    .replace(POSIBLE_REEMPLAZO_PHRASE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const OPTICS_RE = /\b(faro|calavera|niebla)\b/i;

const TREATMENT_RANK: Record<TreatmentDecision, number> = {
  PENDIENTE: 1,
  REPARAR: 2,
  INCIERTO: 3,
  SUSTITUIR: 4,
};

export function stripRefaccionPrefix(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^refacci[oó]n\s*:\s*/i, '')
    .trim();
}

/**
 * Identidad de la pieza física. `Cofre` y `REFACCION:Cofre` resuelven al mismo key.
 */
export function canonicalPhysicalPanelKey(raw: string): string {
  const t = String(raw ?? '').trim();
  if (!t) return '';
  if (isInternalDamageRangePieza(t)) return PANEL_PIEZA_INTERNAL_DAMAGES_CODE;
  if (isIntegralPanelPieza(t) && !isRefaccionPieza(t)) {
    return canonicalizePanelCode(t) || t;
  }
  const stripped = stripRefaccionPrefix(t);
  if (!stripped || /^refacci[oó]n$/i.test(stripped)) {
    return PANEL_PIEZA_REFACCION_CODE;
  }
  if (isInternalDamageRangePieza(stripped)) {
    return PANEL_PIEZA_INTERNAL_DAMAGES_CODE;
  }
  return canonicalizePanelCode(stripped) || stripped;
}

export function parseTreatmentDecision(
  raw: unknown,
): TreatmentDecision | undefined {
  return parseStructuredTreatment(raw);
}

export function isLockedTreatment(item: {
  tratamiento?: unknown;
}): boolean {
  return isStructuredTreatment(parseStructuredTreatment(item.tratamiento));
}

/**
 * Ítem moderno (visión/canónico) sin treatment estructurado.
 * No es un carrito histórico: no debe inferirse desde texto.
 */
export function isModernUnlockedItem(item: {
  tratamiento?: unknown;
  treatmentSource?: string;
  treatmentReason?: string;
}): boolean {
  if (isLockedTreatment(item)) return false;
  const source = String(item.treatmentSource ?? '').trim();
  const reason = String(item.treatmentReason ?? '').trim();
  return (
    source === 'vision' ||
    source === 'user' ||
    source === 'operator' ||
    reason === 'missing_structured_treatment'
  );
}

export function deriveStableVehicleId(
  item: Pick<DetectedDamageItem, 'vehicleId' | 'vehiculoDetectado'>,
): string | undefined {
  const explicit = String(item.vehicleId ?? '').trim();
  if (explicit && explicit !== UNKNOWN_VEHICLE_ID) return explicit;
  const label = String(item.vehiculoDetectado ?? '').trim();
  if (!label) return undefined;
  const id = resolveModernVehicleIdentity(label).vehicleId;
  return id === UNKNOWN_VEHICLE_ID ? undefined : id;
}

/**
 * Key de merge progresivo.
 * Con vehicleId estable: vehicleId + physicalPanelKey.
 * Fallback legacy (sin vehicleId): solo physicalPanelKey — ver collapseInventoryByPhysicalPanel.
 */
export function physicalInventoryMergeKey(item: DetectedDamageItem): string {
  const panel = canonicalPhysicalPanelKey(item.pieza);
  const vid = deriveStableVehicleId(item);
  return vid ? `${vid}::${panel}` : panel;
}

function isModernIdentityCarrier(it: DetectedDamageItem): boolean {
  const src = String(it.treatmentSource ?? '').trim();
  if (
    src === 'vision' ||
    src === 'user' ||
    src === 'operator' ||
    src === 'merge_rule' ||
    src === 'degraded'
  ) {
    return true;
  }
  return String(it.treatmentReason ?? '').trim() === 'missing_structured_treatment';
}

/**
 * Fórmula damageItemId: dmg_sha1(vehicleId | physicalPanelKey).
 * Si damageItemId ya existe, se preserva. No inventa una segunda identidad
 * moderna con fórmula distinta.
 */
export function ensureDamageIdentity(
  it: DetectedDamageItem,
): DetectedDamageItem {
  const existing = String(it.damageItemId ?? '').trim();
  const vehicleId = deriveStableVehicleId(it);
  if (existing.startsWith('dmg_')) {
    return {
      ...it,
      ...(vehicleId ? { vehicleId } : {}),
      damageItemId: existing,
    };
  }

  const panel =
    canonicalPhysicalPanelKey(it.pieza) ||
    String(it.pieza ?? '').trim() ||
    'unknown';

  if (isModernIdentityCarrier(it) && !vehicleId) {
    return { ...it };
  }

  return {
    ...it,
    ...(vehicleId ? { vehicleId } : {}),
    damageItemId: createDamageItemId({
      vehicleId: vehicleId ?? UNKNOWN_VEHICLE_ID,
      physicalPanelKey: panel,
    }),
  };
}

export function isOpticsLikePieza(raw: string): boolean {
  const stripped = stripRefaccionPrefix(raw);
  if (OPTICS_RE.test(stripped)) return true;
  const codigo = refaccionCatalogCodigoForPieza(stripped);
  if (!codigo) return false;
  return /^(FARO_|CAL_)/.test(codigo);
}

export function needsMontajePinturaComponent(pieza: string): boolean {
  if (isInternalDamageRangePieza(pieza) || isIntegralPanelPieza(pieza)) {
    return false;
  }
  if (isOpticsLikePieza(pieza)) return false;
  return resolveCatalogPiezaForMatrixLookup(stripRefaccionPrefix(pieza)) != null;
}

export function looksLikeReplacementCue(
  severidad: string,
  descripcionTecnica?: string,
): boolean {
  const raw = String(descripcionTecnica ?? '').trim();
  const blob = stripPosibleReemplazoPhrases(raw);
  const level = coerceDamageLevelCode(severidad);
  if (damageLevelRank(level) >= damageLevelRank('DF')) {
    if (!raw || BREAKAGE_RE.test(blob)) return true;
  }
  return REPLACE_CUE_RE.test(blob);
}

export function strongerTreatment(
  a?: TreatmentDecision,
  b?: TreatmentDecision,
): TreatmentDecision | undefined {
  if (!a) return b;
  if (!b) return a;
  return TREATMENT_RANK[a] >= TREATMENT_RANK[b] ? a : b;
}

/**
 * Compatibilidad: carritos viejos sin `tratamiento` estructurado.
 * Si el ítem ya está locked, devuelve esa decisión y NO consulta texto.
 */
export function inferTreatmentDecision(
  item: DetectedDamageItem,
  group: readonly DetectedDamageItem[] = [item],
): TreatmentDecision {
  const explicit = parseTreatmentDecision(item.tratamiento);
  if (explicit) return explicit;

  if (isInternalDamageRangePieza(item.pieza)) return 'PENDIENTE';
  if (isIntegralPanelPieza(item.pieza) && !isRefaccionPieza(item.pieza)) {
    return 'REPARAR';
  }

  const key = canonicalPhysicalPanelKey(item.pieza);
  const hasPricedRefaccionSibling = group.some((s) => {
    if (canonicalPhysicalPanelKey(s.pieza) !== key) return false;
    if (isRefaccionPieza(s.pieza) && (Number(s.precioMx) || 0) > 0) return true;
    return Boolean(s.detallesRefaccion && (Number(s.precioMx) || 0) > 0);
  });
  if (hasPricedRefaccionSibling || isRefaccionPieza(item.pieza)) {
    return 'SUSTITUIR';
  }
  if ((Number(item.precioMx) || 0) > 0 && isOpticsLikePieza(item.pieza)) {
    return 'SUSTITUIR';
  }

  if (isOpticsLikePieza(item.pieza)) {
    return 'PENDIENTE';
  }

  if (looksLikeReplacementCue(item.severidad, item.descripcionTecnica)) {
    return 'SUSTITUIR';
  }

  const level = coerceDamageLevelCode(item.severidad);
  if (damageLevelRank(level) >= damageLevelRank('DMF')) {
    return 'INCIERTO';
  }
  return 'REPARAR';
}

export type InventoryTreatmentResolution = TreatmentResolution & {
  usedLegacyInference: boolean;
};

/**
 * Resolución única para pricing/merge.
 * locked → preservar; moderno sin treatment → PENDIENTE; legacy → infer.
 */
export function resolveInventoryTreatment(
  item: DetectedDamageItem,
  group: readonly DetectedDamageItem[] = [item],
): InventoryTreatmentResolution {
  const locked = parseTreatmentDecision(item.tratamiento);
  if (locked) {
    return {
      treatment: locked,
      source: item.treatmentSource ?? 'vision',
      reason: item.treatmentReason ?? 'preserved_locked_treatment',
      locked: true,
      usedLegacyInference: false,
    };
  }
  if (isModernUnlockedItem(item)) {
    return {
      treatment: 'PENDIENTE',
      source: (item.treatmentSource as InventoryTreatmentResolution['source']) ??
        'vision',
      reason: 'missing_structured_treatment',
      locked: false,
      usedLegacyInference: false,
    };
  }
  const inferred = inferTreatmentDecision(item, group);
  return {
    treatment: inferred,
    source: 'legacy',
    reason: 'legacy_inferred',
    locked: false,
    usedLegacyInference: true,
  };
}

function applyTreatmentResolution(
  item: DetectedDamageItem,
  resolved: InventoryTreatmentResolution,
): DetectedDamageItem {
  return {
    ...item,
    tratamiento: resolved.treatment,
    treatmentSource: resolved.source,
    treatmentReason: resolved.reason,
  };
}

function preferPanelPiezaCode(a: string, b: string): string {
  if (isRefaccionPieza(a) && !isRefaccionPieza(b)) {
    return canonicalizePanelCode(stripRefaccionPrefix(b)) || stripRefaccionPrefix(b) || a;
  }
  if (isRefaccionPieza(b) && !isRefaccionPieza(a)) {
    return canonicalizePanelCode(stripRefaccionPrefix(a)) || stripRefaccionPrefix(a) || a;
  }
  if (isRefaccionPieza(a) && isRefaccionPieza(b)) {
    const stripped = stripRefaccionPrefix(a) || stripRefaccionPrefix(b);
    return canonicalizePanelCode(stripped) || stripped || a;
  }
  return canonicalizePanelCode(a) || a;
}

export function mergePhysicalPanelItems(
  a: DetectedDamageItem,
  b: DetectedDamageItem,
): DetectedDamageItem {
  const sevA = coerceDamageLevelCode(a.severidad);
  const sevB = coerceDamageLevelCode(b.severidad);
  const worst =
    damageLevelRank(sevB) > damageLevelRank(sevA) ? sevB : sevA;
  const descParts = [a.descripcionTecnica, b.descripcionTecnica]
    .map((d) => String(d ?? '').trim())
    .filter(Boolean);
  const priced =
    (Number(b.precioMx) || 0) > (Number(a.precioMx) || 0) ? b : a;
  const aLocked = parseTreatmentDecision(a.tratamiento);
  const bLocked = parseTreatmentDecision(b.tratamiento);
  let tratamiento: TreatmentDecision | undefined;
  let treatmentSource = b.treatmentSource || a.treatmentSource;
  let treatmentReason = b.treatmentReason || a.treatmentReason;
  if (aLocked || bLocked) {
    const merged = mergeLockedTreatments(aLocked, bLocked);
    tratamiento = merged.treatment;
    treatmentSource = merged.source;
    treatmentReason = merged.reason;
  } else if (isModernUnlockedItem(a) || isModernUnlockedItem(b)) {
    tratamiento = 'PENDIENTE';
    treatmentSource = a.treatmentSource || b.treatmentSource || 'vision';
    treatmentReason = 'missing_structured_treatment';
  } else {
    tratamiento = inferTreatmentDecision(
      {
        ...a,
        tratamiento: strongerTreatment(aLocked, bLocked),
      },
      [a, b],
    );
    treatmentSource = 'legacy';
    treatmentReason = 'legacy_inferred';
  }
  const merged: DetectedDamageItem = {
    pieza: preferPanelPiezaCode(a.pieza, b.pieza),
    severidad: worst,
    descripcionTecnica: [...new Set(descParts)].join(' | '),
    urls_origen: [
      ...new Set([...(a.urls_origen ?? []), ...(b.urls_origen ?? [])]),
    ],
    ...(a.vehiculoDetectado || b.vehiculoDetectado
      ? { vehiculoDetectado: b.vehiculoDetectado || a.vehiculoDetectado }
      : {}),
    ...(deriveStableVehicleId(b) || deriveStableVehicleId(a)
      ? { vehicleId: deriveStableVehicleId(b) || deriveStableVehicleId(a) }
      : {}),
    tratamiento,
    ...(treatmentSource ? { treatmentSource } : {}),
    ...(treatmentReason ? { treatmentReason } : {}),
    ...(priced.precioMx != null ? { precioMx: priced.precioMx } : {}),
    ...(b.detallesRefaccion || a.detallesRefaccion
      ? { detallesRefaccion: b.detallesRefaccion || a.detallesRefaccion }
      : {}),
    ...(b.refaccionDePieza || a.refaccionDePieza
      ? {
          refaccionDePieza:
            b.refaccionDePieza ||
            a.refaccionDePieza ||
            canonicalPhysicalPanelKey(a.pieza),
        }
      : {}),
    ...(b.priceSource || a.priceSource
      ? { priceSource: b.priceSource || a.priceSource }
      : {}),
    ...(b.possibleHiddenDamage || a.possibleHiddenDamage
      ? {
          possibleHiddenDamage:
            b.possibleHiddenDamage ?? a.possibleHiddenDamage,
        }
      : {}),
    ...(a.posibleReemplazoRefaccion || b.posibleReemplazoRefaccion
      ? { posibleReemplazoRefaccion: true }
      : {}),
    ...(b.pricingStatus || a.pricingStatus
      ? { pricingStatus: b.pricingStatus || a.pricingStatus }
      : {}),
    ...(a.damageItemId && a.damageItemId === b.damageItemId
      ? { damageItemId: a.damageItemId }
      : {}),
  };
  return ensureDamageIdentity(merged);
}

/** Copia semántica técnica (+ extras comerciales ya presentes). Un solo listado. */
export function copyDetectedDamageSemantics(
  it: DetectedDamageItem,
): Partial<DetectedDamageItem> {
  const locked = parseTreatmentDecision(it.tratamiento);
  const vehicleId = deriveStableVehicleId(it);
  const identified = ensureDamageIdentity({
    ...it,
    ...(vehicleId ? { vehicleId } : {}),
  });
  return {
    ...(it.vehiculoDetectado?.trim()
      ? { vehiculoDetectado: it.vehiculoDetectado.trim() }
      : {}),
    ...(vehicleId ? { vehicleId } : {}),
    ...(identified.damageItemId
      ? { damageItemId: identified.damageItemId }
      : {}),
    ...(locked ? { tratamiento: locked } : {}),
    ...(it.treatmentSource ? { treatmentSource: it.treatmentSource } : {}),
    ...(it.treatmentReason ? { treatmentReason: it.treatmentReason } : {}),
    ...(it.posibleReemplazoRefaccion
      ? { posibleReemplazoRefaccion: true }
      : {}),
    ...(it.possibleHiddenDamage
      ? {
          possibleHiddenDamage: {
            detected: it.possibleHiddenDamage.detected,
            areas: [...(it.possibleHiddenDamage.areas ?? [])],
            requiresDisassembly: it.possibleHiddenDamage.requiresDisassembly,
          },
        }
      : {}),
    ...(it.inventarioVisualPrevio?.length
      ? {
          inventarioVisualPrevio: it.inventarioVisualPrevio.map((row) => ({
            ...row,
            urls_origen: [...(row.urls_origen ?? [])],
          })),
        }
      : {}),
    ...(it.precioMx != null ? { precioMx: it.precioMx } : {}),
    ...(it.detallesRefaccion
      ? { detallesRefaccion: it.detallesRefaccion }
      : {}),
    ...(it.refaccionDePieza
      ? { refaccionDePieza: it.refaccionDePieza }
      : {}),
    ...(it.priceSource ? { priceSource: it.priceSource } : {}),
    ...(it.pricingStatus ? { pricingStatus: it.pricingStatus } : {}),
    ...(it.pricingType ? { pricingType: it.pricingType } : {}),
    ...(it.precioMinEstimado != null
      ? { precioMinEstimado: it.precioMinEstimado }
      : {}),
    ...(it.precioMaxEstimado != null
      ? { precioMaxEstimado: it.precioMaxEstimado }
      : {}),
    ...(it.precioCentral != null ? { precioCentral: it.precioCentral } : {}),
    ...(it.marketPrecioMin != null ? { marketPrecioMin: it.marketPrecioMin } : {}),
    ...(it.marketPrecioMax != null ? { marketPrecioMax: it.marketPrecioMax } : {}),
    ...(it.marketPrecioCentral != null
      ? { marketPrecioCentral: it.marketPrecioCentral }
      : {}),
    ...(it.cantidadMuestras != null
      ? { cantidadMuestras: it.cantidadMuestras }
      : {}),
    ...(it.cantidadDominios != null
      ? { cantidadDominios: it.cantidadDominios }
      : {}),
    ...(it.providersUsed ? { providersUsed: [...it.providersUsed] } : {}),
    ...(it.partTypeGroup ? { partTypeGroup: it.partTypeGroup } : {}),
  };
}

/** @deprecated usar copyDetectedDamageSemantics */
export function copyTreatmentFields(
  it: DetectedDamageItem,
): Partial<DetectedDamageItem> {
  return copyDetectedDamageSemantics(it);
}

export function cloneDetectedDamageItem(
  it: DetectedDamageItem,
): DetectedDamageItem {
  return {
    pieza: it.pieza,
    severidad: it.severidad,
    descripcionTecnica: it.descripcionTecnica,
    urls_origen: [...(it.urls_origen ?? [])],
    ...copyDetectedDamageSemantics(it),
  };
}

/**
 * Colapsa por identidad física.
 * Fallback legacy: sin vehicleId se usa solo physicalPanelKey.
 * Con vehicleId en ambos lados, no fusiona vehículos distintos.
 */
export function collapseInventoryByPhysicalPanel(
  inventory: readonly DetectedDamageItem[],
): DetectedDamageItem[] {
  const map = new Map<string, DetectedDamageItem>();
  const order: string[] = [];
  for (const it of inventory) {
    const key = physicalInventoryMergeKey(it);
    if (!key) continue;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        ...cloneDetectedDamageItem(it),
        pieza: preferPanelPiezaCode(it.pieza, it.pieza),
      });
      order.push(key);
      continue;
    }
    map.set(key, mergePhysicalPanelItems(existing, it));
  }
  return order.map((key) => {
    const item = map.get(key)!;
    return applyTreatmentResolution(item, resolveInventoryTreatment(item, [item]));
  });
}

export function applyXorTreatmentsToInventory(
  inventory: readonly DetectedDamageItem[],
): DetectedDamageItem[] {
  return collapseInventoryByPhysicalPanel(inventory);
}

export function isBillableQuoteRow(row: {
  billable?: boolean;
  serviceType?: QuoteServiceType;
  precioMx?: number;
}): boolean {
  if (row.billable === false) return false;
  if (
    row.serviceType === 'PENDIENTE' ||
    row.serviceType === 'ADVERTENCIA'
  ) {
    return false;
  }
  return (Number(row.precioMx) || 0) > 0;
}

export function structuredLineLabel(row: {
  description?: string;
  pieza: string;
}): string {
  const desc = String(row.description ?? '').trim();
  if (desc) return desc;
  return String(row.pieza ?? '').trim() || 'Servicio';
}

/**
 * El texto al cliente no puede invertir la semántica de una línea estructurada.
 */
export function narrativeRespectsStructuredLines(
  text: string,
  lines: readonly {
    pieza: string;
    description?: string;
    tratamiento?: TreatmentDecision;
    serviceType?: QuoteServiceType;
    precioMx: number;
    billable?: boolean;
  }[],
): boolean {
  const blob = String(text ?? '');
  if (!blob.trim()) return false;
  for (const line of lines) {
    if (line.billable === false) continue;
    const amt = Math.max(0, Math.round(Number(line.precioMx) || 0));
    if (amt <= 0) continue;
    const amtText = amt.toLocaleString('es-MX');
    const amtIdx = blob.indexOf(amtText);
    if (amtIdx < 0) continue;
    const window = blob.slice(Math.max(0, amtIdx - 80), amtIdx + amtText.length + 40);
    const isReplace =
      line.tratamiento === 'SUSTITUIR' ||
      line.serviceType === 'REFACCION' ||
      line.serviceType === 'MONTAJE_PINTURA';
    const isRepair = line.serviceType === 'REPARACION_PINTURA';
    if (
      isReplace &&
      /reparar y pintar/i.test(window) &&
      !/(sustitu|refacci|montar)/i.test(window)
    ) {
      return false;
    }
    if (
      isRepair &&
      /sustituir/i.test(window) &&
      !/reserv|podr[ií]a|en caso/i.test(window)
    ) {
      return false;
    }
  }
  return true;
}
