import type { DraftQuoteLine } from './autofix-config';
import { coerceDamageLevelCode } from './autofix-config';
import type { DetectedDamageItem } from './entities/chat.entity';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import { resolvePiecePriceForVehicleProfile } from '../catalog/vehicle-piece-pricing';
import type { VehiclePricingProfile } from '../catalog/vehicle-pricing-profile';
import {
  findPanelPiezaOption,
  isInternalDamageRangePieza,
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

export type QuoteRowKind = 'internal_damage' | 'refaccion' | 'matrix';

export function classifyQuoteRow(line: QuoteRowInput): QuoteRowKind {
  if (isInternalDamageRangePieza(line.pieza)) return 'internal_damage';
  if (isRefaccionPieza(line.pieza)) return 'refaccion';
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

/**
 * Una fila de cotización por código de panel (FD, FT, PDI…), sin colapsar Fascia.
 * Misma lógica que QuoteCartService.rebuildAndPersist.
 */
export function quoteRowsFromDamageInventory(
  inventory: readonly DetectedDamageItem[],
  snap: MatrixPricingSnapshot,
  vehicleProfile?: VehiclePricingProfile | null,
): QuoteRowInput[] {
  const rows: QuoteRowInput[] = [];
  for (const it of inventory) {
    const panelCode = normalizePanelPiezaCode(it.pieza) || String(it.pieza ?? '').trim();
    if (!panelCode) continue;
    const sev = coerceDamageLevelCode(it.severidad);
    let precio = 0;
    if (!isSpecialPanelPieza(panelCode)) {
      const catalogPieza =
        resolveCatalogPiezaForMatrixLookup(panelCode) ??
        snap.matchServicio(it.pieza) ??
        it.pieza;
      precio = resolvePiecePriceForVehicleProfile(
        snap,
        catalogPieza,
        sev,
        vehicleProfile,
      );
      if (precio <= 0) {
        precio = snap.getAmount(it.pieza, sev);
        if (precio > 0 && vehicleProfile) {
          precio = resolvePiecePriceForVehicleProfile(
            snap,
            snap.matchServicio(it.pieza) ?? it.pieza,
            sev,
            vehicleProfile,
          );
        }
      }
    }
    rows.push({
      pieza: panelCode,
      severidad: sev,
      precioMx: Math.max(0, Math.round(precio)),
    });
  }
  return rows;
}

export function buildDraftQuoteLinesFromDamageInventory(
  inventory: readonly DetectedDamageItem[],
  snap: MatrixPricingSnapshot,
  vehicleProfile?: VehiclePricingProfile | null,
): DraftQuoteLine[] {
  return quoteRowsFromDamageInventory(inventory, snap, vehicleProfile).map(
    (row, idx) => buildDraftQuoteLineFromQuoteRow(row, idx, snap),
  );
}

function isSpecialPanelPiezaForMatrix(pieza: string): boolean {
  return isInternalDamageRangePieza(pieza) || isRefaccionPieza(pieza);
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
