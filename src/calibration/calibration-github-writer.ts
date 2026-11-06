/**
 * CAL-005 prototype. Server-side only: do not expose GitHub tokens to ChatGPT.
 * Deliberately not wired into NestJS routes or live systems.
 * CAL-006 reads the index and reconciles a partial index write. It still does
 * not open a route or embed a credential.
 */
export type CalibrationCaseInput = {
  case_id: string;
  source: { source_case_key: string; kind: string };
  [key: string]: unknown;
};
export type GitHubCaseWriteResult =
  | { status: 'created'; caseId: string; caseCommit: string; indexCommit: string }
  | { status: 'already_exists'; caseId: string }
  | { status: 'partial'; caseId: string; caseCommit: string; reason: string };

type GithubFile = { content: string; sha: string };
type GithubWrite = { commit: { sha: string } };

export type GithubFailureKind =
  | 'occupied'
  | 'conflict'
  | 'forbidden'
  | 'validation'
  | 'rate_limit'
  | 'transient'
  | 'rejected';

export class CalibrationConflictError extends Error {}
export class CalibrationWriteError extends Error {
  readonly status: number | null;
  readonly kind: GithubFailureKind;
  constructor(message: string, status: number | null = null, kind?: GithubFailureKind) {
    super(message);
    this.name = 'CalibrationWriteError';
    this.status = status;
    this.kind = kind ?? classifyGithubFailure(status, message);
  }
}

/**
 * A 422 is an occupied path only when GitHub says the SHA was required because
 * the file already exists. Validation, permissions, and rate limits are not collisions.
 */
export function classifyGithubFailure(status: number | null, message: string): GithubFailureKind {
  const text = message.toLowerCase();
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 429) return 'rate_limit';
  if (status === 408 || (status != null && status >= 500 && status <= 599)) return 'transient';
  if (status === 409) return 'conflict';
  if (status === 422) {
    if (
      text.includes("wasn't supplied") ||
      text.includes('was not supplied') ||
      text.includes('sha required') ||
      text.includes('already exists')
    ) {
      return 'occupied';
    }
    return 'validation';
  }
  return 'rejected';
}

export type CalibrationIndex = {
  schema_version: string;
  cases: Record<string, string>;
  source_keys: Record<string, string>;
};

const CASE_PATTERN = /^AF-[0-9]{6}$/;
const SOURCE_KEY_PATTERN = /^[a-zA-Z0-9_.:-]{4,150}$/;
const TARGET_REPO = 'arturo2565-alt/pegazuz-calibration-data';

/**
 * Short-lived installation credential. A static string remains available for
 * tests; the live path uses a GitHub App and can drop a rejected token once.
 */
export type CalibrationAccessToken = {
  authorization(): Promise<string>;
  invalidate(): void;
};

/** Encodes UTF-8 strings safely without external dependencies. */
function b64(value: string): string { return Buffer.from(value, 'utf8').toString('base64'); }
function canonical(value: unknown): string { return JSON.stringify(value, null, 2) + '\n'; }

export class CalibrationGithubWriter {
  constructor(
    private readonly credential: string | CalibrationAccessToken,
    private readonly transport: typeof fetch = fetch,
    private readonly repository = TARGET_REPO,
  ) {
    if (typeof credential === 'string' && !credential.trim()) {
      throw new Error('Missing calibration GitHub credential');
    }
    if (this.repository !== TARGET_REPO) {
      throw new Error('Calibration GitHub repository is not allowed');
    }
  }

  private async request<T>(method: 'GET' | 'PUT', path: string, body?: object): Promise<T | null> {
    return this.dispatch(method, path, body, false);
  }

