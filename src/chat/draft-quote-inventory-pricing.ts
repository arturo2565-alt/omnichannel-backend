import type { DraftQuoteLine } from './autofix-config';
import { coerceDamageLevelCode } from './autofix-config';
import type { DetectedDamageItem } from './entities/chat.entity';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import { resolvePiecePriceForVehicleProfile } from '../catalog/vehicle-piece-pricing';
import { computeCatalogPiecePrice } from '../catalog/catalog-pricing-rules';
import {
  inferVehicleProfileFromLegacyBañoSeveridad,
  resolveIntegralPriceForVehicleProfile,
} from '../catalog/vehicle-integral-pricing';
import type { CatalogPricingRules } from '../catalog/catalog-pricing-rules';
import type { VehiclePricingProfile } from '../catalog/vehicle-pricing-profile';
import { normalizeVehicleSizeTier } from '../catalog/vehicle-pricing-profile';
import {
  findPanelPiezaOption,
  getClientPieceLabel,
  isInternalDamageRangePieza,
  isIntegralPanelPieza,
  isMolduraPieza,
  isRefaccionPieza,
  isSpecialPanelPieza,
  resolveCatalogPiezaForMatrixLookup,
  resolveMatrixServicioRaw,
  refaccionCatalogCodigoForPieza,
} from '../catalog/panel-pieza-catalog';
import {
  MOLDURA_MONTAJE_PENDIENTE,
  MOLDURA_NO_PINTABLE_REQUIERE_REVISION,
  MOLDURA_PINTADA_CATALOG,
  PANEL_PIEZA_MOLDURA_CODE,
  isMolduraNonPaintableFinish,
  parseMoldingFinishType,
} from '../catalog/moldura';
import {
  pricingEligibilityReason,
  resolveDamageEvidenceStatusForPricing,
} from '../catalog/damage-evidence';
import {
  CANONICAL_TRACE_EVENTS,
  pegCanonicalTrace,
} from './canonical-trace';
import {
  applyXorTreatmentsToInventory,
  canonicalPhysicalPanelKey,
  ensureDamageIdentity,
  HIDDEN_DAMAGE_CLIENT_DISCLAIMER,
  INCIERTO_SUBSTITUTION_DISCLAIMER,
  isBillableQuoteRow,
  resolveInventoryTreatment,
  resolveReplacementInstallationMode,
  isOpticsLikePieza,
  isGrilleLikePieza,
  stripRefaccionPrefix,
  structuredLineLabel,
  type QuoteServiceType,
  type RefaccionPriceSource,
  type TreatmentDecision,
} from './piece-treatment';
import { stampQuoteLineId } from './quote-line-identity';
import {
  MONTAJE_PINTURA_SEVERIDAD_ALIASES,
  MONTAJE_SEVERIDAD,
} from '../catalog/montaje-pintura-catalog';

/** Fila de cotización del panel / PATCH (QuoteRow). */
export interface QuoteRowInput {
  pieza: string;
  severidad: string;
  precioMx: number;
  /** Rango superior — daños internos. */
  precioMaximo?: number;
  /** @deprecated alias de precioMaximo */
  precioMaxMx?: number;
  /** Nombre de la refacción (panel). */
  detallesRefaccion?: string;
  descripcionTecnica?: string;
  descripcion?: string;
  description?: string;
  /** @deprecated alias de description */
  descripcionServicio?: string;
  tratamiento?: TreatmentDecision;
  serviceType?: QuoteServiceType;
  physicalPanelKey?: string;
  damageItemId?: string;
  quoteLineId?: string;
  vehicleId?: string;
  billable?: boolean;
  priceSource?: RefaccionPriceSource;
  pricingStatus?:
    | 'OK'
    | 'INSUFFICIENT_MARKET_SAMPLE'
    | 'AWAITING_VEHICLE_DATA'
    | 'UNCONFIGURED';
  pricingType?: 'RANGE' | 'NONE';
  precioMinEstimado?: number;
  precioMaxEstimado?: number;
  precioCentral?: number;
  cantidadMuestras?: number;
  cantidadDominios?: number;
  providersUsed?: string[];
  partTypeGroup?: string;
  marketQuery?: string;
  disclaimer?: string;
}

