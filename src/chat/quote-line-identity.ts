/**
 * Identidad DamageItem ↔ QuoteLine (1:N). El orden de un array no determina
 * qué línea económica pertenece a qué daño moderno.
 *
 * Fórmula damageItemId (ids.ts createDamageItemId):
 *   dmg_sha1(slug(vehicleId) | slug(physicalPanelKey))
 *   damageHint no entra. vehicleId ausente → UNKNOWN_VEHICLE_ID.
 *
 * Fórmula quoteLineId (ids.ts createQuoteLineId):
 *   ql_sha1(slug(damageItemId) | slug(serviceType) | slug(discriminator))
 *   discriminator vacío salvo que un daño emita dos líneas del mismo serviceType.
 *
 * Matching:
 *   1. quoteRow.damageItemId → DamageItem.damageItemId
 *   2. Legacy sin IDs en AMBOS lados → fallback posicional aislado
 *   3. Objeto moderno sin ID → NO fallback; MISSING_DAMAGE_ITEM_ID
 */

import { Logger } from '@nestjs/common';
import {
  QUOTE_SCHEMA_VERSION,
  createQuoteId,
  createQuoteLineId,
  type CanonicalQuoteV1,
  type QuoteLine,
  type QuoteServiceType,
} from '../domain/peritaje-v1';
import { coerceDamageLevelCode } from './autofix-config';
import type { DraftQuoteLine } from './autofix-config';
import type { DetectedDamageItem } from './entities/chat.entity';
import type { DraftQuoteItem } from './entities/draft-quote-item.entity';
import { normalizePanelPiezaCode } from '../catalog/panel-pieza-catalog';
import {
  canonicalPhysicalPanelKey,
  deriveStableVehicleId,
  ensureDamageIdentity,
  mergePhysicalPanelItems,
  type QuoteServiceType as LegacyQuoteServiceType,
} from './piece-treatment';

const logger = new Logger('QuoteIdentity');

export const QUOTE_IDENTITY_DIVERGENCES = [
  'POSITIONAL_FALLBACK_USED',
  'ORPHAN_QUOTE_LINE',
  'MISSING_DAMAGE_ITEM_ID',
  'EVIDENCE_ASSOCIATION_MISMATCH',
  'DUPLICATE_QUOTE_LINE_ID',
] as const;

export type QuoteIdentityDivergence =
  (typeof QUOTE_IDENTITY_DIVERGENCES)[number];

export type QuoteIdentityCarrier = {
  damageItemId?: string;
  vehicleId?: string;
  quoteLineId?: string;
  serviceType?: string;
  treatmentSource?: string;
  treatmentReason?: string;
  physicalPanelKey?: string;
  pieza?: string;
  urls_origen?: string[];
  urlsOrigen?: string[] | null;
};

export type DamageResolveMethod =
  | 'identity'
  | 'positional_legacy'
  | 'unresolved';

export type DamageResolveResult = {
  item?: DetectedDamageItem;
  method: DamageResolveMethod;
  divergence?: QuoteIdentityDivergence;
};

export type PersistableDraftQuoteItem = Omit<
  DraftQuoteItem,
  'id' | 'draftQuote' | 'draftQuoteId'
>;

export type QuoteIdentityLogEntry = {
  code: QuoteIdentityDivergence;
  damageItemId?: string;
  quoteLineId?: string;
  index?: number;
};

const MODERN_SOURCES = new Set([
  'vision',
  'user',
  'operator',
  'merge_rule',
  'degraded',
]);

export function isModernIdentityObject(
  obj: QuoteIdentityCarrier | DetectedDamageItem | null | undefined,
): boolean {
  if (!obj) return false;
  const src = String(
    (obj as QuoteIdentityCarrier).treatmentSource ?? '',
  ).trim();
  if (MODERN_SOURCES.has(src)) return true;
  if (
    String((obj as QuoteIdentityCarrier).treatmentReason ?? '').trim() ===
    'missing_structured_treatment'
  ) {
    return true;
  }
  if (String(obj.damageItemId ?? '').startsWith('dmg_')) return true;
  if (String(obj.quoteLineId ?? '').startsWith('ql_')) return true;
  return false;
}

