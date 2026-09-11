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
  isInternalDamageRangePieza,
  isIntegralPanelPieza,
  isRefaccionPieza,
  isSpecialPanelPieza,
  resolveCatalogPiezaForMatrixLookup,
  resolveMatrixServicioRaw,
} from '../catalog/panel-pieza-catalog';
import {
  applyXorTreatmentsToInventory,
  canonicalPhysicalPanelKey,
  HIDDEN_DAMAGE_CLIENT_DISCLAIMER,
  INCIERTO_SUBSTITUTION_DISCLAIMER,
  isBillableQuoteRow,
  needsMontajePinturaComponent,
  structuredLineLabel,
  type QuoteServiceType,
  type RefaccionPriceSource,
  type TreatmentDecision,
} from './piece-treatment';
import {
  MONTAJE_PINTURA_SEVERIDAD_ALIASES,
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
  billable?: boolean;
  priceSource?: RefaccionPriceSource;
  pricingStatus?: 'OK' | 'INSUFFICIENT_MARKET_SAMPLE';
  pricingType?: 'RANGE' | 'NONE';
  precioMinEstimado?: number;
  precioMaxEstimado?: number;
  precioCentral?: number;
  cantidadMuestras?: number;
  cantidadDominios?: number;
  disclaimer?: string;
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
  | 'pendiente';

export function classifyQuoteRow(line: QuoteRowInput): QuoteRowKind {
  if (line.serviceType === 'PENDIENTE') return 'pendiente';
  if (line.serviceType === 'MONTAJE_PINTURA') return 'montaje_pintura';
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

function displayPiezaName(pieza: string, snap?: MatrixPricingSnapshot): string {
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
        priceItemId: `panel:${idx}:montaje`,
        description: structuredDesc || `Montar y pintar ${label}`,
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

export type MontajePinturaPriceResolution = {
  precio: number;
  priceSource: Extract<
    RefaccionPriceSource,
    'AUTOFIX_CATALOG' | 'LEGACY_REPAIR_MATRIX_FALLBACK'
  >;
};

/**
 * Mano de obra de sustituir: celda dedicada MONTAJE(_PINTURA).
 * Si no existe, reutiliza DL/LEVE solo como fallback etiquetado.
 */
export function resolveMontajePinturaPrice(
  snap: MatrixPricingSnapshot,
  catalogPieza: string,
  vehicleProfile?: VehiclePricingProfile | null,
  pricingRules?: CatalogPricingRules | null,
): MontajePinturaPriceResolution {
  const canonical = String(catalogPieza ?? '').trim();
  if (!canonical) {
    return { precio: 0, priceSource: 'LEGACY_REPAIR_MATRIX_FALLBACK' };
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
      };
    }
  }
  return {
    precio: resolvePiecePriceForVehicleProfile(
      snap,
      canonical,
      'DL',
      vehicleProfile,
      pricingRules,
    ),
    priceSource: 'LEGACY_REPAIR_MATRIX_FALLBACK',
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

  for (const it of collapsed) {
    const panelCode =
      canonicalPhysicalPanelKey(it.pieza) || String(it.pieza ?? '').trim();
    if (!panelCode) continue;
    const tratamiento = it.tratamiento ?? 'REPARAR';
    const display = displayPiezaName(panelCode, snap);

    if (isInternalDamageRangePieza(panelCode)) {
      rows.push({
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
      });
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
      rows.push({
        pieza: panelCode,
        severidad: storedSev,
        precioMx: Math.max(0, Math.round(precio)),
        tratamiento: 'REPARAR',
        serviceType: 'REPARACION_PINTURA',
        physicalPanelKey: panelCode,
        billable: precio > 0,
      });
      continue;
    }

    if (tratamiento === 'PENDIENTE') {
      rows.push({
        pieza: panelCode,
        severidad: coerceDamageLevelCode(String(it.severidad ?? '').trim()),
        precioMx: 0,
        tratamiento: 'PENDIENTE',
        serviceType: 'PENDIENTE',
        physicalPanelKey: panelCode,
        billable: false,
        description: `${display} — pendiente de revisión/cotización`,
        descripcionServicio: `${display} — pendiente de revisión/cotización`,
      });
      continue;
    }

    if (tratamiento === 'SUSTITUIR') {
      const rawPart = Number(it.precioMx);
      const hasValidPart = Number.isFinite(rawPart) && rawPart > 0;
      const insufficient =
        it.pricingStatus === 'INSUFFICIENT_MARKET_SAMPLE' ||
        it.priceSource === 'INSUFFICIENT_MARKET_SAMPLE' ||
        !hasValidPart;
      const partPrice = hasValidPart ? Math.round(rawPart) : 0;
      const priceSource =
        it.priceSource ??
        (hasValidPart ? 'WEB_MARKET_ESTIMATE' : 'INSUFFICIENT_MARKET_SAMPLE');
      rows.push({
        pieza: `REFACCION:${panelCode}`,
        severidad: 'N/A',
        precioMx: partPrice,
        detallesRefaccion: it.detallesRefaccion || display,
        tratamiento: 'SUSTITUIR',
        serviceType: 'REFACCION',
        physicalPanelKey: panelCode,
        billable: partPrice > 0 && !insufficient,
        priceSource,
        pricingStatus: insufficient
          ? 'INSUFFICIENT_MARKET_SAMPLE'
          : it.pricingStatus ?? 'OK',
        pricingType: it.pricingType ?? (hasValidPart ? 'RANGE' : 'NONE'),
        precioMinEstimado: it.precioMinEstimado,
        precioMaxEstimado: it.precioMaxEstimado,
        precioCentral: it.precioCentral,
        cantidadMuestras: it.cantidadMuestras,
        cantidadDominios: it.cantidadDominios,
        disclaimer: insufficient
          ? `Refacción de ${display}: sin muestra de mercado suficiente para esta unidad. Se confirma en físico.`
          : undefined,
        description: `Refacción de ${display}`,
        descripcionServicio: `Refacción de ${display}`,
      });
      if (needsMontajePinturaComponent(panelCode)) {
        const catalogPieza =
          resolveCatalogPiezaForMatrixLookup(panelCode) ??
          snap.matchServicio(it.pieza) ??
          it.pieza;
        const montaje = resolveMontajePinturaPrice(
          snap,
          String(catalogPieza),
          vehicleProfile,
          pricingRules,
        );
        rows.push({
          pieza: panelCode,
          severidad: 'MONTAJE_PINTURA',
          precioMx: Math.max(0, Math.round(montaje.precio)),
          tratamiento: 'SUSTITUIR',
          serviceType: 'MONTAJE_PINTURA',
          physicalPanelKey: panelCode,
          billable: montaje.precio > 0,
          priceSource: montaje.priceSource,
          description: `Montar y pintar ${display}`,
          descripcionServicio: `Montar y pintar ${display}`,
        });
      }
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
      rows.push({
        pieza: panelCode,
        severidad: storedSev,
        precioMx: Math.max(0, Math.round(precio)),
        tratamiento,
        serviceType: 'REPARACION_PINTURA',
        physicalPanelKey: panelCode,
        billable: precio > 0,
        description: desc,
        descripcionServicio: desc,
        ...(tratamiento === 'INCIERTO'
          ? { disclaimer: INCIERTO_SUBSTITUTION_DISCLAIMER }
          : {}),
      });
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
