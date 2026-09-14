import { shortConvId, shortTurnId } from '../pegazuz-context';
import { dropEmpty } from '../sanitize-log';
import type { PegazuzLogRecord } from '../pegazuz-log-record';

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
  if (Array.isArray(value)) {
    if (
      value.every(
        (row) =>
          row &&
          typeof row === 'object' &&
          'reason' in (row as object) &&
          'count' in (row as object),
      )
    ) {
      return value
        .map((row) => {
          const r = row as { reason: unknown; count: unknown };
          return `${r.reason}:${r.count}`;
        })
        .join(',');
    }
    const json = JSON.stringify(value);
    if (json.length > 180) return `${json.slice(0, 160)}…`;
    return json;
  }
  const json = JSON.stringify(value);
  if (!json) return 'null';
  if (json.length > 180) return `${json.slice(0, 160)}…`;
  return json;
}

export function renderCompactLog(record: PegazuzLogRecord): string {
  const merged = dropEmpty({
    turn: shortTurnId(record.correlation.turnId),
    conv: shortConvId(record.correlation.conversationId),
    q: record.correlation.quoteId
      ? shortConvId(record.correlation.quoteId)
      : undefined,
    run: record.correlation.searchRunId,
    vehicleId: record.correlation.vehicleId,
    visionRunId: record.correlation.visionRunId,
    ...record.data,
  });
  const parts = [`[${record.event}]`];
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