  private async dispatch<T>(
    method: 'GET' | 'PUT',
    path: string,
    body: object | undefined,
    refreshed: boolean,
  ): Promise<T | null> {
    const response = await this.transport(
      `https://api.github.com/repos/${this.repository}/contents/${path}`,
      {
        method,
        headers: {
          Authorization: await this.authorization(),
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    if (response.status === 401 && !refreshed && typeof this.credential !== 'string') {
      this.credential.invalidate();
      return this.dispatch(method, path, body, true);
    }
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) {
      const detail = await readGithubErrorMessage(response);
      throw new CalibrationWriteError(
        `GitHub ${method} returned ${response.status}`,
        response.status,
        classifyGithubFailure(response.status, detail),
      );
    }
    return await response.json() as T;
  }

  private async authorization(): Promise<string> {
    const value = typeof this.credential === 'string'
      ? this.credential
      : await this.credential.authorization();
    const token = value.trim();
    if (!token || /\s/.test(token)) throw new Error('Missing calibration GitHub credential');
    return `Bearer ${token}`;
  }

  async readIndex(): Promise<CalibrationIndex> {
    const file = await this.read('data/index.json');
    if (!file) throw new CalibrationWriteError('Missing master index');
    return parseIndex(file.content);
  }

  async readCase(caseId: string): Promise<Record<string, unknown> | null> {
    if (!CASE_PATTERN.test(caseId)) {
      throw new CalibrationConflictError('Invalid case identifier or source key');
    }
    const file = await this.read(`data/cases/${caseId}.json`);
    if (!file) return null;
    return JSON.parse(file.content) as Record<string, unknown>;
  }

  /**
   * Completes the index after the case file was stored and the index write lost
   * the optimistic SHA race. Does not rewrite the case file.
   */
  async reconcile(caseId: string): Promise<GitHubCaseWriteResult> {
    if (!CASE_PATTERN.test(caseId)) {
      throw new CalibrationConflictError('Invalid case identifier or source key');
    }
    const casePath = `data/cases/${caseId}.json`;
    const caseFile = await this.read(casePath);
    if (!caseFile) throw new CalibrationWriteError('Missing case file for reconciliation');
    const parsed = JSON.parse(caseFile.content) as CalibrationCaseInput;
    const key = parsed.source?.source_case_key;
    if (!key || !SOURCE_KEY_PATTERN.test(key)) {
      throw new CalibrationConflictError('Case file has no source key');
    }
    const indexFile = await this.read('data/index.json');
    if (!indexFile) throw new CalibrationWriteError('Missing master index');
    const index = parseIndex(indexFile.content);
    const indexed = index.source_keys[key];
    if (indexed && indexed !== caseId) {
      throw new CalibrationConflictError('Source key references a different case');
    }
    if (index.cases[caseId] && indexed === caseId) {
      return { status: 'already_exists', caseId };
    }
    if (index.cases[caseId] && index.cases[caseId] !== casePath) {
      throw new CalibrationConflictError('Case ID already assigned');
    }
    index.cases[caseId] = casePath;
    index.source_keys[key] = caseId;
    const indexCommit = await this.save(
      'data/index.json',
      canonical(index),
      `cal: reconcile ${caseId}`,
      indexFile.sha,
    );
    return { status: 'created', caseId, caseCommit: 'pre-existing', indexCommit };
  }

  /**
   * Stores a photo manifest only when the caller already proved the checksum.
   * An existing manifest with the same SHA is reused. A different SHA conflicts.
   */
  async saveVerifiedPhoto(document: {
    photo_id: string;
    case_id: string;
    content_sha256: string;
    storage_status: 'verified';
    [key: string]: unknown;
  }): Promise<string> {
    if (!CASE_PATTERN.test(document.case_id) || !/^IMG-[0-9]{6}$/.test(document.photo_id)) {
      throw new CalibrationConflictError('Photo manifest identity is invalid');
    }
    if (document.storage_status !== 'verified' || !/^[a-f0-9]{64}$/.test(document.content_sha256)) {
      throw new CalibrationConflictError('A photo manifest requires a verified checksum');
    }
    const path = `data/photos/${document.case_id}/${document.photo_id}.json`;
    const existing = await this.read(path);
    if (existing) {
      const parsed = JSON.parse(existing.content) as { content_sha256?: string };
      if (parsed.content_sha256 === document.content_sha256) return 'pre-existing';
      throw new CalibrationConflictError('Photo id already stores different content');
    }
    return this.save(path, canonical(document), `cal: verify photo ${document.case_id} ${document.photo_id}`);
  }

  async readPhotoManifest(caseId: string, photoId: string): Promise<Record<string, unknown> | null> {
    if (!CASE_PATTERN.test(caseId) || !/^IMG-[0-9]{6}$/.test(photoId)) return null;
    const file = await this.read(`data/photos/${caseId}/${photoId}.json`);
    if (!file) return null;
    return JSON.parse(file.content) as Record<string, unknown>;
  }

  /**
   * Records verified photo refs on an existing case. Refuses any status other
   * than a private archive that the caller has already checksum-verified.
   */
  async updateVerifiedPhotos(input: {
    caseId: string;
    photoRefs: string[];
    updatedAt: string;
  }): Promise<string> {
    if (!CASE_PATTERN.test(input.caseId) || input.photoRefs.length === 0) {
      throw new CalibrationConflictError('Verified photos require a case and at least one ref');
    }
    if (input.photoRefs.some((ref) => !/^IMG-[0-9]{6}$/.test(ref))) {
      throw new CalibrationConflictError('Photo reference is not a private manifest id');
    }
    const casePath = `data/cases/${input.caseId}.json`;
    const caseFile = await this.read(casePath);
    if (!caseFile) throw new CalibrationWriteError('Missing case file for photo verification');
    const parsed = JSON.parse(caseFile.content) as Record<string, unknown>;
    parsed.photo_refs = [...input.photoRefs];
    parsed.photo_archive_status = 'archived_private';
    parsed.updated_at = input.updatedAt;
    return this.save(
      casePath,
      canonical(parsed),
      `cal: verify photos ${input.caseId}`,
      caseFile.sha,
    );
  }

  private async read(path: string): Promise<GithubFile | null> {
    const result = await this.request<{ content: string; sha: string }>('GET', path + '?ref=main');
    if (!result) return null;
    return { sha: result.sha, content: Buffer.from(result.content.replace(/\s/g, ''), 'base64').toString('utf8') };
  }

  private async save(path: string, content: string, message: string, sha?: string): Promise<string> {
    const payload = { message, content: b64(content), branch: 'main', ...(sha ? { sha } : {}) };
    try {
      const response = await this.request<GithubWrite>('PUT', path, payload);
      if (!response?.commit?.sha) throw new CalibrationWriteError('Missing commit receipt');
      return response.commit.sha;
    } catch (err) {
      if (!sha && err instanceof CalibrationWriteError && err.kind === 'occupied') {
        throw new CalibrationConflictError('Case file already exists');
      }
      throw err;
    }
  }

  /**
   * Append-only new cases. Corrections are a separate reviewed operation.
   * A repeated source key returns existing case without writing.
   * If index update fails, return partial for later reconciliation.
   */
  async insert(input: CalibrationCaseInput): Promise<GitHubCaseWriteResult> {
    const id = input.case_id;
    const key = input.source?.source_case_key;
    if (!CASE_PATTERN.test(id) || !key || !SOURCE_KEY_PATTERN.test(key)) {
      throw new CalibrationConflictError('Invalid case identifier or source key');
    }
    const indexPath = 'data/index.json';
    const casePath = `data/cases/${id}.json`;
    const idxFile = await this.read(indexPath);
    if (!idxFile) throw new CalibrationWriteError('Missing master index');
    const index = parseIndex(idxFile.content);
    const existing = index.source_keys[key];
    if (existing) {
      if (existing !== id) throw new CalibrationConflictError('Source key references a different case');
      return { status: 'already_exists', caseId: existing };
    }
    if (index.cases[id]) throw new CalibrationConflictError('Case ID already assigned');

    // Prevent overwriting an orphan created by a previous partially completed operation.
    const orphan = await this.read(casePath);
    if (orphan) {
      const parsed = JSON.parse(orphan.content) as CalibrationCaseInput;
      if (parsed.source?.source_case_key !== key) throw new CalibrationConflictError('Existing unindexed case differs');
      // The orphan can be reconciled without uploading the file twice.
      index.cases[id] = casePath;
      index.source_keys[key] = id;
      const indexCommit = await this.save(indexPath, canonical(index), `cal: reconcile orphan ${id}`, idxFile.sha);
      return { status: 'created', caseId: id, caseCommit: 'pre-existing', indexCommit };
    }

    const caseCommit = await this.save(casePath, canonical(input), `cal: record ${id}`);
    index.cases[id] = casePath;
    index.source_keys[key] = id;
    try {
      const indexCommit = await this.save(indexPath, canonical(index), `cal: index ${id}`, idxFile.sha);
      return { status: 'created', caseId: id, caseCommit, indexCommit };
    } catch (err) {
      if (
        err instanceof CalibrationWriteError &&
        (err.kind === 'conflict' || err.kind === 'transient' || err.kind === 'rate_limit')
      ) {
        return { status: 'partial', caseId: id, caseCommit, reason: 'Index update requires reconciliation' };
      }
      throw err;
    }
  }
}

async function readGithubErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { message?: unknown };
    return typeof payload.message === 'string' ? payload.message.slice(0, 300) : '';
  } catch {
    return '';
  }
}

function parseIndex(content: string): CalibrationIndex {
  const index = JSON.parse(content) as CalibrationIndex;
  if (!index || typeof index.cases !== 'object' || typeof index.source_keys !== 'object') {
    throw new CalibrationWriteError('Invalid master index');
  }
  return index;
}
