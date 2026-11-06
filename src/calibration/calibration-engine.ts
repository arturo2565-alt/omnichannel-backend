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
  CalibrationWriteError,
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
    assetPublicId?: string | null;
    assetVersion?: number | null;
  }>;
};

export type CalibrationRecordResult = {
  status: 'created' | 'already_exists' | 'reconciled';
  caseId: string;
  caseCommit: string;
  indexCommit: string;
  photoArchiveStatus: PhotoArchiveStatus;
  /** Refs already linked on the case. Empty while the case is still pending. */
  photoRefs: string[];
  /** Manifests stored for this case but not linked yet. They are not deleted. */
  orphanPhotoRefs: string[];
};

export type CalibrationRetryPolicy = {
  /** Collisions that allocate another case id. The default remains five. */
  maxAllocationAttempts: number;
  /** Extra attempts for 429 and 5xx. They reuse the same case id. */
  maxTransientAttempts: number;
  baseDelayMs: number;
  jitterRatio: number;
};

export const DEFAULT_CALIBRATION_RETRY: CalibrationRetryPolicy = {
  maxAllocationAttempts: 5,
  maxTransientAttempts: 3,
  baseDelayMs: 25,
  jitterRatio: 0.2,
};

export type ManifestAssessment = 'linked' | 'orphan_recoverable' | 'unproven';

export function retryDelayMs(
  attempt: number,
  policy: Pick<CalibrationRetryPolicy, 'baseDelayMs' | 'jitterRatio'>,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt);
  const base = policy.baseDelayMs * 2 ** exponent;
  const ratio = Math.min(Math.max(policy.jitterRatio, 0), 1);
  const sample = Math.min(Math.max(random(), 0), 1);
  return Math.round(base + base * ratio * sample);
}

export function assessPhotoManifest(input: {
  caseExists: boolean;
  referenced: boolean;
  pathCaseId: string;
  pathPhotoId: string;
  manifest: {
    case_id?: unknown;
    photo_id?: unknown;
    content_sha256?: unknown;
    storage_status?: unknown;
  } | null;
}): ManifestAssessment {
  if (!input.caseExists || !input.manifest) return 'unproven';
  if (input.referenced) return 'linked';
  const checksum = input.manifest.content_sha256;
  const proven =
    input.manifest.case_id === input.pathCaseId &&
    input.manifest.photo_id === input.pathPhotoId &&
    input.manifest.storage_status === 'verified' &&
    typeof checksum === 'string' &&
    /^[a-f0-9]{64}$/.test(checksum);
  return proven ? 'orphan_recoverable' : 'unproven';
}

const PHOTO_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;

const delay = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

