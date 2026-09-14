/**
 * Observabilidad profunda del lookup de mercado.
 * No cambia queries, filtros, samples ni pricing.
 */
import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  getCanonicalTraceContext,
  mergeCanonicalTraceContext,
} from '../canonical-trace';
import { getLlmAuditContext } from '../llm-audit-context';
import {
  isDebugDetailEnabled,
  isTraceDetailEnabled,
  shouldEmitLegacyTraceJson,
  shouldLog,
} from '../../observability/pegazuz-log-level';
import { pegLogger } from '../../observability/pegazuz-logger';
import { patchTurnSummary } from '../../observability/pegazuz-context';
import { sanitizeTracePayload } from '../../observability/sanitize-log';
import type { MarketProviderId, PartType, RawProviderHit } from './refaccion-market.types';
import type { MarketRejectionReason } from './market-audit';

export const PEG_MARKET_TRACE_ENV = 'PEG_MARKET_TRACE';
export const PEG_MARKET_TRACE_VERBOSE_ENV = 'PEG_MARKET_TRACE_VERBOSE';
export const PEG_MARKET_TRACE_PREFIX = '[PEG_MARKET_TRACE]';
export const MARKET_TRACE_VERBOSE_LIMIT = 25;

export const MARKET_TRACE_EVENTS = {
  SEARCH_STARTED: 'REFACCION_SEARCH_STARTED',
  QUERIES_GENERATED: 'REFACCION_QUERIES_GENERATED',
  CACHE_DECISION: 'REFACCION_CACHE_DECISION',
  PROVIDER_REQUEST: 'REFACCION_PROVIDER_REQUEST',
  PROVIDER_RESPONSE: 'REFACCION_PROVIDER_RESPONSE',
  RAW_SAMPLE: 'REFACCION_RAW_SAMPLE',
  SAMPLE_EVALUATED: 'REFACCION_SAMPLE_EVALUATED',
  SEARCH_FUNNEL: 'REFACCION_SEARCH_FUNNEL',
  PART_TYPE_SELECTION: 'REFACCION_PART_TYPE_SELECTION',
  ACCEPTED_SAMPLE: 'REFACCION_ACCEPTED_SAMPLE',
  PRICING_DECISION: 'REFACCION_PRICING_DECISION',
  SEARCH_FINISHED: 'REFACCION_SEARCH_FINISHED',
  PART_DISCOVERY_STARTED: 'PART_DISCOVERY_STARTED',
  PART_NUMBER_DISCOVERED: 'PART_NUMBER_DISCOVERED',
  SHOPPING_LOOKUP_STARTED: 'SHOPPING_LOOKUP_STARTED',
  SHOPPING_LOOKUP_RESULT: 'SHOPPING_LOOKUP_RESULT',
  PART_NUMBER_PIVOT_STARTED: 'PART_NUMBER_PIVOT_STARTED',
  PART_NUMBER_PIVOT_RESULT: 'PART_NUMBER_PIVOT_RESULT',
  VARIANT_CLUSTER_CREATED: 'VARIANT_CLUSTER_CREATED',
  CROSS_QUERY_DEDUPE: 'CROSS_QUERY_DEDUPE',
  MARKET_SAMPLE_SELECTED: 'MARKET_SAMPLE_SELECTED',
} as const;

export const MARKET_TRACE_REJECTION_REASONS = [
  'ACCESSORY',
  'PIEZA_MISMATCH',
  'SIDE_MISSING',
  'SIDE_MISMATCH',
  'MAKE_MISMATCH',
  'MODEL_MISMATCH',
  'YEAR_MISMATCH',
  'PRICE_PARSE_FAILED',
  'INVALID_PRICE',
  'DUPLICATE',
  'UNKNOWN_PART_TYPE',
  'OTHER',
] as const;

export type MarketTraceRejectionReason =
  (typeof MARKET_TRACE_REJECTION_REASONS)[number];

