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
  PANEL_PIEZA_REFACCION_CODE,
  canonicalizePanelCode,
  findPanelPiezaOption,
  isInternalDamageRangePieza,
  isIntegralPanelPieza,
  isRefaccionPieza,
  isSpecialPanelPieza,
  normalizePanelPiezaCode,
  resolveCatalogPiezaForMatrixLookup,
  resolveMatrixServicioRaw,
} from '../catalog/panel-pieza-catalog';
import { resolvePiezaDisplayLabel } from './draft-quote-resume';
import { refaccionFallbackPrecioAlCliente } from './refaccion-mercado';

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
  /** Texto de línea al cliente (p. ej. montaje en cabina). */
  descripcionServicio?: string;
}

const LARGE_REPLACEABLE_PANEL_CODES = new Set([
  'Cofre',
  'FD',
  'FT',
  'Tapa Cajuela',
]);

export const PRELIMINARY_REPLACEMENT_DISCLAIMER =
  'Total Preliminar. Sujeto a desmontaje y revisión de marco frontal y bases de faros.';

export function isLargeReplaceablePanel(pieza: string): boolean {
  const code = canonicalizePanelCode(pieza);
  if (LARGE_REPLACEABLE_PANEL_CODES.has(code)) return true;
  const n = String(pieza ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return /\b(cofre|fascia|porton|tapa\s+de\s+cajuela|tapa\s+cajuela)\b/.test(n);
}

export function needsLargePanelReplacementSplit(
  item: Pick<DetectedDamageItem, 'pieza' | 'severidad' | 'posibleReemplazoRefaccion'>,
): boolean {
  if (!isLargeReplaceablePanel(item.pieza)) return false;
  if (item.posibleReemplazoRefaccion === true) return true;
  return coerceDamageLevelCode(String(item.severidad ?? '')) === 'DMFuerte';
}

export function cabinInstallServiceLabel(pieza: string): string {
  const label = resolvePiezaDisplayLabel(pieza);
  return `Montar, preparar y pintar ${label}`;
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
    const custom = String(line.descripcionServicio ?? '').trim();
    return {
      priceItemId: `panel:${idx}:refaccion`,
      description: custom || `Refacción estimada (${label}) — mercado +30%`,
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
  const custom = String(line.descripcionServicio ?? '').trim();
  return {
    priceItemId: `panel:${idx}:${canonical}:${lev}`,
    description: custom || `${displayName} — nivel ${lev} (panel)`,
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
  const refaccionBySource = new Set(
    inventory
      .filter((it) => isRefaccionPieza(it.pieza))
      .map((it) =>
        String(it.refaccionDePieza ?? it.pieza.replace(/^REFACCION\s*:\s*/i, ''))
          .trim(),
      )
      .filter(Boolean)
      .map((c) => canonicalizePanelCode(c) || c),
  );

  const pricePiece = (
    pieza: string,
    sev: string,
  ): number => {
    const catalogPieza =
      resolveCatalogPiezaForMatrixLookup(pieza) ??
      snap.matchServicio(pieza) ??
      pieza;
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
        snap.matchServicio(pieza) ?? pieza,
        sev,
        vehicleProfile,
        pricingRules,
      );
    }
    return Math.max(0, Math.round(precio));
  };

  for (const it of inventory) {
    const panelCode = normalizePanelPiezaCode(it.pieza) || String(it.pieza ?? '').trim();
    if (!panelCode) continue;
    const sevRaw = String(it.severidad ?? '').trim();
    let storedSev = sevRaw || 'DM';
    let precio = 0;
    const canon = canonicalizePanelCode(panelCode) || panelCode;
    const hasRefaccionSibling = refaccionBySource.has(canon);
    const splitReplacement = needsLargePanelReplacementSplit(it);

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
      rows.push({
        pieza: panelCode,
        severidad: storedSev,
        precioMx: Math.max(0, Math.round(precio)),
      });
      continue;
    }

    if (isRefaccionPieza(it.pieza) || isRefaccionPieza(panelCode)) {
      rows.push({
        pieza: String(it.pieza ?? '').trim() || panelCode,
        severidad: 'N/A',
        precioMx: Math.max(0, Math.round(Number(it.precioMx) || 0)),
        ...(it.detallesRefaccion
          ? { detallesRefaccion: it.detallesRefaccion }
          : {}),
      });
      continue;
    }

    if (isSpecialPanelPieza(panelCode)) {
      rows.push({
        pieza: panelCode,
        severidad: coerceDamageLevelCode(sevRaw),
        precioMx: 0,
      });
      continue;
    }

    if (splitReplacement) {
      const cabinPrice = pricePiece(panelCode, 'DL');
      rows.push({
        pieza: panelCode,
        severidad: 'DL',
        precioMx: cabinPrice,
        descripcionServicio: cabinInstallServiceLabel(panelCode),
      });
      if (!hasRefaccionSibling) {
        const refPrecio =
          Math.max(0, Math.round(Number(it.precioMx) || 0)) ||
          refaccionFallbackPrecioAlCliente(panelCode);
        rows.push({
          pieza: `${PANEL_PIEZA_REFACCION_CODE}:${canon}`,
          severidad: 'N/A',
          precioMx: refPrecio,
          detallesRefaccion: resolvePiezaDisplayLabel(panelCode),
          descripcionServicio: `Refacción estimada (${resolvePiezaDisplayLabel(panelCode)}) — mercado +30%`,
        });
      }
      continue;
    }

    if (hasRefaccionSibling) {
      continue;
    }

    const sev = coerceDamageLevelCode(sevRaw);
    storedSev = sev;
    precio = pricePiece(panelCode, sev);
    rows.push({
      pieza: panelCode,
      severidad: storedSev,
      precioMx: Math.max(0, Math.round(precio)),
      ...(it.detallesRefaccion
        ? { detallesRefaccion: it.detallesRefaccion }
        : {}),
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
