/** Severidad dedicada en `price_matrix` para mano de obra de sustituir. */
export const MONTAJE_PINTURA_SEVERIDAD = 'MONTAJE_PINTURA';

/** Alias histórico; también cuenta como tarifa dedicada. */
export const MONTAJE_PINTURA_SEVERIDAD_ALIASES = [
  MONTAJE_PINTURA_SEVERIDAD,
  'MONTAJE',
] as const;

/**
 * Piezas de catálogo que deben tener celda `MONTAJE_PINTURA`
 * (lookup FD→Fascia, PDI→Puerta, etc. ya ocurre antes).
 */
export const MONTAJE_PINTURA_CATALOG_SERVICIOS = [
  'Cofre',
  'Fascia',
  'Puerta',
  'Salpicadera',
  'Salpicadera trasera',
  'Tapa Cajuela',
  'Toldo',
  'Espejo',
  'Estribo',
  'BiCO',
  'Parilla',
  'Poste',
] as const;

export type MontajePinturaBaseRow = {
  servicio: string;
  precio: number;
  diasEntrega: number;
  matrixRowId: string | null;
  hasDedicatedRate: boolean;
};

export function isMontajePinturaSeveridad(severidad: string): boolean {
  const k = String(severidad ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
  return k === 'MONTAJE_PINTURA' || k === 'MONTAJE';
}

export function aggregateMontajePinturaRows(
  rows: ReadonlyArray<{
    id: string;
    servicio: string;
    severidad: string;
    precio: number;
    diasEntrega: number;
  }>,
): MontajePinturaBaseRow[] {
  const byServicio = new Map<
    string,
    { precio: number; diasEntrega: number; id: string; preferDedicated: boolean }
  >();

  for (const row of rows) {
    if (!isMontajePinturaSeveridad(row.severidad)) continue;
    const servicio = String(row.servicio ?? '').trim();
    if (!servicio) continue;
    const preferDedicated =
      String(row.severidad).trim().toUpperCase().replace(/\s+/g, '_') ===
      'MONTAJE_PINTURA';
    const prev = byServicio.get(servicio);
    if (!prev || (preferDedicated && !prev.preferDedicated)) {
      byServicio.set(servicio, {
        precio: Math.max(0, Math.round(Number(row.precio) || 0)),
        diasEntrega: Math.max(0, Math.round(Number(row.diasEntrega) || 0)),
        id: row.id,
        preferDedicated,
      });
    }
  }

  const servicios = new Set<string>([
    ...MONTAJE_PINTURA_CATALOG_SERVICIOS,
    ...byServicio.keys(),
  ]);

  return [...servicios]
    .sort((a, b) => a.localeCompare(b, 'es'))
    .map((servicio) => {
      const hit = byServicio.get(servicio);
      const precio = hit?.precio ?? 0;
      return {
        servicio,
        precio,
        diasEntrega: hit?.diasEntrega ?? 4,
        matrixRowId: hit?.id ?? null,
        hasDedicatedRate: Boolean(hit && precio > 0),
      };
    });
}
