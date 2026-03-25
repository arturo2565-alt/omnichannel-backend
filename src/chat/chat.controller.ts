import { 
  Controller, 
  Get, 
  Post, 
  Body, 
  Query, 
  Param, 
  HttpCode, 
  HttpStatus, 
  UseInterceptors, 
  UploadedFile 
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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

  // --- RUTAS DE OPTIMIZACIÓN ---

  @Get('conversations')
  async getConversations() {
    return await this.chatService.findAllConversations();
  }

  @Get('messages/:conversationId')
  async getMessages(@Param('conversationId') conversationId: string) {
    return await this.chatService.findMessagesByConversation(conversationId);
  }

  // --- MULTIMEDIA (NUEVO) ---

  /**
   * 2. Subida de archivos a Cloudinary
   * El interceptor 'file' debe coincidir con el nombre del campo en el FormData del frontend.
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(@UploadedFile() file: Express.Multer.File) {
    console.log('Subiendo archivo a Cloudinary...');
    const url = await this.chatService.uploadImage(file);
    return { url };
  }

  // --- RECEPCIÓN Y IA ---

  @Post()
  @HttpCode(HttpStatus.OK)
  async receiveMessage(@Body() body: any) {
    const saved = await this.chatService.saveMessage(body);
    return { status: 'EVENT_RECEIVED', id: saved.id };
  }

  @Post('ai-suggest/:id')
  async getSuggestion(@Param('id') id: string) {
    const suggestion = await this.chatService.getManualAiSuggestion(id);
    return { suggestion };
  }
}