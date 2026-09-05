/** Cola de outbox: entrega a Meta (WhatsApp Cloud / Messenger Send API). */
export const OUTGOING_MESSAGES_QUEUE = 'outgoing-messages';

export const OUTGOING_MESSAGE_ATTEMPTS = 5;
export const OUTGOING_MESSAGE_BACKOFF_DELAY_MS = 2000;

export type OutgoingMessageChannel = 'whatsapp' | 'messenger' | string;

/**
 * Job de outbox. `metaPayload` es el body exacto que exige Graph
 * (no re-serializar ni remapear campos en el worker).
 */
export type OutgoingMessageJobData = {
  tallerId: string;
  conversationId: string;
  channel: OutgoingMessageChannel;
  metaPayload: Record<string, unknown>;
};