export function hasStableDamageItemId(
  obj: { damageItemId?: string } | null | undefined,
): boolean {
  return String(obj?.damageItemId ?? '').trim().startsWith('dmg_');
}

export function stampQuoteLineId(input: {
  damageItemId?: string;
  serviceType?: string;
  discriminator?: string;
}): string | undefined {
  const damageItemId = String(input.damageItemId ?? '').trim();
  const serviceType = String(input.serviceType ?? '').trim();
  if (!damageItemId || !serviceType) return undefined;
  return createQuoteLineId({
    damageItemId,
    serviceType: serviceType as QuoteServiceType,
    discriminator: input.discriminator,
  });
}

export function logQuoteIdentityDivergence(
  code: QuoteIdentityDivergence,
  fields: Omit<QuoteIdentityLogEntry, 'code'>,
): void {
  logger.warn(
    JSON.stringify({
      divergence: code,
      damageItemId: fields.damageItemId,
      quoteLineId: fields.quoteLineId,
      index: fields.index,
    }),
  );
}

/**
 * Resuelve el DamageItem de una línea económica por identidad.
 *
 * Fallback posicional: SOLO si línea e inventario son legacy sin IDs
 * y es imposible resolver por identidad. Aislado, testeado, observable.
 * Un objeto moderno sin damageItemId NUNCA usa este fallback.
 */
export function resolveDamageForQuoteRow(input: {
  row: QuoteIdentityCarrier;
  inventory: readonly DetectedDamageItem[];
  index: number;
  log?: boolean;
}): DamageResolveResult {
  const rowId = String(input.row.damageItemId ?? '').trim();
  if (rowId) {
    const hit = input.inventory.find(
      (it) => String(it.damageItemId ?? '').trim() === rowId,
    );
    if (hit) {
      return { item: hit, method: 'identity' };
    }
    if (input.log !== false) {
      logQuoteIdentityDivergence('ORPHAN_QUOTE_LINE', {
        damageItemId: rowId,
        quoteLineId: input.row.quoteLineId,
        index: input.index,
      });
    }
    return { method: 'unresolved', divergence: 'ORPHAN_QUOTE_LINE' };
  }

  const panel =
    String(input.row.physicalPanelKey ?? '').trim() ||
    canonicalPhysicalPanelKey(String(input.row.pieza ?? ''));
  const vehicleId = String(input.row.vehicleId ?? '').trim();
  if (panel) {
    const physical = input.inventory.find((prev) => {
      const prevPanel = canonicalPhysicalPanelKey(prev.pieza);
      if (prevPanel !== panel) return false;
      if (!vehicleId) return true;
      const prevVid = deriveStableVehicleId(prev);
      return !prevVid || prevVid === vehicleId;
    });
    if (physical) {
      return { item: physical, method: 'identity' };
    }
  }

  const inventoryModern = input.inventory.some(
    (it) => isModernIdentityObject(it) || hasStableDamageItemId(it),
  );
  const rowModern = isModernIdentityObject(input.row);
  if (rowModern || inventoryModern) {
    if (input.log !== false) {
      logQuoteIdentityDivergence('MISSING_DAMAGE_ITEM_ID', {
        quoteLineId: input.row.quoteLineId,
        index: input.index,
      });
    }
    return { method: 'unresolved', divergence: 'MISSING_DAMAGE_ITEM_ID' };
  }

  const fallback = input.inventory[input.index];
  if (!fallback) {
    return { method: 'unresolved' };
  }
  if (input.log !== false) {
    logQuoteIdentityDivergence('POSITIONAL_FALLBACK_USED', {
      index: input.index,
      quoteLineId: input.row.quoteLineId,
    });
  }
  return {
    item: fallback,
    method: 'positional_legacy',
    divergence: 'POSITIONAL_FALLBACK_USED',
  };
}

