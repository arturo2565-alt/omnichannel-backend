import { Controller, Get, Post, Body, Query, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ChatService } from './chat.service';

@Controller('webhook') // URL base: http://localhost:3000/webhook
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  // 1. Verificación de Meta O Carga de mensajes para el Frontend
  @Get()
  async handleGet(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const MY_VERIFY_TOKEN = 'mi_token_secreto_123';

    // Verificación de Webhook de Facebook/Instagram
    if (mode === 'subscribe' && token === MY_VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      return challenge;
    }

    // Si no es Meta, es React pidiendo el historial
    console.log('Frontend solicitando mensajes...');
    return await this.chatService.findAllMessages();
  }

  // 2. Recepción de mensajes (Webhooks y envío desde Dashboard)
  @Post()
  @HttpCode(HttpStatus.OK)
  async receiveMessage(@Body() body: any) {
    const saved = await this.chatService.saveMessage(body);
    return { status: 'EVENT_RECEIVED', id: saved.id };
  }

  // 3. NUEVO: Solicitar una sugerencia de IA manualmente para una conversación
  @Post('ai-suggest/:id')
  async getSuggestion(@Param('id') id: string) {
    console.log(`Solicitando sugerencia manual para conv: ${id}`);
    const suggestion = await this.chatService.getManualAiSuggestion(id);
    return { suggestion };
  }
}