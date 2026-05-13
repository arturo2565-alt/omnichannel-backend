import { 
  Controller, 
  Get, 
  Post,
  Patch,
  Body, 
  Query, 
  Param, 
  HttpCode, 
  HttpStatus, 
  UseInterceptors, 
  UploadedFile,
  ForbiddenException,
  Res,
  Req,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { ChatService } from './chat.service';
import type { PatchDraftQuoteBody } from './chat.service';
import { AiConfigService } from './ai-config.service';
import { PriceMatrixService } from './price-matrix.service';

@Controller('webhook') 
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly aiConfigService: AiConfigService,
    private readonly priceMatrixService: PriceMatrixService,
  ) {}

  // Verificación GET de Meta (WhatsApp / webhooks): debe devolver el challenge en texto plano.
  @Get()
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const verifyToken =
      process.env.FB_VERIFY_TOKEN?.trim() || 'AutoFix_Secret_2026';
    if (mode === 'subscribe' && token === verifyToken) {
      return res
        .status(200)
        .type('text/plain')
        .send(String(challenge ?? ''));
    }
    throw new ForbiddenException('Validación fallida');
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

  @Get('conversations/:conversationId/draft-quotes')
  async getDraftQuotes(@Param('conversationId') conversationId: string) {
    return await this.chatService.findDraftQuotesByConversation(conversationId);
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
  receiveMessage(@Req() req: Request, @Body() body: any) {
    console.log('--- NUEVO WEBHOOK ---', JSON.stringify(req.body, null, 2));

    /** Meta exige 200 rápido; el trabajo pesado va en background (errores solo en log). */
    void this.chatService
      .ingestWebhookPayload(body ?? {})
      .then((result) => {
        console.log('[webhook] procesamiento terminado:', result);
      })
      .catch((err) => {
        console.error('[webhook] error en ingestWebhookPayload:', err);
      });

    return {
      status: 'EVENT_RECEIVED',
      acknowledged: true,
    };
  }

  @Post('ai-suggest/:id')
  async getSuggestion(@Param('id') id: string) {
    const suggestion = await this.chatService.getManualAiSuggestion(id);
    return { suggestion };
  }

  @Patch('conversations/:id')
  async patchConversation(
    @Param('id') id: string,
    @Body() body: { isAutoPilotActive?: boolean },
  ) {
    return await this.chatService.patchConversationSettings(id, body);
  }

  @Patch('quote/:id')
  async patchDraftQuote(
    @Param('id') id: string,
    @Body() body: PatchDraftQuoteBody,
  ) {
    return await this.chatService.patchDraftQuote(id, body);
  }

  @Get('appointments')
  async getAppointments() {
    return await this.chatService.findAllAppointments();
  }

  @Patch('appointments/:id')
  async patchAppointment(
    @Param('id') id: string,
    @Body() body: { status?: string },
  ) {
    return await this.chatService.patchAppointmentStatus(id, body);
  }

  @Get('ai-config')
  async getAiConfig() {
    return await this.aiConfigService.getAdminAiSettings();
  }

  /** Catálogo pieza × severidad (matriz de precios editable). */
  @Get('price-matrix')
  async getPriceMatrix() {
    const rows = await this.priceMatrixService.findAllOrdered();
    return { rows };
  }

  @Patch('price-matrix/:id')
  async patchPriceMatrixCell(
    @Param('id') id: string,
    @Body() body: { precio?: number; diasEntrega?: number },
  ) {
    return await this.priceMatrixService.updateById(id, body);
  }

  @Post('price-matrix')
  @HttpCode(HttpStatus.CREATED)
  async postPriceMatrixCell(
    @Body()
    body: {
      pieza: string;
      severidad: string;
      precio: number;
      diasEntrega?: number;
    },
  ) {
    return await this.priceMatrixService.create(body);
  }

  @Patch('ai-config')
  async patchAiConfig(
    @Body()
    body: {
      visionPrompt: string;
      chatAppointmentPrompt: string;
      businessMapsUrl: string;
      businessPhone: string;
      businessHours: string;
    },
  ) {
    await this.aiConfigService.saveAdminAiSettings(body);
    return { ok: true };
  }

  /**
   * Prueba de IA para el panel (prompts en borrador). No persiste conversaciones ni borradores en BD.
   */
  @Post('ai-playground/test')
  @HttpCode(HttpStatus.OK)
  async testAiPlayground(
    @Body()
    body: {
      visionPrompt?: string;
      chatAppointmentPrompt?: string;
      userText?: string;
      imageBase64?: string;
      history?: unknown;
    },
  ) {
    return await this.chatService.testAiPlayground({
      visionPrompt: String(body.visionPrompt ?? ''),
      chatAppointmentPrompt: String(body.chatAppointmentPrompt ?? ''),
      userText: body.userText,
      imageBase64: body.imageBase64,
      history: body.history,
    });
  }

  /**
   * Playground: tras autorizar borrador (lote con imagen), primera respuesta del asistente de chat.
   */
  @Post('ai-playground/resume-after-draft')
  @HttpCode(HttpStatus.OK)
  async testAiPlaygroundResumeAfterDraft(
    @Body()
    body: {
      chatAppointmentPrompt?: string;
      userBatchText?: string;
      authorizedQuoteSummary?: string;
      history?: unknown;
      visionItems?: unknown;
    },
  ) {
    return await this.chatService.testAiPlaygroundResumeAfterDraft({
      chatAppointmentPrompt: String(body.chatAppointmentPrompt ?? ''),
      userBatchText: body.userBatchText,
      authorizedQuoteSummary: String(body.authorizedQuoteSummary ?? ''),
      history: body.history,
      visionItems: body.visionItems,
    });
  }
}