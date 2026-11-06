import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { CalibrationValidationError, validateHumanQuote } from './calibration-case';
import { CalibrationCloudinaryArchive, createCloudinaryGateway } from './calibration-cloudinary-archive';
import { CalibrationEngine, type CalibrationRecordResult } from './calibration-engine';
import { CalibrationGithubApp, readGithubAppConfig } from './calibration-github-app';
import { CalibrationConflictError, CalibrationGithubWriter, CalibrationWriteError } from './calibration-github-writer';
import { validateCalibrationImage } from './calibration-image-archive.service';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

export const CALIBRATION_RECORDER = Symbol('CALIBRATION_RECORDER');
export const CALIBRATION_MAX_IMAGES = 8;
export const CALIBRATION_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type CalibrationIngestOutcome = {
  outcome: 'created' | 'already_exists' | 'reconciled' | 'partial';
  registration: 'created' | 'already_exists' | 'reconciled';
  caseId: string;
  photoArchiveStatus: CalibrationRecordResult['photoArchiveStatus'];
  photoRefs: string[];
  orphanPhotoRefs: string[];
};

export function calibrationIngestEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.CALIBRATION_INGEST_ENABLED === 'true';
}

export function assertCalibrationWorkshop(
  user: Pick<AuthenticatedUser, 'tallerId'> | null | undefined,
  body: unknown,
): string {
  const tallerId = user?.tallerId?.trim() ?? '';
  if (!tallerId) throw new UnauthorizedException({ error: 'authentication_required' });
  if (body && typeof body === 'object' && !Array.isArray(body) && 'tallerId' in body) {
    const claimed = (body as { tallerId?: unknown }).tallerId;
    if (claimed !== tallerId) {
      throw new ForbiddenException({ error: 'workshop_mismatch' });
    }
  }
  return tallerId;
}

export function readCalibrationImages(input: unknown): Buffer[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new BadRequestException({ error: 'invalid_images' });
  if (input.length > CALIBRATION_MAX_IMAGES) {
    throw new BadRequestException({ error: 'too_many_images' });
  }
  const images: Buffer[] = [];
  let total = 0;
  for (const item of input) {
    if (typeof item !== 'string' || item.startsWith('data:') || item.includes('://')) {
      throw new BadRequestException({ error: 'original_bytes_required' });
    }
    const compact = item.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
      throw new BadRequestException({ error: 'invalid_images' });
    }
    if (compact.length > Math.ceil(CALIBRATION_MAX_IMAGE_BYTES / 3) * 4) {
      throw new BadRequestException({ error: 'image_too_large' });
    }
    const bytes = Buffer.from(compact, 'base64');
    if (bytes.length === 0 || bytes.length > CALIBRATION_MAX_IMAGE_BYTES) {
      throw new BadRequestException({ error: 'image_too_large' });
    }
    total += bytes.length;
    if (total > CALIBRATION_MAX_IMAGES * CALIBRATION_MAX_IMAGE_BYTES) {
      throw new BadRequestException({ error: 'image_too_large' });
    }
    validateCalibrationImage(bytes);
    images.push(bytes);
  }
  return images;
}

export function createCalibrationRecorder(
  env: NodeJS.ProcessEnv,
  transport: typeof fetch = fetch,
): CalibrationEngine {
  const config = readGithubAppConfig(env);
  if (!config) {
    throw new ServiceUnavailableException({ error: 'archive_not_configured' });
  }
  const credentials = new CalibrationGithubApp(config, transport);
  const writer = new CalibrationGithubWriter(credentials, transport);
  const gateway = createCloudinaryGateway(env, transport);
  const photos = gateway ? new CalibrationCloudinaryArchive(gateway) : null;
  return new CalibrationEngine(writer, photos, () => new Date().toISOString());
}

@Injectable()
export class CalibrationIngestService {
  private readonly records: Pick<CalibrationEngine, 'record'> | null;

  constructor(
    @Optional() @Inject(CALIBRATION_RECORDER) records?: Pick<CalibrationEngine, 'record'> | null,
  ) {
    this.records = records ?? null;
  }

  async record(
    user: Pick<AuthenticatedUser, 'tallerId'> | null | undefined,
    body: unknown,
    env: NodeJS.ProcessEnv,
  ): Promise<CalibrationIngestOutcome> {
    if (!calibrationIngestEnabled(env)) throw new NotFoundException();
    assertCalibrationWorkshop(user, body);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('quote' in body)) {
      throw new BadRequestException({ error: 'invalid_quote' });
    }
    const images = readCalibrationImages((body as { images?: unknown }).images);
    let quote: ReturnType<typeof validateHumanQuote>;
    try {
      quote = validateHumanQuote((body as { quote?: unknown }).quote);
    } catch (err) {
      throw publicIngestError(err);
    }
    try {
      const recorder = this.records ?? createCalibrationRecorder(env);
      const result = await recorder.record(quote, images);
      return present(result, images.length > 0);
    } catch (err) {
      throw publicIngestError(err);
    }
  }
}

function present(result: CalibrationRecordResult, imagesSent: boolean): CalibrationIngestOutcome {
  const pendingPhotos = imagesSent && result.photoArchiveStatus !== 'archived_private';
  return {
    outcome: pendingPhotos ? 'partial' : result.status,
    registration: result.status,
    caseId: result.caseId,
    photoArchiveStatus: result.photoArchiveStatus,
    photoRefs: result.photoRefs,
    orphanPhotoRefs: result.orphanPhotoRefs,
  };
}

function publicIngestError(err: unknown): Error {
  if (
    err instanceof NotFoundException
    || err instanceof UnauthorizedException
    || err instanceof ForbiddenException
    || err instanceof BadRequestException
    || err instanceof ConflictException
    || err instanceof ServiceUnavailableException
  ) {
    return err;
  }
  if (err instanceof CalibrationValidationError) {
    return new BadRequestException({ error: err.code });
  }
  if (err instanceof CalibrationConflictError) {
    const code = err.message === 'Source key already records a different observation'
      ? 'different_observation'
      : 'not_recorded';
    return new ConflictException({ error: code });
  }
  if (err instanceof CalibrationWriteError && err.kind === 'forbidden') {
    return new ForbiddenException({ error: 'archive_forbidden' });
  }
  if (err instanceof CalibrationWriteError && (err.kind === 'validation' || err.kind === 'rejected')) {
    return new BadRequestException({ error: 'archive_rejected' });
  }
  return new ServiceUnavailableException({ error: 'archive_unavailable' });
}