function resolveSustituirRefaccionPricing(
  it: DetectedDamageItem,
  display: string,
): {
  partPrice: number;
  billable: boolean;
  priceSource: RefaccionPriceSource;
  pricingStatus:
    | 'OK'
    | 'INSUFFICIENT_MARKET_SAMPLE'
    | 'AWAITING_VEHICLE_DATA';
  awaiting: boolean;
  insufficient: boolean;
  pendingDisclaimer: string;
  pendingDescription: string;
} {
  const awaiting =
    it.pricingStatus === 'AWAITING_VEHICLE_DATA' ||
    it.priceSource === 'AWAITING_VEHICLE_DATA';
  const rawPart = Number(it.precioMx);
  const catalogManual =
    it.priceSource === 'AUTOFIX_CATALOG' || it.priceSource === 'FALLBACK';
  const hasValidPart =
    !catalogManual && Number.isFinite(rawPart) && rawPart > 0;
  const insufficient =
    !awaiting &&
    (catalogManual ||
      it.pricingStatus === 'INSUFFICIENT_MARKET_SAMPLE' ||
      it.priceSource === 'INSUFFICIENT_MARKET_SAMPLE' ||
      !hasValidPart);
  const partPrice = hasValidPart && !awaiting ? Math.round(rawPart) : 0;
  const priceSource: RefaccionPriceSource = awaiting
    ? 'AWAITING_VEHICLE_DATA'
    : catalogManual
      ? 'INSUFFICIENT_MARKET_SAMPLE'
      : (it.priceSource ??
        (hasValidPart ? 'WEB_MARKET_ESTIMATE' : 'INSUFFICIENT_MARKET_SAMPLE'));
  const pricingStatus = awaiting
    ? 'AWAITING_VEHICLE_DATA'
    : insufficient
      ? 'INSUFFICIENT_MARKET_SAMPLE'
      : it.pricingStatus === 'OK'
        ? 'OK'
        : 'OK';
  return {
    partPrice,
    billable: partPrice > 0 && !insufficient && !awaiting,
    priceSource,
    pricingStatus,
    awaiting,
    insufficient,
    pendingDisclaimer: awaiting
      ? `Refacción de ${display}: falta información del vehículo para cotizar el reemplazo.`
      : `Refacción de ${display}: precio pendiente de estimación. El montaje/pintura no cubre la pieza de reemplazo.`,
    pendingDescription: awaiting
      ? `Refacción de ${display}: pendiente de datos del vehículo`
      : `Refacción de ${display}: precio pendiente de estimación`,
  };
}

/** Proyecta rango y evidencia de mercado a QuoteLine. No recalcula importe. */
export function quoteLineMarketProjection(row: QuoteRowInput): {
  priceRange?: { min: number; max: number; central: number };
  marketEvidence?: {
    sampleCount?: number;
    domainCount?: number;
    providersUsed?: string[];
    partTypeGroup?: string;
    query?: string;
  };
} {
  const priceRange =
    row.precioMinEstimado != null &&
    row.precioMaxEstimado != null &&
    row.precioCentral != null
      ? {
          min: row.precioMinEstimado,
          max: row.precioMaxEstimado,
          central: row.precioCentral,
        }
      : undefined;
  const marketEvidence =
    row.cantidadMuestras != null ||
    row.cantidadDominios != null ||
    row.providersUsed != null ||
    row.partTypeGroup != null ||
    row.marketQuery != null
      ? {
          sampleCount: row.cantidadMuestras,
          domainCount: row.cantidadDominios,
          providersUsed: row.providersUsed,
          partTypeGroup: row.partTypeGroup,
          query: row.marketQuery,
        }
      : undefined;
  return {
    ...(priceRange ? { priceRange } : {}),
    ...(marketEvidence ? { marketEvidence } : {}),
  };
}

