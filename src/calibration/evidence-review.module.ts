import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Module,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
  StreamableFile,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { calibrationQueryAccess } from './calibration-access';
import {
  EvidenceReviewDesk,
  EvidenceReviewError,
  parseEvidencePreviewConfirm,
  parseEvidencePreviewHold,
} from './evidence-review';

/**
 * Private owner review. The preview is not a public upload and it does not
 * write the durable archive by itself.
 */
@Controller('api/calibration')
@UseGuards(JwtAuthGuard)
export class EvidenceReviewController {
  constructor(private readonly desk: EvidenceReviewDesk) {}

  @Post('evidence-previews')
  hold(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.run(user, () => this.desk.hold(user, parseEvidencePreviewHold(body)));
  }

  @Get('evidence-previews/:previewId')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async read(
    @CurrentUser() user: AuthenticatedUser,
    @Param('previewId') previewId: string,
  ): Promise<StreamableFile> {
    const image = await this.run(user, () => this.desk.read(user, previewId));
    return new StreamableFile(image.bytes, { type: image.mime, disposition: 'inline' });
  }

  @Post('evidence-previews/:previewId/confirm')
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('previewId') previewId: string,
    @Body() body: unknown,
  ) {
    return this.run(user, () => this.desk.confirm(user, previewId, parseEvidencePreviewConfirm(body)));
  }

  @Post('evidence-previews/:previewId/cancel')
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('previewId') previewId: string) {
    return this.run(user, () => this.desk.cancel(user, previewId));
  }

  private async run<T>(user: AuthenticatedUser | undefined, work: () => Promise<T>): Promise<T> {
    try {
      const access = calibrationQueryAccess(process.env, user);
      if (access === 'hidden') throw new EvidenceReviewError('hidden');
      if (!user) throw new EvidenceReviewError('unauthorized');
      if (access !== 'open') throw new EvidenceReviewError('forbidden');
      return await work();
    } catch (err) {
      if (err instanceof EvidenceReviewError) {
        if (err.code === 'hidden' || err.code === 'missing' || err.code === 'expired') throw new NotFoundException();
        if (err.code === 'forbidden') throw new ForbiddenException();
        if (err.code === 'unauthorized') throw new UnauthorizedException();
        if (err.code === 'unavailable') throw new ServiceUnavailableException();
        throw new BadRequestException();
      }
      throw new ServiceUnavailableException();
    }
  }
}

@Module({
  imports: [AuthModule],
  controllers: [EvidenceReviewController],
  providers: [{ provide: EvidenceReviewDesk, useFactory: () => new EvidenceReviewDesk() }],
})
export class EvidenceReviewModule {}