export class CalibrationEngine {
  private readonly policy: CalibrationRetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly writer: CalibrationGithubWriter,
    private readonly photos: CalibrationPhotoStore | null = null,
    private readonly clock: () => string = () => '2026-11-06T18:00:00.000Z',
    options: {
      retry?: Partial<CalibrationRetryPolicy>;
      sleep?: (ms: number) => Promise<void>;
      random?: () => number;
    } = {},
  ) {
    this.policy = { ...DEFAULT_CALIBRATION_RETRY, ...options.retry };
    this.sleep = options.sleep ?? delay;
    this.random = options.random ?? Math.random;
  }

  async record(input: unknown, images: readonly Buffer[] = []): Promise<CalibrationRecordResult> {
    const quote = validateHumanQuote(input);
    const uniqueImages = dedupeImages(images);
    const written = await this.commitQuote(quote, uniqueImages.length > 0);
    if (uniqueImages.length === 0 || written.photoArchiveStatus === 'archived_private') {
      return written;
    }
    return this.archivePhotos(written, uniqueImages);
  }

  /**
   * Links verified manifests that belong to the case and are not referenced.
   * A manifest without that proof stays on disk. This method does not delete.
   */
  async recoverOrphanManifests(caseId: string, photoIds: readonly string[]): Promise<{
    linked: string[];
    unproven: string[];
    photoArchiveStatus: PhotoArchiveStatus;
  }> {
    const stored = await this.withTransientRetry(() => this.writer.readCase(caseId));
    if (!stored) {
      return { linked: [], unproven: [...photoIds], photoArchiveStatus: 'not_provided' };
    }
    const referenced = new Set(photoRefsOf(stored));
    const recoverable: string[] = [];
    const unproven: string[] = [];
    for (const photoId of photoIds) {
      const manifest = await this.writer.readPhotoManifest(caseId, photoId);
      const assessment = assessPhotoManifest({
        caseExists: true,
        referenced: referenced.has(photoId),
        pathCaseId: caseId,
        pathPhotoId: photoId,
        manifest,
      });
      if (assessment === 'orphan_recoverable') recoverable.push(photoId);
      else if (assessment !== 'linked') unproven.push(photoId);
    }
    if (recoverable.length === 0) {
      return {
        linked: [...referenced],
        unproven,
        photoArchiveStatus: photoStatusOf(stored),
      };
    }
    const linked = [...referenced, ...recoverable];
    await this.withTransientRetry(() => this.writer.updateVerifiedPhotos({
      caseId,
      photoRefs: linked,
      updatedAt: this.clock(),
    }));
    return { linked, unproven, photoArchiveStatus: 'archived_private' };
  }

  private async commitQuote(
    quote: ValidatedHumanQuote,
    hasPhotos: boolean,
  ): Promise<CalibrationRecordResult> {
    const occupied = new Set<string>();
    let allocation = 0;
    while (allocation < this.policy.maxAllocationAttempts) {
      const index = await this.withTransientRetry(() => this.writer.readIndex());
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
          orphanPhotoRefs: [],
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
        const result = await this.withTransientRetry(() => this.writer.insert(document));
        if (result.status === 'partial') {
          const recovered = await this.withTransientRetry(() => this.writer.reconcile(result.caseId));
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
            orphanPhotoRefs: [],
          };
        }
        return {
          status: 'created',
          caseId: result.caseId,
          caseCommit: result.caseCommit,
          indexCommit: result.indexCommit,
          photoArchiveStatus,
          photoRefs: [],
          orphanPhotoRefs: [],
        };
      } catch (err) {
        const collision =
          err instanceof CalibrationConflictError &&
          (err.message === 'Case file already exists' ||
            err.message === 'Case ID already assigned' ||
            err.message === 'Existing unindexed case differs');
        if (collision) {
          occupied.add(caseId);
          allocation += 1;
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
    if (!this.photos) {
      return { ...written, photoArchiveStatus: 'pending_private_archive', photoRefs: [], orphanPhotoRefs: [] };
    }
    const refs: string[] = [];
    try {
      for (let index = 0; index < images.length; index += 1) {
        const bytes = images[index]!;
        const local = validateCalibrationImage(bytes);
        const photoId = `IMG-${String(index + 1).padStart(6, '0')}`;
        const prior = await this.writer.readPhotoManifest(written.caseId, photoId);
        if (prior?.content_sha256 === local.sha256 && prior.storage_status === 'verified') {
          refs.push(photoId);
          continue;
        }
        const stored = await this.photos.store({ caseId: written.caseId, bytes });
        const asset = acceptedPrivateAsset(stored);
        if (!stored.verified || stored.sha256 !== local.sha256 || !asset) {
          return {
            ...written,
            photoArchiveStatus: 'pending_private_archive',
            photoRefs: [],
            orphanPhotoRefs: refs,
          };
        }
        await this.withTransientRetry(() => this.writer.saveVerifiedPhoto({
          schema_version: '1.0.0',
          photo_id: photoId,
          case_id: written.caseId,
          storage_provider: 'cloudinary',
          storage_status: 'verified',
          asset_public_id: asset.assetPublicId,
          asset_version: asset.assetVersion,
          delivery_type: 'authenticated',
          content_sha256: local.sha256,
          mime_type: PHOTO_MIME[local.format],
          size_bytes: bytes.length,
          width: null,
          height: null,
          linked_line_ids: [],
          verified_at: this.clock(),
          source_kind: 'manual_import',
        }));
        refs.push(photoId);
      }
      const caseCommit = await this.withTransientRetry(() => this.writer.updateVerifiedPhotos({
        caseId: written.caseId,
        photoRefs: refs,
        updatedAt: this.clock(),
      }));
      return {
        ...written,
        caseCommit,
        photoArchiveStatus: 'archived_private',
        photoRefs: refs,
        orphanPhotoRefs: [],
      };
    } catch {
      return {
        ...written,
        photoArchiveStatus: 'pending_private_archive',
        photoRefs: [],
        orphanPhotoRefs: refs,
      };
    }
  }

  private async withTransientRetry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await operation();
      } catch (err) {
        const recoverable =
          err instanceof CalibrationWriteError &&
          (err.kind === 'rate_limit' || err.kind === 'transient');
        if (!recoverable || attempt >= this.policy.maxTransientAttempts) throw err;
        await this.sleep(retryDelayMs(attempt, this.policy, this.random));
        attempt += 1;
      }
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

const PRIVATE_ASSET_ID = /^[A-Za-z0-9_./-]{1,240}$/;

/** A manifest may name the private asset. It never stores a delivery URL. */
export function acceptedPrivateAsset(stored: {
  assetPublicId?: string | null;
  assetVersion?: number | null;
}): { assetPublicId: string | null; assetVersion: number | null } | null {
  const assetPublicId = stored.assetPublicId ?? null;
  const assetVersion = stored.assetVersion ?? null;
  if (assetPublicId != null && !PRIVATE_ASSET_ID.test(assetPublicId)) return null;
  if (assetVersion != null && (!Number.isInteger(assetVersion) || assetVersion < 1)) return null;
  return { assetPublicId, assetVersion };
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
    orphanPhotoRefs: [],
  };
}

