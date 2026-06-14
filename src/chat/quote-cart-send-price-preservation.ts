import type { QuoteSendSnapshot } from './autofix-config';
import type { DraftQuoteLine } from './autofix-config';
import type { CotizacionDesgloseLine } from './cotizacion-tool-envelope';
import type { DetectedDamageItem } from './entities/chat.entity';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import type { CatalogPricingRules } from '../catalog/catalog-pricing-rules';
import type { VehiclePricingProfile } from '../catalog/vehicle-pricing-profile';
import {
  findPanelPiezaOption,
  isInternalDamageRangePieza,
  normalizePanelPiezaCode,
} from '../catalog/panel-pieza-catalog';
import { piezaMatchesQuery } from './quote-cart-analysis';
import {
  quoteRowsFromDamageInventory,
  type QuoteRowInput,
} from './draft-quote-inventory-pricing';

export type SentPriceLine = {
  precioMx: number;
  severidad: string;
  precioMaximo?: number;
};

/** Parsea rango "$1,500 - $3,000" en descripciones de daños internos. */
export function parseInternalDamageRangeFromText(
  text: string,
): { min: number; max: number } | null {
  const m = String(text ?? '').match(/\$([\d,]+)\s*-\s*\$([\d,]+)/);
  if (!m) return null;
  const min = Math.round(Number(String(m[1]).replace(/,/g, '')) || 0);
  const max = Math.round(Number(String(m[2]).replace(/,/g, '')) || 0);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return null;
  return { min, max };
}

function isInternalDamageDraftLine(line: DraftQuoteLine): boolean {
  const id = String(line.priceItemId ?? '');
  if (id.includes('internal-damage')) return true;
  return /posibles\s+da[nñ]os\s+internos/i.test(String(line.description ?? ''));
}

/** Recupera precioMaximo desde líneas persistidas del borrador. */
export function resolvePrecioMaximoFromDraftLines(
  draftLines: readonly DraftQuoteLine[] | undefined | null,
): number | undefined {
  if (!draftLines?.length) return undefined;
  for (const line of draftLines) {
    if (!isInternalDamageDraftLine(line)) continue;
    const parsed = parseInternalDamageRangeFromText(line.description);
    if (parsed) return parsed.max;
    const unit = Math.round(Number(line.unitPrice) || 0);
    if (unit > 0) return unit;
  }
  return undefined;
}

export function findSentPriceForInventoryPieza(
  pieza: string,
  sentDesglose: readonly CotizacionDesgloseLine[],
): SentPriceLine | null {
  for (const sent of sentDesglose) {
    if (!piezaMatchesQuery(pieza, sent.pieza)) continue;
    return {
      precioMx: Math.max(0, Math.round(Number(sent.precioMx) || 0)),
      severidad: String(sent.severidad ?? '').trim() || 'DL',
      ...(sent.precioMaximo != null &&
      Number(sent.precioMaximo) > Number(sent.precioMx)
        ? {
            precioMaximo: Math.max(
              0,
              Math.round(Number(sent.precioMaximo) || 0),
            ),
          }
        : {}),
    };
  }
  return null;
}

export function enrichDesgloseWithInternalRanges(
  desglose: CotizacionDesgloseLine[],
  draftLines: readonly DraftQuoteLine[] | undefined | null,
): CotizacionDesgloseLine[] {
  const fallbackMax = resolvePrecioMaximoFromDraftLines(draftLines);
  return desglose.map((line) => {
    const isInternal =
      isInternalDamageRangePieza(line.pieza) ||
      /posibles\s+da[nñ]os\s+internos/i.test(String(line.pieza ?? ''));
    if (!isInternal) return line;
    const max =
      line.precioMaximo != null
        ? Math.round(Number(line.precioMaximo) || 0)
        : fallbackMax;
    if (max != null && max > line.precioMx) {
      return { ...line, precioMaximo: max };
    }
    return line;
  });
}

