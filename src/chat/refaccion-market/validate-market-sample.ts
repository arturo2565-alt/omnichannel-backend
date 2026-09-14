import type { VehiclePartIdentity } from './refaccion-market.types';
import {
  listingMentionsPieceFamily,
  resolveMarketPieceTaxonomy,
} from './market-piece-taxonomy';
import { parseMarketSide } from './market-side';
import type { MarketRejectionReason } from './market-audit';

function norm(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function piezaTokensForLabel(piezaLabel: string): string[] {
  return resolveMarketPieceTaxonomy(piezaLabel).searchAliases;
}

const ACCESSORY_RE =
  /\b(bisagra|cubre\s*cofre|cubre\s*fascia|protector|bra\b|emblema|cerradura|varilla|soporte|tope de cofre|aislante|moldura de|guia de|clips?|tornillos?|empaque|hule|reten)\b/i;

export function listingLooksLikeAccessory(title: string, snippet?: string): boolean {
  return ACCESSORY_RE.test(`${title} ${snippet ?? ''}`);
}

export function listingLooksCommercial(title: string, snippet?: string): boolean {
  return /\$|mxn|pesos|precio|comprar|venta/i.test(`${title} ${snippet ?? ''}`);
}

export function listingMentionsPieza(
  title: string,
  snippet: string | undefined,
  piezaLabel: string,
): boolean {
  return listingMentionsPieceFamily(
    title,
    snippet,
    resolveMarketPieceTaxonomy(piezaLabel),
  );
}

export function listingMentionsVehicle(
  title: string,
  snippet: string | undefined,
  identity: VehiclePartIdentity,
): boolean {
  const blob = norm(`${title} ${snippet ?? ''}`);
  const marca = norm(identity.marca);
  const modelo = norm(identity.modelo);
  if (!marca || !blob.includes(marca)) return false;
  if (!modelo) return true;
  const compactModelo = modelo.replace(/\s+/g, '');
  const compactBlob = blob.replace(/\s+/g, '');
  if (blob.includes(modelo) || compactBlob.includes(`${marca}${compactModelo}`)) {
    return true;
  }
  return compactBlob.includes(compactModelo) && compactModelo.length >= 1;
}

/**
 * Año compatible solo si el listado trae el año exacto o un rango explícito
 * que lo contiene. Un año vecino suelto (2019 vs 2020) NO basta.
 * Generación (L33) no implica año.
 */
export function listingYearCompatible(
  title: string,
  snippet: string | undefined,
  anio: string | null,
): boolean {
  if (!anio || !/^(19|20)\d{2}$/.test(anio)) return false;
  const year = Number(anio);
  const blob = `${title} ${snippet ?? ''}`;
  const ranges = [
    ...blob.matchAll(
      /((?:19|20)\d{2})\s*(?:[-–]|a|al|\/)\s*((?:19|20)\d{2})/gi,
    ),
  ];
  for (const m of ranges) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (year >= lo && year <= hi) return true;
  }
  const short = [
    ...blob.matchAll(/\b((?:19|20)?\d{2})\s*[-–]\s*((?:19|20)?\d{2})\b/g),
  ];
  for (const m of short) {
    const lo = expandYearToken(m[1]!, year);
    const hi = expandYearToken(m[2]!, year);
    if (lo != null && hi != null && year >= Math.min(lo, hi) && year <= Math.max(lo, hi)) {
      return true;
    }
  }
  const exact = new RegExp(`\\b${anio}\\b`);
  return exact.test(blob);
}

function expandYearToken(raw: string, vehicleYear: number): number | null {
  const t = String(raw ?? '').replace(/\D/g, '');
  if (t.length === 4 && /^(19|20)\d{2}$/.test(t)) return Number(t);
  if (t.length === 2) {
    const century = Math.floor(vehicleYear / 100) * 100;
    return century + Number(t);
  }
  return null;
}

export type ListingValidation = {
  ok: boolean;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reason?: MarketRejectionReason;
  compatible: boolean;
};

export function validateListingAgainstIdentity(
  title: string,
  snippet: string | undefined,
  identity: VehiclePartIdentity,
): ListingValidation {
  const taxonomy = resolveMarketPieceTaxonomy(identity.pieza || identity.piezaLabel);
  if (listingLooksLikeAccessory(title, snippet)) {
    return { ok: false, confidence: 'LOW', reason: 'ACCESSORY', compatible: false };
  }
  if (!listingMentionsPieceFamily(title, snippet, taxonomy)) {
    return { ok: false, confidence: 'LOW', reason: 'PIEZA_MISMATCH', compatible: false };
  }
  if (taxonomy.requiredSide) {
    const listingSide = parseMarketSide(`${title} ${snippet ?? ''}`);
    if (!listingSide) {
      return { ok: false, confidence: 'LOW', reason: 'SIDE_MISSING', compatible: false };
    }
    if (listingSide !== taxonomy.requiredSide) {
      return { ok: false, confidence: 'LOW', reason: 'SIDE_MISMATCH', compatible: false };
    }
  }
  if (!listingMentionsVehicle(title, snippet, identity)) {
    return { ok: false, confidence: 'LOW', reason: 'MODEL_MISMATCH', compatible: false };
  }
  if (!listingYearCompatible(title, snippet, identity.anio)) {
    return { ok: false, confidence: 'LOW', reason: 'YEAR_MISMATCH', compatible: false };
  }
  const blob = `${title} ${snippet ?? ''}`;
  const hasRange = /((?:19|20)\d{2})\s*(?:[-–]|a|al|\/)\s*((?:19|20)\d{2})/i.test(
    blob,
  );
  return {
    ok: true,
    confidence: hasRange ? 'MEDIUM' : 'HIGH',
    compatible: true,
  };
}
