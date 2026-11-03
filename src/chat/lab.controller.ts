import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Injectable,
  NotFoundException,
  Param,
  Post,
  UseGuards,
  type CanActivate,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { ChatService } from './chat.service';
import { labRouteVisibility } from './lab-channel';

/** Oculta el laboratorio fuera de staging antes de revisar el JWT. */
@Injectable()
export class LabVisibilityGuard implements CanActivate {
  canActivate(): boolean {
    if (labRouteVisibility(process.env) === 'hidden') {
      throw new NotFoundException();
    }
    return true;
  }
}

@Controller('lab')
@UseGuards(LabVisibilityGuard, JwtAuthGuard)
export class LabController {
  constructor(private readonly chatService: ChatService) {}

  @Post('conversations')
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body?: unknown,
  ) {
    return this.chatService.createLabConversation(user, body);
  }

  @Post('conversations/:id/turn')
  @HttpCode(HttpStatus.OK)
  turn(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body?: unknown,
  ) {
    return this.chatService.appendLabTurn(id, body, user);
  }
}
