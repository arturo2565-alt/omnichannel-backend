import { buildFlatRowsFromLegacyFrontendMatrix } from './legacy-price-matrix-import';

export type PriceMatrixSeedRow = {
  servicio: string;
  severidad: string;
  precio: number;
  diasEntrega: number;
};

/**
 * Filas para `npm run seed:price-matrix` (misma fuente que el botón “Importar desde archivo JS”).
 * `diasEntrega` por defecto 4 en CLI; el import por API usa 3 salvo que envíes otro valor.
 */
export function buildPriceMatrixSeedRows(
  diasEntregaDefault = 4,
): PriceMatrixSeedRow[] {
  return buildFlatRowsFromLegacyFrontendMatrix(diasEntregaDefault);
}
