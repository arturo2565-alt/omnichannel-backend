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
  return [identity.piezaLabel, identity.marca, identity.modelo, identity.anio, 'nuevo']
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class MercadoLibreProvider implements RefaccionPriceProvider {
  readonly id = 'MERCADO_LIBRE' as const;

  async search(identity: VehiclePartIdentity): Promise<RawProviderHit[]> {
    if (mlSearchDisabled()) return [];
    const query = buildMercadoLibreQuery(identity);
    if (!query) return [];
    const url = `https://api.mercadolibre.com/sites/MLM/search?q=${encodeURIComponent(query)}&limit=20`;
    const retrievedAt = new Date().toISOString();
    try {
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
        if (!Number.isFinite(price) || price <= 0) continue;
        hits.push({
          provider: this.id,
          title: String(r.title ?? '').trim(),
          price: Math.round(price),
          url: String(r.permalink ?? '').trim(),
          condition: mapCondition(r.condition),
          snippet: String(r.title ?? '').trim(),
          externalId: String(r.id ?? '').trim() || undefined,
          query,
          retrievedAt,
        });
      }
      return hits;
    } catch {
      return [];
    }
  }
}
