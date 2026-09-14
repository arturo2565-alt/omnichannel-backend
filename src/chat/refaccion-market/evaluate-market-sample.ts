/**
 * Evaluación observacional de un hit. No decide el precio.
 * Usa los mismos predicados que el pipeline, más dimensiones extra.
 */
import {
  findMatchedPieceAlias,
  resolveMarketPieceTaxonomy,
} from './market-piece-taxonomy';
import { parseMarketSide, type MarketSide } from './market-side';
import {
  extractListingYearRange,
  listingLooksCommercial,
  listingLooksLikeAccessory,
  listingMentionsMake,
  listingMentionsVehicle,
  listingYearCompatible,
} from './validate-market-sample';
import {
  classifyRawHit,
  domainFromUrl,
  inferCondition,
  inferPartType,
} from './normalize-market-sample';
import type { PartType, RawProviderHit, VehiclePartIdentity } from './refaccion-market.types';
import type { MarketTraceRejectionReason } from './market-search-trace';

export type MarketSampleEvaluation = {
  pieceMatch: boolean;
  matchedPieceAlias?: string;
  expectedSide: MarketSide | null;
  detectedSide: MarketSide | null;
  sideMatch: boolean | null;
  makeMatch: boolean;
  modelMatch: boolean;
  yearMatch: boolean;
  extractedYearRange?: { lo: number; hi: number };
  targetYear: string | null;
  extractedPrice?: number;
  priceValid: boolean;
  detectedPartType: PartType;
  accepted: boolean;
  rejectionReason?: MarketTraceRejectionReason;
};

export function evaluateMarketSample(
  hit: RawProviderHit,
  identity: VehiclePartIdentity,
): MarketSampleEvaluation {
  const taxonomy = resolveMarketPieceTaxonomy(identity.pieza || identity.piezaLabel);
  const accessory = listingLooksLikeAccessory(hit.title, hit.snippet);
  const matchedPieceAlias = findMatchedPieceAlias(hit.title, hit.snippet, taxonomy);
  const pieceMatch = !accessory && Boolean(matchedPieceAlias);
  const detectedSide = parseMarketSide(`${hit.title} ${hit.snippet ?? ''}`);
  const expectedSide = taxonomy.requiredSide;
  const sideMatch =
    expectedSide == null ? null : detectedSide === expectedSide;
  const makeMatch = listingMentionsMake(hit.title, hit.snippet, identity);
  const vehicleMatch = listingMentionsVehicle(hit.title, hit.snippet, identity);
  const modelMatch = vehicleMatch;
  const yearMatch = listingYearCompatible(hit.title, hit.snippet, identity.anio);
  const extractedYearRange = extractListingYearRange(hit.title, hit.snippet);
  const price = Number(hit.price);
  const hasPrice = Number.isFinite(price) && price > 0;
  const condition = inferCondition(hit);
  const detectedPartType = inferPartType(hit, condition);
  const classified = classifyRawHit(hit, identity);

  let rejectionReason: MarketTraceRejectionReason | undefined;
  if (accessory) rejectionReason = 'ACCESSORY';
  else if (!matchedPieceAlias) rejectionReason = 'PIEZA_MISMATCH';
  else if (expectedSide && !detectedSide) rejectionReason = 'SIDE_MISSING';
  else if (expectedSide && detectedSide !== expectedSide) {
    rejectionReason = 'SIDE_MISMATCH';
  } else if (!makeMatch) rejectionReason = 'MAKE_MISMATCH';
  else if (!vehicleMatch) rejectionReason = 'MODEL_MISMATCH';
  else if (!yearMatch) rejectionReason = 'YEAR_MISMATCH';
  else if (!hasPrice) {
    rejectionReason = listingLooksCommercial(hit.title, hit.snippet)
      ? 'PRICE_PARSE_FAILED'
      : 'INVALID_PRICE';
  }

  return {
    pieceMatch,
    ...(matchedPieceAlias ? { matchedPieceAlias } : {}),
    expectedSide,
    detectedSide,
    sideMatch,
    makeMatch,
    modelMatch,
    yearMatch,
    ...(extractedYearRange ? { extractedYearRange } : {}),
    targetYear: identity.anio,
    ...(hasPrice ? { extractedPrice: Math.round(price) } : {}),
    priceValid: hasPrice,
    detectedPartType,
    accepted: classified.ok,
    rejectionReason: classified.ok
      ? undefined
      : rejectionReason ??
        (classified.ok ? undefined : mapPipelineReason(classified)),
  };
}

function mapPipelineReason(
  classified: ReturnType<typeof classifyRawHit>,
): MarketTraceRejectionReason {
  if (classified.ok) return 'OTHER';
  const reason = classified.reason;
  if (reason === 'ACCESSORY') return 'ACCESSORY';
  if (reason === 'PIEZA_MISMATCH') return 'PIEZA_MISMATCH';
  if (reason === 'SIDE_MISSING') return 'SIDE_MISSING';
  if (reason === 'SIDE_MISMATCH') return 'SIDE_MISMATCH';
  if (reason === 'MODEL_MISMATCH') return 'MODEL_MISMATCH';
  if (reason === 'YEAR_MISMATCH') return 'YEAR_MISMATCH';
  if (reason === 'PRICE_PARSE_FAILED') return 'PRICE_PARSE_FAILED';
  if (reason === 'INVALID_PRICE') return 'INVALID_PRICE';
  if (reason === 'DUPLICATE') return 'DUPLICATE';
  return 'OTHER';
}

export function rawPriceTextOf(hit: RawProviderHit): string | undefined {
  const blob = `${hit.title} ${hit.snippet ?? ''}`;
  const m = /(\$|mxn|pesos)\s*[\d.,]+|[\d.,]+\s*(mxn|pesos)/i.exec(blob);
  return m?.[0];
}

export function domainOfHit(hit: RawProviderHit): string {
  return domainFromUrl(hit.url);
}
