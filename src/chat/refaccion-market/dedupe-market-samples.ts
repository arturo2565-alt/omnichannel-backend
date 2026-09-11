import type { MarketSample } from './refaccion-market.types';
import { canonicalizeUrl } from './normalize-market-sample';

function normTitle(title: string): string {
  return String(title ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function dedupeMarketSamples(samples: readonly MarketSample[]): MarketSample[] {
  const seenUrl = new Set<string>();
  const seenExt = new Set<string>();
  const seenTitle = new Set<string>();
  const out: MarketSample[] = [];
  for (const s of samples) {
    const url = canonicalizeUrl(s.url);
    if (url && seenUrl.has(url)) continue;
    const ext = String(s.externalId ?? '').trim().toUpperCase();
    if (ext && seenExt.has(ext)) continue;
    const titleKey = `${s.domain}|${normTitle(s.title)}`;
    if (titleKey !== 'unknown|' && seenTitle.has(titleKey)) continue;
    if (url) seenUrl.add(url);
    if (ext) seenExt.add(ext);
    if (titleKey !== 'unknown|') seenTitle.add(titleKey);
    out.push(s);
  }
  return out;
}
