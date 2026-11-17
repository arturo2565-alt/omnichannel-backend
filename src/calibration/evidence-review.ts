import { randomBytes } from 'node:crypto';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { calibrationQueryAccess } from './calibration-access';
import { CalibrationGithubApp, readGithubAppConfig, type GithubInstallationGrant } from './calibration-github-app';
import { createCloudinaryGateway } from './calibration-cloudinary-archive';
import { EvidenceCloudinaryArchive } from './evidence-cloudinary';
import {
  EvidenceGithub,
  EvidenceLinkError,
  commitOwnerReview,
  evidenceSubjectExists,
  issueOwnerReviewProof,
  linkEvidence,
  ownerActorKey,
  sha256,
  type EvidenceFiles,
  type EvidencePhotoSink,
} from './evidence-link';
import { imageContainsPersonalMetadata, validateCalibrationImage } from './calibration-image-archive.service';

/**
 * Temporary preview of one derivative. It lives in this process, expires,
 * and is not the Cloudinary archive or the quote document.
 */

export const EVIDENCE_PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_PREVIEWS = 20;
const MAX_BYTES = 5 * 1024 * 1024;
const SUBJECT_ID = /^(?:CQ|RQ)-\d{6}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PREVIEW_ID = /^[a-f0-9]{32}$/;

const CLIENT_AUTHORITY = [
  'operatorRole', 'operator_role', 'role', 'email', 'name', 'userId',
  'humanReviewed', 'human_reviewed', 'confirmation', 'visualReview', 'visual_review',
  'attestation', 'authorization', 'actorKey', 'actor_key', 'reviewer', 'previewId',
];
const HOLD_KEYS = new Set(['subjectId', 'receivedSha256', 'bytes']);
const CONFIRM_KEYS = new Set(['subjectId', 'sha256', 'visibleIdentifiersReviewed']);
const HOLD_BODY = new Set(['subjectId', 'receivedSha256', 'imageBase64']);

export class EvidenceReviewError extends Error {
  constructor(
    readonly code: 'hidden' | 'forbidden' | 'unauthorized' | 'invalid' | 'expired' | 'incomplete' | 'conflict' | 'rejected' | 'missing' | 'limit' | 'unavailable',
  ) {
    super(code);
    this.name = 'EvidenceReviewError';
  }
}

type PreviewSlot = {
  previewId: string;
  actorKey: string;
  subjectId: string;
  receivedSha256: string;
  sha256: string;
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  bytes: Buffer;
  expiresAt: number;
  viewed: boolean;
};

export class EvidencePreviewVault {
  private readonly slots = new Map<string, PreviewSlot>();

  constructor(private readonly clock: () => number = Date.now) {}

  hold(input: {
    actorKey: string;
    subjectId: string;
    receivedSha256: string;
    sha256: string;
    mime: PreviewSlot['mime'];
    bytes: Buffer;
  }): { previewId: string; sha256: string; expiresAt: string } {
    this.evict();
    if (this.slots.size >= MAX_PREVIEWS) throw new EvidenceReviewError('limit');
    const previewId = randomBytes(16).toString('hex');
    const expiresAt = this.clock() + EVIDENCE_PREVIEW_TTL_MS;
    this.slots.set(previewId, {
      ...input,
      previewId,
      bytes: Buffer.from(input.bytes),
      expiresAt,
      viewed: false,
    });
    return { previewId, sha256: input.sha256, expiresAt: new Date(expiresAt).toISOString() };
  }

  open(actorKey: string, previewId: string, markViewed: boolean): PreviewSlot | 'missing' | 'expired' {
    if (!PREVIEW_ID.test(previewId)) return 'missing';
    const slot = this.slots.get(previewId);
    if (!slot || slot.actorKey !== actorKey) return 'missing';
    if (this.clock() >= slot.expiresAt) {
      this.slots.delete(previewId);
      return 'expired';
    }
    if (markViewed) slot.viewed = true;
    return slot;
  }

  drop(actorKey: string, previewId: string): boolean {
    if (!PREVIEW_ID.test(previewId)) return false;
    const slot = this.slots.get(previewId);
    if (!slot || slot.actorKey !== actorKey) return false;
    this.slots.delete(previewId);
    return true;
  }

