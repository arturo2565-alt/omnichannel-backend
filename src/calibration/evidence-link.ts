import { createHash } from 'node:crypto';
import { CalibrationWriteError, classifyGithubFailure } from './calibration-github-writer';
import { imageContainsPersonalMetadata, validateCalibrationImage } from './calibration-image-archive.service';
import { evidencePublicId, type EvidencePhotoReceipt } from './evidence-cloudinary';

/**
 * Linked evidence for one CQ or RQ document. It does not rewrite the quote,
 * create an AF case, or store the received bytes.
 */

export const EVIDENCE_SCHEMA_VERSION = '1.0.0';
const SUBJECT_ID = /^(?:CQ|RQ)-\d{6}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ITEMS = 30;
const WRITE_PATH = /^data\/evidence\/(?:index\.json|(?:commercial\/CQ-\d{6}|repairs\/RQ-\d{6})\/(?:index\.json|links\/LN-\d{6}\.json|manifests\/EV-\d{6}\.json|reviews\/index\.json|reviews\/RV-\d{6}\.json))$/;
export const EVIDENCE_CATALOG_PATH = 'data/evidence/index.json';
const SELF_REVIEW = ['humanReviewed', 'human_reviewed', 'visualReview', 'visual_review', 'attestation', 'review', 'reviewer', 'operator', 'operatorRole', 'operator_role', 'confirmation', 'email', 'name'];
const REVIEW_FIELDS = new Set(['subjectId', 'receivedSha256', 'reviewedSha256', 'operatorRole', 'confirmation']);
const QUOTE_PATH = /^data\/(?:commercial\/quotes\/CQ-\d{6}|repairs\/quotes\/RQ-\d{6})\.json$/;
const BLOCKED = ['data/cases/', 'data/photos/', 'data/probes', 'data/index.json', 'AF-', 'cal008-probe', 'cal010-probe'];

export class EvidenceLinkError extends Error {
  constructor(readonly code: 'invalid' | 'missing' | 'conflict' | 'rejected' | 'limit' | 'metadata' | 'review_required') {
    super(code);
    this.name = 'EvidenceLinkError';
  }
}

export type EvidenceApproval = 'anonymized_copy' | 'privacy_hold';
export type EvidenceState = 'verified' | 'privacy_pending' | 'link_pending';

export type EvidenceFiles = {
  read(path: string): Promise<{ content: string; sha: string } | null>;
  write(path: string, content: string, sha?: string): Promise<string>;
};

export type EvidencePhotoSink = {
  store(input: { subjectId: string; evidenceId: string; bytes: Buffer }): Promise<EvidencePhotoReceipt>;
};

export type EvidenceRequest = {
  subjectId: string;
  approval: EvidenceApproval;
  receivedSha256: string;
  bytes?: Buffer;
};

export type HumanReviewRequest = {
  subjectId: string;
  receivedSha256: string;
  reviewedSha256: string;
  operatorRole: 'owner';
  confirmation: 'human_reviewed';
};

export type EvidenceResult =
  | { status: 'privacy_pending' | 'linked' | 'link_pending'; evidenceId: string; linkId: string; failure?: string }
  | { status: 'already_recorded' | 'already_linked'; evidenceId: string };

type EvidenceItem = {
  evidence_id: string;
  link_id: string;
  state: EvidenceState;
  received_sha256: string;
  content_sha256: string | null;
  provenance: 'anonymized_copy' | null;
};

type EvidenceIndex = {
  schema_version: typeof EVIDENCE_SCHEMA_VERSION;
  subject_kind: 'commercial_quote' | 'repair_quote';
  subject_id: string;
  items: EvidenceItem[];
  link_ids: string[];
};

export function evidenceIndexPath(subjectId: string): string {
  return `${evidenceDirectory(subjectId)}/index.json`;
}

export function assertEvidenceRead(path: string): void {
  const bare = path.split('?')[0];
  if (BLOCKED.some((needle) => bare.includes(needle)) || (!WRITE_PATH.test(bare) && !QUOTE_PATH.test(bare))) {
    throw new EvidenceLinkError('rejected');
  }
}

