import type { DraftQuoteLine } from './autofix-config';
import { coerceDamageLevelCode } from './autofix-config';
import type { DetectedDamageItem } from './entities/chat.entity';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import { resolvePiecePriceForVehicleProfile } from '../catalog/vehicle-piece-pricing';
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
  normalizePanelPiezaCode,
  resolveCatalogPiezaForMatrixLookup,
  resolveMatrixServicioRaw,
} from '../catalog/panel-pieza-catalog';

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

export type QuoteRowKind = 'internal_damage' | 'refaccion' | 'matrix' | 'integral';

export function classifyQuoteRow(line: QuoteRowInput): QuoteRowKind {
  if (isInternalDamageRangePieza(line.pieza)) return 'internal_damage';
  if (isRefaccionPieza(line.pieza)) return 'refaccion';
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

/** Subtotal facturable: mínimo en daños internos; precio manual en refacciones. */
export function quoteRowSubtotalForTotal(line: QuoteRowInput): number {
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

export function buildDraftQuoteLineFromQuoteRow(
  line: QuoteRowInput,
  idx: number,
  snap: MatrixPricingSnapshot,
): DraftQuoteLine {
  const u = Math.round(Number(line.precioMx) || 0);
  const kind = classifyQuoteRow(line);

  if (kind === 'refaccion') {
    const label = refaccionLabelFromRow(line);
    return {
      priceItemId: `panel:${idx}:refaccion`,
      description: `Refacción (${label}) — panel`,
      quantity: 1,
      unitPrice: u,
      subtotal: u,
    };
  }

  if (kind === 'internal_damage') {
    const maxU = Math.round(resolveQuoteRowPrecioMaximo(line) ?? u);
    return {
      priceItemId: `panel:${idx}:internal-damage`,
      description: `Posibles daños internos — $${u.toLocaleString('es-MX')} - $${maxU.toLocaleString('es-MX')} MXN (sujeto a desarme)`,
      quantity: 1,
      unitPrice: u,
      subtotal: u,
    };
  }

  if (kind === 'integral') {
    const displayName =
      findPanelPiezaOption(String(line.pieza).trim())?.fullName ??
      String(line.pieza).trim();
    const tierLabel = String(line.severidad ?? '').trim() || 'Mediano';
    return {
      priceItemId: `panel:${idx}:integral:${displayName}`,
      description: `${displayName} — ${tierLabel} (panel)`,
      quantity: 1,
      unitPrice: u,
      subtotal: u,
    };
  }

  const matrixRaw = resolveMatrixServicioRaw(String(line.pieza).trim());
  const canonical = snap.matchServicio(matrixRaw) ?? matrixRaw;
  const lev = coerceDamageLevelCode(String(line.severidad));
  const displayName =
    findPanelPiezaOption(String(line.pieza).trim())?.fullName ?? canonical;
  return {
    priceItemId: `panel:${idx}:${canonical}:${lev}`,
    description: `${displayName} — nivel ${lev} (panel)`,
    quantity: 1,
    unitPrice: u,
    subtotal: u,
  };
}

/** Perfil vehicular para cotizar servicios integrales desde severidad guardada en inventario. */
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

/**
 * Una fila de cotización por código de panel (FD, FT, PDI…), sin colapsar Fascia.
 * Misma lógica que QuoteCartService.rebuildAndPersist.
 */
export function quoteRowsFromDamageInventory(
  inventory: readonly DetectedDamageItem[],
  snap: MatrixPricingSnapshot,
  vehicleProfile?: VehiclePricingProfile | null,
  pricingRules?: CatalogPricingRules | null,
): QuoteRowInput[] {
  const rows: QuoteRowInput[] = [];
  for (const it of inventory) {
    const panelCode = normalizePanelPiezaCode(it.pieza) || String(it.pieza ?? '').trim();
    if (!panelCode) continue;
    const sevRaw = String(it.severidad ?? '').trim();
    let storedSev = sevRaw || 'DM';
    let precio = 0;

    if (isIntegralPanelPieza(panelCode)) {
      storedSev = sevRaw || vehicleProfile?.sizeTier || 'Mediano';
      const opt = findPanelPiezaOption(panelCode);
      const catalogPieza =
        opt?.catalogPieza ??
        snap.matchServicio(it.pieza) ??
        it.pieza;
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
      precio = resolution?.unitPrice ?? 0;
    } else if (!isSpecialPanelPieza(panelCode)) {
      const sev = coerceDamageLevelCode(sevRaw);
      storedSev = sev;
      const catalogPieza =
        resolveCatalogPiezaForMatrixLookup(panelCode) ??
        snap.matchServicio(it.pieza) ??
        it.pieza;
      precio = resolvePiecePriceForVehicleProfile(
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
    } else {
      storedSev = coerceDamageLevelCode(sevRaw);
    }
    rows.push({
      pieza: panelCode,
      severidad: storedSev,
      precioMx: Math.max(0, Math.round(precio)),
    });
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