export function resolvePrevInventoryForPanelLine(input: {
  line: QuoteIdentityCarrier;
  prevInv: readonly DetectedDamageItem[];
  index: number;
  log?: boolean;
}): DamageResolveResult {
  const byId = resolveDamageForQuoteRow({
    row: input.line,
    inventory: input.prevInv,
    index: input.index,
    log: false,
  });
  if (byId.method === 'identity' || byId.divergence === 'ORPHAN_QUOTE_LINE') {
    if (byId.divergence === 'ORPHAN_QUOTE_LINE' && input.log !== false) {
      logQuoteIdentityDivergence('ORPHAN_QUOTE_LINE', {
        damageItemId: input.line.damageItemId,
        quoteLineId: input.line.quoteLineId,
        index: input.index,
      });
    }
    return byId;
  }

  const panel =
    String(input.line.physicalPanelKey ?? '').trim() ||
    canonicalPhysicalPanelKey(String(input.line.pieza ?? ''));
  const vehicleId = String(input.line.vehicleId ?? '').trim();
  if (panel) {
    const physical = input.prevInv.find((prev) => {
      const prevPanel = canonicalPhysicalPanelKey(prev.pieza);
      if (prevPanel !== panel) return false;
      if (!vehicleId) return true;
      const prevVid = deriveStableVehicleId(prev);
      return !prevVid || prevVid === vehicleId;
    });
    if (physical) {
      return { item: physical, method: 'identity' };
    }
  }

  const inventoryModern = input.prevInv.some(
    (it) => isModernIdentityObject(it) || hasStableDamageItemId(it),
  );
  const lineModern = isModernIdentityObject(input.line);
  if (lineModern || inventoryModern) {
    if (input.log !== false) {
      logQuoteIdentityDivergence('MISSING_DAMAGE_ITEM_ID', {
        quoteLineId: input.line.quoteLineId,
        index: input.index,
      });
    }
    return { method: 'unresolved', divergence: 'MISSING_DAMAGE_ITEM_ID' };
  }

  const fallback = input.prevInv[input.index];
  if (!fallback) return { method: 'unresolved' };
  if (input.log !== false) {
    logQuoteIdentityDivergence('POSITIONAL_FALLBACK_USED', {
      index: input.index,
    });
  }
  return {
    item: fallback,
    method: 'positional_legacy',
    divergence: 'POSITIONAL_FALLBACK_USED',
  };
}

export function collapseInventoryByDamageItemId(
  items: readonly DetectedDamageItem[],
): DetectedDamageItem[] {
  const out: DetectedDamageItem[] = [];
  const indexById = new Map<string, number>();
  for (const raw of items) {
    const it = ensureDamageIdentity(raw);
    const id = String(it.damageItemId ?? '').trim();
    if (!id) {
      out.push(it);
      continue;
    }
    const idx = indexById.get(id);
    if (idx == null) {
      indexById.set(id, out.length);
      out.push(it);
      continue;
    }
    out[idx] = mergePhysicalPanelItems(out[idx]!, it);
  }
  return out;
}

function evidenceUrlsOf(item?: DetectedDamageItem): string[] {
  return (item?.urls_origen ?? []).map(String).filter(Boolean);
}

function sameUrlSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((u, i) => u === sb[i]);
}

