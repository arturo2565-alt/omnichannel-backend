import { pegLogger } from './pegazuz-logger';
import { getPegazuzContext, patchTurnSummary } from './pegazuz-context';

export function emitTurnComplete(startedAt: number): void {
  const ctx = getPegazuzContext();
  const summary = ctx?.turnSummary ?? {};
  const durationMs = Math.max(0, Date.now() - startedAt);
  if (summary.ux) {
    pegLogger.info('UX', { ...summary.ux });
  }
  pegLogger.info('TURN', {
    phase: 'COMPLETE',
    mode: summary.mode ?? summary.ux?.mode,
    vehicle: summary.vehicle,
    market: summary.market,
    quoteTotal: summary.quoteTotal,
    partial: summary.partial,
    outbound: summary.outbound ?? 'NONE',
    visionMs: summary.visionMs,
    marketMs: summary.marketMs,
    llmMs: summary.llmMs,
    durationMs,
    duration: `${durationMs}ms`,
  });
}

export function markOutboundEnqueued(): void {
  patchTurnSummary({ outbound: 'ENQUEUED' });
}

export function markOutboundSent(): void {
  patchTurnSummary({ outbound: 'SENT' });
}

export function addTurnDuration(
  field: 'visionMs' | 'marketMs' | 'llmMs',
  ms: number,
): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  const current = getPegazuzContext()?.turnSummary?.[field] ?? 0;
  patchTurnSummary({ [field]: current + ms });
}
