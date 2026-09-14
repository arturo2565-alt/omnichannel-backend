/**
 * Identidad comercial de mercado. No muta DamageItem.
 */
import {
  resolveMarketPieceTaxonomy,
  type MarketPieceTaxonomy,
} from './market-piece-taxonomy';
import { buildMarketSearchQueryPlan } from './market-search-queries';
import type { VehiclePartIdentity } from './refaccion-market.types';
import type { MarketSide } from './market-side';
import type { DiscoveredPartNumber } from './part-number';

export type ResolvedMarketPartIdentity = {
  pieceCode: string;
  family: string;
  side: MarketSide | null;
  position?: string;
  make: string;
  model: string;
  year: string | null;
  variant?: string | null;
  oemPartNumbers: string[];
  aftermarketPartNumbers: string[];
  commercialAliases: string[];
};

export function resolveMarketPartIdentity(
  identity: VehiclePartIdentity,
  discovered: readonly DiscoveredPartNumber[] = [],
): ResolvedMarketPartIdentity {
  const taxonomy = resolveMarketPieceTaxonomy(identity.pieza || identity.piezaLabel);
  const oem = [
    ...new Set(discovered.filter((p) => p.kind === 'OEM').map((p) => p.normalized)),
  ];
  const after = [
    ...new Set(
      discovered.filter((p) => p.kind === 'AFTERMARKET').map((p) => p.normalized),
    ),
  ];
  return {
    pieceCode: taxonomy.pieceCode,
    family: taxonomy.family,
    side: taxonomy.requiredSide,
    make: identity.marca,
    model: identity.modelo,
    year: identity.anio,
    variant: identity.version ?? null,
    oemPartNumbers: oem,
    aftermarketPartNumbers: after,
    commercialAliases: shoppingCommercialAliases(taxonomy),
  };
}

export function shoppingCommercialAliases(taxonomy: MarketPieceTaxonomy): string[] {
  const extra: string[] = [];
  if (taxonomy.family === 'CALAVERA') {
    if (taxonomy.requiredSide === 'RIGHT') extra.push('right tail light');
    else if (taxonomy.requiredSide === 'LEFT') extra.push('left tail light');
    else extra.push('tail light');
  }
  return [...taxonomy.searchAliases.slice(0, 3), ...extra];
}

/** Queries Shopping de discovery. No cambia el query plan genérico. */
export function buildShoppingDiscoveryQueries(
  identity: VehiclePartIdentity,
): string[] {
  const taxonomy = resolveMarketPieceTaxonomy(identity.pieza || identity.piezaLabel);
  const plan = buildMarketSearchQueryPlan(identity);
  const vehicle = [identity.marca, identity.modelo, identity.anio]
    .filter(Boolean)
    .join(' ');
  const extras = shoppingCommercialAliases(taxonomy)
    .filter((a) => /tail light/i.test(a))
    .map((alias) => [alias, vehicle].filter(Boolean).join(' ').trim());
  return [...plan.googleQueries, ...extras].filter(
    (q, i, all) => q && all.indexOf(q) === i,
  ).slice(0, 3);
}
