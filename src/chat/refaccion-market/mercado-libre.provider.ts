import { buildMarketSearchQueryPlan } from './market-search-queries';
import {
  emitMarketTrace,
  getMarketSearchIds,
  MARKET_TRACE_EVENTS,
} from './market-search-trace';
import type {
  RawProviderHit,
  RefaccionPriceProvider,
  SampleCondition,
  VehiclePartIdentity,
} from './refaccion-market.types';

function mlSearchDisabled(): boolean {
  return process.env.NODE_ENV === 'test' && process.env.REFACCION_ML_SEARCH !== '1';
}

function mapCondition(raw: unknown): SampleCondition {
  const c = String(raw ?? '').toLowerCase();
  if (c === 'new' || c === 'nuevo') return 'NEW';
  if (c === 'used' || c === 'usado') return 'USED';
  return 'UNKNOWN';
}

function mlAccessToken(): string {
  return (
    String(process.env.MELI_ACCESS_TOKEN ?? '').trim() ||
    String(process.env.MERCADOLIBRE_ACCESS_TOKEN ?? '').trim()
  );
}

function mlHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = mlAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function buildMercadoLibreQuery(identity: VehiclePartIdentity): string {
  return buildMarketSearchQueryPlan(identity).mlQueries[0] ?? '';
}

type MlQueryResult = { hits: RawProviderHit[]; error?: string };

async function searchMlQuery(
  query: string,
  retrievedAt: string,
  queryIndex = 0,
): Promise<MlQueryResult> {
  if (!query) return { hits: [] };
  const ids = getMarketSearchIds();
  if (ids) {
    emitMarketTrace(MARKET_TRACE_EVENTS.PROVIDER_REQUEST, ids, {
      provider: 'MERCADO_LIBRE',
      queryIndex,
      query,
    });
  }
  const t0 = Date.now();
  try {
    const url = `https://api.mercadolibre.com/sites/MLM/search?q=${encodeURIComponent(query)}&limit=20`;
    const res = await fetch(url, {
      headers: mlHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const error = `HTTP_${res.status}`;
      if (ids) {
        emitMarketTrace(MARKET_TRACE_EVENTS.PROVIDER_RESPONSE, ids, {
          provider: 'MERCADO_LIBRE',
          queryIndex,
          resultCount: 0,
          durationMs: Date.now() - t0,
          success: false,
          errorType: error,
        });
      }
      return { hits: [], error };
    }
    const json = (await res.json()) as {
      results?: Array<{
        id?: string;
        title?: string;
        price?: number;
        permalink?: string;
        condition?: string;
        seller?: { id?: number; nickname?: string };
      }>;
    };
    const hits: RawProviderHit[] = [];
    for (const r of json.results ?? []) {
      const price = Number(r.price);
      const seller =
        String(r.seller?.nickname ?? '').trim() ||
        (r.seller?.id != null ? String(r.seller.id) : '');
      hits.push({
        provider: 'MERCADO_LIBRE',
        title: String(r.title ?? '').trim(),
        ...(Number.isFinite(price) && price > 0 ? { price: Math.round(price) } : {}),
        url: String(r.permalink ?? '').trim(),
        condition: mapCondition(r.condition),
        snippet: String(r.title ?? '').trim(),
        externalId: String(r.id ?? '').trim() || undefined,
        ...(seller ? { seller } : {}),
        query,
        retrievedAt,
      });
    }
    if (ids) {
      emitMarketTrace(MARKET_TRACE_EVENTS.PROVIDER_RESPONSE, ids, {
        provider: 'MERCADO_LIBRE',
        queryIndex,
        resultCount: hits.length,
        durationMs: Date.now() - t0,
        success: true,
      });
    }
    return { hits };
  } catch (err) {
    const error = err instanceof Error ? err.name : 'Error';
    if (ids) {
      emitMarketTrace(MARKET_TRACE_EVENTS.PROVIDER_RESPONSE, ids, {
        provider: 'MERCADO_LIBRE',
        queryIndex,
        resultCount: 0,
        durationMs: Date.now() - t0,
        success: false,
        errorType: error,
      });
    }
    return { hits: [], error };
  }
}

export class MercadoLibreProvider implements RefaccionPriceProvider {
  readonly id = 'MERCADO_LIBRE' as const;
  readonly coverageStageId = 'MERCADO_LIBRE';
  lastError?: string;

  async search(identity: VehiclePartIdentity): Promise<RawProviderHit[]> {
    this.lastError = undefined;
    if (mlSearchDisabled()) return [];
    const plan = buildMarketSearchQueryPlan(identity);
    const retrievedAt = new Date().toISOString();
    const first = await searchMlQuery(plan.mlQueries[0] ?? '', retrievedAt, 0);
    if (first.error) {
      this.lastError = first.error;
      return [];
    }
    if (first.hits.length >= 8 || plan.mlQueries.length < 2) return first.hits;
    const second = await searchMlQuery(plan.mlQueries[1] ?? '', retrievedAt, 1);
    if (second.error && !this.lastError) this.lastError = second.error;
    return [...first.hits, ...second.hits];
  }
}
