import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
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
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { ChatService } from './chat.service';
import type {
  PatchDraftQuoteBody,
  PreviewDraftQuoteNarrativeBody,
  SendAgentMessageBody,
} from './chat.service';
import { AiConfigService } from './ai-config.service';
import { getWhatsAppVerifyToken } from './whatsapp-config';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

@Controller(['webhook', 'chat'])
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly aiConfigService: AiConfigService,
  ) {}

  @Public()
  @Get()
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const verifyToken = getWhatsAppVerifyToken();
    if (!verifyToken) {
      console.warn('[webhook GET] WHATSAPP_VERIFY_TOKEN no configurado');
      throw new ForbiddenException('Validación fallida: WHATSAPP_VERIFY_TOKEN no configurado');
    }
    if (mode === 'subscribe' && token === verifyToken) {
      return res
        .status(200)
        .type('text/plain')
        .send(String(challenge ?? ''));
    }
    throw new ForbiddenException('Validación fallida');
  }

  @UseGuards(JwtAuthGuard)
  @Get('conversations')
  async getConversations(@CurrentUser() user: AuthenticatedUser) {
    return await this.chatService.findAllConversations(user.tallerId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('messages/:conversationId')
  async getMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('conversationId') conversationId: string,
  ) {
    return await this.chatService.findMessagesByConversation(
      conversationId,
      user.tallerId,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('messages')
  @HttpCode(HttpStatus.CREATED)
  async sendAgentMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SendAgentMessageBody,
  ) {
    return await this.chatService.sendAgentMessage(body, user.tallerId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('conversations/:conversationId/draft-quotes')
  async getDraftQuotes(
    @CurrentUser() user: AuthenticatedUser,
    @Param('conversationId') conversationId: string,
  ) {
    return await this.chatService.findDraftQuotesByConversation(
      conversationId,
      user.tallerId,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('conversations/:conversationId/cotizacion/:cotizacionId/agregar-pieza')
  @HttpCode(HttpStatus.OK)
  async agregarPiezaACotizacion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('conversationId') conversationId: string,
    @Param('cotizacionId') cotizacionId: string,
    @Body()
    body: {
      piezaOServicio: string;
      severidad?: string;
      descripcionDano?: string;
      messageId?: string;
    },
  ) {
    return this.chatService.actualizarCotizacionExistente({
      cotizacionId,
      piezaOServicio: body.piezaOServicio,
      severidad: body.severidad,
      descripcionDano: body.descripcionDano,
      conversationId,
      tallerId: user.tallerId,
      messageId: body.messageId,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(@UploadedFile() file: Express.Multer.File) {
    console.log('Subiendo archivo a Cloudinary...');
    const url = await this.chatService.uploadImage(file);
    return { url };
  }

  /** Webhook Meta (Messenger / WhatsApp) + envío plano del panel (sin JWT). */
  @Public()
  @Post()
  receiveMessage(@Req() req: Request, @Res() res: Response) {
    const body = req.body;
    console.log('--- NUEVO WEBHOOK ---', JSON.stringify(body, null, 2));

    void this.chatService
      .ingestWebhookPayload(body ?? {})
      .then((result) => {
        console.log('[webhook] procesamiento terminado:', result);
      })
      .catch((err) => {
        console.error('[webhook] error en ingestWebhookPayload:', err);
      });

    res.status(HttpStatus.OK).type('text/plain').send('EVENT_RECEIVED');
  }

  @UseGuards(JwtAuthGuard)
  @Post('ai-suggest/:id')
  async getSuggestion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    const suggestion = await this.chatService.getManualAiSuggestion(
      id,
      user.tallerId,
    );
    return { suggestion };
  }

  @UseGuards(JwtAuthGuard)
  @Patch('conversations/:id')
  async patchConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: { isAutoPilotActive?: boolean },
  ) {
    return await this.chatService.patchConversationSettings(
      id,
      body,
      user.tallerId,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Delete('conversations/:id')
  async deleteConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    await this.chatService.deleteConversation(id, user.tallerId);
    return {
      success: true,
      message: 'Conversación eliminada correctamente',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Patch('quote/:id')
  async patchDraftQuote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: PatchDraftQuoteBody,
  ) {
    return await this.chatService.patchDraftQuote(id, body, user.tallerId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('draft-quote/preview-narrative')
  @HttpCode(HttpStatus.OK)
  async previewDraftQuoteNarrative(
    @Body() body: PreviewDraftQuoteNarrativeBody,
  ) {
    const narrative =
      await this.chatService.previewDraftQuoteClientNarrative(body);
    return { narrative };
  }

  @UseGuards(JwtAuthGuard)
  @Post('draft-quote/:id/regenerate-narrative')
  @HttpCode(HttpStatus.OK)
  async regenerateDraftQuoteNarrative(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: { inventoryLines?: PatchDraftQuoteBody['inventoryLines'] },
  ) {
    return await this.chatService.regenerateDraftQuoteClientNarrative(
      id,
      user.tallerId,
      body,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('appointments')
  async getAppointments(@CurrentUser() user: AuthenticatedUser) {
    return await this.chatService.findAllAppointments(user.tallerId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('appointments/:id')
  async patchAppointment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: { status?: string },
  ) {
    return await this.chatService.patchAppointmentStatus(
      id,
      body,
      user.tallerId,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('ai-config')
  async getAiConfig() {
    return await this.aiConfigService.getAdminAiSettings();
  }

  @UseGuards(JwtAuthGuard)
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

  @UseGuards(JwtAuthGuard)
  @Post('ai-playground/test')
  @HttpCode(HttpStatus.OK)
  async testAiPlayground(
    @Body()
    body: {
      visionPrompt?: string;
      chatAppointmentPrompt?: string;
      userText?: string;
      imagesBase64?: string[];
      imageBase64?: string;
      history?: unknown;
    },
  ) {
    return await this.chatService.testAiPlayground({
      visionPrompt: String(body.visionPrompt ?? ''),
      chatAppointmentPrompt: String(body.chatAppointmentPrompt ?? ''),
      userText: body.userText,
      imagesBase64: body.imagesBase64,
      imageBase64: body.imageBase64,
      history: body.history,
    });
  }

  @UseGuards(JwtAuthGuard)
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
      conversationId?: string;
    },
  ) {
    return await this.chatService.testAiPlaygroundResumeAfterDraft({
      chatAppointmentPrompt: String(body.chatAppointmentPrompt ?? ''),
      userBatchText: body.userBatchText,
      authorizedQuoteSummary: String(body.authorizedQuoteSummary ?? ''),
      history: body.history,
      visionItems: body.visionItems,
      conversationId: body.conversationId,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Post('conversations/:conversationId/resume-after-draft')
  @HttpCode(HttpStatus.OK)
  async resumeConversationAfterDraft(
    @CurrentUser() user: AuthenticatedUser,
    @Param('conversationId') conversationId: string,
    @Body()
    body: {
      userBatchText?: string;
      authorizedQuoteSummary?: string;
      visionItems?: unknown;
    },
  ) {
    return await this.chatService.resumeConversationAfterDraft(
      conversationId,
      {
        userBatchText: body.userBatchText,
        authorizedQuoteSummary: String(body.authorizedQuoteSummary ?? ''),
        visionItems: body.visionItems,
      },
      user.tallerId,
    );
  }
}
