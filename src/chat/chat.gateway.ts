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
}