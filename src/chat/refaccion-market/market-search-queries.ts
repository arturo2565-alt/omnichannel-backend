import { resolveMarketPieceTaxonomy } from './market-piece-taxonomy';
import type { VehiclePartIdentity } from './refaccion-market.types';

export type MarketSearchQueryPlan = {
  queries: string[];
  googleQueries: string[];
  mlQueries: string[];
};

function yearBand(anio: string | null | undefined): string {
  const year = String(anio ?? '').replace(/\D/g, '').slice(0, 4);
  const n = Number(year);
  if (!Number.isFinite(n) || n < 1990) return year;
  return `${n - 1} ${year} ${n + 1}`;
}

function joinQuery(parts: Array<string | null | undefined>): string {
  return parts
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Conjunto pequeño y controlado. Máximo 4 queries lógicas.
 * Google usa 2; Mercado Libre usa 1–2.
 */
export function buildMarketSearchQueryPlan(
  identity: Pick<VehiclePartIdentity, 'pieza' | 'piezaLabel' | 'marca' | 'modelo' | 'anio'>,
): MarketSearchQueryPlan {
  const taxonomy = resolveMarketPieceTaxonomy(identity.pieza || identity.piezaLabel);
  const vehicle = [identity.marca, identity.modelo].filter(Boolean).join(' ').trim();
  const anio = String(identity.anio ?? '').replace(/\D/g, '').slice(0, 4);
  const aliases = taxonomy.searchAliases.slice(0, 3);
  const primary = aliases[0] || taxonomy.canonicalLabel || identity.piezaLabel;
  const secondary = aliases[1] || primary;
  const commercial = aliases[2] || secondary;
  const queries = [
    joinQuery([primary, vehicle, anio]),
    joinQuery([secondary, vehicle, anio]),
    joinQuery([commercial, vehicle, anio]),
    joinQuery([secondary, vehicle, yearBand(anio)]),
  ].filter((q, i, all) => q && all.indexOf(q) === i);
  const googleQueries = [queries[0], queries[2] || queries[1] || queries[0]].filter(
    (q, i, all) => q && all.indexOf(q) === i,
  );
  const mlQueries = [
    joinQuery([secondary === primary ? primary : secondary, vehicle, anio, 'nuevo']),
    joinQuery([commercial, vehicle, anio, 'nuevo']),
  ].filter((q, i, all) => q && all.indexOf(q) === i);
  return {
    queries: queries.slice(0, 4),
    googleQueries: googleQueries.slice(0, 2),
    mlQueries: mlQueries.slice(0, 2),
  };
}

export function buildMarketSearchQueries(
  identity: Pick<VehiclePartIdentity, 'pieza' | 'piezaLabel' | 'marca' | 'modelo' | 'anio'>,
): string[] {
  return buildMarketSearchQueryPlan(identity).queries;
}
