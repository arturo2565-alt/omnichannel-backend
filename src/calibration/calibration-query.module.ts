import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
  ServiceUnavailableException,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { Module } from '@nestjs/common';
import {
  CalibrationQueryError,
  calibrationQueryAccess,
  listCalibrationCases,
  listCalibrationOpportunities,
  readCalibrationCase,
  readCalibrationPhoto,
  readCalibrationQuote,
  readCalibrationSummary,
  type CalibrationArchive,
  type QueryList,
} from './calibration-query';
import { liveCalibrationArchive } from './calibration-query-source';

export class CalibrationQueryService {
  constructor(private readonly archive?: CalibrationArchive) {}

  open(env: NodeJS.ProcessEnv): CalibrationArchive {
    if (this.archive) return this.archive;
    return liveCalibrationArchive(env);
  }
}

/**
 * Consulta autenticada. Permanece oculta hasta CALIBRATION_READ_ENABLED=true
 * en staging. No registra CalibrationModule ni abre escritura.
 */
@Controller('api/calibration')
@UseGuards(JwtAuthGuard)
export class CalibrationQueryController {
  constructor(private readonly archive: CalibrationQueryService) {}

  @Get('summary')
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.run(user, (archive) => readCalibrationSummary(archive));
  }

  @Get('cases')
  cases(@CurrentUser() user: AuthenticatedUser, @Query() query: QueryList) {
    return this.run(user, (archive) => listCalibrationCases(archive, query));
  }

  @Get('cases/:caseId')
  caseDetail(@CurrentUser() user: AuthenticatedUser, @Param('caseId') caseId: string) {
    return this.run(user, (archive) => readCalibrationCase(archive, caseId));
  }

  @Get('cases/:caseId/photos/:photoId')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async photo(
    @CurrentUser() user: AuthenticatedUser,
    @Param('caseId') caseId: string,
    @Param('photoId') photoId: string,
  ): Promise<StreamableFile> {
    const image = await this.run(user, (archive) => readCalibrationPhoto(archive, caseId, photoId));
    return new StreamableFile(image.bytes, { type: image.mime, disposition: 'inline' });
  }

  @Get('opportunities')
  opportunities(@CurrentUser() user: AuthenticatedUser, @Query() query: QueryList) {
    return this.run(user, (archive) => listCalibrationOpportunities(archive, query));
  }

  @Get('quotes/:quoteId')
  quote(@CurrentUser() user: AuthenticatedUser, @Param('quoteId') quoteId: string) {
    return this.run(user, (archive) => readCalibrationQuote(archive, quoteId));
  }

  private async run<T>(user: AuthenticatedUser, work: (archive: CalibrationArchive) => Promise<T>): Promise<T> {
    try {
      const access = calibrationQueryAccess(process.env, user);
      if (access === 'hidden') throw new CalibrationQueryError('hidden');
      if (access === 'forbidden') throw new CalibrationQueryError('forbidden');
      return await work(this.archive.open(process.env));
    } catch (err) {
      if (err instanceof CalibrationQueryError) {
        if (err.code === 'hidden' || err.code === 'missing') throw new NotFoundException();
        if (err.code === 'forbidden') throw new ForbiddenException();
        if (err.code === 'invalid') throw new BadRequestException('La consulta no es válida.');
      }
      throw new ServiceUnavailableException('La consulta no está disponible.');
    }
  }
}

@Module({
  imports: [AuthModule],
  controllers: [CalibrationQueryController],
  providers: [CalibrationQueryService],
})
export class CalibrationQueryModule {}
