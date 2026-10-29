import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { createSocketAuthMiddleware } from './chat-socket-auth';
import {
  appointmentSocketRoom,
  type AppointmentRealtimePayload,
} from './crm-appointment';

type WorkshopSocketEvent =
  | 'newMessage'
  | 'imageDamageAnalysis'
  | 'draftQuoteReady'
  | 'draftPeritajeAwaitingVehicle'
  | 'conversationLeadUpdated'
  | 'aiSuggestion'
  | 'appointmentCreated'
  | 'appointmentUpdated';

type DraftQuoteReadyPayload = {
  draftQuoteId: string;
  conversationId: string;
  messageId: string;
  damageAnalysis: unknown;
  draftQuote: unknown;
  estimateAmount: number;
  isAutoPilotActive?: boolean;
  awaitingVehicleForBanio?: boolean;
};

type ConversationLeadPayload = {
  conversationId: string;
  status: string;
  contactName?: string;
  lastMessageAt?: string | null;
  lastMessage?: string | null;
  isAutoPilotActive?: boolean;
};

@WebSocketGateway({
  cors: { origin: '*', methods: ['GET', 'POST'] },
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  constructor(private readonly jwtService: JwtService) {}

  afterInit(server: Server) {
    server.use(
      createSocketAuthMiddleware((token) =>
        this.jwtService.verifyAsync<{ tallerId?: string }>(token),
      ),
    );
  }

  async handleConnection(client: Socket) {
    const tallerId = String(client.data?.tallerId ?? '').trim();
    const room = appointmentSocketRoom(tallerId);
    if (!room) {
      client.disconnect(true);
      return;
    }
    await client.join(room);
  }

  handleDisconnect(_client: Socket) {
    /* conexión cerrada */
  }

  emitNewMessage(tallerId: string, message: unknown) {
    this.emitToTaller(tallerId, 'newMessage', message);
  }

  emitImageDamageAnalysis(
    tallerId: string,
    payload: {
      messageId: string;
      conversationId: string;
      damageAnalysis: unknown;
      draftQuote?: unknown;
    },
  ) {
    this.emitToTaller(tallerId, 'imageDamageAnalysis', payload);
  }

  emitDraftQuoteReady(tallerId: string, payload: DraftQuoteReadyPayload) {
    this.emitToTaller(tallerId, 'draftQuoteReady', payload);
  }

  emitDraftPeritajeAwaitingVehicle(
    tallerId: string,
    payload: {
      draftQuoteId: string;
      conversationId: string;
      messageId: string;
      damageAnalysis: unknown;
      isAutoPilotActive?: boolean;
    },
  ) {
    this.emitToTaller(tallerId, 'draftPeritajeAwaitingVehicle', payload);
  }

  emitConversationLeadUpdated(
    tallerId: string,
    payload: ConversationLeadPayload,
  ) {
    this.emitToTaller(tallerId, 'conversationLeadUpdated', payload);
  }

  emitAiSuggestion(
    tallerId: string,
    payload: { conversationId?: string; suggestion: string },
  ) {
    this.emitToTaller(tallerId, 'aiSuggestion', payload);
  }

  emitAppointmentCreated(
    tallerId: string,
    payload: AppointmentRealtimePayload,
  ) {
    this.emitToTaller(tallerId, 'appointmentCreated', payload);
  }

  emitAppointmentUpdated(
    tallerId: string,
    payload: AppointmentRealtimePayload,
  ) {
    this.emitToTaller(tallerId, 'appointmentUpdated', payload);
  }

  private emitToTaller(
    tallerId: string,
    event: WorkshopSocketEvent,
    payload: unknown,
  ) {
    const room = appointmentSocketRoom(tallerId);
    if (!room || !this.server) return;
    this.server.to(room).emit(event, payload);
  }
}
