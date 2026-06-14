import {
  buildCotizacionToolEnvelope,
  COTIZACION_INSTRUCCION_PARA_MODELO,
  type CotizacionDesgloseLine,
} from './cotizacion-tool-envelope';
import type { QuoteSendSnapshot } from './autofix-config';
import type { DraftQuoteEntity } from './entities/draft-quote.entity';
import type { QuoteCartEstado } from './quote-cart.types';
import { findPanelPiezaOption, isInternalDamageRangePieza } from '../catalog/panel-pieza-catalog';
import {
  enrichDesgloseWithInternalRanges,
  resolvePrecioMaximoFromDraftLines,
} from './quote-cart-send-price-preservation';

type CartRow = Pick<
  DraftQuoteEntity,
  'id' | 'estimateAmount' | 'damageAnalysis' | 'items' | 'quotePayload'
>;

type DesgloseCartSource = {
  items?: DraftQuoteEntity['items'];
  quotePayload?: DraftQuoteEntity['quotePayload'] | null;
};

export function desgloseFromCartEntity(
  row: DesgloseCartSource,
): CotizacionDesgloseLine[] {
  const labelForPieza = (code: string) =>
    findPanelPiezaOption(code)?.fullName ?? code;

  const draftLines = row.quotePayload?.lines ?? [];
  const fallbackInternalMax = resolvePrecioMaximoFromDraftLines(draftLines);

  if (row.items?.length) {
    const base = row.items.map((it) => {
      const label = labelForPieza(it.pieza);
      const precioMx = Math.max(0, Math.round(Number(it.precioMx) || 0));
      const line: CotizacionDesgloseLine = {
        pieza: label,
        severidad: String(it.severidad ?? '').trim() || 'DL',
        precioMx,
      };
      if (
        isInternalDamageRangePieza(it.pieza) &&
        fallbackInternalMax != null &&
        fallbackInternalMax > precioMx
      ) {
        line.precioMaximo = fallbackInternalMax;
      }
      return line;
    });
    return enrichDesgloseWithInternalRanges(base, draftLines);
  }
  const base = (draftLines ?? []).map((line) => ({
    pieza: String(line.description ?? '').split('—')[0]?.trim() || 'Servicio',
    severidad: 'DL',
    precioMx: Math.round(Number(line.subtotal ?? line.unitPrice) || 0),
  }));
  return enrichDesgloseWithInternalRanges(base, draftLines);
}

function desgloseSignature(lines: readonly CotizacionDesgloseLine[]): string {
  return [...lines]
    .map(
      (l) =>
        `${String(l.pieza).trim().toLowerCase()}|${String(l.severidad).trim()}|${Math.round(Number(l.precioMx) || 0)}`,
    )
    .sort()
    .join(';');
}

export function cartDiffersFromSendSnapshot(
  cart: DesgloseCartSource & { estimateAmount: number },
  snapshot: QuoteSendSnapshot | undefined,
): boolean {
  if (!snapshot) return false;
  const current = desgloseFromCartEntity(cart);
  const currentTotal = Math.max(0, Math.round(Number(cart.estimateAmount) || 0));
  const snapTotal = Math.max(0, Math.round(Number(snapshot.total) || 0));
  if (currentTotal !== snapTotal) return true;
  return desgloseSignature(current) !== desgloseSignature(snapshot.desglose ?? []);
}

/** Vista del carrito activo (siempre editable; envío = snapshot, no congelación). */
export function buildActiveCartViewFromEntity(
  cart: CartRow | null,
): Record<string, unknown> {
  const desglose = cart ? desgloseFromCartEntity(cart) : [];
  const totalGlobal = cart
    ? Math.max(0, Math.round(Number(cart.estimateAmount) || 0))
    : 0;
  const lastSendSnapshot = cart?.quotePayload?.lastSendSnapshot;
  const sendCount = Math.max(0, Number(cart?.quotePayload?.sendCount) || 0);
  const hayCambiosDesdeUltimoEnvio = Boolean(
    cart && lastSendSnapshot && cartDiffersFromSendSnapshot(cart, lastSendSnapshot),
  );

  let estadoCarrito: QuoteCartEstado = 'vacio';
  if (cart && desglose.length > 0) {
    estadoCarrito = hayCambiosDesdeUltimoEnvio ? 'activo_modificado' : 'activo';
  }

  const instruccionBase =
    estadoCarrito === 'activo_modificado'
      ? `${COTIZACION_INSTRUCCION_PARA_MODELO} El carrito cambió desde el último envío al cliente; usa desglose y totalGlobal actuales. Los precios de piezas ya enviadas se conservaron; solo cambió lo nuevo o lo que el cliente pidió quitar. Si hay precioMaximo en daños internos, redacta el rango.`
      : sendCount > 0
        ? `${COTIZACION_INSTRUCCION_PARA_MODELO} La cotización ya se envió al cliente; el carrito sigue editable. Si pide cambios, usa quitarDelCarrito o agregarAlCarrito y responde con el total actualizado.`
        : COTIZACION_INSTRUCCION_PARA_MODELO;

  return buildCotizacionToolEnvelope(
    {
      success: true,
      desglose,
      totalGlobal,
      draftQuoteId: cart?.id,
    },
    {
      estadoCarrito,
      lastSendSnapshot: lastSendSnapshot ?? null,
      sendCount,
      hayCambiosDesdeUltimoEnvio,
      /** Compat: ya no hay carrito aprobado separado. */
      desgloseAprobado: [],
      desgloseComplemento: [],
      desglosePendiente: desglose,
      totalAprobado: 0,
      totalComplemento: 0,
      totalPendiente: totalGlobal,
      pendingDraftQuoteId: cart?.id ?? null,
      cantidadLineas: desglose.length,
      instruccionParaModelo: instruccionBase,
    },
  );
}

/**
 * @deprecated Usar buildActiveCartViewFromEntity. Mantenido para tests legacy.
 */
export function buildAggregatedCartViewFromEntities(
  pending: CartRow | null,
  approved: readonly CartRow[],
): Record<string, unknown> {
  if (pending) {
    return buildActiveCartViewFromEntity(pending);
  }
  if (approved.length > 0) {
    return buildActiveCartViewFromEntity(approved[approved.length - 1]!);
  }
  return buildActiveCartViewFromEntity(null);
}
