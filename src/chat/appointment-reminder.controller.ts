import { Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AppointmentReminderService } from './appointment-reminder.service';

@Controller('api/appointments')
@UseGuards(JwtAuthGuard)
export class AppointmentReminderController {
  constructor(
    private readonly appointmentReminderService: AppointmentReminderService,
  ) {}

  @Post('trigger-reminders')
  @HttpCode(HttpStatus.OK)
  triggerReminders() {
    return this.appointmentReminderService.sendUpcomingAppointmentReminders();
  }
}
