import { shortConvId } from './pegazuz-context';
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
  pegLogger.info('INBOUND', {
    channel: input.channel,
    type: input.type,
    messageId: input.messageId,
    conv: shortConvId(input.conversationId),
    count: input.count,
  });
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
