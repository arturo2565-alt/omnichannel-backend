import { Controller, Get, Post, Body, Query, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ChatService } from './chat.service';

@Controller('webhook') 
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  // 1. Verificación de Meta O Carga de mensajes (Mantenemos por compatibilidad)
  @Get()
  async handleGet(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const MY_VERIFY_TOKEN = 'mi_token_secreto_123';

    if (mode === 'subscribe' && token === MY_VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      return challenge;
    }

    console.log('Frontend solicitando todos los mensajes...');
    return await this.chatService.findAllMessages();
  }

  // --- NUEVAS RUTAS OPTIMIZADAS ---

  // 2. Obtener solo la lista de conversaciones (Para el Sidebar)
  @Get('conversations')
  async getConversations() {
    console.log('Cargando lista de conversaciones...');
    return await this.chatService.findAllConversations();
  }

  // 3. Obtener mensajes de una conversación específica (Para el ChatView)
  @Get('messages/:conversationId')
  async getMessages(@Param('conversationId') conversationId: string) {
    console.log(`Cargando mensajes para la conversación: ${conversationId}`);
    return await this.chatService.findMessagesByConversation(conversationId);
  }

  // --- RECEPCIÓN Y IA ---

  // 4. Recepción de mensajes (Webhooks y Dashboard)
  @Post()
  @HttpCode(HttpStatus.OK)
  async receiveMessage(@Body() body: any) {
    const saved = await this.chatService.saveMessage(body);
    return { status: 'EVENT_RECEIVED', id: saved.id };
  }

  // 5. Sugerencia manual de IA
  @Post('ai-suggest/:id')
  async getSuggestion(@Param('id') id: string) {
    console.log(`Solicitando sugerencia manual para conv: ${id}`);
    const suggestion = await this.chatService.getManualAiSuggestion(id);
    return { suggestion };
  }
}