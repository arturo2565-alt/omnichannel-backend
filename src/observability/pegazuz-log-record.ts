import type { PegLogLevel } from './pegazuz-log-level';
import { isUserTextLoggingEnabled } from './pegazuz-log-level';
import { getPegazuzContext } from './pegazuz-context';
import { dropEmpty, sanitizeTracePayload } from './sanitize-log';

const USER_TEXT_KEY = /^(text|userText|inboundText|messageText)$/i;

function applyUserTextPolicy(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const key of Object.keys(out)) {
    if (!USER_TEXT_KEY.test(key)) continue;
    if (!isUserTextLoggingEnabled()) {
      delete out[key];
      continue;
    }
    if (typeof out[key] === 'string') {
      out[key] = String(out[key]).slice(0, 120);
    }
  }
  return out;
}

export type PegazuzCorrelation = {
  turnId?: string;
  conversationId?: string;
  quoteId?: string;
  vehicleId?: string;
  visionRunId?: string;
  searchRunId?: string;
};

export type PegazuzLogRecord = {
  level: PegLogLevel;
  event: string;
  timestamp: string;
  correlation: PegazuzCorrelation;
  data: Record<string, unknown>;
};

export function resolveStructuredEventName(
  event: string,
  data: Record<string, unknown>,
): string {
  const phase = String(data.phase ?? '').toUpperCase();
  const nested = String(data.event ?? '').toUpperCase();
  if (event === 'MARKET' && phase === 'START') return 'MARKET_STARTED';
  if (event === 'MARKET' && nested === 'MARKET_INSUFFICIENT') {
    return 'MARKET_INSUFFICIENT';
  }
  if (event === 'MARKET') return 'MARKET_FINISHED';
  if (event === 'TURN' && phase === 'COMPLETE') return 'TURN_COMPLETE';
  if (event === 'INBOUND') return 'INBOUND';
  if (event === 'OUTBOUND' && String(data.status ?? '') === 'sent') {
    return 'OUTBOUND_SENT';
  }
  if (event === 'WEBHOOK' && data.echo) return 'WEBHOOK_ECHO';
  return event;
}

export function buildPegazuzLogRecord(
  level: PegLogLevel,
  event: string,
  data: Record<string, unknown>,
): PegazuzLogRecord {
  const ctx = getPegazuzContext();
  const sanitized = applyUserTextPolicy(
    sanitizeTracePayload(dropEmpty(data)) as Record<string, unknown>,
  );
  return {
    level,
    event: String(event ?? 'LOG').replace(/^\[|\]$/g, ''),
    timestamp: new Date().toISOString(),
    correlation: dropEmpty({
      turnId: (sanitized.turnId as string | undefined) ?? ctx?.turnId,
      conversationId:
        (sanitized.conversationId as string | undefined) ??
        ctx?.conversationId,
      quoteId:
        (sanitized.quoteId as string | undefined) ??
        (sanitized.q as string | undefined) ??
        ctx?.quoteId ??
        ctx?.draftQuoteId,
      vehicleId: (sanitized.vehicleId as string | undefined) ?? ctx?.vehicleId,
      visionRunId:
        (sanitized.visionRunId as string | undefined) ?? ctx?.visionRunId,
      searchRunId:
        (sanitized.searchRunId as string | undefined) ??
        (sanitized.run as string | undefined) ??
        ctx?.searchRunId,
    }) as PegazuzCorrelation,
    data: dropEmpty({
      ...sanitized,
      turnId: undefined,
      conversationId: undefined,
    }),
  };
}
