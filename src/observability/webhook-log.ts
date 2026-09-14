import {
  getPegazuzContext,
  patchTurnSummary,
  shortConvId,
} from './pegazuz-context';
import { pegLogger } from './pegazuz-logger';

export function logWebhookPayloadTrace(
  channel: string,
  body: unknown,
): void {
  pegLogger.trace('WEBHOOK', { channel, payload: body });
}

export function logInboundReceived(input: {
  channel: string;
  type: string;
  messageId?: string;
  conversationId?: string;
  count?: number;
}): void {
  const ctx = getPegazuzContext();
  const payload = {
    channel: input.channel,
    type: input.type,
    messageId: input.messageId,
    conv: shortConvId(input.conversationId),
    count: input.count,
    phase: 'START',
  };
  if (ctx?.turnId) {
    patchTurnSummary({
      channel: input.channel,
      inboundType: input.type,
    });
    pegLogger.info('INBOUND', payload);
    return;
  }
  pegLogger.debug('INBOUND', payload);
}

export function logWebhookEchoIgnored(mid?: string): void {
  pegLogger.info('WEBHOOK', {
    echo: 'ignored',
    mid: mid || undefined,
  });
}

export function logWebhookDuplicate(kind: string, mid?: string): void {
  pegLogger.debug('WEBHOOK', { duplicate: kind, mid });
}

export function logWebhookReceipt(kind: string): void {
  pegLogger.debug('WEBHOOK', { receipt: kind });
}
