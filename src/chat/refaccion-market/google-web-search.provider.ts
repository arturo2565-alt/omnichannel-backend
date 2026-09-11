import {
  buildRefaccionWebQueries,
  searchRefaccionWebOrganics,
} from '../refaccion-web-search';
import type {
  MarketProviderId,
  RawProviderHit,
  RefaccionPriceProvider,
  VehiclePartIdentity,
} from './refaccion-market.types';

function mapOrganicSource(
  source: 'serper' | 'tavily' | 'openai',
): MarketProviderId {
  if (source === 'tavily') return 'TAVILY';
  if (source === 'openai') return 'OPENAI_WEB';
  return 'GOOGLE_WEB';
}

export class GoogleWebSearchProvider implements RefaccionPriceProvider {
  readonly id = 'GOOGLE_WEB' as const;

  async search(identity: VehiclePartIdentity): Promise<RawProviderHit[]> {
    const queries = buildRefaccionWebQueries({
      pieza: identity.piezaLabel,
      marca: identity.marca,
      modelo: identity.modelo,
      anio: identity.anio,
    });
    const organics = await searchRefaccionWebOrganics(queries);
    const retrievedAt = new Date().toISOString();
    const hits: RawProviderHit[] = [];
    for (const o of organics) {
      const price = o.prices[0];
      if (price == null || price <= 0) continue;
      hits.push({
        provider: mapOrganicSource(o.source),
        title: o.title,
        price,
        url: o.url,
        snippet: o.snippet,
        query: queries[0] ?? identity.piezaLabel,
        retrievedAt,
      });
    }
    return hits;
  }
}
