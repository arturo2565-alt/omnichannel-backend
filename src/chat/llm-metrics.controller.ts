import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { LlmCallTrackerService } from './llm-call-tracker.service';

function parseOptionalDate(
  raw: string | undefined,
  label: string,
): Date | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`${label} no es una fecha válida (ISO).`);
  }
  return d;
}

@Controller('metrics/llm')
@UseGuards(JwtAuthGuard)
export class LlmMetricsController {
  constructor(private readonly llmCallTracker: LlmCallTrackerService) {}

  /**
   * Resumen de costo/uso LLM.
   * Por defecto: últimos 30 días, scoped al taller del JWT.
   * Query `tallerId` opcional (mismo taller del token salvo override explícito).
   */
  @Get('summary')
  async summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query('tallerId') tallerIdQ?: string,
    @Query('startDate') startDateQ?: string,
    @Query('endDate') endDateQ?: string,
  ) {
    const endDate =
      parseOptionalDate(endDateQ, 'endDate') ?? new Date();
    const startDate =
      parseOptionalDate(startDateQ, 'startDate') ??
      new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    if (startDate > endDate) {
      throw new BadRequestException('startDate debe ser <= endDate');
    }

    const requestedTaller = String(tallerIdQ ?? '').trim();
    const tallerId = requestedTaller || user.tallerId || null;

    return this.llmCallTracker.getSummary({
      tallerId,
      startDate,
      endDate,
    });
  }
}
