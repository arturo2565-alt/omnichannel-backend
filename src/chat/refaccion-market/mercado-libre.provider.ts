import { buildMarketSearchQueryPlan } from './market-search-queries';
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

export function buildMercadoLibreQuery(identity: VehiclePartIdentity): string {
  return buildMarketSearchQueryPlan(identity).mlQueries[0] ?? '';
}

async function searchMlQuery(
  query: string,
  retrievedAt: string,
): Promise<RawProviderHit[]> {
  if (!query) return [];
  const url = `https://api.mercadolibre.com/sites/MLM/search?q=${encodeURIComponent(query)}&limit=20`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as {
    results?: Array<{
      id?: string;
      title?: string;
      price?: number;
      permalink?: string;
      condition?: string;
    }>;
  };
  const hits: RawProviderHit[] = [];
  for (const r of json.results ?? []) {
    const price = Number(r.price);
    hits.push({
      provider: 'MERCADO_LIBRE',
      title: String(r.title ?? '').trim(),
      ...(Number.isFinite(price) && price > 0 ? { price: Math.round(price) } : {}),
      url: String(r.permalink ?? '').trim(),
      condition: mapCondition(r.condition),
      snippet: String(r.title ?? '').trim(),
      externalId: String(r.id ?? '').trim() || undefined,
      query,
      retrievedAt,
    });
  }
  return hits;
}

export class MercadoLibreProvider implements RefaccionPriceProvider {
  readonly id = 'MERCADO_LIBRE' as const;

  async search(identity: VehiclePartIdentity): Promise<RawProviderHit[]> {
    if (mlSearchDisabled()) return [];
    const plan = buildMarketSearchQueryPlan(identity);
    const retrievedAt = new Date().toISOString();
    try {
      const first = await searchMlQuery(plan.mlQueries[0] ?? '', retrievedAt);
      if (first.length >= 8 || plan.mlQueries.length < 2) return first;
      const second = await searchMlQuery(plan.mlQueries[1] ?? '', retrievedAt);
      return [...first, ...second];
    } catch {
      return [];
    }
  }
}
