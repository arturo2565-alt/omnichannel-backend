import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Inject,
  Module,
  NotFoundException,
  Optional,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { calibrationQueryAccess } from './calibration-access';
import { CalibrationGithubApp, readGithubAppConfig, type GithubInstallationGrant } from './calibration-github-app';
import {
  ColorError,
  ColorGithub,
  confirmVehicleColor,
  type ColorFiles,
} from './color-annotation';

const CONFIRM_KEYS = new Set(['subjectId', 'exteriorColor', 'requestedColor', 'finish', 'paintCode', 'colorReviewed']);
const CLIENT_AUTHORITY = ['validated', 'operatorRole', 'operator_role', 'humanValidated', 'email', 'name', 'role', 'price'];
const FINISH = /^(?:mate|brillante|perlado|metálico|metalico|metalizado|sólido|solido|tricapa|bicapa)$/iu;
const CODE = /^[A-Za-z0-9]{2,12}$/;
const COLOR = /^[\p{L}\p{N}][\p{L}\p{N} .'-]{0,39}$/u;

@Controller('api/calibration')
@UseGuards(JwtAuthGuard)
export class ColorReviewController {
  constructor(@Optional() @Inject('color-files') private readonly files?: ColorFiles) {}

  @Post('color')
  confirm(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.run(user, () => {
      const request = parseConfirm(body);
      const access = calibrationQueryAccess(process.env, user);
      if (access === 'hidden') throw new ColorError('hidden');
      if (!user) throw new ColorError('unauthorized');
      if (access !== 'open') throw new ColorError('forbidden');
      return confirmVehicleColor(this.writer(), process.env, user, request);
    });
  }

  private writer(): ColorFiles {
    if (this.files) return this.files;
    return openColorFiles(process.env, fetch);
  }

  private async run<T>(user: AuthenticatedUser | undefined, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof ColorError) {
        if (err.code === 'hidden' || err.code === 'missing') throw new NotFoundException();
        if (err.code === 'forbidden') throw new ForbiddenException();
        if (err.code === 'unauthorized') throw new UnauthorizedException();
        throw new BadRequestException();
      }
      throw new ServiceUnavailableException();
    }
  }
}

export function colorWriteGrantAllowed(grant: GithubInstallationGrant | null): boolean {
  if (!grant || grant.repositorySelection !== 'selected') return false;
  if (grant.permissions.contents !== 'write') return false;
  const metadata = grant.permissions.metadata;
  if (metadata != null && metadata !== 'read') return false;
  return Object.keys(grant.permissions).every((key) => key === 'contents' || key === 'metadata');
}

export function openColorFiles(env: NodeJS.ProcessEnv, transport: typeof fetch): ColorFiles {
  let config: ReturnType<typeof readGithubAppConfig>;
  try {
    config = readGithubAppConfig(env);
  } catch {
    throw new Error('color writer unavailable');
  }
  if (!config) throw new Error('color writer unavailable');
  const app = new CalibrationGithubApp(config, transport);
  return new ColorGithub(transport, async () => {
    try {
      const token = await app.authorization();
      if (!colorWriteGrantAllowed(app.installationGrant()) || !token.startsWith('ghs_')) {
        throw new Error('color writer unavailable');
      }
      return `Bearer ${token}`;
    } catch (err) {
      if (err instanceof ColorError) throw err;
      throw new Error('color writer unavailable');
    }
  });
}

function parseConfirm(body: unknown): {
  subjectId: string;
  exteriorColor: string;
  requestedColor: string | null;
  finish: string | null;
  paintCode: string | null;
  colorReviewed: true;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ColorError('invalid');
  const record = body as Record<string, unknown>;
  if (CLIENT_AUTHORITY.some((key) => Object.prototype.hasOwnProperty.call(record, key))) throw new ColorError('rejected');
  if (Object.keys(record).some((key) => !CONFIRM_KEYS.has(key))) throw new ColorError('rejected');
  if (typeof record.subjectId !== 'string' || record.colorReviewed !== true) throw new ColorError('rejected');
  if (typeof record.exteriorColor !== 'string' || !COLOR.test(record.exteriorColor.trim())) throw new ColorError('invalid');
  const requested = record.requestedColor == null ? null : record.requestedColor;
  if (requested != null && (typeof requested !== 'string' || !COLOR.test(requested.trim()))) throw new ColorError('invalid');
  const finish = record.finish == null ? null : record.finish;
  if (finish != null && (typeof finish !== 'string' || !FINISH.test(finish))) throw new ColorError('rejected');
  const paintCode = record.paintCode == null ? null : record.paintCode;
  if (paintCode != null && (typeof paintCode !== 'string' || !CODE.test(paintCode))) throw new ColorError('rejected');
  return {
    subjectId: record.subjectId,
    exteriorColor: record.exteriorColor.trim(),
    requestedColor: typeof requested === 'string' ? requested.trim() : null,
    finish: typeof finish === 'string' ? finish : null,
    paintCode: typeof paintCode === 'string' ? paintCode : null,
    colorReviewed: true,
  };
}

@Module({
  imports: [AuthModule],
  controllers: [ColorReviewController],
})
export class ColorReviewModule {}