  private evict(): void {
    for (const [id, slot] of this.slots) {
      if (this.clock() >= slot.expiresAt) this.slots.delete(id);
    }
  }
}

export type EvidenceReviewDependencies = {
  files?: EvidenceFiles;
  photos?: EvidencePhotoSink;
  vault?: EvidencePreviewVault;
  env?: NodeJS.ProcessEnv;
  transport?: typeof fetch;
  clock?: () => number;
};

export type EvidenceArchiveReceipt = {
  status: 'attested' | 'already_attested';
  archive: 'linked' | 'already_linked' | 'link_pending';
  reviewId: string;
  evidenceId: string;
  sha256: string;
  failure?: string;
};

export class EvidenceReviewDesk {
  private readonly vault: EvidencePreviewVault;
  private readonly lanes = new Map<string, Promise<void>>();
  private live: EvidenceFiles | null = null;
  private livePhotos: EvidencePhotoSink | null = null;

  constructor(private readonly deps: EvidenceReviewDependencies = {}) {
    this.vault = deps.vault ?? new EvidencePreviewVault(deps.clock);
  }

  async hold(
    user: AuthenticatedUser | undefined,
    input: { subjectId: string; receivedSha256: string; bytes: Buffer },
  ): Promise<{ previewId: string; sha256: string; expiresAt: string }> {
    const actor = this.gate(user);
    return this.attempt(async () => {
      rejectClientFields(input, HOLD_KEYS);
      if (!SUBJECT_ID.test(input.subjectId) || !SHA256.test(input.receivedSha256) || !Buffer.isBuffer(input.bytes)) {
        throw new EvidenceReviewError('invalid');
      }
      const files = this.files();
      if (!(await evidenceSubjectExists(files, input.subjectId))) throw new EvidenceReviewError('missing');
      if (imageContainsPersonalMetadata(input.bytes)) throw new EvidenceReviewError('rejected');
      let checked: { format: 'jpg' | 'png' | 'webp'; sha256: string };
      try {
        checked = validateCalibrationImage(input.bytes);
      } catch {
        throw new EvidenceReviewError('invalid');
      }
      if (checked.sha256 === input.receivedSha256) throw new EvidenceReviewError('rejected');
      return this.vault.hold({
        actorKey: ownerActorKey(actor.userId),
        subjectId: input.subjectId,
        receivedSha256: input.receivedSha256,
        sha256: checked.sha256,
        mime: imageMime(checked.format),
        bytes: input.bytes,
      });
    });
  }

  async read(
    user: AuthenticatedUser | undefined,
    previewId: string,
  ): Promise<{ bytes: Buffer; mime: PreviewSlot['mime']; sha256: string }> {
    const actor = this.gate(user);
    const slot = this.vault.open(ownerActorKey(actor.userId), previewId, true);
    if (slot === 'expired') throw new EvidenceReviewError('expired');
    if (slot === 'missing') throw new EvidenceReviewError('missing');
    return { bytes: Buffer.from(slot.bytes), mime: slot.mime, sha256: slot.sha256 };
  }

  async confirm(
    user: AuthenticatedUser | undefined,
    previewId: string,
    input: { subjectId: string; sha256: string; visibleIdentifiersReviewed: boolean },
  ): Promise<EvidenceArchiveReceipt> {
    return this.lane(previewId, () => this.attempt(async () => {
      const prepared = await this.reviewedSlot(user, previewId, input);
      const photos = this.photoSink();
      const stored = await this.commitReviewed(prepared);
      const linked = await linkEvidence(this.files(), photos, {
        subjectId: prepared.subjectId,
        approval: 'anonymized_copy',
        receivedSha256: prepared.receivedSha256,
        bytes: prepared.bytes,
      });
      if (linked.status !== 'linked' && linked.status !== 'already_linked' && linked.status !== 'link_pending') {
        throw new EvidenceReviewError('conflict');
      }
      if (linked.status === 'linked' || linked.status === 'already_linked') this.vault.drop(prepared.actorKey, previewId);
      return {
        status: stored.status,
        archive: linked.status,
        reviewId: stored.reviewId,
        evidenceId: linked.evidenceId,
        sha256: prepared.actual,
        ...(linked.status === 'link_pending' && linked.failure ? { failure: linked.failure } : {}),
      };
    }));
  }

