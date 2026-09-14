import type {
  MarketProviderId,
  MarketSample,
  PartType,
  RawProviderHit,
  SampleCondition,
} from './refaccion-market.types';
import {
  listingLooksCommercial,
  validateListingAgainstIdentity,
} from './validate-market-sample';
import type { VehiclePartIdentity } from './refaccion-market.types';
import type { MarketRejectionReason } from './market-audit';

const USED_RE =
  /\b(usado|usada|seminuevo|seminueva|yonke|deshueso|desarmadora|segunda\s+mano)\b/i;
const OEM_RE = /\b(oem|original|genuino|genuine)\b/i;
const AFTER_RE =
  /\b(aftermarket|generico|generica|alternativo|taiwan|chino|reproduction|repro)\b/i;

export function inferCondition(
  hit: RawProviderHit,
): SampleCondition {
  if (hit.condition === 'NEW' || hit.condition === 'USED') return hit.condition;
  const blob = `${hit.title} ${hit.snippet ?? ''}`;
  if (USED_RE.test(blob)) return 'USED';
  if (/\bnuevo|nueva|new\b/i.test(blob)) return 'NEW';
  return 'UNKNOWN';
}

export function inferPartType(
  hit: RawProviderHit,
  condition: SampleCondition,
): PartType {
  const blob = `${hit.title} ${hit.snippet ?? ''}`;
  if (condition === 'USED' || USED_RE.test(blob)) return 'OEM_USED';
  if (AFTER_RE.test(blob)) return 'AFTERMARKET_NEW';
  if (OEM_RE.test(blob)) return 'OEM_NEW';
  if (condition === 'NEW') return 'AFTERMARKET_NEW';
  return 'UNKNOWN';
}

export function domainFromUrl(url?: string): string {
  const raw = String(url ?? '').trim();
  if (!raw) return 'unknown';
  try {
    const host = new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname
      .replace(/^www\./, '')
      .toLowerCase();
    return host || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function canonicalizeUrl(url?: string): string {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    u.hash = '';
    u.search = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return raw.toLowerCase();
  }
}

export type ClassifiedRawHit =
  | { ok: true; sample: MarketSample; compatible: true }
  | {
      ok: false;
      reason: MarketRejectionReason;
      compatible: boolean;
    };

export function classifyRawHit(
  hit: RawProviderHit,
  identity: VehiclePartIdentity,
): ClassifiedRawHit {
  const check = validateListingAgainstIdentity(
    hit.title,
    hit.snippet,
    identity,
  );
  const price = Number(hit.price);
  const hasPrice = Number.isFinite(price) && price > 0;
  if (!check.ok) {
    return {
      ok: false,
      reason: check.reason ?? 'PIEZA_MISMATCH',
      compatible: false,
    };
  }
  if (!hasPrice) {
    return {
      ok: false,
      reason: listingLooksCommercial(hit.title, hit.snippet)
        ? 'PRICE_PARSE_FAILED'
        : 'INVALID_PRICE',
      compatible: true,
    };
  }
  const condition = inferCondition(hit);
  return {
    ok: true,
    compatible: true,
    sample: {
      source: hit.provider,
      domain: domainFromUrl(hit.url),
      title: String(hit.title ?? '').trim(),
      price: Math.round(price),
      currency: 'MXN',
      condition,
      partType: inferPartType(hit, condition),
      url: canonicalizeUrl(hit.url) || hit.url || '',
      compatibilityConfidence: check.confidence,
      query: hit.query,
      retrievedAt: hit.retrievedAt,
      externalId: hit.externalId,
    },
  };
}

export function normalizeRawHit(
  hit: RawProviderHit,
  identity: VehiclePartIdentity,
): MarketSample | null {
  const classified = classifyRawHit(hit, identity);
  return classified.ok ? classified.sample : null;
}
