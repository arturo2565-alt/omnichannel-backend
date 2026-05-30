import {
  Controller,
  Post,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { ChatService } from './chat.service';

@Controller('api/chats')
export class ArrivalAlarmController {
  constructor(private readonly chatService: ChatService) {}

  /** Kill switch: apaga la alarma de recepción física (Twilio). */
  @UseGuards(JwtAuthGuard)
  @Post(':id/marcar-atendido')
  @HttpCode(HttpStatus.OK)
  async marcarClienteAtendido(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') conversationId: string,
  ) {
    return await this.chatService.markClienteEsperandoAtendido(
      conversationId,
      user.tallerId,
    );
  }
}