  async recordReview(
    user: AuthenticatedUser | undefined,
    previewId: string,
    input: { subjectId: string; sha256: string; visibleIdentifiersReviewed: boolean },
  ): Promise<{ status: 'attested' | 'already_attested'; reviewId: string; evidenceId: string; sha256: string }> {
    return this.lane(previewId, () => this.attempt(async () => {
      const prepared = await this.reviewedSlot(user, previewId, input);
      const stored = await this.commitReviewed(prepared);
      return {
        status: stored.status,
        reviewId: stored.reviewId,
        evidenceId: stored.evidenceId,
        sha256: prepared.actual,
      };
    }));
  }

  async cancel(user: AuthenticatedUser | undefined, previewId: string): Promise<{ status: 'cleared' }> {
    const actor = this.gate(user);
    const actorKey = ownerActorKey(actor.userId);
    const slot = this.vault.open(actorKey, previewId, false);
    if (slot === 'expired') return { status: 'cleared' };
    if (slot === 'missing' || !this.vault.drop(actorKey, previewId)) throw new EvidenceReviewError('missing');
    return { status: 'cleared' };
  }

  private async reviewedSlot(
    user: AuthenticatedUser | undefined,
    previewId: string,
    input: { subjectId: string; sha256: string; visibleIdentifiersReviewed: boolean },
  ): Promise<{
    actor: AuthenticatedUser;
    actorKey: string;
    bytes: Buffer;
    actual: string;
    subjectId: string;
    receivedSha256: string;
  }> {
    const actor = this.gate(user);
    rejectClientFields(input, CONFIRM_KEYS);
    if (input.visibleIdentifiersReviewed !== true) throw new EvidenceReviewError('incomplete');
    const actorKey = ownerActorKey(actor.userId);
    const slot = this.vault.open(actorKey, previewId, false);
    if (slot === 'expired') throw new EvidenceReviewError('expired');
    if (slot === 'missing') throw new EvidenceReviewError('missing');
    if (!slot.viewed) throw new EvidenceReviewError('incomplete');
    if (input.subjectId !== slot.subjectId) throw new EvidenceReviewError('conflict');
    const actual = sha256(slot.bytes);
    if (input.sha256 !== slot.sha256 || input.sha256 !== actual) throw new EvidenceReviewError('conflict');
    return {
      actor,
      actorKey,
      bytes: Buffer.from(slot.bytes),
      actual,
      subjectId: slot.subjectId,
      receivedSha256: slot.receivedSha256,
    };
  }

  private async commitReviewed(prepared: {
    actor: AuthenticatedUser;
    bytes: Buffer;
    actual: string;
    subjectId: string;
    receivedSha256: string;
  }): Promise<{ status: 'attested' | 'already_attested'; reviewId: string; evidenceId: string }> {
    const proof = issueOwnerReviewProof(this.environment(), prepared.actor, {
      subjectId: prepared.subjectId,
      receivedSha256: prepared.receivedSha256,
      reviewedSha256: prepared.actual,
      visibleIdentifiersReviewed: true,
    });
    return commitOwnerReview(this.files(), proof);
  }

  private gate(user: AuthenticatedUser | undefined): AuthenticatedUser {
    const access = calibrationQueryAccess(this.environment(), user);
    if (access === 'hidden') throw new EvidenceReviewError('hidden');
    if (!user) throw new EvidenceReviewError('unauthorized');
    if (access !== 'open') throw new EvidenceReviewError('forbidden');
    return user;
  }

  private environment(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  private files(): EvidenceFiles {
    if (this.deps.files) return this.deps.files;
    if (!this.live) this.live = openEvidenceFiles(this.environment(), this.deps.transport ?? fetch);
    return this.live;
  }

  private photoSink(): EvidencePhotoSink {
    if (this.deps.photos) return this.deps.photos;
    if (!this.livePhotos) this.livePhotos = openEvidencePhotos(this.environment(), this.deps.transport ?? fetch);
    return this.livePhotos;
  }

  private lane<T>(previewId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(previewId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.then(() => undefined, () => undefined);
    this.lanes.set(previewId, settled);
    void settled.finally(() => {
      if (this.lanes.get(previewId) === settled) this.lanes.delete(previewId);
    });
    return run;
  }

  private async attempt<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof EvidenceReviewError) throw err;
      if (err instanceof EvidenceLinkError) {
        if (err.code === 'missing') throw new EvidenceReviewError('missing');
        if (err.code === 'conflict') throw new EvidenceReviewError('conflict');
        if (err.code === 'limit') throw new EvidenceReviewError('limit');
        throw new EvidenceReviewError('rejected');
      }
      throw new EvidenceReviewError('unavailable');
    }
  }
}

