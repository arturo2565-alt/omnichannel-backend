/** Cola única de inbound omnichannel (WhatsApp, Messenger, etc.). */
export const INCOMING_MESSAGES_QUEUE = 'incoming-messages';

export type IncomingMessageChannel =
  | 'whatsapp'
  | 'messenger'
  | 'facebook'
  | 'instagram'
  | 'web'
  | string;

export type IncomingMessageJobData = {
  tallerId: string;
  conversationId: string;
  channel: IncomingMessageChannel;
  messageData: unknown;
};
