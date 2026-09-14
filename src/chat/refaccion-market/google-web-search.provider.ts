import {
  searchWebOrganicsBackend,
  type WebSearchBackend,
} from '../refaccion-web-search';
import { buildMarketSearchQueryPlan } from './market-search-queries';
import { buildSiteScopedQueries } from './site-scoped-queries';
import {
  emitMarketTrace,
  getMarketSearchIds,
  MARKET_TRACE_EVENTS,
} from './market-search-trace';
import type {
  MarketProviderId,
  RawProviderHit,
  RefaccionPriceProvider,
  VehiclePartIdentity,
} from './refaccion-market.types';

function mapBackendToProvider(backend: WebSearchBackend): MarketProviderId {
  if (backend === 'tavily') return 'TAVILY';
  if (backend === 'openai') return 'OPENAI_WEB';
  return 'GOOGLE_WEB';
}

export class GoogleWebSearchProvider implements RefaccionPriceProvider {
  readonly id: MarketProviderId;
  readonly coverageStageId: string;
  lastError?: string;

  constructor(
    private readonly backend: WebSearchBackend = 'serper',
    private readonly siteDomain?: string,
    id?: MarketProviderId,
  ) {
    this.id = id ?? mapBackendToProvider(backend);
    this.coverageStageId = siteDomain
      ? `${this.id}_SITE_${siteDomain.replace(/\W+/g, '_').toUpperCase()}`
      : this.id;
  }

  isConfigured(): boolean {
    if (this.backend === 'serper') {
      return Boolean(String(process.env.SERPER_API_KEY ?? '').trim());
    }
    if (this.backend === 'tavily') {
      return Boolean(String(process.env.TAVILY_API_KEY ?? '').trim());
    }
    return Boolean(String(process.env.OPENAI_API_KEY ?? '').trim());
  }

  async search(identity: VehiclePartIdentity): Promise<RawProviderHit[]> {
    this.lastError = undefined;
    const plan = buildMarketSearchQueryPlan(identity);
    const queries = this.siteDomain
      ? buildSiteScopedQueries(identity, this.siteDomain)
      : plan.googleQueries;
    const ids = getMarketSearchIds();
    queries.forEach((query, queryIndex) => {
      if (!ids) return;
      emitMarketTrace(MARKET_TRACE_EVENTS.PROVIDER_REQUEST, ids, {
        provider: this.id,
        coverageStageId: this.coverageStageId,
        queryIndex,
        query,
      });
    });
    const t0 = Date.now();
    try {
      const organics = await searchWebOrganicsBackend(this.backend, queries);
      if (ids) {
        emitMarketTrace(MARKET_TRACE_EVENTS.PROVIDER_RESPONSE, ids, {
          provider: this.id,
          coverageStageId: this.coverageStageId,
          queryIndex: 0,
          resultCount: organics.length,
          durationMs: Date.now() - t0,
          success: true,
        });
      }
      const retrievedAt = new Date().toISOString();
      return organics.map((o) => {
        const price = o.prices[0];
        return {
          provider: this.id,
          title: o.title,
          ...(price != null && price > 0 ? { price } : {}),
          url: o.url,
          snippet: o.snippet,
          query: queries[0] ?? identity.piezaLabel,
          retrievedAt,
        };
      });
    } catch (err) {
      this.lastError = err instanceof Error ? err.name : 'Error';
      if (ids) {
        emitMarketTrace(MARKET_TRACE_EVENTS.PROVIDER_RESPONSE, ids, {
          provider: this.id,
          coverageStageId: this.coverageStageId,
          queryIndex: 0,
          resultCount: 0,
          durationMs: Date.now() - t0,
          success: false,
          errorType: this.lastError,
        });
      }
      throw err;
    }
  }
}
