import { Injectable } from '@nestjs/common';
import { extractMxnPricesFromText } from '../refaccion-web-search';
import { buildShoppingDiscoveryQueries } from './resolved-market-part';
import {
  emitMarketTrace,
  getMarketSearchIds,
  MARKET_TRACE_EVENTS,
} from './market-search-trace';
import type {
  RawProviderHit,
  RefaccionPriceProvider,
  VehiclePartIdentity,
} from './refaccion-market.types';
import { inferLampType } from './variant-cluster';
import { extractPrimaryPartNumber } from './part-number';

export type SerperShoppingRow = {
  title?: string;
  source?: string;
  link?: string;
  price?: string;
  productId?: string;
};

export function parseShoppingPrice(raw?: string): number | undefined {
  const prices = extractMxnPricesFromText(String(raw ?? ''));
  return prices[0];
}

export function mapShoppingRowsToHits(
  rows: readonly SerperShoppingRow[],
  query: string,
  retrievedAt: string,
): RawProviderHit[] {
  const hits: RawProviderHit[] = [];
  for (const row of rows) {
    const title = String(row.title ?? '').trim();
    if (!title) continue;
    const price = parseShoppingPrice(row.price);
    const merchant = String(row.source ?? '').trim();
    const pn = extractPrimaryPartNumber(title);
    hits.push({
      provider: 'SERPER_SHOPPING',
      title,
      ...(price != null ? { price } : {}),
      url: String(row.link ?? '').trim() || undefined,
      snippet: [title, row.price, merchant].filter(Boolean).join(' · '),
      merchant,
      seller: merchant || undefined,
      productId: String(row.productId ?? '').trim() || undefined,
      partNumber: pn?.normalized,
      lampType: inferLampType(title),
      query,
      retrievedAt,
    });
  }
  return hits;
}

export async function searchSerperShopping(
  query: string,
  num = 20,
): Promise<SerperShoppingRow[]> {
  const key = String(process.env.SERPER_API_KEY ?? '').trim();
  if (!key || !query) return [];
  const res = await fetch('https://google.serper.dev/shopping', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': key,
    },
    body: JSON.stringify({ q: query, gl: 'mx', hl: 'es', num }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { shopping?: SerperShoppingRow[] };
  return json.shopping ?? [];
}

@Injectable()
export class SerperShoppingProvider implements RefaccionPriceProvider {
  readonly id = 'SERPER_SHOPPING' as const;
  readonly coverageStageId = 'SERPER_SHOPPING';
  lastError?: string;

  isConfigured(): boolean {
    return Boolean(String(process.env.SERPER_API_KEY ?? '').trim());
  }

  async search(identity: VehiclePartIdentity): Promise<RawProviderHit[]> {
    return this.searchQueries(buildShoppingDiscoveryQueries(identity));
  }

  async searchQueries(queries: readonly string[]): Promise<RawProviderHit[]> {
    this.lastError = undefined;
    if (!this.isConfigured()) return [];
    const ids = getMarketSearchIds();
    const retrievedAt = new Date().toISOString();
    const all: RawProviderHit[] = [];
    const limited = queries.filter(Boolean).slice(0, 3);
    for (const [queryIndex, query] of limited.entries()) {
      if (ids) {
        emitMarketTrace(MARKET_TRACE_EVENTS.PROVIDER_REQUEST, ids, {
          provider: this.id,
          queryIndex,
          query,
        });
      }
      const t0 = Date.now();
      try {
        const rows = await searchSerperShopping(query, 20);
        const hits = mapShoppingRowsToHits(rows, query, retrievedAt);
        all.push(...hits);
        if (ids) {
          emitMarketTrace(MARKET_TRACE_EVENTS.SHOPPING_LOOKUP_RESULT, ids, {
            query,
            resultCount: hits.length,
            durationMs: Date.now() - t0,
            success: true,
          });
          emitMarketTrace(MARKET_TRACE_EVENTS.PROVIDER_RESPONSE, ids, {
            provider: this.id,
            queryIndex,
            resultCount: hits.length,
            durationMs: Date.now() - t0,
            success: true,
          });
        }
        if (all.length >= 30) break;
      } catch (err) {
        this.lastError = err instanceof Error ? err.name : 'Error';
        if (ids) {
          emitMarketTrace(MARKET_TRACE_EVENTS.PROVIDER_RESPONSE, ids, {
            provider: this.id,
            queryIndex,
            resultCount: 0,
            durationMs: Date.now() - t0,
            success: false,
            errorType: this.lastError,
          });
        }
      }
    }
    return all;
  }
}