export function evidenceWriteGrantAllowed(grant: GithubInstallationGrant | null): boolean {
  if (!grant || grant.repositorySelection !== 'selected') return false;
  if (grant.permissions.contents !== 'write') return false;
  const metadata = grant.permissions.metadata;
  if (metadata != null && metadata !== 'read') return false;
  return Object.keys(grant.permissions).every((key) => key === 'contents' || key === 'metadata');
}

export function openEvidenceFiles(env: NodeJS.ProcessEnv, transport: typeof fetch): EvidenceFiles {
  let config: ReturnType<typeof readGithubAppConfig>;
  try {
    config = readGithubAppConfig(env);
  } catch {
    throw new EvidenceReviewError('unavailable');
  }
  if (!config) throw new EvidenceReviewError('unavailable');
  const app = new CalibrationGithubApp(config, transport);
  return new EvidenceGithub(transport, async () => {
    try {
      const token = await app.authorization();
      if (!evidenceWriteGrantAllowed(app.installationGrant()) || !token.startsWith('ghs_')) {
        throw new EvidenceReviewError('unavailable');
      }
      return `Bearer ${token}`;
    } catch (err) {
      if (err instanceof EvidenceReviewError) throw err;
      throw new EvidenceReviewError('unavailable');
    }
  });
}

export function parseEvidencePreviewHold(body: unknown): { subjectId: string; receivedSha256: string; bytes: Buffer } {
  const record = plainRecord(body);
  rejectClientFields(record, HOLD_BODY);
  if (typeof record.subjectId !== 'string' || typeof record.receivedSha256 !== 'string' || typeof record.imageBase64 !== 'string') {
    throw new EvidenceReviewError('invalid');
  }
  if (record.imageBase64.length === 0 || record.imageBase64.length > 7_000_000) throw new EvidenceReviewError('invalid');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(record.imageBase64)) throw new EvidenceReviewError('invalid');
  const bytes = Buffer.from(record.imageBase64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new EvidenceReviewError('invalid');
  return { subjectId: record.subjectId, receivedSha256: record.receivedSha256, bytes };
}

export function parseEvidencePreviewConfirm(body: unknown): { subjectId: string; sha256: string; visibleIdentifiersReviewed: boolean } {
  const record = plainRecord(body);
  rejectClientFields(record, CONFIRM_KEYS);
  if (typeof record.subjectId !== 'string' || typeof record.sha256 !== 'string' || typeof record.visibleIdentifiersReviewed !== 'boolean') {
    throw new EvidenceReviewError('invalid');
  }
  return {
    subjectId: record.subjectId,
    sha256: record.sha256,
    visibleIdentifiersReviewed: record.visibleIdentifiersReviewed,
  };
}

function plainRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new EvidenceReviewError('invalid');
  return body as Record<string, unknown>;
}

function rejectClientFields(input: object, allowed: Set<string>): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new EvidenceReviewError('invalid');
  const record = input as Record<string, unknown>;
  if (CLIENT_AUTHORITY.some((key) => Object.prototype.hasOwnProperty.call(record, key))) {
    throw new EvidenceReviewError('rejected');
  }
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new EvidenceReviewError('rejected');
}

function openEvidencePhotos(env: NodeJS.ProcessEnv, transport: typeof fetch): EvidencePhotoSink {
  const gateway = createCloudinaryGateway(env, transport);
  if (!gateway) throw new EvidenceReviewError('unavailable');
  const archive = new EvidenceCloudinaryArchive();
  return { store: (input) => archive.store(gateway, input) };
}

function imageMime(format: 'jpg' | 'png' | 'webp'): PreviewSlot['mime'] {
  if (format === 'jpg') return 'image/jpeg';
  if (format === 'png') return 'image/png';
  return 'image/webp';
}