export function buildPersistedDraftQuoteItemRows(input: {
  lines: ReadonlyArray<
    QuoteIdentityCarrier & {
      pieza?: string;
      severidad?: string;
      precioMx?: number;
      descripcionTecnica?: string;
      description?: string;
      unitPrice?: number;
      subtotal?: number;
      billable?: boolean;
    }
  >;
  inventory: readonly DetectedDamageItem[];
  fallbackUrls?: readonly string[];
  analysisPieza?: string;
  analysisSeveridad?: string;
  analysisDescripcion?: string;
}): {
  rows: PersistableDraftQuoteItem[];
  divergences: QuoteIdentityLogEntry[];
} {
  const divergences: QuoteIdentityLogEntry[] = [];
  const seenLineIds = new Set<string>();
  const identifiedInv = input.inventory.map((it) => ensureDamageIdentity(it));
  const rows = input.lines.map((line, idx) => {
    const resolved = resolveDamageForQuoteRow({
      row: line,
      inventory: identifiedInv,
      index: idx,
    });
    if (resolved.divergence) {
      divergences.push({
        code: resolved.divergence,
        damageItemId: line.damageItemId,
        quoteLineId: line.quoteLineId,
        index: idx,
      });
    }

    const evidence = evidenceUrlsOf(resolved.item);
    let urlsOrigen: string[] | null =
      evidence.length > 0 ? [...evidence] : null;
    if (
      !urlsOrigen &&
      resolved.method === 'positional_legacy' &&
      (input.fallbackUrls?.length ?? 0) > 0
    ) {
      urlsOrigen = [...(input.fallbackUrls ?? [])];
    }

    if (
      resolved.item &&
      urlsOrigen &&
      evidence.length > 0 &&
      !sameUrlSet(urlsOrigen, evidence)
    ) {
      logQuoteIdentityDivergence('EVIDENCE_ASSOCIATION_MISMATCH', {
        damageItemId: resolved.item.damageItemId,
        quoteLineId: line.quoteLineId,
        index: idx,
      });
      divergences.push({
        code: 'EVIDENCE_ASSOCIATION_MISMATCH',
        damageItemId: resolved.item.damageItemId,
        quoteLineId: line.quoteLineId,
        index: idx,
      });
    }

    const quoteLineId =
      String(line.quoteLineId ?? '').trim() ||
      stampQuoteLineId({
        damageItemId: line.damageItemId || resolved.item?.damageItemId,
        serviceType: line.serviceType,
      }) ||
      null;
    if (quoteLineId) {
      if (seenLineIds.has(quoteLineId)) {
        logQuoteIdentityDivergence('DUPLICATE_QUOTE_LINE_ID', {
          quoteLineId,
          damageItemId: line.damageItemId,
          index: idx,
        });
        divergences.push({
          code: 'DUPLICATE_QUOTE_LINE_ID',
          quoteLineId,
          damageItemId: line.damageItemId,
          index: idx,
        });
      }
      seenLineIds.add(quoteLineId);
    }

    const piezaRaw =
      String(line.pieza ?? '').trim() ||
      String(line.physicalPanelKey ?? '').trim() ||
      resolved.item?.pieza ||
      input.analysisPieza ||
      'Estetica Exterior';

    const precioMx = Math.round(
      Number(
        line.precioMx ?? line.subtotal ?? line.unitPrice ?? 0,
      ) || 0,
    );

    return {
      sortOrder: idx,
      pieza: normalizePanelPiezaCode(piezaRaw) || piezaRaw,
      severidad: String(line.severidad ?? '').trim()
        ? String(line.severidad)
        : coerceDamageLevelCode(
            resolved.item?.severidad || input.analysisSeveridad || 'DM',
          ),
      precioMx,
      descripcionTecnica:
        resolved.item?.descripcionTecnica ??
        line.descripcionTecnica ??
        input.analysisDescripcion ??
        null,
      urlsOrigen,
      damageItemId: String(line.damageItemId ?? '').trim() ||
        (resolved.method === 'identity'
          ? String(resolved.item?.damageItemId ?? '').trim() || null
          : null),
      quoteLineId,
      vehicleId:
        String(line.vehicleId ?? '').trim() ||
        (resolved.method === 'identity'
          ? String(resolved.item?.vehicleId ?? '').trim() || null
          : null),
      serviceType: String(line.serviceType ?? '').trim() || null,
      billable:
        typeof line.billable === 'boolean' ? line.billable : null,
    };
  });

  return { rows, divergences };
}

/**
 * Persistencia legacy: inventario y líneas sin IDs y misma longitud.
 * Aislado a propósito. No usar para objetos modernos.
 */
