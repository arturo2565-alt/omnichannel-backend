import {
  buildCotizacionToolEnvelope,
  COTIZACION_INSTRUCCION_PARA_MODELO,
  type CotizacionDesgloseLine,
} from './cotizacion-tool-envelope';
import type { DraftQuoteEntity } from './entities/draft-quote.entity';
import type { QuoteCartEstado } from './quote-cart.types';
import { findPanelPiezaOption } from '../catalog/panel-pieza-catalog';

type CartRow = Pick<
  DraftQuoteEntity,
  'id' | 'estimateAmount' | 'damageAnalysis' | 'items' | 'quotePayload'
>;

function desgloseFromEntity(row: Pick<DraftQuoteEntity, 'items' | 'quotePayload'>): CotizacionDesgloseLine[] {
  const labelForPieza = (code: string) =>
    findPanelPiezaOption(code)?.fullName ?? code;

  if (row.items?.length) {
    return row.items.map((it) => ({
      pieza: labelForPieza(it.pieza),
      severidad: String(it.severidad ?? '').trim() || 'DL',
      precioMx: Math.max(0, Math.round(Number(it.precioMx) || 0)),
    }));
  }
  return (row.quotePayload?.lines ?? []).map((line) => ({
    pieza: String(line.description ?? '').split('—')[0]?.trim() || 'Servicio',
    severidad: 'DL',
    precioMx: Math.round(Number(line.subtotal ?? line.unitPrice) || 0),
  }));
}

/** Vista agregada aprobado + complemento/pendiente. */
export function buildAggregatedCartViewFromEntities(
  pending: CartRow | null,
  approved: readonly CartRow[],
): Record<string, unknown> {
  const desgloseAprobado = approved.flatMap((r) => desgloseFromEntity(r));
  const isComplement =
    pending?.damageAnalysis?.quoteCartMeta?.cartRole === 'complement';
  const desglosePendiente = pending ? desgloseFromEntity(pending) : [];

  const totalAprobado = approved.reduce(
    (acc, r) => acc + Math.max(0, Math.round(Number(r.estimateAmount) || 0)),
    0,
  );
  const totalPendiente = pending
    ? Math.max(0, Math.round(Number(pending.estimateAmount) || 0))
    : 0;

  let estadoCarrito: QuoteCartEstado = 'vacio';
  if (pending && isComplement) estadoCarrito = 'complemento_pendiente';
  else if (pending) estadoCarrito = 'pendiente_aprobacion';
  else if (approved.length > 0) estadoCarrito = 'aprobado';

  const desglose = [...desgloseAprobado, ...desglosePendiente];

  return buildCotizacionToolEnvelope(
    {
      success: true,
      desglose,
      totalGlobal: totalAprobado + totalPendiente,
      draftQuoteId: pending?.id ?? approved.at(-1)?.id,
    },
    {
      estadoCarrito,
      desgloseAprobado,
      desgloseComplemento: isComplement ? desglosePendiente : [],
      desglosePendiente: !isComplement ? desglosePendiente : [],
      totalAprobado,
      totalComplemento: isComplement ? totalPendiente : 0,
      totalPendiente,
      pendingDraftQuoteId: pending?.id ?? null,
      cantidadLineas: desglose.length,
      instruccionParaModelo:
        estadoCarrito === 'complemento_pendiente'
          ? `${COTIZACION_INSTRUCCION_PARA_MODELO} Presenta por separado lo ya aprobado (desgloseAprobado) y el complemento nuevo (desgloseComplemento); usa totalGlobal como gran total.`
          : COTIZACION_INSTRUCCION_PARA_MODELO,
    },
  );
}