export function assertEvidenceWrite(path: string): void {
  const bare = path.split('?')[0];
  if (BLOCKED.some((needle) => bare.includes(needle)) || QUOTE_PATH.test(bare) || !WRITE_PATH.test(bare)) {
    throw new EvidenceLinkError('rejected');
  }
}

export function presentEvidenceItems(content: string, subjectId: string): EvidenceItem[] {
  const index = parseIndex(content, subjectId);
  return index ? index.items.map(publicItem) : [];
}

export function evidenceByteTarget(content: string, subjectId: string, evidenceId: string): {
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  publicId: string;
  version: number;
  format: 'jpg' | 'png' | 'webp';
  sha256: string;
  reviewId: string;
} | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  const sha = typeof parsed.content_sha256 === 'string' ? parsed.content_sha256 : '';
  const publicId = typeof parsed.asset_public_id === 'string' ? parsed.asset_public_id : '';
  const version = Number(parsed.asset_version);
  const format = mimeFormat(parsed.mime_type);
  if (
    parsed.subject_id !== subjectId
    || parsed.evidence_id !== evidenceId
    || parsed.storage_status !== 'verified'
    || parsed.provenance !== 'anonymized_copy'
    || parsed.visual_review !== undefined
    || parsed.reviewed_sha256 !== sha
    || parsed.review_confirmation !== 'human_reviewed'
    || parsed.operator_role !== 'owner'
    || !/^RV-\d{6}$/.test(String(parsed.human_review_id))
    || parsed.delivery_type !== 'authenticated'
    || !format
    || !SHA256.test(sha)
    || publicId !== evidencePublicId(subjectId, evidenceId, sha)
    || !Number.isInteger(version)
    || version < 1
  ) {
    return null;
  }
  return { mime: format.mime, publicId, version, format: format.format, sha256: sha, reviewId: String(parsed.human_review_id) };
}

export function evidenceReviewMatches(content: string, subjectId: string, reviewId: string, sha256Value: string): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return false;
  }
  const serialized = content.toLowerCase();
  if (serialized.includes('@') || /\brostro|\bplaca|\bvin\b|email|nombre/.test(serialized)) return false;
  return parsed.review_id === reviewId
    && parsed.subject_id === subjectId
    && parsed.reviewed_sha256 === sha256Value
    && parsed.confirmation === 'human_reviewed'
    && parsed.operator_role === 'owner'
    && !('visual_review' in parsed)
    && !('email' in parsed);
}

export async function attestHumanReview(
  files: EvidenceFiles,
  request: HumanReviewRequest,
): Promise<{ status: 'attested' | 'already_attested'; reviewId: string }> {
  rejectUnexpectedReview(request);
  const subjectId = request.subjectId;
  if (!SUBJECT_ID.test(subjectId) || !SHA256.test(request.receivedSha256) || !SHA256.test(request.reviewedSha256)) {
    throw new EvidenceLinkError('invalid');
  }
  if (request.operatorRole !== 'owner' || request.confirmation !== 'human_reviewed') throw new EvidenceLinkError('rejected');
  if (request.receivedSha256 === request.reviewedSha256) throw new EvidenceLinkError('rejected');
  if (!(await readQuote(files, subjectId))) throw new EvidenceLinkError('missing');
  const indexPath = reviewIndexPath(subjectId);
  const indexFile = await files.read(indexPath);
  const reviews = indexFile ? requireReviews(indexFile.content, subjectId) : [];
  const sameBytes = reviews.find((item) => item.reviewed_sha256 === request.reviewedSha256);
  if (sameBytes && sameBytes.received_sha256 !== request.receivedSha256) throw new EvidenceLinkError('conflict');
  if (sameBytes) return { status: 'already_attested', reviewId: sameBytes.review_id };
  if (reviews.length >= MAX_ITEMS) throw new EvidenceLinkError('limit');
  const reviewId = nextId('RV', reviews.map((item) => item.review_id));
  const document = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    review_id: reviewId,
    subject_kind: subjectId.startsWith('CQ-') ? 'commercial_quote' : 'repair_quote',
    subject_id: subjectId,
    received_sha256: request.receivedSha256,
    reviewed_sha256: request.reviewedSha256,
    confirmation: 'human_reviewed',
    operator_role: 'owner',
  };
  await createDocument(files, reviewPath(subjectId, reviewId), document);
  reviews.push({ review_id: reviewId, received_sha256: request.receivedSha256, reviewed_sha256: request.reviewedSha256 });
  await files.write(indexPath, canonical({
    schema_version: EVIDENCE_SCHEMA_VERSION,
    subject_kind: document.subject_kind,
    subject_id: subjectId,
    reviews,
  }), indexFile?.sha);
  return { status: 'attested', reviewId };
}

