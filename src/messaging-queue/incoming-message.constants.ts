/** Cola única de inbound omnichannel (WhatsApp, Messenger, etc.). */
export const INCOMING_MESSAGES_QUEUE = 'incoming-messages';

export const MESSAGING_REDIS = 'MESSAGING_REDIS';

/** Debounce distribuido: silencio antes de procesar la ráfaga. */
export const INCOMING_MESSAGE_DEBOUNCE_MS = 25_000;

export type IncomingMessageChannel =
  | 'whatsapp'
  | 'messenger'
  | 'facebook'
  | 'instagram'
  | 'web'
  | string;

export type IncomingBufferKind = 'text' | 'image';

export type IncomingBufferItem = {
  kind: IncomingBufferKind;
  content: string;
  messageId: string;
  channel: IncomingMessageChannel;
  tallerId: string;
  receivedAt: string;
};

/** Una foto reciente alarga la espera. El texto solo no la alarga. */
export function shouldExtendInboundDebounce(
  items: readonly IncomingBufferItem[],
  now: number,
): boolean {
  let latestImageAt = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    if (item.kind !== 'image') continue;
    const at = Date.parse(item.receivedAt);
    if (Number.isFinite(at) && at > latestImageAt) latestImageAt = at;
  }
  if (!Number.isFinite(latestImageAt)) return false;
  return now - latestImageAt < INCOMING_MESSAGE_DEBOUNCE_MS;
}

export type IncomingMessageJobData = {
  tallerId: string;
  conversationId: string;
  channel: IncomingMessageChannel;
};

export function incomingBufferKey(conversationId: string): string {
  return `chat:buffer:${String(conversationId).trim()}`;
}
