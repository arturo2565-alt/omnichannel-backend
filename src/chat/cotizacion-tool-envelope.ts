/**
 * Formato obligatorio de respuesta de herramientas de cotización al LLM.
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

/** Convierte líneas express (servicio + precioLineaMx) al desglose estándar. */
export function desgloseFromExpressLines(
  lines: ReadonlyArray<{
    servicio?: string;
    canonical?: string;
    precioLineaMx?: number;
    precioUnitarioMx?: number;
  }>,
  extras?: ReadonlyArray<{ label: string; amount: number }>,
): CotizacionDesgloseLine[] {
  const out: CotizacionDesgloseLine[] = [];
  for (const l of lines) {
    const pieza = String(l.servicio ?? l.canonical ?? '').trim();
    if (!pieza) continue;
    const precio = Math.round(
      Number(l.precioLineaMx ?? l.precioUnitarioMx ?? 0),
    );
    if (precio <= 0) continue;
    out.push({ pieza, precio });
  }
  for (const ex of extras ?? []) {
    const pieza = String(ex.label ?? '').trim();
    if (!pieza) continue;
    const precio = Math.round(Number(ex.amount) || 0);
    if (precio <= 0) continue;
    out.push({ pieza, precio });
  }
  return out;
}
