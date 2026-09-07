import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { DashboardService } from './dashboard.service';

@Controller('api/dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('kpis')
  getKpis(@CurrentUser() user: AuthenticatedUser) {
    return this.dashboardService.getKpis(user.tallerId);
  }

  @Get('hot-leads')
  getHotLeads(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limitQ?: string,
  ) {
    const parsed = Number(limitQ);
    const limit = Number.isFinite(parsed) ? parsed : 10;
    return this.dashboardService.getHotLeads(user.tallerId, limit);
  }
}
