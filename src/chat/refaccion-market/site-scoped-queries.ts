import { buildMarketSearchQueryPlan } from './market-search-queries';
import type { VehiclePartIdentity } from './refaccion-market.types';

/** Dominio indexado para recuperar ML cuando la API directa no es viable. */
export const INDEXED_ML_SITE = 'mercadolibre.com.mx';

/**
 * Misma query plan (aliases actuales) + site:. No inventa aliases.
 */
export function buildSiteScopedQueries(
  identity: Pick<
    VehiclePartIdentity,
    'pieza' | 'piezaLabel' | 'marca' | 'modelo' | 'anio'
  >,
  site = INDEXED_ML_SITE,
): string[] {
  const host = String(site ?? '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!host) return [];
  return buildMarketSearchQueryPlan(identity).googleQueries.map(
    (query) => `${query} site:${host}`,
  );
}
