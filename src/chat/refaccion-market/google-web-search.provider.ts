import { searchRefaccionWebOrganics } from '../refaccion-web-search';
import { buildMarketSearchQueryPlan } from './market-search-queries';
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
    const plan = buildMarketSearchQueryPlan(identity);
    const organics = await searchRefaccionWebOrganics(plan.googleQueries);
    const retrievedAt = new Date().toISOString();
    const hits: RawProviderHit[] = [];
    for (const o of organics) {
      const price = o.prices[0];
      hits.push({
        provider: mapOrganicSource(o.source),
        title: o.title,
        ...(price != null && price > 0 ? { price } : {}),
        url: o.url,
        snippet: o.snippet,
        query: plan.googleQueries[0] ?? identity.piezaLabel,
        retrievedAt,
      });
    }
    return hits;
  }
}
