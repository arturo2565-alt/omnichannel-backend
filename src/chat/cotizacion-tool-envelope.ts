export type CotizacionDesgloseLine = {
  pieza: string;
  severidad: string;
  precioMx: number;
};

export type CotizacionToolEnvelope = {
  success: boolean;
  desglose: CotizacionDesgloseLine[];
  totalGlobal: number;
  instruccionParaModelo: string;
  error?: string;
  draftQuoteId?: string;
};

export const COTIZACION_INSTRUCCION_PARA_MODELO =
  'Usa exactamente desglose y totalGlobal para redactar al cliente. NO calcules ni sumes precios tú mismo.';

export function buildCotizacionToolEnvelope(
  opts: {
    success: boolean;
    desglose: CotizacionDesgloseLine[];
    totalGlobal: number;
    draftQuoteId?: string;
    error?: string;
  },
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const envelope: CotizacionToolEnvelope = {
    success: opts.success,
    desglose: opts.desglose,
    totalGlobal: Math.max(0, Math.round(opts.totalGlobal)),
    instruccionParaModelo: COTIZACION_INSTRUCCION_PARA_MODELO,
    ...(opts.error ? { error: opts.error } : {}),
    ...(opts.draftQuoteId ? { draftQuoteId: opts.draftQuoteId } : {}),
  };
  return { ...envelope, ...(extra ?? {}) };
}

export function desgloseFromDraftQuoteItems(
  items: ReadonlyArray<{
    pieza: string;
    severidad: string;
    precioMx: number;
  }>,
): CotizacionDesgloseLine[] {
  return items.map((it) => ({
    pieza: String(it.pieza ?? '').trim() || 'Servicio',
    severidad: String(it.severidad ?? '').trim() || 'DL',
    precioMx: Math.max(0, Math.round(Number(it.precioMx) || 0)),
  }));
}
