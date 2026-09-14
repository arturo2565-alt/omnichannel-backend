/**
 * Observabilidad de investigación de mercado (CANONICAL).
 * No hay REFACCION_CATALOG_HIT: el catálogo manual ya no es fuente.
 */
import { pegLogger } from '../../observability/pegazuz-logger';
import { compactMarketStatus } from './market-search-trace';

export const REFACCION_MARKET_EVENTS = {
  SEARCH_STARTED: 'REFACCION_MARKET_SEARCH_STARTED',
  ESTIMATE_READY: 'REFACCION_MARKET_ESTIMATE_READY',
  INSUFFICIENT: 'REFACCION_MARKET_INSUFFICIENT',
  AWAITING_VEHICLE_DATA: 'REFACCION_MARKET_AWAITING_VEHICLE_DATA',
  COMPATIBILITY_REJECTED: 'REFACCION_MARKET_COMPATIBILITY_REJECTED',
  AUDIT: 'REFACCION_MARKET_AUDIT',
  LOOKUP_EXECUTED: 'MARKET_LOOKUP_EXECUTED',
  CACHE_REUSED: 'MARKET_CACHE_REUSED',
} as const;

export type RefaccionMarketEventName =
  (typeof REFACCION_MARKET_EVENTS)[keyof typeof REFACCION_MARKET_EVENTS];

export type RefaccionMarketEventSink = (
  event: RefaccionMarketEventName,
  payload: Record<string, unknown>,
) => void;

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function logRefaccionMarketEvent(
  event: RefaccionMarketEventName,
  payload: Record<string, unknown> = {},
): void {
  if (event === REFACCION_MARKET_EVENTS.AUDIT) {
    const funnel =
      payload.funnel && typeof payload.funnel === 'object'
        ? (payload.funnel as { afterDedupe?: unknown })
        : undefined;
    const accepted = asNumber(payload.acceptedSampleCount) ?? 0;
    const required = asNumber(payload.minValidSamples) ?? 4;
    pegLogger.info('MARKET', {
      audit: payload.searchRunId ?? payload.pieceCode,
      run: payload.searchRunId,
      raw: payload.rawResultCount,
      unique:
        payload.uniqueSamplesAfterCrossProviderDedupe ?? funnel?.afterDedupe,
      accepted: `${accepted}/${required}`,
      status: compactMarketStatus(payload.pricingStatus),
    });
    pegLogger.debug('MARKET', { event, ...payload, queries: undefined });
    pegLogger.trace('MARKET', { event, audit: payload });
    return;
  }
  pegLogger.debug('MARKET', { event, ...payload });
}
