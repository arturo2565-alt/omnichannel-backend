import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { ChatService } from './chat.service';
import { ManualAppointmentService } from './manual-appointment.service';

@Controller('api/crm/appointments')
@UseGuards(JwtAuthGuard)
export class CrmAppointmentsController {
  constructor(
    private readonly manualAppointments: ManualAppointmentService,
    private readonly chatService: ChatService,
  ) {}

  @Get('suggestions')
  suggestions(@CurrentUser() user: AuthenticatedUser) {
    return this.manualAppointments.suggestions(user.tallerId);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.manualAppointments.listManual(user.tallerId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: Record<string, unknown>,
  ) {
    return this.manualAppointments.create(user.tallerId, user.userId, body ?? {});
  }

  @Patch(':id')
  updateVisit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: { status?: string; visitStatus?: string },
  ) {
    return this.chatService.patchAppointmentStatus(id, body ?? {}, user.tallerId);
  }

  @Patch(':id/commercial')
  saveCommercial(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.manualAppointments.saveCommercial(user.tallerId, id, body ?? {});
  }

  @Post(':id/contract')
  contract(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: { contractedAmount?: unknown; notes?: unknown },
  ) {
    return this.manualAppointments.upsertContract(user.tallerId, id, body ?? {});
  }
}
