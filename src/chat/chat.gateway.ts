import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import {
  appointmentSocketRoom,
  type AppointmentRealtimePayload,
} from './crm-appointment';

@WebSocketGateway({
  cors: { origin: '*',
          methods: ['GET', 'POST'], },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(private readonly jwtService: JwtService) {}

  async handleConnection(client: Socket) {
    const raw = client.handshake?.auth?.token ?? client.handshake?.query?.token;
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (!token || typeof token !== 'string') return;
    try {
      const payload = await this.jwtService.verifyAsync<{ tallerId?: string }>(
        token,
      );
      const room = appointmentSocketRoom(payload?.tallerId);
      if (room) await client.join(room);
    } catch {
      // Sin sala: no recibe eventos de citas de ningún taller.
    }
  }

  handleDisconnect(_client: Socket) {
    /* conexión cerrada */
  }

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

  emitDraftQuoteReady(payload: {
    draftQuoteId: string;
    conversationId: string;
    messageId: string;
    damageAnalysis: unknown;
    draftQuote: unknown;
    estimateAmount: number;
    isAutoPilotActive?: boolean;
    awaitingVehicleForBanio?: boolean;
  }) {
    this.server.emit('draftQuoteReady', payload);
  }

  emitDraftPeritajeAwaitingVehicle(payload: {
    draftQuoteId: string;
    conversationId: string;
    messageId: string;
    damageAnalysis: unknown;
    isAutoPilotActive?: boolean;
  }) {
    this.server.emit('draftPeritajeAwaitingVehicle', payload);
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

  private emitToTaller(
    tallerId: string,
    event: 'appointmentCreated' | 'appointmentUpdated',
    payload: AppointmentRealtimePayload,
  ) {
    const room = appointmentSocketRoom(tallerId);
    if (!room || !this.server) return;
    this.server.to(room).emit(event, payload);
  }
}