export type RebuildPriceOpts = {
  /** Piezas que deben recalcularse con matriz (nuevas o editadas). */
  matrixPricePiezaCodes?: readonly string[];
};

function piezaCodeSet(codes: readonly string[] | undefined): Set<string> {
  const set = new Set<string>();
  for (const raw of codes ?? []) {
    const code = normalizePanelPiezaCode(raw) || String(raw ?? '').trim();
    if (code) set.add(code);
  }
  return set;
}

function shouldMatrixPricePieza(
  pieza: string,
  sentDesglose: readonly CotizacionDesgloseLine[],
  matrixOnly: Set<string>,
): boolean {
  const code = normalizePanelPiezaCode(pieza) || String(pieza ?? '').trim();
  if (code && matrixOnly.has(code)) return true;
  return findSentPriceForInventoryPieza(pieza, sentDesglose) == null;
}

function matrixQuoteRowForItem(
  item: DetectedDamageItem,
  snap: MatrixPricingSnapshot,
  vehicleProfile?: VehiclePricingProfile | null,
  pricingRules?: CatalogPricingRules | null,
): QuoteRowInput {
  const [row] = quoteRowsFromDamageInventory(
    [item],
    snap,
    vehicleProfile,
    pricingRules,
  );
  const panelCode =
    normalizePanelPiezaCode(item.pieza) || String(item.pieza ?? '').trim();
  return (
    row ?? {
      pieza: panelCode,
      severidad: String(item.severidad ?? '').trim() || 'DL',
      precioMx: 0,
    }
  );
}

/**
 * Tras un envío al cliente: conserva precios del snapshot en piezas ya cotizadas;
 * solo recalcula con matriz las piezas nuevas o explícitamente marcadas.
 */
export function quoteRowsPreservingLastSend(
  inventory: readonly DetectedDamageItem[],
  snap: MatrixPricingSnapshot,
  vehicleProfile: VehiclePricingProfile | null | undefined,
  pricingRules: CatalogPricingRules | null | undefined,
  sentSnapshot: QuoteSendSnapshot,
  draftLines: readonly DraftQuoteLine[] | undefined | null,
  opts?: RebuildPriceOpts,
): QuoteRowInput[] {
  const sentDesglose = enrichDesgloseWithInternalRanges(
    sentSnapshot.desglose ?? [],
    draftLines,
  );
  const matrixOnly = piezaCodeSet(opts?.matrixPricePiezaCodes);
  const rows: QuoteRowInput[] = [];

  for (const it of inventory) {
    const panelCode =
      normalizePanelPiezaCode(it.pieza) || String(it.pieza ?? '').trim();
    if (!panelCode) continue;

    if (shouldMatrixPricePieza(it.pieza, sentDesglose, matrixOnly)) {
      rows.push(
        matrixQuoteRowForItem(it, snap, vehicleProfile, pricingRules),
      );
      continue;
    }

    const sent = findSentPriceForInventoryPieza(it.pieza, sentDesglose);
    if (!sent) {
      rows.push(
        matrixQuoteRowForItem(it, snap, vehicleProfile, pricingRules),
      );
      continue;
    }

    const row: QuoteRowInput = {
      pieza: panelCode,
      severidad: sent.severidad,
      precioMx: sent.precioMx,
    };
    if (
      isInternalDamageRangePieza(panelCode) ||
      isInternalDamageRangePieza(it.pieza)
    ) {
      const max =
        sent.precioMaximo ??
        resolvePrecioMaximoFromDraftLines(draftLines) ??
        sent.precioMx;
      if (max > sent.precioMx) {
        row.precioMaximo = max;
      }
    }
    rows.push(row);
  }

  return rows;
}

/** Etiqueta legible para desglose de herramientas (FD → Fascia delantera). */
export function displayPiezaForDesglose(piezaCode: string): string {
  return findPanelPiezaOption(piezaCode)?.fullName ?? piezaCode;
}
