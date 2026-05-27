import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server } from 'socket.io';

@WebSocketGateway({
  cors: { origin: '*', // Permite que cualquier sitio (como tu Vercel) se conecte
          methods: ['GET', 'POST'], }, // Permitir que React se conecte
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  handleConnection(client: any) {
    console.log('Navegador conectado vía Socket:', client.id);
  }

  handleDisconnect(client: any) {
    console.log('Navegador desconectado');
  }

  // Esta función la llamaremos desde el Service cuando llegue un mensaje
  emitNewMessage(message: any) {
    this.server.emit('newMessage', message);
  }

  emitImageDamageAnalysis(payload: {
    messageId: string;
    conversationId: string;
    damageAnalysis: unknown;
    draftQuote?: unknown;
  }) {
    this.server.emit('imageDamageAnalysis', payload);
  }

  /** Nueva cotización persistida en `draft_quotes`, lista para revisión en el panel */
  emitDraftQuoteReady(payload: {
    draftQuoteId: string;
    conversationId: string;
    messageId: string;
    damageAnalysis: unknown;
    draftQuote: unknown;
    estimateAmount: number;
    /** Tras cotización IA el autopilot se apaga para revisión humana */
    isAutoPilotActive?: boolean;
    awaitingVehicleForBanio?: boolean;
  }) {
    this.server.emit('draftQuoteReady', payload);
  }

  /** Peritaje visual guardado; falta marca/modelo antes de cotizar (sin precios en panel). */
  emitDraftPeritajeAwaitingVehicle(payload: {
    draftQuoteId: string;
    conversationId: string;
    messageId: string;
    damageAnalysis: unknown;
    isAutoPilotActive?: boolean;
  }) {
    this.server.emit('draftPeritajeAwaitingVehicle', payload);
  }

  /** Actualización de estado de lead / bandeja sin nuevo mensaje */
  emitConversationLeadUpdated(payload: {
    conversationId: string;
    status: string;
    contactName?: string;
    lastMessageAt?: string | null;
    lastMessage?: string | null;
    isAutoPilotActive?: boolean;
  }) {
    this.server.emit('conversationLeadUpdated', payload);
  }
}