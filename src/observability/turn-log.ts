import { pegLogger } from './pegazuz-logger';
import { getPegazuzContext, patchTurnSummary } from './pegazuz-context';

export function emitTurnComplete(startedAt: number): void {
  const ctx = getPegazuzContext();
  const summary = ctx?.turnSummary ?? {};
  const durationMs = Math.max(0, Date.now() - startedAt);
  pegLogger.info('TURN', {
    phase: 'COMPLETE',
    mode: summary.mode,
    vehicle: summary.vehicle,
    market: summary.market,
    quoteTotal: summary.quoteTotal,
    partial: summary.partial,
    outbound: summary.outbound ?? 'NONE',
    duration: `${durationMs}ms`,
  });
}

export function markOutboundEnqueued(): void {
  patchTurnSummary({ outbound: 'ENQUEUED' });
}

export function markOutboundSent(): void {
  patchTurnSummary({ outbound: 'SENT' });
}
