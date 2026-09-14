import {
  getEffectiveLogLevel,
  shouldLog,
  type PegLogLevel,
} from './pegazuz-log-level';
import {
  getPegazuzContext,
  shortConvId,
  shortTurnId,
} from './pegazuz-context';
import { dropEmpty, sanitizeTracePayload } from './sanitize-log';

export type PegazuzLogData = Record<string, unknown>;

function formatValue(value: unknown): string {
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    if (/[\s=]/.test(value) || value.includes('"')) {
      return JSON.stringify(value);
    }
    return value;
  }
  const json = JSON.stringify(value);
  if (!json) return 'null';
  if (json.length > 180) return `${json.slice(0, 160)}…`;
  return json;
}

function correlationFields(): PegazuzLogData {
  const ctx = getPegazuzContext();
  if (!ctx) return {};
  return dropEmpty({
    turn: shortTurnId(ctx.turnId),
    conv: shortConvId(ctx.conversationId),
    q: ctx.quoteId ?? ctx.draftQuoteId,
    vehicleId: ctx.vehicleId,
    visionRunId: ctx.visionRunId,
    run: ctx.searchRunId,
  });
}

export function formatPegazuzLine(
  event: string,
  data: PegazuzLogData = {},
): string {
  const sanitized = sanitizeTracePayload(dropEmpty(data)) as PegazuzLogData;
  const merged = dropEmpty({
    ...correlationFields(),
    ...sanitized,
  });
  const tag = String(event ?? 'LOG').replace(/^\[|\]$/g, '');
  const parts = [`[${tag}]`];
  let phase: string | undefined;
  for (const [key, value] of Object.entries(merged)) {
    if (key === 'phase' && typeof value === 'string') {
      phase = value;
      continue;
    }
    parts.push(`${key}=${formatValue(value)}`);
  }
  if (phase) parts.push(phase);
  return parts.join(' ');
}

function write(level: PegLogLevel, event: string, data: PegazuzLogData): void {
  if (!shouldLog(level)) return;
  const line = formatPegazuzLine(event, data);
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
}

function errorFields(
  event: string,
  data: PegazuzLogData,
): PegazuzLogData {
  const err = data.err ?? data.error;
  const error =
    err instanceof Error
      ? err
      : typeof data.message === 'string'
        ? null
        : null;
  const message =
    (typeof data.message === 'string' && data.message) ||
    (error ? error.message : undefined) ||
    (typeof err === 'string' ? err : undefined);
  const errorType =
    (typeof data.errorType === 'string' && data.errorType) ||
    (error ? error.name : err != null ? typeof err : undefined);
  const stack =
    typeof data.stack === 'string'
      ? data.stack
      : error?.stack;
  const ctx = getPegazuzContext();
  return dropEmpty({
    event,
    message,
    errorType,
    conversationId: data.conversationId ?? ctx?.conversationId,
    turnId: data.turnId ?? ctx?.turnId,
    runId: data.runId ?? data.searchRunId ?? ctx?.searchRunId,
    visionRunId: data.visionRunId ?? ctx?.visionRunId,
    ...data,
    err: undefined,
    error: undefined,
    stack,
  });
}

export class PegazuzLogger {
  info(event: string, data: PegazuzLogData = {}): void {
    write('info', event, data);
  }

  warn(event: string, data: PegazuzLogData = {}): void {
    write('warn', event, data);
  }

  error(event: string, data: PegazuzLogData = {}): void {
    write('error', event, errorFields(event, data));
  }

  debug(event: string, data: PegazuzLogData = {}): void {
    write('debug', event, data);
  }

  trace(event: string, data: PegazuzLogData = {}): void {
    write('trace', event, data);
  }

  get level(): PegLogLevel {
    return getEffectiveLogLevel();
  }
}

export const pegLogger = new PegazuzLogger();
