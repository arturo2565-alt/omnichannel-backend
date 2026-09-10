/** Precio al cliente: costo × (1 + margen/100). Nunca NaN. */
export function precioSugeridoAlCliente(
  costoReferenciaBase: unknown,
  margenPorcentaje: unknown = 30,
): number {
  const base = Number(costoReferenciaBase);
  const margen = Number(margenPorcentaje);
  const safeBase = Number.isFinite(base) && base >= 0 ? base : 0;
  const safeMargen = Number.isFinite(margen) ? margen : 30;
  const raw = safeBase * (1 + safeMargen / 100);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.round(raw));
}

/** Redondeo comercial a múltiplos de 50 MXN (fallback de mercado). */
export function redondearRefaccionA50(monto: unknown): number {
  const n = Number(monto);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n / 50) * 50;
}
