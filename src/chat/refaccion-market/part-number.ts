/**
 * Extracción y normalización de números de parte.
 * No hardcodea OEM/aftermarket de un vehículo concreto.
 */
export type DiscoveredPartNumber = {
  raw: string;
  normalized: string;
  kind: 'OEM' | 'AFTERMARKET';
};

export function normalizePartNumber(raw: string): string {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[–—]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function looksLikeYearToken(n: string): boolean {
  return /^(19|20)\d{2}$/.test(n);
}

/**
 * Extrae OEM (#####-XXXXX) y aftermarket (marca + dígitos, interchange)
 * desde título/snippet. Conservador: no usa años ni precios.
 */
export function extractPartNumbers(
  title: string,
  snippet?: string,
): DiscoveredPartNumber[] {
  const blob = `${title} ${snippet ?? ''}`;
  const found = new Map<string, DiscoveredPartNumber>();

  const oemRe = /\b(\d{5}-[A-Z0-9]{4,6})\b/gi;
  for (const m of blob.matchAll(oemRe)) {
    const raw = m[1]!;
    const normalized = normalizePartNumber(raw);
    if (normalized.length < 8) continue;
    found.set(normalized, { raw: raw.toUpperCase(), normalized, kind: 'OEM' });
  }

  const branded = /\b(?:depo|tyc|depo\s+aftermarket)\s*[:#-]?\s*(\d{4,6})\b/gi;
  for (const m of blob.matchAll(branded)) {
    const raw = m[1]!;
    if (looksLikeYearToken(raw)) continue;
    const normalized = normalizePartNumber(raw);
    if (!found.has(normalized)) {
      found.set(normalized, { raw, normalized, kind: 'AFTERMARKET' });
    }
  }

  const interchange = /\b([A-Z]{2}\d{6,8})\b/g;
  for (const m of blob.matchAll(interchange)) {
    const raw = m[1]!;
    const normalized = normalizePartNumber(raw);
    if (!found.has(normalized)) {
      found.set(normalized, { raw, normalized, kind: 'AFTERMARKET' });
    }
  }

  return [...found.values()];
}

export function extractPrimaryPartNumber(
  title: string,
  snippet?: string,
): DiscoveredPartNumber | undefined {
  const all = extractPartNumbers(title, snippet);
  return all.find((p) => p.kind === 'OEM') ?? all[0];
}

export function buildPartNumberPivotQueries(
  partNumber: string,
  identity: { marca?: string; modelo?: string },
): string[] {
  const pn = normalizePartNumber(partNumber);
  if (!pn) return [];
  const vehicle = [identity.marca, identity.modelo].filter(Boolean).join(' ').trim();
  return [
    `"${pn}"`,
    vehicle ? `"${pn}" ${vehicle}` : '',
    `"${pn}" México`,
  ].filter(Boolean);
}
