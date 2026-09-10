/** Cola única de inbound omnichannel (WhatsApp, Messenger, etc.). */
export const INCOMING_MESSAGES_QUEUE = 'incoming-messages';

export const MESSAGING_REDIS = 'MESSAGING_REDIS';

/** Debounce distribuido: silencio antes de procesar la ráfaga. */
export const INCOMING_MESSAGE_DEBOUNCE_MS = 25_000;

/**
 * Si el job se promueve antes de que la última foto cumpla la ventana
 * (p. ej. un debounce de texto previo), no drenar: reprogramar.
 */
export const INBOUND_DEBOUNCE_SETTLE_SLACK_MS = 1_000;

export function inboundDebouncePendingJobId(conversationId: string): string {
  return `${String(conversationId).trim()}:pending`;
}

export function inboundDebounceJobIds(conversationId: string): string[] {
  const cid = String(conversationId).trim();
  return [cid, inboundDebouncePendingJobId(cid)];
}

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

export type IncomingMessageJobData = {
  tallerId: string;
  conversationId: string;
  channel: IncomingMessageChannel;
};

export function incomingBufferKey(conversationId: string): string {
  return `chat:buffer:${String(conversationId).trim()}`;
}

export function shouldExtendInboundDebounce(
  items: readonly IncomingBufferItem[],
  nowMs = Date.now(),
  windowMs = INCOMING_MESSAGE_DEBOUNCE_MS,
): boolean {
  const images = items.filter(
    (it) => it.kind === 'image' && String(it.content ?? '').trim(),
  );
  if (!images.length) return false;
  const newest = Math.max(
    ...images.map((it) => Date.parse(String(it.receivedAt ?? '')) || 0),
  );
  if (!Number.isFinite(newest) || newest <= 0) return false;
  return nowMs - newest < windowMs - INBOUND_DEBOUNCE_SETTLE_SLACK_MS;
}
