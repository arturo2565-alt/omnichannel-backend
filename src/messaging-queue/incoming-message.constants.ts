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

export type IncomingMessageJobData = {
  tallerId: string;
  conversationId: string;
  channel: IncomingMessageChannel;
};

export function incomingBufferKey(conversationId: string): string {
  return `chat:buffer:${String(conversationId).trim()}`;
}
