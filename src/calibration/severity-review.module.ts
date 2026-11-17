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
  SeverityError,
  SeverityGithub,
  confirmDeclaredSeverities,
  confirmSeverity,
  type DeclaredConfirmation,
  type SeverityFiles,
  type SeverityLevel,
} from './severity-annotation';

const CONFIRM_KEYS = new Set(['subjectId', 'lineId', 'level', 'lineReviewed']);
const LEVELS = new Set(['leve', 'medio_leve', 'medio', 'medio_fuerte', 'fuerte']);
const CLIENT_AUTHORITY = ['validated', 'operatorRole', 'operator_role', 'humanValidated', 'email', 'name', 'role', 'price'];

@Controller('api/calibration')
@UseGuards(JwtAuthGuard)
export class SeverityReviewController {
  constructor(@Optional() @Inject('severity-files') private readonly files?: SeverityFiles) {}

  @Post('severity')
  confirm(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.run(user, () => {
      const request = parseConfirm(body);
      const access = calibrationQueryAccess(process.env, user);
      if (access === 'hidden') throw new SeverityError('hidden');
      if (!user) throw new SeverityError('unauthorized');
      if (access !== 'open') throw new SeverityError('forbidden');
      return confirmSeverity(this.writer(), process.env, user, request);
    });
  }

  @Post('severity-declarations')
  confirmDeclarations(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.run(user, () => {
      const request = parseDeclaredConfirm(body);
      const access = calibrationQueryAccess(process.env, user);
      if (access === 'hidden') throw new SeverityError('hidden');
      if (!user) throw new SeverityError('unauthorized');
      if (access !== 'open') throw new SeverityError('forbidden');
      return confirmDeclaredSeverities(this.writer(), process.env, user, request);
    });
  }

  private writer(): SeverityFiles {
    if (this.files) return this.files;
    return openSeverityFiles(process.env, fetch);
  }

  private async run<T>(user: AuthenticatedUser | undefined, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof SeverityError) {
        if (err.code === 'hidden' || err.code === 'missing') throw new NotFoundException();
        if (err.code === 'forbidden') throw new ForbiddenException();
        if (err.code === 'unauthorized') throw new UnauthorizedException();
        throw new BadRequestException();
      }
      throw new ServiceUnavailableException();
    }
  }
}

export function severityWriteGrantAllowed(grant: GithubInstallationGrant | null): boolean {
  if (!grant || grant.repositorySelection !== 'selected') return false;
  if (grant.permissions.contents !== 'write') return false;
  const metadata = grant.permissions.metadata;
  if (metadata != null && metadata !== 'read') return false;
  return Object.keys(grant.permissions).every((key) => key === 'contents' || key === 'metadata');
}

export function openSeverityFiles(env: NodeJS.ProcessEnv, transport: typeof fetch): SeverityFiles {
  let config: ReturnType<typeof readGithubAppConfig>;
  try {
    config = readGithubAppConfig(env);
  } catch {
    throw new Error('severity writer unavailable');
  }
  if (!config) throw new Error('severity writer unavailable');
  const app = new CalibrationGithubApp(config, transport);
  return new SeverityGithub(transport, async () => {
    try {
      const token = await app.authorization();
      if (!severityWriteGrantAllowed(app.installationGrant()) || !token.startsWith('ghs_')) {
        throw new Error('severity writer unavailable');
      }
      return `Bearer ${token}`;
    } catch (err) {
      if (err instanceof SeverityError) throw err;
      throw new Error('severity writer unavailable');
    }
  });
}

function parseDeclaredConfirm(body: unknown): {
  subjectId: string;
  declarationsReviewed: true;
  items: DeclaredConfirmation[];
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SeverityError('invalid');
  const record = body as Record<string, unknown>;
  if (CLIENT_AUTHORITY.some((key) => Object.prototype.hasOwnProperty.call(record, key))) throw new SeverityError('rejected');
  if (Object.keys(record).some((key) => !['subjectId', 'declarationsReviewed', 'items'].includes(key))) {
    throw new SeverityError('rejected');
  }
  if (typeof record.subjectId !== 'string' || record.declarationsReviewed !== true || !Array.isArray(record.items)) {
    throw new SeverityError('rejected');
  }
  if (record.items.length < 1 || record.items.length > 12) throw new SeverityError('rejected');
  const items = record.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new SeverityError('rejected');
    const note = item as Record<string, unknown>;
    if (CLIENT_AUTHORITY.some((key) => Object.prototype.hasOwnProperty.call(note, key))) throw new SeverityError('rejected');
    if (Object.keys(note).some((key) => !['lineId', 'annotationId', 'level'].includes(key))) throw new SeverityError('rejected');
    if (typeof note.lineId !== 'string' || typeof note.annotationId !== 'string') throw new SeverityError('rejected');
    if (typeof note.level !== 'string' || !LEVELS.has(note.level)) throw new SeverityError('invalid');
    return { lineId: note.lineId, annotationId: note.annotationId, level: note.level as SeverityLevel };
  });
  return { subjectId: record.subjectId, declarationsReviewed: true, items };
}

function parseConfirm(body: unknown): { subjectId: string; lineId: string; level: SeverityLevel; lineReviewed: true } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SeverityError('invalid');
  const record = body as Record<string, unknown>;
  if (CLIENT_AUTHORITY.some((key) => Object.prototype.hasOwnProperty.call(record, key))) throw new SeverityError('rejected');
  if (Object.keys(record).some((key) => !CONFIRM_KEYS.has(key))) throw new SeverityError('rejected');
  if (typeof record.subjectId !== 'string' || typeof record.lineId !== 'string' || record.lineReviewed !== true) {
    throw new SeverityError('rejected');
  }
  if (typeof record.level !== 'string' || !LEVELS.has(record.level)) throw new SeverityError('invalid');
  return {
    subjectId: record.subjectId,
    lineId: record.lineId,
    level: record.level as SeverityLevel,
    lineReviewed: true,
  };
}

@Module({
  imports: [AuthModule],
  controllers: [SeverityReviewController],
})
export class SeverityReviewModule {}