export async function linkEvidence(
  files: EvidenceFiles,
  photos: EvidencePhotoSink,
  request: EvidenceRequest,
): Promise<EvidenceResult> {
  const subjectId = request.subjectId;
  rejectSelfReview(request);
  if (!SUBJECT_ID.test(subjectId) || !SHA256.test(request.receivedSha256)) throw new EvidenceLinkError('invalid');
  if (request.approval !== 'anonymized_copy' && request.approval !== 'privacy_hold') {
    throw new EvidenceLinkError('rejected');
  }
  const quote = await readQuote(files, subjectId);
  if (!quote) throw new EvidenceLinkError('missing');
  const indexPath = evidenceIndexPath(subjectId);
  const indexFile = await files.read(indexPath);
  const index = indexFile ? requireIndex(indexFile.content, subjectId) : emptyIndex(subjectId);
  if (request.approval === 'privacy_hold') return holdPrivacy(files, index, indexFile?.sha, request.receivedSha256, request.bytes);
  if (!request.bytes) throw new EvidenceLinkError('rejected');
  return archiveDerivative(files, photos, index, indexFile?.sha, subjectId, request.receivedSha256, request.bytes);
}

export class EvidenceGithub implements EvidenceFiles {
  constructor(
    private readonly transport: typeof fetch,
    private readonly authorization: () => Promise<string>,
    private readonly repository = 'arturo2565-alt/pegazuz-calibration-data',
  ) {}

  async read(path: string): Promise<{ content: string; sha: string } | null> {
    assertEvidenceRead(path);
    const response = await this.request('GET', path);
    if (response.status === 404) return null;
    if (!response.ok) throw new EvidenceLinkError('rejected');
    const payload = await response.json() as { content?: unknown; sha?: unknown };
    if (typeof payload.content !== 'string' || typeof payload.sha !== 'string') throw new EvidenceLinkError('rejected');
    return {
      sha: payload.sha,
      content: Buffer.from(payload.content.replace(/\s/g, ''), 'base64').toString('utf8'),
    };
  }