export function buildLegacyPositionalPersistRows(input: {
  lines: ReadonlyArray<{
    subtotal?: number;
    unitPrice?: number;
  }>;
  inventory: readonly DetectedDamageItem[];
}): PersistableDraftQuoteItem[] {
  return input.lines.map((line, idx) => {
    const row = input.inventory[idx];
    logQuoteIdentityDivergence('POSITIONAL_FALLBACK_USED', { index: idx });
    return {
      sortOrder: idx,
      pieza: normalizePanelPiezaCode(row?.pieza?.trim() ?? '') || 'Estetica Exterior',
      severidad: coerceDamageLevelCode(row?.severidad ?? 'DM'),
      precioMx: Math.round(Number(line.subtotal ?? line.unitPrice ?? 0)),
      descripcionTecnica: row?.descripcionTecnica ?? null,
      urlsOrigen:
        Array.isArray(row?.urls_origen) && row.urls_origen.length > 0
          ? [...row.urls_origen]
          : null,
      damageItemId: null,
      quoteLineId: null,
      vehicleId: null,
      serviceType: null,
      billable: null,
    };
  });
}

export function shouldUseLegacyPositionalPersist(
  lines: readonly QuoteIdentityCarrier[],
  inventory: readonly DetectedDamageItem[],
): boolean {
  if (!lines.length || !inventory.length) return false;
  if (lines.length !== inventory.length) return false;
  const anyModern =
    lines.some((l) => isModernIdentityObject(l) || hasStableDamageItemId(l)) ||
    inventory.some((it) => isModernIdentityObject(it) || hasStableDamageItemId(it));
  return !anyModern;
}

export function validateModernQuoteAssociations(input: {
  inventory: readonly DetectedDamageItem[];
  rows: readonly QuoteIdentityCarrier[];
}): { code: string; message: string }[] {
  const errors: { code: string; message: string }[] = [];
  const damageIds = new Set(
    input.inventory
      .map((it) => String(it.damageItemId ?? '').trim())
      .filter(Boolean),
  );
  const lineIds = new Set<string>();

  for (const row of input.rows) {
    const modern = isModernIdentityObject(row);
    if (!modern && !hasStableDamageItemId(row)) continue;

    if (!hasStableDamageItemId(row)) {
      errors.push({
        code: 'MISSING_DAMAGE_ITEM_ID',
        message: 'QuoteLine moderna sin damageItemId',
      });
    } else if (!damageIds.has(String(row.damageItemId).trim())) {
      errors.push({
        code: 'ORPHAN_QUOTE_LINE',
        message: 'damageItemId no referencia un DamageItem existente',
      });
    }

    const qid = String(row.quoteLineId ?? '').trim();
    if (!qid) {
      errors.push({
        code: 'MISSING_QUOTE_LINE_ID',
        message: 'QuoteLine moderna sin quoteLineId',
      });
    } else if (lineIds.has(qid)) {
      errors.push({
        code: 'DUPLICATE_QUOTE_LINE_ID',
        message: 'quoteLineId duplicado dentro de la quote',
      });
    } else {
      lineIds.add(qid);
    }

    if (row.vehicleId && row.damageItemId) {
      const dmg = input.inventory.find(
        (it) => it.damageItemId === row.damageItemId,
      );
      if (dmg?.vehicleId && dmg.vehicleId !== row.vehicleId) {
        errors.push({
          code: 'VEHICLE_MISMATCH',
          message: 'vehicleId de QuoteLine no coincide con el DamageItem',
        });
      }
    }
  }

  return errors;
}

type CalculatedQuoteRow = {
  quoteLineId?: string;
  damageItemId?: string;
  vehicleId?: string;
  serviceType?: string;
  description?: string;
  descripcionServicio?: string;
  precioMx?: number;
  unitPrice?: number;
  subtotal?: number;
  billable?: boolean;
  priceSource?: string;
  pricingStatus?: string;
  pricingType?: string;
  precioMinEstimado?: number;
  precioMaxEstimado?: number;
  precioCentral?: number;
  cantidadMuestras?: number;
  cantidadDominios?: number;
};

