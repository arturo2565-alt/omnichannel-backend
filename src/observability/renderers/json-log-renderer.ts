import {
  resolveStructuredEventName,
  type PegazuzLogRecord,
} from '../pegazuz-log-record';

export function renderJsonLog(record: PegazuzLogRecord): string {
  const rest = { ...record.data };
  delete rest.event;
  return JSON.stringify({
    level: record.level,
    timestamp: record.timestamp,
    turnId: record.correlation.turnId,
    conversationId: record.correlation.conversationId,
    quoteId: record.correlation.quoteId,
    vehicleId: record.correlation.vehicleId,
    visionRunId: record.correlation.visionRunId,
    searchRunId: record.correlation.searchRunId,
    ...rest,
    event: resolveStructuredEventName(record.event, record.data),
  });
}
