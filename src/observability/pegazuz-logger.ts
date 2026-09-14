import {
  getEffectiveLogLevel,
  getPegLogFormat,
  shouldLog,
  type PegLogLevel,
} from './pegazuz-log-level';
import { getPegazuzContext } from './pegazuz-context';
import { dropEmpty } from './sanitize-log';
import { buildPegazuzLogRecord } from './pegazuz-log-record';
import { renderCompactLog } from './renderers/compact-log-renderer';
import { renderJsonLog } from './renderers/json-log-renderer';
import { renderPrettyLog } from './renderers/pretty-log-renderer';

export type PegazuzLogData = Record<string, unknown>;

export function formatPegazuzLine(
  event: string,
  data: PegazuzLogData = {},
): string {
  return renderCompactLog(buildPegazuzLogRecord('info', event, data));
}

function render(level: PegLogLevel, event: string, data: PegazuzLogData): string {
  const record = buildPegazuzLogRecord(level, event, data);
  const format = getPegLogFormat();
  if (format === 'json') return renderJsonLog(record);
  if (format === 'compact') return renderCompactLog(record);
  return renderPrettyLog(record);
}

function write(level: PegLogLevel, event: string, data: PegazuzLogData): void {
  if (!shouldLog(level)) return;
  const line = render(level, event, data);
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
  const error = err instanceof Error ? err : null;
  const message =
    (typeof data.message === 'string' && data.message) ||
    (error ? error.message : undefined) ||
    (typeof err === 'string' ? err : undefined);
  const errorType =
    (typeof data.errorType === 'string' && data.errorType) ||
    (error ? error.name : err != null ? typeof err : undefined);
  const stack =
    typeof data.stack === 'string' ? data.stack : error?.stack;
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
