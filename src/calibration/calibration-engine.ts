import { createHash } from 'node:crypto';
import { validateCalibrationImage } from './calibration-image-archive.service';
import {
  nextCalibrationCaseId,
  validateHumanQuote,
  type ValidatedHumanQuote,
} from './calibration-case';
import {
  CalibrationConflictError,
  CalibrationGithubWriter,
  type GitHubCaseWriteResult,
} from './calibration-github-writer';

/**
 * CAL-006 orchestration. No HTTP route, no CanonicalQuoteV1, no live credential.
 * A photograph is archived_private only after the archive port reports a matching SHA-256.
 */
export type PhotoArchiveStatus = 'not_provided' | 'pending_private_archive' | 'archived_private';

export type CalibrationPhotoStore = {
  store(input: { caseId: string; bytes: Buffer }): Promise<{
    sha256: string;
    verified: boolean;
  }>;
};

export type CalibrationRecordResult = {
  status: 'created' | 'already_exists' | 'reconciled';
  caseId: string;
  caseCommit: string;
  indexCommit: string;
  photoArchiveStatus: PhotoArchiveStatus;
  photoRefs: string[];
};

const PHOTO_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;

export class CalibrationEngine {
  constructor(
    private readonly writer: CalibrationGithubWriter,
    private readonly photos: CalibrationPhotoStore | null = null,
    private readonly clock: () => string = () => '2026-11-06T18:00:00.000Z',
  ) {}

  async record(input: unknown, images: readonly Buffer[] = []): Promise<CalibrationRecordResult> {
    const quote = validateHumanQuote(input);
    const uniqueImages = dedupeImages(images);
    const written = await this.commitQuote(quote, uniqueImages.length > 0);
    if (written.status === 'already_exists' || uniqueImages.length === 0) {
      return written;
    }
    return this.archivePhotos(written, uniqueImages);
  }

  private async commitQuote(
    quote: ValidatedHumanQuote,
    hasPhotos: boolean,
  ): Promise<CalibrationRecordResult> {
    const occupied = new Set<string>();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const index = await this.writer.readIndex();
      const existingId = index.source_keys[quote.source.source_case_key];
      if (existingId) {
        await this.assertSameObservation(existingId, quote);
        const stored = await this.writer.readCase(existingId);
        return {
          status: 'already_exists',
          caseId: existingId,
          caseCommit: 'pre-existing',
          indexCommit: 'pre-existing',
          photoArchiveStatus: photoStatusOf(stored),
          photoRefs: photoRefsOf(stored),
        };
      }
      const caseId = nextCalibrationCaseId([...Object.keys(index.cases), ...occupied]);
      const photoArchiveStatus: PhotoArchiveStatus = hasPhotos
        ? 'pending_private_archive'
        : 'not_provided';
      const document = {
        ...quote,
        case_id: caseId,
        photo_refs: [] as string[],
        photo_archive_status: photoArchiveStatus,
        created_at: this.clock(),
        updated_at: this.clock(),
      };
      try {
        const result = await this.writer.insert(document);
        if (result.status === 'partial') {
          const recovered = await this.writer.reconcile(result.caseId);
          return resultOf(result, recovered, photoArchiveStatus, 'reconciled');
        }
        if (result.status === 'already_exists') {
          await this.assertSameObservation(result.caseId, quote);
          const stored = await this.writer.readCase(result.caseId);
          return {
            status: 'already_exists',
            caseId: result.caseId,
            caseCommit: 'pre-existing',
            indexCommit: 'pre-existing',
            photoArchiveStatus: photoStatusOf(stored),
            photoRefs: photoRefsOf(stored),
          };
        }
        return {
          status: 'created',
          caseId: result.caseId,
          caseCommit: result.caseCommit,
          indexCommit: result.indexCommit,
          photoArchiveStatus,
          photoRefs: [],
        };
      } catch (err) {
        const retryable =
          err instanceof CalibrationConflictError &&
          (err.message === 'Case file already exists' ||
            err.message === 'Case ID already assigned' ||
            err.message === 'Existing unindexed case differs');
        if (retryable) {
          occupied.add(caseId);
          continue;
        }
        throw err;
      }
    }
    throw new CalibrationConflictError('Concurrent case allocation was not resolved');
  }

  private async archivePhotos(
    written: CalibrationRecordResult,
    images: readonly Buffer[],
  ): Promise<CalibrationRecordResult> {
    if (!this.photos) return { ...written, photoArchiveStatus: 'pending_private_archive', photoRefs: [] };
    try {
      const refs: string[] = [];
      for (let index = 0; index < images.length; index += 1) {
        const bytes = images[index]!;
        const local = validateCalibrationImage(bytes);
        const stored = await this.photos.store({ caseId: written.caseId, bytes });
        if (!stored.verified || stored.sha256 !== local.sha256) {
          return { ...written, photoArchiveStatus: 'pending_private_archive', photoRefs: [] };
        }
        const photoId = `IMG-${String(index + 1).padStart(6, '0')}`;
        await this.writer.saveVerifiedPhoto({
          schema_version: '1.0.0',
          photo_id: photoId,
          case_id: written.caseId,
          storage_provider: 'cloudinary',
          storage_status: 'verified',
          asset_public_id: null,
          asset_version: null,
          delivery_type: 'authenticated',
          content_sha256: local.sha256,
          mime_type: PHOTO_MIME[local.format],
          size_bytes: bytes.length,
          width: null,
          height: null,
          linked_line_ids: [],
          verified_at: this.clock(),
          source_kind: 'manual_import',
        });
        refs.push(photoId);
      }
      const caseCommit = await this.writer.updateVerifiedPhotos({
        caseId: written.caseId,
        photoRefs: refs,
        updatedAt: this.clock(),
      });
      return {
        ...written,
        caseCommit,
        photoArchiveStatus: 'archived_private',
        photoRefs: refs,
      };
    } catch {
      return { ...written, photoArchiveStatus: 'pending_private_archive', photoRefs: [] };
    }
  }

  private async assertSameObservation(caseId: string, quote: ValidatedHumanQuote): Promise<void> {
    const stored = await this.writer.readCase(caseId);
    if (!stored || fingerprint(stored) !== fingerprint(quote)) {
      throw new CalibrationConflictError('Source key already records a different observation');
    }
  }
}