export function resolveQuoteRowPrecioMaximo(
  line: QuoteRowInput,
): number | undefined {
  const raw =
    line.precioMaximo != null
      ? line.precioMaximo
      : line.precioMaxMx != null
        ? line.precioMaxMx
        : undefined;
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export type QuoteRowKind =
  | 'internal_damage'
  | 'refaccion'
  | 'matrix'
  | 'integral'
  | 'montaje_pintura'
  | 'montaje'
  | 'pendiente';

export function classifyQuoteRow(line: QuoteRowInput): QuoteRowKind {
  if (line.serviceType === 'PENDIENTE') return 'pendiente';
  if (line.serviceType === 'MONTAJE_PINTURA') return 'montaje_pintura';
  if (line.serviceType === 'MONTAJE') return 'montaje';
  if (line.serviceType === 'ADVERTENCIA' || isInternalDamageRangePieza(line.pieza)) {
    return 'internal_damage';
  }
  if (line.serviceType === 'REFACCION' || isRefaccionPieza(line.pieza)) {
    return 'refaccion';
  }
  if (isIntegralPanelPieza(line.pieza)) return 'integral';
  const max = resolveQuoteRowPrecioMaximo(line);
  const min = Math.round(Number(line.precioMx) || 0);
  if (max != null && max > min) return 'internal_damage';
  if (
    line.detallesRefaccion != null &&
    String(line.detallesRefaccion).trim() !== ''
  ) {
    return 'refaccion';
  }
  return 'matrix';
}

/** Solo líneas cobrables. Pendientes y daños internos no confirmados = 0. */
export function quoteRowSubtotalForTotal(line: QuoteRowInput): number {
  if (!isBillableQuoteRow(line)) return 0;
  const kind = classifyQuoteRow(line);
  if (kind === 'internal_damage' || kind === 'pendiente') return 0;
  const u = Math.round(Number(line.precioMx) || 0);
  return Math.max(0, u);
}

export function sumQuoteRowsSubtotal(lines: readonly QuoteRowInput[]): number {
  return lines.reduce((acc, l) => acc + quoteRowSubtotalForTotal(l), 0);
}

function refaccionLabelFromRow(line: QuoteRowInput): string {
  const fromField = String(line.detallesRefaccion ?? '').trim();
  if (fromField) return fromField;
  const piezaTrim = String(line.pieza ?? '').trim();
  const fromPieza = piezaTrim.replace(/^refacci[oó]n\s*:\s*/i, '').trim();
  if (fromPieza && !/^refacci[oó]n$/i.test(fromPieza)) return fromPieza;
  const desc =
    typeof line.descripcionTecnica === 'string'
      ? line.descripcionTecnica.trim()
      : typeof line.descripcion === 'string'
        ? line.descripcion.trim()
        : '';
  return desc || 'Sin especificar';
}

function displayPiezaName(
  pieza: string,
  snap?: MatrixPricingSnapshot,
  item?: DetectedDamageItem,
): string {
  const client = getClientPieceLabel(pieza, item);
  if (client) return client;
  const opt = findPanelPiezaOption(String(pieza).trim());
  if (opt?.fullName) return opt.fullName;
  if (snap) {
    const matrixRaw = resolveMatrixServicioRaw(String(pieza).trim());
    return snap.matchServicio(matrixRaw) ?? matrixRaw;
  }
  return String(pieza).trim();
}

function attachStructured(
  line: DraftQuoteLine,
  row: QuoteRowInput,
): DraftQuoteLine {
  return {
    ...line,
    ...(row.damageItemId ? { damageItemId: row.damageItemId } : {}),
    ...(row.quoteLineId ? { quoteLineId: row.quoteLineId } : {}),
    ...(row.vehicleId ? { vehicleId: row.vehicleId } : {}),
    tratamiento: row.tratamiento,
    serviceType: row.serviceType,
    physicalPanelKey: row.physicalPanelKey,
    billable: row.billable !== false && quoteRowSubtotalForTotal(row) > 0,
    ...(row.priceSource ? { priceSource: row.priceSource } : {}),
    ...(row.pricingStatus ? { pricingStatus: row.pricingStatus } : {}),
    ...(row.pricingType ? { pricingType: row.pricingType } : {}),
    ...(row.precioMinEstimado != null
      ? { precioMinEstimado: row.precioMinEstimado }
      : {}),
    ...(row.precioMaxEstimado != null
      ? { precioMaxEstimado: row.precioMaxEstimado }
      : {}),
    ...(row.precioCentral != null ? { precioCentral: row.precioCentral } : {}),
    ...(row.cantidadMuestras != null
      ? { cantidadMuestras: row.cantidadMuestras }
      : {}),
    ...(row.cantidadDominios != null
      ? { cantidadDominios: row.cantidadDominios }
      : {}),
    ...(row.disclaimer ? { disclaimer: row.disclaimer } : {}),
  };
}

export function buildDraftQuoteLineFromQuoteRow(
  line: QuoteRowInput,
  idx: number,
  snap: MatrixPricingSnapshot,
): DraftQuoteLine {
  const u = Math.round(Number(line.precioMx) || 0);
  const kind = classifyQuoteRow(line);
  const structuredDesc = String(
    line.description ?? line.descripcionServicio ?? '',
  ).trim();

  if (kind === 'pendiente') {
    const label = displayPiezaName(line.pieza, snap);
    return attachStructured(
      {
        priceItemId: `panel:${idx}:pendiente`,
        description: structuredDesc || `${label} — pendiente de revisión`,
        quantity: 1,
        unitPrice: 0,
        subtotal: 0,
      },
      line,
    );
  }

  if (kind === 'refaccion') {
    const label = refaccionLabelFromRow(line);
    return attachStructured(
      {
        priceItemId: `panel:${idx}:refaccion`,
        description: structuredDesc || `Refacción de ${label}`,
        quantity: 1,
        unitPrice: u,
        subtotal: u,
      },
      line,
    );
  }

  if (kind === 'montaje_pintura') {
    const label = displayPiezaName(line.pieza, snap);
    return attachStructured(
      {
        priceItemId: `panel:${idx}:montaje-pintura`,
        description: structuredDesc || `Montar y pintar ${label}`,
        quantity: 1,
        unitPrice: u,
        subtotal: u,
      },
      line,
    );
  }

  if (kind === 'montaje') {
    const label = displayPiezaName(line.pieza, snap);
    return attachStructured(
      {
        priceItemId: `panel:${idx}:montaje`,
        description: structuredDesc || `Montaje ${label}`,
        quantity: 1,
        unitPrice: u,
        subtotal: u,
      },
      line,
    );
  }

  if (kind === 'internal_damage') {
    return attachStructured(
      {
        priceItemId: `panel:${idx}:internal-damage`,
        description:
          structuredDesc ||
          `Posibles daños internos (sujeto a desarme) — no incluido en el total`,
        quantity: 1,
        unitPrice: 0,
        subtotal: 0,
      },
      { ...line, billable: false, precioMx: 0 },
    );
  }

  if (kind === 'integral') {
    const displayName =
      findPanelPiezaOption(String(line.pieza).trim())?.fullName ??
      String(line.pieza).trim();
    const tierLabel = String(line.severidad ?? '').trim() || 'Mediano';
    return attachStructured(
      {
        priceItemId: `panel:${idx}:integral:${displayName}`,
        description: structuredDesc || `${displayName} — ${tierLabel} (panel)`,
        quantity: 1,
        unitPrice: u,
        subtotal: u,
      },
      line,
    );
  }

  const matrixRaw = resolveMatrixServicioRaw(String(line.pieza).trim());
  const canonical = snap.matchServicio(matrixRaw) ?? matrixRaw;
  const lev = coerceDamageLevelCode(String(line.severidad));
  const displayName =
    findPanelPiezaOption(String(line.pieza).trim())?.fullName ?? canonical;
  const repairLabel =
    line.tratamiento === 'INCIERTO'
      ? `Reparación y pintura estimada de ${displayName}`
      : `Reparar y pintar ${displayName}`;
  return attachStructured(
    {
      priceItemId: `panel:${idx}:${canonical}:${lev}`,
      description: structuredDesc || `${repairLabel} — nivel ${lev}`,
      quantity: 1,
      unitPrice: u,
      subtotal: u,
    },
    line,
  );
}

function resolveProfileForIntegralInventoryRow(
  severidadStored: string,
  vehicleProfile?: VehiclePricingProfile | null,
): VehiclePricingProfile {
  const tierFromSev =
    normalizeVehicleSizeTier(severidadStored) ??
    inferVehicleProfileFromLegacyBañoSeveridad(
      severidadStored,
      vehicleProfile?.vehicleLabel ?? '',
    ).sizeTier;
  const inferred = inferVehicleProfileFromLegacyBañoSeveridad(
    severidadStored,
    vehicleProfile?.vehicleLabel ?? '',
  );
  return {
    vehicleLabel: vehicleProfile?.vehicleLabel ?? 'panel',
    sizeTier: tierFromSev ?? vehicleProfile?.sizeTier ?? 'Compacto',
    isPremium:
      vehicleProfile?.isPremium ?? inferred.isPremium ?? false,
    tierSource: vehicleProfile?.tierSource ?? 'inferido',
  };
}

export type MountPaintPriceSource =
  | 'DEDICATED_TARIFF'
  | 'LEGACY_REPAIR_MATRIX_FALLBACK'
  | 'UNCONFIGURED';

export type MontajePinturaPriceResolution = {
  precio: number;
  priceSource: Extract<
    RefaccionPriceSource,
    'AUTOFIX_CATALOG' | 'LEGACY_REPAIR_MATRIX_FALLBACK' | 'UNCONFIGURED'
  >;
  mountPaintPriceSource: MountPaintPriceSource;
};

/**
 * Mano de obra de sustituir: celda dedicada MONTAJE(_PINTURA).
 * Si no existe, reutiliza DL/LEVE solo como fallback etiquetado.
 * $0 + UNCONFIGURED no es "gratis".
 */
export function resolveMontajePinturaPrice(
  snap: MatrixPricingSnapshot,
  catalogPieza: string,
  vehicleProfile?: VehiclePricingProfile | null,
  pricingRules?: CatalogPricingRules | null,
): MontajePinturaPriceResolution {
  const canonical = String(catalogPieza ?? '').trim();
  if (!canonical) {
    return {
      precio: 0,
      priceSource: 'UNCONFIGURED',
      mountPaintPriceSource: 'UNCONFIGURED',
    };
  }
  for (const key of MONTAJE_PINTURA_SEVERIDAD_ALIASES) {
    const explicit =
      snap.getPriceForCanonical(canonical, key) ||
      snap.getAmount(canonical, key);
    if (explicit > 0) {
      return {
        precio: computeCatalogPiecePrice({
          basePrice: explicit,
          sizeTier: vehicleProfile?.sizeTier ?? 'Compacto',
          isPremium: vehicleProfile?.isPremium ?? false,
          damageMagnitude: 'LEVE',
          rules: pricingRules ?? undefined,
        }),
        priceSource: 'AUTOFIX_CATALOG',
        mountPaintPriceSource: 'DEDICATED_TARIFF',
      };
    }
  }
  const fallback = resolvePiecePriceForVehicleProfile(
    snap,
    canonical,
    'DL',
    vehicleProfile,
    pricingRules,
  );
  if (fallback > 0) {
    return {
      precio: fallback,
      priceSource: 'LEGACY_REPAIR_MATRIX_FALLBACK',
      mountPaintPriceSource: 'LEGACY_REPAIR_MATRIX_FALLBACK',
    };
  }
  return {
    precio: 0,
    priceSource: 'UNCONFIGURED',
    mountPaintPriceSource: 'UNCONFIGURED',
  };
}

export function resolveMontajeCatalogPieza(pieza: string): string {
  const stripped = stripRefaccionPrefix(pieza);
  if (isMolduraPieza(stripped)) return 'MOLDURA';
  if (isOpticsLikePieza(stripped)) {
    const codigo = refaccionCatalogCodigoForPieza(stripped) ?? '';
    if (/NIEBLA/i.test(codigo) || /niebla/i.test(stripped)) return 'Faro niebla';
    if (/^CAL_/i.test(codigo) || /calavera/i.test(stripped)) return 'Calavera';
    return 'Faro';
  }
  if (isGrilleLikePieza(stripped)) return 'Parilla';
  return resolveCatalogPiezaForMatrixLookup(stripped) ?? stripped;
}

/**
 * Mano de obra de instalación sin pintura. Sin fallback a DL ni a MONTAJE_PINTURA.
 * $0 + UNCONFIGURED no es "gratis".
 */
export function resolveMontajePrice(
  snap: MatrixPricingSnapshot,
  catalogPieza: string,
  vehicleProfile?: VehiclePricingProfile | null,
  pricingRules?: CatalogPricingRules | null,
): MontajePinturaPriceResolution {
  const canonical = String(catalogPieza ?? '').trim();
  if (!canonical) {
    return {
      precio: 0,
      priceSource: 'UNCONFIGURED',
      mountPaintPriceSource: 'UNCONFIGURED',
    };
  }
  const explicit =
    snap.getPriceForCanonical(canonical, MONTAJE_SEVERIDAD) ||
    snap.getAmount(canonical, MONTAJE_SEVERIDAD);
  if (explicit > 0) {
    return {
      precio: computeCatalogPiecePrice({
        basePrice: explicit,
        sizeTier: vehicleProfile?.sizeTier ?? 'Compacto',
        isPremium: vehicleProfile?.isPremium ?? false,
        damageMagnitude: 'LEVE',
        rules: pricingRules ?? undefined,
      }),
      priceSource: 'AUTOFIX_CATALOG',
      mountPaintPriceSource: 'DEDICATED_TARIFF',
    };
  }
  return {
    precio: 0,
    priceSource: 'UNCONFIGURED',
    mountPaintPriceSource: 'UNCONFIGURED',
  };
}

function matrixRepairPrice(
  it: DetectedDamageItem,
  panelCode: string,
  snap: MatrixPricingSnapshot,
  vehicleProfile?: VehiclePricingProfile | null,
  pricingRules?: CatalogPricingRules | null,
): { precio: number; storedSev: string } {
  const sevRaw = String(it.severidad ?? '').trim();
  const sev = coerceDamageLevelCode(sevRaw);
  const catalogPieza =
    resolveCatalogPiezaForMatrixLookup(panelCode) ??
    snap.matchServicio(it.pieza) ??
    it.pieza;
  let precio = resolvePiecePriceForVehicleProfile(
    snap,
    catalogPieza,
    sev,
    vehicleProfile,
    pricingRules,
  );
  if (precio <= 0) {
    precio = resolvePiecePriceForVehicleProfile(
      snap,
      snap.matchServicio(it.pieza) ?? it.pieza,
      sev,
      vehicleProfile,
      pricingRules,
    );
  }
  return { precio, storedSev: sev };
}

/** Propaga IDs desde el DamageItem. Nunca recalcula damageItemId desde description. */
function stampRowFromDamage(
  it: DetectedDamageItem,
  row: QuoteRowInput,
): QuoteRowInput {
  const identified = ensureDamageIdentity(it);
  const quoteLineId =
    String(row.quoteLineId ?? '').trim() ||
    stampQuoteLineId({
      damageItemId: identified.damageItemId,
      serviceType: row.serviceType,
    });
  return {
    ...row,
    damageItemId: identified.damageItemId,
    vehicleId: identified.vehicleId,
    ...(quoteLineId ? { quoteLineId } : {}),
  };
}

function pushReplacementInstallationRow(
  rows: QuoteRowInput[],
  it: DetectedDamageItem,
  panelCode: string,
  display: string,
  snap: MatrixPricingSnapshot,
  vehicleProfile?: VehiclePricingProfile | null,
  pricingRules?: CatalogPricingRules | null,
): void {
  const resolution = resolveReplacementInstallationMode({
    pieza: it.pieza,
    physicalPanelKey: panelCode,
    tratamiento: 'SUSTITUIR',
    finishType: it.finishType,
  });
  pegCanonicalTrace(CANONICAL_TRACE_EVENTS.REPLACEMENT_INSTALLATION_RESOLUTION, {
    damageItemId: it.damageItemId ?? null,
    pieceCode: it.pieza,
    treatment: 'SUSTITUIR',
    installationMode: resolution.installationMode,
    reason: resolution.reason,
  });
  if (resolution.installationMode === 'NONE') return;
  if (resolution.installationMode === 'MONTAJE_PINTURA') {
    const catalogPieza =
      isMolduraPieza(it.pieza) || isMolduraPieza(panelCode)
        ? MOLDURA_PINTADA_CATALOG
        : resolveCatalogPiezaForMatrixLookup(panelCode) ??
          snap.matchServicio(it.pieza) ??
          it.pieza;
    const montaje = resolveMontajePinturaPrice(
      snap,
      String(catalogPieza),
      vehicleProfile,
      pricingRules,
    );
    const montajeUnconfigured = montaje.mountPaintPriceSource === 'UNCONFIGURED';
    rows.push(
      stampRowFromDamage(it, {
        pieza: panelCode,
        severidad: 'MONTAJE_PINTURA',
        precioMx: Math.max(0, Math.round(montaje.precio)),
        tratamiento: 'SUSTITUIR',
        serviceType: 'MONTAJE_PINTURA',
        physicalPanelKey: panelCode,
        billable: montaje.precio > 0 && !montajeUnconfigured,
        priceSource: montaje.priceSource,
        ...(montajeUnconfigured ? { pricingStatus: 'UNCONFIGURED' as const } : {}),
        description: `Montar y pintar ${display}`,
        descripcionServicio: `Montar y pintar ${display}`,
      }),
    );
    return;
  }
  const montaje = resolveMontajePrice(
    snap,
    resolveMontajeCatalogPieza(it.pieza || panelCode),
    vehicleProfile,
    pricingRules,
  );
  const unconfigured = montaje.mountPaintPriceSource === 'UNCONFIGURED';
  rows.push(
    stampRowFromDamage(it, {
      pieza: panelCode,
      severidad: 'MONTAJE',
      precioMx: Math.max(0, Math.round(montaje.precio)),
      tratamiento: 'SUSTITUIR',
      serviceType: 'MONTAJE',
      physicalPanelKey: panelCode,
      billable: montaje.precio > 0 && !unconfigured,
      priceSource: montaje.priceSource,
      ...(unconfigured ? { pricingStatus: 'UNCONFIGURED' as const } : {}),
      description: `Montaje ${display}`,
      descripcionServicio: `Montaje ${display}`,
    }),
  );
}

/**
 * Una decisión comercial por pieza física. REPARAR XOR SUSTITUIR.
 */
export function quoteRowsFromDamageInventory(
  inventory: readonly DetectedDamageItem[],
  snap: MatrixPricingSnapshot,
  vehicleProfile?: VehiclePricingProfile | null,
  pricingRules?: CatalogPricingRules | null,
): QuoteRowInput[] {
  const collapsed = applyXorTreatmentsToInventory(inventory);
  const rows: QuoteRowInput[] = [];

  for (const raw of collapsed) {
    const it = ensureDamageIdentity(raw);
    const panelCode =
      canonicalPhysicalPanelKey(it.pieza, it) || String(it.pieza ?? '').trim();
    if (!panelCode) continue;
    const tratamiento = resolveInventoryTreatment(it, collapsed).treatment;
    const display = getClientPieceLabel(it.pieza || panelCode, it);

    if (isInternalDamageRangePieza(panelCode)) {
      rows.push(
        stampRowFromDamage(it, {
          pieza: panelCode,
          severidad: 'N/A',
          precioMx: 0,
          tratamiento: 'PENDIENTE',
          serviceType: 'ADVERTENCIA',
          physicalPanelKey: panelCode,
          billable: false,
          disclaimer: HIDDEN_DAMAGE_CLIENT_DISCLAIMER,
          description: 'Posibles daños internos (sujeto a desarme)',
          descripcionServicio: 'Posibles daños internos (sujeto a desarme)',
        }),
      );
      continue;
    }

    if (isIntegralPanelPieza(panelCode) && !isRefaccionPieza(panelCode)) {
      const sevRaw = String(it.severidad ?? '').trim();
      const storedSev = sevRaw || vehicleProfile?.sizeTier || 'Mediano';
      const opt = findPanelPiezaOption(panelCode);
      const catalogPieza =
        opt?.catalogPieza ?? snap.matchServicio(it.pieza) ?? it.pieza;
      const profile = resolveProfileForIntegralInventoryRow(
        storedSev,
        vehicleProfile,
      );
      const resolution = resolveIntegralPriceForVehicleProfile(
        snap,
        String(catalogPieza),
        profile,
        pricingRules,
      );
      const precio = resolution?.unitPrice ?? 0;
      const unconfigured = precio <= 0;
      rows.push(
        stampRowFromDamage(it, {
          pieza: panelCode,
          severidad: storedSev,
          precioMx: Math.max(0, Math.round(precio)),
          tratamiento: 'REPARAR',
          serviceType: 'REPARACION_PINTURA',
          physicalPanelKey: panelCode,
          billable: precio > 0,
          ...(unconfigured
            ? { priceSource: 'UNCONFIGURED' as const }
            : { priceSource: 'AUTOFIX_CATALOG' as const }),
        }),
      );
      continue;
    }

    const evidenceStatus = resolveDamageEvidenceStatusForPricing(
      it.damageEvidenceStatus,
    );
    const billableEligible = evidenceStatus === 'CONFIRMED_VISIBLE';
    pegCanonicalTrace(CANONICAL_TRACE_EVENTS.PRICING_ELIGIBILITY, {
      damageItemId: it.damageItemId ?? null,
      pieceCode: it.pieza,
      damageEvidenceStatus: evidenceStatus,
      treatment: tratamiento,
      billableEligible,
      reason: pricingEligibilityReason(evidenceStatus),
    });
    if (!billableEligible) {
      const pendingWhy =
        evidenceStatus === 'NOT_ASSESSABLE'
          ? 'no valorable con las imágenes actuales'
          : 'posible involucramiento; pendiente de revisión en taller';
      rows.push(
        stampRowFromDamage(it, {
          pieza: panelCode,
          severidad: coerceDamageLevelCode(String(it.severidad ?? '').trim()),
          precioMx: 0,
          tratamiento,
          serviceType: 'PENDIENTE',
          physicalPanelKey: panelCode,
          billable: false,
          description: `${display} — ${pendingWhy}`,
          descripcionServicio: `${display} — ${pendingWhy}`,
        }),
      );
      continue;
    }

    if (isMolduraPieza(it.pieza) || isMolduraPieza(panelCode)) {
      const finish = parseMoldingFinishType(it.finishType);
      if (tratamiento === 'PENDIENTE') {
        rows.push(
          stampRowFromDamage(it, {
            pieza: PANEL_PIEZA_MOLDURA_CODE,
            severidad: coerceDamageLevelCode(String(it.severidad ?? '').trim()),
            precioMx: 0,
            tratamiento: 'PENDIENTE',
            serviceType: 'PENDIENTE',
            physicalPanelKey: panelCode,
            billable: false,
            description: `${display} — pendiente de revisión/cotización`,
            descripcionServicio: `${display} — pendiente de revisión/cotización`,
          }),
        );
        continue;
      }

      if (tratamiento === 'SUSTITUIR') {
        const finish = parseMoldingFinishType(it.finishType);
        const negraMontajePendiente = finish === 'UNKNOWN';
        const refaccion = resolveSustituirRefaccionPricing(it, display);
        rows.push(
          stampRowFromDamage(it, {
            pieza: `REFACCION:${PANEL_PIEZA_MOLDURA_CODE}`,
            severidad: 'N/A',
            precioMx: refaccion.partPrice,
            detallesRefaccion: it.detallesRefaccion || display,
            tratamiento: 'SUSTITUIR',
            serviceType: 'REFACCION',
            physicalPanelKey: panelCode,
            billable: refaccion.billable,
            priceSource: refaccion.priceSource,
            pricingStatus: refaccion.pricingStatus,
            pricingType:
              it.pricingType ??
              (refaccion.partPrice > 0 ? 'RANGE' : 'NONE'),
            precioMinEstimado: it.precioMinEstimado,
            precioMaxEstimado: it.precioMaxEstimado,
            precioCentral: it.precioCentral,
            cantidadMuestras: it.cantidadMuestras,
            cantidadDominios: it.cantidadDominios,
            providersUsed: it.providersUsed,
            partTypeGroup: it.partTypeGroup,
            disclaimer: negraMontajePendiente
              ? MOLDURA_MONTAJE_PENDIENTE
              : refaccion.awaiting || refaccion.insufficient
                ? refaccion.pendingDisclaimer
                : undefined,
            description:
              refaccion.awaiting || refaccion.insufficient
                ? refaccion.pendingDescription
                : `Refacción de ${display}`,
            descripcionServicio:
              refaccion.awaiting || refaccion.insufficient
                ? refaccion.pendingDescription
                : `Refacción de ${display}`,
          }),
        );
        pushReplacementInstallationRow(
          rows,
          it,
          panelCode,
          display,
          snap,
          vehicleProfile,
          pricingRules,
        );
        continue;
      }

      if (tratamiento === 'REPARAR' || tratamiento === 'INCIERTO') {
        if (isMolduraNonPaintableFinish(finish)) {
          rows.push(
            stampRowFromDamage(it, {
              pieza: PANEL_PIEZA_MOLDURA_CODE,
              severidad: coerceDamageLevelCode(String(it.severidad ?? '').trim()),
              precioMx: 0,
              tratamiento,
              serviceType: 'PENDIENTE',
              physicalPanelKey: panelCode,
              billable: false,
              priceSource: 'UNCONFIGURED',
              pricingStatus: 'UNCONFIGURED',
              disclaimer: MOLDURA_NO_PINTABLE_REQUIERE_REVISION,
              description: `${display} — ${MOLDURA_NO_PINTABLE_REQUIERE_REVISION}`,
              descripcionServicio: `${display} — ${MOLDURA_NO_PINTABLE_REQUIERE_REVISION}`,
            }),
          );
          continue;
        }
        const paintedItem = { ...it, pieza: MOLDURA_PINTADA_CATALOG };
        const { precio, storedSev } = matrixRepairPrice(
          paintedItem,
          MOLDURA_PINTADA_CATALOG,
          snap,
          vehicleProfile,
          pricingRules,
        );
        const unconfigured = precio <= 0;
        const desc = unconfigured
          ? `${display} — tarifa MOLDURA_PINTADA sin configurar`
          : tratamiento === 'INCIERTO'
            ? `Reparación y pintura estimada de ${display}`
            : `Reparar y pintar ${display}`;
        rows.push(
          stampRowFromDamage(it, {
            pieza: PANEL_PIEZA_MOLDURA_CODE,
            severidad: storedSev,
            precioMx: Math.max(0, Math.round(precio)),
            tratamiento,
            serviceType: 'REPARACION_PINTURA',
            physicalPanelKey: panelCode,
            billable: precio > 0 && !unconfigured,
            priceSource: unconfigured ? 'UNCONFIGURED' : 'AUTOFIX_CATALOG',
            ...(unconfigured
              ? { pricingStatus: 'UNCONFIGURED' as const }
              : {}),
            description: desc,
            descripcionServicio: desc,
            ...(tratamiento === 'INCIERTO' || it.posibleReemplazoRefaccion
              ? { disclaimer: INCIERTO_SUBSTITUTION_DISCLAIMER }
              : {}),
          }),
        );
      }
      continue;
    }

    if (tratamiento === 'PENDIENTE') {
      rows.push(
        stampRowFromDamage(it, {
          pieza: panelCode,
          severidad: coerceDamageLevelCode(String(it.severidad ?? '').trim()),
          precioMx: 0,
          tratamiento: 'PENDIENTE',
          serviceType: 'PENDIENTE',
          physicalPanelKey: panelCode,
          billable: false,
          description: `${display} — pendiente de revisión/cotización`,
          descripcionServicio: `${display} — pendiente de revisión/cotización`,
        }),
      );
      continue;
    }

    if (tratamiento === 'SUSTITUIR') {
      const refaccion = resolveSustituirRefaccionPricing(it, display);
      rows.push(
        stampRowFromDamage(it, {
        pieza: `REFACCION:${panelCode}`,
        severidad: 'N/A',
        precioMx: refaccion.partPrice,
        detallesRefaccion: it.detallesRefaccion || display,
        tratamiento: 'SUSTITUIR',
        serviceType: 'REFACCION',
        physicalPanelKey: panelCode,
        billable: refaccion.billable,
        priceSource: refaccion.priceSource,
        pricingStatus: refaccion.pricingStatus,
        pricingType:
          it.pricingType ?? (refaccion.partPrice > 0 ? 'RANGE' : 'NONE'),
        precioMinEstimado: it.precioMinEstimado,
        precioMaxEstimado: it.precioMaxEstimado,
        precioCentral: it.precioCentral,
        cantidadMuestras: it.cantidadMuestras,
        cantidadDominios: it.cantidadDominios,
        providersUsed: it.providersUsed,
        partTypeGroup: it.partTypeGroup,
        disclaimer:
          refaccion.awaiting || refaccion.insufficient
            ? refaccion.pendingDisclaimer
            : undefined,
        description:
          refaccion.awaiting || refaccion.insufficient
            ? refaccion.pendingDescription
            : `Refacción de ${display}`,
        descripcionServicio:
          refaccion.awaiting || refaccion.insufficient
            ? refaccion.pendingDescription
            : `Refacción de ${display}`,
        }),
      );
        pushReplacementInstallationRow(
          rows,
          it,
          panelCode,
          display,
          snap,
          vehicleProfile,
          pricingRules,
        );
        continue;
      }

    if (tratamiento === 'REPARAR' || tratamiento === 'INCIERTO') {
      if (isSpecialPanelPieza(panelCode) && isRefaccionPieza(panelCode)) {
        continue;
      }
      const { precio, storedSev } = matrixRepairPrice(
        it,
        panelCode,
        snap,
        vehicleProfile,
        pricingRules,
      );
      const desc =
        tratamiento === 'INCIERTO'
          ? `Reparación y pintura estimada de ${display}`
          : `Reparar y pintar ${display}`;
      rows.push(
        stampRowFromDamage(it, {
          pieza: panelCode,
          severidad: storedSev,
          precioMx: Math.max(0, Math.round(precio)),
          tratamiento,
          serviceType: 'REPARACION_PINTURA',
          physicalPanelKey: panelCode,
          billable: precio > 0,
          description: desc,
          descripcionServicio: desc,
          ...(tratamiento === 'INCIERTO' || it.posibleReemplazoRefaccion
            ? { disclaimer: INCIERTO_SUBSTITUTION_DISCLAIMER }
            : {}),
        }),
      );
    }
  }

  return rows;
}

export function buildDraftQuoteLinesFromDamageInventory(
  inventory: readonly DetectedDamageItem[],
  snap: MatrixPricingSnapshot,
  vehicleProfile?: VehiclePricingProfile | null,
  pricingRules?: CatalogPricingRules | null,
): DraftQuoteLine[] {
  return quoteRowsFromDamageInventory(
    inventory,
    snap,
    vehicleProfile,
    pricingRules,
  ).map((row, idx) => buildDraftQuoteLineFromQuoteRow(row, idx, snap));
}

function isSpecialPanelPiezaForMatrix(pieza: string): boolean {
  return (
    isInternalDamageRangePieza(pieza) ||
    isRefaccionPieza(pieza) ||
    isIntegralPanelPieza(pieza)
  );
}

export function matrixServicioInputsWithCatalogResolve(
  items: ReadonlyArray<{ pieza: string; severidad: string }>,
): { servicio: string; severidad: string }[] {
  return items
    .filter((it) => !isSpecialPanelPiezaForMatrix(it.pieza))
    .map((it) => ({
      servicio: resolveMatrixServicioRaw(it.pieza),
      severidad: it.severidad,
    }));
}

export { structuredLineLabel };