const SAMPLE_EVENTS = new Set<string>([
  MARKET_TRACE_EVENTS.RAW_SAMPLE,
  MARKET_TRACE_EVENTS.SAMPLE_EVALUATED,
  MARKET_TRACE_EVENTS.ACCEPTED_SAMPLE,
]);

const TRACE_EVENTS = new Set<string>([
  ...SAMPLE_EVENTS,
  MARKET_TRACE_EVENTS.PROVIDER_REQUEST,
  MARKET_TRACE_EVENTS.PROVIDER_RESPONSE,
]);

export type MarketSearchTraceIds = {
  searchRunId: string;
  conversationId?: string;
  quoteId?: string;
  vehicleId?: string;
  damageItemId?: string;
  pieceCode: string;
  marketIdentityKey: string;
  marketStrategyVersion: string;
};

export type MarketEstimateTraceInput = {
  conversationId?: string;
  quoteId?: string;
  vehicleId?: string;
  damageItemId?: string;
  confirmedVehicleFields?: readonly string[];
};

function flagOn(name: string): boolean {
  const raw = String(process.env[name] ?? '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

export function isMarketTraceVerboseEnabled(): boolean {
  return flagOn(PEG_MARKET_TRACE_VERBOSE_ENV);
}

export function isMarketTraceEnabled(): boolean {
  return flagOn(PEG_MARKET_TRACE_ENV) || isMarketTraceVerboseEnabled();
}

export function createSearchRunId(): string {
  return `mrs_${randomBytes(6).toString('hex')}`;
}

const searchAls = new AsyncLocalStorage<MarketSearchTraceIds>();

export function runWithMarketSearchIds<T>(
  ids: MarketSearchTraceIds,
  fn: () => T,
): T {
  return searchAls.run(ids, fn);
}

export function getMarketSearchIds(): MarketSearchTraceIds | undefined {
  return searchAls.getStore();
}

export function hashUrlForTrace(url?: string): string | undefined {
  const raw = String(url ?? '').trim();
  if (!raw) return undefined;
  return createHash('sha1').update(raw).digest('hex').slice(0, 12);
}

export function resolveMarketTraceIds(
  base: Omit<MarketSearchTraceIds, 'conversationId' | 'quoteId'> &
    MarketEstimateTraceInput,
): MarketSearchTraceIds {
  const canon = getCanonicalTraceContext();
  const audit = getLlmAuditContext();
  return {
    searchRunId: base.searchRunId,
    conversationId:
      base.conversationId ?? canon?.conversationId ?? audit?.conversationId ?? undefined,
    quoteId: base.quoteId ?? canon?.draftQuoteId,
    vehicleId: base.vehicleId ?? canon?.vehicleId,
    damageItemId: base.damageItemId,
    pieceCode: base.pieceCode,
    marketIdentityKey: base.marketIdentityKey,
    marketStrategyVersion: base.marketStrategyVersion,
  };
}

export function compactMarketStatus(status: unknown): string {
  const raw = String(status ?? '').trim();
  if (raw === 'INSUFFICIENT_MARKET_SAMPLE') return 'INSUFFICIENT';
  if (raw === 'AWAITING_VEHICLE_DATA') return 'AWAITING';
  if (raw === 'OK') return 'OK';
  return raw || 'UNKNOWN';
}

export function topRejectionReasons(
  rejected: unknown,
  limit = 3,
): string[] {
  if (!rejected || typeof rejected !== 'object') return [];
  return Object.entries(rejected as Record<string, unknown>)
    .map(([reason, count]) => ({
      reason,
      count: typeof count === 'number' ? count : Number(count) || 0,
    }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((row) => `${row.reason}:${row.count}`);
}

function requiredSamplesOf(payload: Record<string, unknown>): number {
  const n = Number(payload.requiredSamples ?? payload.minValidSamples);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

export function emitMarketTrace(
  event: string,
  ids: MarketSearchTraceIds,
  payload: Record<string, unknown> = {},
): void {
  mergeCanonicalTraceContext({
    searchRunId: ids.searchRunId,
    conversationId: ids.conversationId,
    quoteId: ids.quoteId,
    vehicleId: ids.vehicleId,
  });

  if (event === MARKET_TRACE_EVENTS.SEARCH_STARTED) {
    const vehicle = payload.vehicle as
      | { make?: unknown; model?: unknown; year?: unknown }
      | undefined;
    pegLogger.info('MARKET', {
      run: ids.searchRunId,
      piece: ids.pieceCode,
      vehicle: vehicle
        ? [vehicle.make, vehicle.model, vehicle.year]
            .map((part) => String(part ?? '').trim())
            .filter(Boolean)
            .join(' ')
        : undefined,
      phase: 'START',
    });
  }

  if (event === MARKET_TRACE_EVENTS.SEARCH_FINISHED) {
    const status = compactMarketStatus(payload.pricingStatus);
    const accepted = Number(payload.acceptedSampleCount ?? 0);
    const required = requiredSamplesOf(payload);
    const compact = {
      run: ids.searchRunId,
      piece: ids.pieceCode,
      vehicle: payload.vehicleLabel,
      providerPath: payload.providerPath ?? payload.source,
      raw: payload.rawResultCount,
      unique: payload.uniqueSamples,
      samples: `${accepted}/${required}`,
      selectedPartType: payload.selectedPartType,
      status,
      duration: `${Number(payload.totalDurationMs ?? 0)}ms`,
      ...(status === 'INSUFFICIENT'
        ? { topRejectionReasons: topRejectionReasons(payload.rejectedByReason) }
        : {}),
    };
    pegLogger.info('MARKET', compact);
    if (status === 'INSUFFICIENT') {
      pegLogger.warn('MARKET', {
        event: 'MARKET_INSUFFICIENT',
        ...compact,
      });
    }
    patchTurnSummary({ market: status });
  }

  const sampleLike = SAMPLE_EVENTS.has(event);
  if (sampleLike) {
    if (!isMarketTraceVerboseEnabled() && !isTraceDetailEnabled()) return;
    pegLogger.trace('MARKET', { event, piece: ids.pieceCode, ...payload });
  } else if (
    event !== MARKET_TRACE_EVENTS.SEARCH_STARTED &&
    event !== MARKET_TRACE_EVENTS.SEARCH_FINISHED
  ) {
    if (TRACE_EVENTS.has(event)) {
      pegLogger.trace('MARKET', { event, piece: ids.pieceCode, ...payload });
    } else if (shouldLog('debug')) {
      pegLogger.debug('MARKET', { event, piece: ids.pieceCode, ...payload });
    }
  }

  if (!shouldEmitLegacyTraceJson()) return;
  if (sampleLike && !isMarketTraceVerboseEnabled() && !isTraceDetailEnabled()) {
    return;
  }
  if (!isMarketTraceEnabled() && !isDebugDetailEnabled()) return;
  const body = sanitizeTracePayload({
    event,
    ...ids,
    ...payload,
  });
  console.log(`${PEG_MARKET_TRACE_PREFIX} ${JSON.stringify(body)}`);
}

export type MarketSearchFunnel = {
  providerRawResults: Partial<Record<MarketProviderId, number>>;
  rawResultCount: number;
  afterDedupe: number;
  pieceCompatible: number;
  sideCompatible: number;
  vehicleCompatible: number;
  yearCompatible: number;
  validPrice: number;
  acceptedByPartType: Partial<Record<PartType, number>>;
  rejectedByReason: Partial<
    Record<MarketTraceRejectionReason | MarketRejectionReason, number>
  >;
};

export type PartTypeSelectionTrace = {
  preferredOrder: readonly PartType[];
  counts: Record<PartType, number>;
  minValidSamples: number;
  selectedPartType: PartType | null;
  selectedSampleCount: number;
  bestAvailablePartType: PartType | null;
  bestAvailableSampleCount: number;
  samplesMissingToThreshold: number;
};

export function emptyPartTypeCounts(): Record<PartType, number> {
  return {
    AFTERMARKET_NEW: 0,
    UNKNOWN: 0,
    OEM_NEW: 0,
    OEM_USED: 0,
  };
}