/**
 * Adapta QuoteRows YA CALCULADAS a CanonicalQuoteV1.
 * No reimplementa pricing. No es autoridad productiva.
 */
export function adaptCalculatedRowsToCanonicalQuoteV1(input: {
  rows: readonly CalculatedQuoteRow[];
  peritajeId: string;
  quoteId?: string;
  generatedAt?: string;
}): CanonicalQuoteV1 | null {
  if (!input.rows.length) return null;
  const lines: QuoteLine[] = input.rows.map((row) => {
    const amount = Math.round(
      Number(row.subtotal ?? row.precioMx ?? row.unitPrice ?? 0) || 0,
    );
    const serviceType = (row.serviceType ||
      'REPARACION_PINTURA') as QuoteServiceType;
    const damageItemId = String(row.damageItemId ?? '').trim();
    const quoteLineId =
      String(row.quoteLineId ?? '').trim() ||
      (damageItemId
        ? createQuoteLineId({ damageItemId, serviceType })
        : createQuoteLineId({
            damageItemId: 'dmg_unknown',
            serviceType,
          }));
    const billable = row.billable !== false && amount > 0;
    return {
      quoteLineId,
      damageItemId: damageItemId || 'dmg_unknown',
      vehicleId: String(row.vehicleId ?? '').trim() || 'veh_unknown',
      serviceType,
      description: String(
        row.description ?? row.descripcionServicio ?? '',
      ).trim(),
      billable,
      amount,
      confidence: 'MEDIUM',
      ...(row.priceSource
        ? { pricingSource: row.priceSource as QuoteLine['pricingSource'] }
        : {}),
      ...(row.pricingStatus
        ? { pricingStatus: row.pricingStatus as QuoteLine['pricingStatus'] }
        : {}),
      ...(row.pricingType
        ? { pricingType: row.pricingType as QuoteLine['pricingType'] }
        : {}),
      ...(row.precioMinEstimado != null &&
      row.precioMaxEstimado != null &&
      row.precioCentral != null
        ? {
            priceRange: {
              min: row.precioMinEstimado,
              max: row.precioMaxEstimado,
              central: row.precioCentral,
            },
          }
        : {}),
      ...(row.cantidadMuestras != null || row.cantidadDominios != null
        ? {
            marketEvidence: {
              sampleCount: row.cantidadMuestras,
              domainCount: row.cantidadDominios,
            },
          }
        : {}),
    };
  });

  const subtotal = lines
    .filter((l) => l.billable)
    .reduce((acc, l) => acc + l.amount, 0);

  return {
    schemaVersion: QUOTE_SCHEMA_VERSION,
    quoteId: input.quoteId || createQuoteId(),
    peritajeId: input.peritajeId,
    lines,
    subtotal,
    total: subtotal,
    isPartial: lines.some((l) => !l.billable && l.serviceType === 'REFACCION'),
    warnings: [],
    generatedAt: input.generatedAt || new Date().toISOString(),
  };
}

export function draftLinesToCalculatedRows(
  lines: readonly DraftQuoteLine[],
): CalculatedQuoteRow[] {
  return lines.map((line) => ({
    quoteLineId: line.quoteLineId,
    damageItemId: line.damageItemId,
    vehicleId: line.vehicleId,
    serviceType: line.serviceType,
    description: line.description,
    unitPrice: line.unitPrice,
    subtotal: line.subtotal,
    billable: line.billable,
    priceSource: line.priceSource,
    pricingStatus: line.pricingStatus,
    pricingType: line.pricingType,
    precioMinEstimado: line.precioMinEstimado,
    precioMaxEstimado: line.precioMaxEstimado,
    precioCentral: line.precioCentral,
    cantidadMuestras: line.cantidadMuestras,
    cantidadDominios: line.cantidadDominios,
  }));
}

export type { LegacyQuoteServiceType };