export function confirmArchiveChecksum(localSha256: string, downloadedSha256: string | null): boolean {
  return downloadedSha256 !== null && /^[a-f0-9]{64}$/.test(downloadedSha256) && downloadedSha256 === localSha256;
}

function dedupeImages(images: readonly Buffer[]): Buffer[] {
  const seen = new Set<string>();
  const unique: Buffer[] = [];
  for (const bytes of images) {
    const { sha256 } = validateCalibrationImage(bytes);
    if (seen.has(sha256)) continue;
    seen.add(sha256);
    unique.push(bytes);
  }
  return unique;
}

function fingerprint(value: Record<string, unknown> | ValidatedHumanQuote): string {
  const record = value as Record<string, unknown>;
  const stable = {
    source: record.source ?? null,
    vehicle: record.vehicle ?? null,
    line_items: record.line_items ?? null,
    visual_observations: record.visual_observations ?? [],
    status: record.status ?? null,
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function photoStatusOf(stored: Record<string, unknown> | null): PhotoArchiveStatus {
  const status = stored?.photo_archive_status;
  if (status === 'archived_private' || status === 'pending_private_archive' || status === 'not_provided') {
    return status;
  }
  return 'not_provided';
}

function photoRefsOf(stored: Record<string, unknown> | null): string[] {
  return Array.isArray(stored?.photo_refs) ? stored.photo_refs.filter((ref) => typeof ref === 'string') : [];
}

function resultOf(
  written: Extract<GitHubCaseWriteResult, { status: 'partial' }>,
  recovered: GitHubCaseWriteResult,
  photoArchiveStatus: PhotoArchiveStatus,
  status: 'reconciled',
): CalibrationRecordResult {
  return {
    status,
    caseId: written.caseId,
    caseCommit: written.caseCommit,
    indexCommit: recovered.status === 'created' ? recovered.indexCommit : 'pre-existing',
    photoArchiveStatus,
    photoRefs: [],
  };
}

