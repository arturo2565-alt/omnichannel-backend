/**
 * Formato de respuesta de tools de cotización al LLM.
 * El modelo NO debe sumar precios: usa siempre totalGlobal del backend.
 */

export type CotizacionDesgloseLine = {
  pieza: string;
  precio: number;
};

export const COTIZACION_LLM_NO_CALCULAR_TOTAL =
  'PROHIBIDO calcular o sumar precios por tu cuenta. Usa EXACTAMENTE desglose y totalGlobal de esta respuesta.';

export function sumDesglosePrecios(
  desglose: readonly CotizacionDesgloseLine[],
): number {
  return desglose.reduce(
    (acc, line) => acc + Math.max(0, Math.round(Number(line.precio) || 0)),
    0,
  );
}

export function buildCotizacionToolEnvelope(
  desglose: readonly CotizacionDesgloseLine[],
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = desglose.map((l) => ({
    pieza: String(l.pieza ?? '').trim() || 'Servicio',
    precio: Math.max(0, Math.round(Number(l.precio) || 0)),
  }));
  const totalGlobal = sumDesglosePrecios(normalized);
  return {
    ...(extra ?? {}),
    desglose: normalized,
    totalGlobal,
    moneda: 'MXN',
    instruccionParaModelo: COTIZACION_LLM_NO_CALCULAR_TOTAL,
  };
}
