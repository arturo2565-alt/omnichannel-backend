import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { CalibrationIngestService } from './calibration-ingest.service';

/**
 * Prepared ingest route. It is not registered in AppModule.
 * Even if a later change registers this controller, the feature flag
 * must be the exact string "true" or the handler responds 404.
 */
@Controller('calibration')
@UseGuards(JwtAuthGuard)
export class CalibrationIngestController {
  constructor(private readonly ingest: CalibrationIngestService) {}

  @Post('cases')
  record(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Body() body: unknown,
  ) {
    return this.ingest.record(request.user, body, process.env);
  }
}
