/**
 * Observabilidad de investigación de mercado (CANONICAL).
 * No hay REFACCION_CATALOG_HIT: el catálogo manual ya no es fuente.
 */
import { traceRefaccionMarketEvent } from '../canonical-trace';
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

export function logRefaccionMarketEvent(
  event: RefaccionMarketEventName,
  payload: Record<string, unknown> = {},
): void {
  console.log('[RefaccionMarket]', JSON.stringify({ event, ...payload }));
  traceRefaccionMarketEvent(event, payload);
}