  async write(path: string, content: string, sha?: string): Promise<string> {
    assertEvidenceWrite(path);
    if (content.includes('https://') || content.includes('http://')) throw new EvidenceLinkError('rejected');
    const response = await this.request('PUT', path, {
      message: `evidence: ${path.split('/').slice(-2).join('/')}`,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: 'main',
      ...(sha ? { sha } : {}),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new CalibrationWriteError(`GitHub PUT returned ${response.status}`, response.status, classifyGithubFailure(response.status, detail.slice(0, 300)));
    }
    const payload = await response.json() as { commit?: { sha?: string } };
    if (!payload.commit?.sha) throw new CalibrationWriteError('Missing commit receipt');
    return payload.commit.sha;
  }

  private async request(method: 'GET' | 'PUT', path: string, body?: object): Promise<Response> {
    const url = `https://api.github.com/repos/${this.repository}/contents/${path}${method === 'GET' ? '?ref=main' : ''}`;
    assertEvidenceTransport(url, method);
    return this.transport(url, {
      method,
      headers: {
        Authorization: await this.authorization(),
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}

export function assertEvidenceTransport(rawUrl: string, method: string): void {
  const url = new URL(rawUrl);
  const verb = method.toUpperCase();
  if (url.protocol !== 'https:' || url.hostname !== 'api.github.com') throw new EvidenceLinkError('rejected');
  const prefix = '/repos/arturo2565-alt/pegazuz-calibration-data/contents/';
  if (!url.pathname.startsWith(prefix)) throw new EvidenceLinkError('rejected');
  const path = decodeURIComponent(url.pathname.slice(prefix.length));
  if (verb === 'GET') {
    if (url.search !== '?ref=main') throw new EvidenceLinkError('rejected');
    assertEvidenceRead(path);
    return;
  }
  if (verb !== 'PUT' || url.search !== '') throw new EvidenceLinkError('rejected');
  assertEvidenceWrite(path);
}

function evidenceDirectory(subjectId: string): string {
  if (!SUBJECT_ID.test(subjectId)) throw new EvidenceLinkError('invalid');
  const folder = subjectId.startsWith('CQ-') ? 'commercial' : 'repairs';
  return `data/evidence/${folder}/${subjectId}`;
}

function quotePath(subjectId: string): string {
  return subjectId.startsWith('CQ-')
    ? `data/commercial/quotes/${subjectId}.json`
    : `data/repairs/quotes/${subjectId}.json`;
}

async function readQuote(files: EvidenceFiles, subjectId: string): Promise<boolean> {
  const file = await files.read(quotePath(subjectId));
  if (!file) return false;
  try {
    const parsed = JSON.parse(file.content) as { quote_id?: unknown };
    return parsed.quote_id === subjectId;
  } catch {
    return false;
  }
}

async function holdPrivacy(
  files: EvidenceFiles,
  index: EvidenceIndex,
  indexSha: string | undefined,
  receivedSha256: string,
  bytes: Buffer | undefined,
): Promise<EvidenceResult> {
  if (bytes) throw new EvidenceLinkError('rejected');
  const existing = index.items.find((item) => item.received_sha256 === receivedSha256);
  if (existing) {
    await publishCatalog(files, index.subject_id, index);
    return { status: 'already_recorded', evidenceId: existing.evidence_id };
  }
  assertRoom(index);
  const evidenceId = nextId('EV', index.items.map((item) => item.evidence_id));
  const linkId = nextId('LN', index.link_ids);
  const link = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    link_id: linkId,
    evidence_id: evidenceId,
    subject_kind: index.subject_kind,
    subject_id: index.subject_id,
    action: 'privacy_pending',
    provenance: null,
    received_sha256: receivedSha256,
    content_sha256: null,
    disposition: 'privacy_hold',
  };
  await createDocument(files, `${evidenceDirectory(index.subject_id)}/links/${linkId}.json`, link);
  index.items.push({
    evidence_id: evidenceId,
    link_id: linkId,
    state: 'privacy_pending',
    received_sha256: receivedSha256,
    content_sha256: null,
    provenance: null,
  });
  index.link_ids.push(linkId);
  await files.write(evidenceIndexPath(index.subject_id), canonical(index), indexSha);
  await publishCatalog(files, index.subject_id, index);
  return { status: 'privacy_pending', evidenceId, linkId };
}

async function archiveDerivative(
  files: EvidenceFiles,
  photos: EvidencePhotoSink,
  index: EvidenceIndex,
  indexSha: string | undefined,
  subjectId: string,
  receivedSha256: string,
  bytes: Buffer,
): Promise<EvidenceResult> {
  if (imageContainsPersonalMetadata(bytes)) throw new EvidenceLinkError('metadata');
  let checked: { format: 'jpg' | 'png' | 'webp'; sha256: string };
  try {
    checked = validateCalibrationImage(bytes);
  } catch {
    throw new EvidenceLinkError('rejected');
  }
  if (checked.sha256 === receivedSha256) throw new EvidenceLinkError('rejected');
  const sameContent = index.items.find((item) => item.content_sha256 === checked.sha256);
  if (sameContent && sameContent.received_sha256 !== receivedSha256) throw new EvidenceLinkError('conflict');
  const receivedItem = index.items.find((item) => item.received_sha256 === receivedSha256);
  if (receivedItem && receivedItem.content_sha256 !== checked.sha256) throw new EvidenceLinkError('conflict');
  const review = await findReview(files, subjectId, receivedSha256, checked.sha256);
  if (!review) throw new EvidenceLinkError('review_required');
  if (sameContent?.state === 'verified') {
    await publishCatalog(files, subjectId, index);
    return { status: 'already_linked', evidenceId: sameContent.evidence_id };
  }

  let evidenceId = sameContent?.evidence_id;
  let linkId = sameContent?.link_id ?? '';
  let currentSha = indexSha;
  if (!evidenceId) {
    assertRoom(index);
    evidenceId = nextId('EV', index.items.map((item) => item.evidence_id));
    linkId = nextId('LN', index.link_ids);
    const manifest = manifestDocument(index, evidenceId, receivedSha256, checked, bytes.length, review.review_id, null, null, 'pending');
    await createDocument(files, manifestPath(subjectId, evidenceId), manifest);
    await createDocument(files, linkPath(subjectId, linkId), linkDocument(index, linkId, evidenceId, 'link_pending', receivedSha256, checked.sha256, review.review_id));
    index.items.push({
      evidence_id: evidenceId,
      link_id: linkId,
      state: 'link_pending',
      received_sha256: receivedSha256,
      content_sha256: checked.sha256,
      provenance: 'anonymized_copy',
    });
    index.link_ids.push(linkId);
    currentSha = await files.write(evidenceIndexPath(subjectId), canonical(index), currentSha);
  }

  const manifestFile = await files.read(manifestPath(subjectId, evidenceId));
  if (!manifestFile) throw new EvidenceLinkError('missing');
  const manifest = JSON.parse(manifestFile.content) as Record<string, unknown>;
  if (manifest.content_sha256 !== checked.sha256 || manifest.subject_id !== subjectId) {
    throw new EvidenceLinkError('conflict');
  }
  if (manifest.storage_status !== 'verified') {
    const stored = await photos.store({ subjectId, evidenceId, bytes });
    const expected = evidencePublicId(subjectId, evidenceId, checked.sha256);
    if (!stored.verified || stored.sha256 !== checked.sha256 || stored.assetPublicId !== expected || !stored.assetVersion) {
      return { status: 'link_pending', evidenceId, linkId, failure: stored.failure ?? 'unverified' };
    }
    manifest.storage_status = 'verified';
    manifest.asset_public_id = stored.assetPublicId;
    manifest.asset_version = stored.assetVersion;
    await files.write(manifestPath(subjectId, evidenceId), canonical(manifest), manifestFile.sha);
  }
  const completionId = index.link_ids.includes(linkId) && linkId
    ? nextId('LN', index.link_ids)
    : linkId;
  const completion = linkDocument(index, completionId, evidenceId, 'linked', receivedSha256, checked.sha256, review.review_id);
  await createDocument(files, linkPath(subjectId, completionId), completion);
  const item = index.items.find((entry) => entry.evidence_id === evidenceId);
  if (!item) throw new EvidenceLinkError('missing');
  item.state = 'verified';
  item.link_id = completionId;
  item.provenance = 'anonymized_copy';
  if (!index.link_ids.includes(completionId)) index.link_ids.push(completionId);
  await files.write(evidenceIndexPath(subjectId), canonical(index), currentSha);
  await publishCatalog(files, subjectId, index);
  return { status: 'linked', evidenceId, linkId: completionId };
}

function manifestDocument(
  index: EvidenceIndex,
  evidenceId: string,
  receivedSha256: string,
  checked: { format: 'jpg' | 'png' | 'webp'; sha256: string },
  sizeBytes: number,
  reviewId: string,
  assetPublicId: string | null,
  assetVersion: number | null,
  storageStatus: 'pending' | 'verified',
) {
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    evidence_id: evidenceId,
    subject_kind: index.subject_kind,
    subject_id: index.subject_id,
    storage_provider: 'cloudinary',
    storage_status: storageStatus,
    provenance: 'anonymized_copy',
    received_sha256: receivedSha256,
    content_sha256: checked.sha256,
    human_review_id: reviewId,
    reviewed_sha256: checked.sha256,
    review_confirmation: 'human_reviewed',
    operator_role: 'owner',
    mime_type: checked.format === 'jpg' ? 'image/jpeg' : checked.format === 'png' ? 'image/png' : 'image/webp',
    size_bytes: sizeBytes,
    asset_public_id: assetPublicId,
    asset_version: assetVersion,
    delivery_type: 'authenticated',
  };
}

function linkDocument(
  index: EvidenceIndex,
  linkId: string,
  evidenceId: string,
  action: 'link_pending' | 'linked',
  receivedSha256: string,
  contentSha256: string,
  reviewId: string,
) {
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    link_id: linkId,
    evidence_id: evidenceId,
    subject_kind: index.subject_kind,
    subject_id: index.subject_id,
    action,
    provenance: 'anonymized_copy',
    received_sha256: receivedSha256,
    content_sha256: contentSha256,
    human_review_id: reviewId,
    reviewed_sha256: contentSha256,
    review_confirmation: 'human_reviewed',
    operator_role: 'owner',
  };
}

async function createDocument(files: EvidenceFiles, path: string, document: unknown): Promise<string> {
  const content = canonical(document);
  const existing = await files.read(path);
  if (!existing) return files.write(path, content);
  const current = JSON.parse(existing.content) as Record<string, unknown>;
  const next = document as Record<string, unknown>;
  if (current.review_id || next.review_id) {
    if (
      current.review_id === next.review_id
      && current.reviewed_sha256 === next.reviewed_sha256
      && current.received_sha256 === next.received_sha256
    ) return existing.sha;
    throw new EvidenceLinkError('conflict');
  }
  if (current.evidence_id === next.evidence_id && current.action === next.action && current.content_sha256 === next.content_sha256) {
    return existing.sha;
  }
  throw new EvidenceLinkError('conflict');
}

function emptyIndex(subjectId: string): EvidenceIndex {
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    subject_kind: subjectId.startsWith('CQ-') ? 'commercial_quote' : 'repair_quote',
    subject_id: subjectId,
    items: [],
    link_ids: [],
  };
}

function requireIndex(content: string, subjectId: string): EvidenceIndex {
  const index = parseIndex(content, subjectId);
  if (!index) throw new EvidenceLinkError('conflict');
  return index;
}

function parseIndex(content: string, subjectId: string): EvidenceIndex | null {
  try {
    const parsed = JSON.parse(content) as EvidenceIndex;
    if (parsed.subject_id !== subjectId || !Array.isArray(parsed.items) || !Array.isArray(parsed.link_ids)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function publicItem(item: EvidenceItem): EvidenceItem {
  return {
    evidence_id: item.evidence_id,
    link_id: item.link_id,
    state: item.state,
    received_sha256: item.received_sha256,
    content_sha256: item.content_sha256,
    provenance: item.provenance,
  };
}

function assertRoom(index: EvidenceIndex): void {
  if (index.items.length >= MAX_ITEMS) throw new EvidenceLinkError('limit');
}

function nextId(prefix: 'EV' | 'LN' | 'RV', used: string[]): string {
  const values = used.map((id) => Number(id.slice(3))).filter((value) => Number.isInteger(value));
  const next = (values.length ? Math.max(...values) : 0) + 1;
  if (next > 999999) throw new EvidenceLinkError('limit');
  return `${prefix}-${String(next).padStart(6, '0')}`;
}

function manifestPath(subjectId: string, evidenceId: string): string {
  return `${evidenceDirectory(subjectId)}/manifests/${evidenceId}.json`;
}

function linkPath(subjectId: string, linkId: string): string {
  return `${evidenceDirectory(subjectId)}/links/${linkId}.json`;
}

function mimeFormat(value: unknown): { mime: 'image/jpeg' | 'image/png' | 'image/webp'; format: 'jpg' | 'png' | 'webp' } | null {
  if (value === 'image/jpeg') return { mime: value, format: 'jpg' };
  if (value === 'image/png') return { mime: value, format: 'png' };
  if (value === 'image/webp') return { mime: value, format: 'webp' };
  return null;
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function rejectSelfReview(request: EvidenceRequest): void {
  const record = request as unknown as Record<string, unknown>;
  if (SELF_REVIEW.some((key) => Object.prototype.hasOwnProperty.call(record, key))) {
    throw new EvidenceLinkError('rejected');
  }
}

function rejectUnexpectedReview(request: HumanReviewRequest): void {
  const record = request as unknown as Record<string, unknown>;
  if (Object.keys(record).some((key) => !REVIEW_FIELDS.has(key))) throw new EvidenceLinkError('rejected');
  if ('bytes' in record) throw new EvidenceLinkError('rejected');
}

type StoredReview = { review_id: string; received_sha256: string; reviewed_sha256: string };

function reviewIndexPath(subjectId: string): string {
  return `${evidenceDirectory(subjectId)}/reviews/index.json`;
}

function reviewPath(subjectId: string, reviewId: string): string {
  return `${evidenceDirectory(subjectId)}/reviews/${reviewId}.json`;
}

function requireReviews(content: string, subjectId: string): StoredReview[] {
  const parsed = JSON.parse(content) as { subject_id?: unknown; reviews?: unknown };
  if (parsed.subject_id !== subjectId || !Array.isArray(parsed.reviews)) throw new EvidenceLinkError('conflict');
  return parsed.reviews.flatMap((item) => {
    const review = item as StoredReview;
    return review && typeof review.review_id === 'string' ? [review] : [];
  });
}

async function findReview(
  files: EvidenceFiles,
  subjectId: string,
  receivedSha256: string,
  reviewedSha256: string,
): Promise<StoredReview | null> {
  const indexFile = await files.read(reviewIndexPath(subjectId));
  if (!indexFile) return null;
  const entry = requireReviews(indexFile.content, subjectId).find((item) => (
    item.reviewed_sha256 === reviewedSha256 && item.received_sha256 === receivedSha256
  ));
  if (!entry) return null;
  const file = await files.read(reviewPath(subjectId, entry.review_id));
  if (!file || !evidenceReviewMatches(file.content, subjectId, entry.review_id, reviewedSha256)) return null;
  return entry;
}

async function publishCatalog(files: EvidenceFiles, subjectId: string, index: EvidenceIndex): Promise<void> {
  const current = await files.read(EVIDENCE_CATALOG_PATH);
  const catalog = current ? parseCatalog(current.content) : { schema_version: EVIDENCE_SCHEMA_VERSION, commercial: {}, repairs: {} };
  if (!catalog) throw new EvidenceLinkError('conflict');
  const folder = subjectId.startsWith('CQ-') ? 'commercial' : 'repairs';
  const verified = index.items.filter((item) => item.state === 'verified').length;
  const pending = index.items.filter((item) => item.state === 'privacy_pending' || item.state === 'link_pending').length;
  if (verified === 0 && pending === 0) delete catalog[folder][subjectId];
  else catalog[folder][subjectId] = { verified, pending };
  const next = canonical(catalog);
  if (current?.content === next) return;
  await files.write(EVIDENCE_CATALOG_PATH, next, current?.sha);
}

function parseCatalog(content: string): {
  schema_version: typeof EVIDENCE_SCHEMA_VERSION;
  commercial: Record<string, { verified: number; pending: number }>;
  repairs: Record<string, { verified: number; pending: number }>;
} | null {
  try {
    const parsed = JSON.parse(content) as {
      commercial?: Record<string, { verified: number; pending: number }>;
      repairs?: Record<string, { verified: number; pending: number }>;
    };
    if (!parsed.commercial || !parsed.repairs || Array.isArray(parsed.commercial) || Array.isArray(parsed.repairs)) return null;
    return {
      schema_version: EVIDENCE_SCHEMA_VERSION,
      commercial: parsed.commercial,
      repairs: parsed.repairs,
    };
  } catch {
    return null;
  }
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
