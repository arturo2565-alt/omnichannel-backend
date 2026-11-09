import { CALIBRATION_GITHUB_REPOSITORY } from './calibration-github-app';
import { validateHumanQuote } from './calibration-case';
import { calibrationObservationFingerprint } from './calibration-engine';
import {
  CalibrationConflictError,
  CalibrationWriteError,
  classifyGithubFailure,
  type CalibrationAccessToken,
  type CalibrationCaseInput,
  type GitHubCaseWriteResult,
} from './calibration-github-writer';

/**
 * CAL-009C. The probe shares the private calibration repository and never
 * receives its own GitHub App. Every Contents call stays under data/probes/.
 * Identifiers start at AF-900000 and are not taken from data/index.json.
 */
export const CALIBRATION_PROBE_ROOT = 'data/probes';
export const CALIBRATION_PROBE_INDEX_PATH = 'data/probes/index.json';
export const CALIBRATION_PROBE_SCHEMA_VERSION = '1.0.0';
export const CALIBRATION_PROBE_FIRST_ID = 'AF-900000';

const PROBE_CASE_ID = /^AF-9\d{5}$/;
const SOURCE_KEY_PATTERN = /^[a-zA-Z0-9_.:-]{4,150}$/;
const FOREIGN_ARCHIVE_TEXT = [
  '27b61d9ab76b915baa754954bfb34ec8',
  'pegazuz_calibration/cal008-probe/',
  'AF-000001',
  'data/index.json',
  'data/cases/',
];

export type ProbeIndex = {
  schema_version: typeof CALIBRATION_PROBE_SCHEMA_VERSION;
  archive: 'probe';
  cases: Record<string, string>;
  source_keys: Record<string, string>;
};

export type ProbeRecordResult = {
  status: 'created' | 'already_exists' | 'reconciled';
  caseId: string;
  caseCommit: string;
  indexCommit: string;
  photoArchiveStatus: 'not_provided';
  photoRefs: [];
};

type GithubFile = { content: string; sha: string };
type GithubWrite = { commit?: { sha?: string }; content?: { sha?: string } };

export function emptyProbeIndex(): ProbeIndex {
  return {
    schema_version: CALIBRATION_PROBE_SCHEMA_VERSION,
    archive: 'probe',
    cases: {},
    source_keys: {},
  };
}

export function probeCasePath(caseId: string): string {
  if (!PROBE_CASE_ID.test(caseId)) {
    throw new CalibrationConflictError('Probe case id is outside the reserved range');
  }
  return assertProbeContentsPath(`${CALIBRATION_PROBE_ROOT}/cases/${caseId}.json`);
}

/**
 * Accepts only the probe index and a reserved case file. Relative segments,
 * encodings, real archive paths, and AF-000001 never pass.
 */
export function assertProbeContentsPath(raw: string): string {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 96) {
    throw new CalibrationConflictError('Probe path is not allowed');
  }
  if (/[\\%\x00-\x1f\x7f]/.test(raw) || raw !== raw.normalize('NFC')) {
    throw new CalibrationConflictError('Probe path is not allowed');
  }
  const queryAt = raw.indexOf('?');
  const pathname = queryAt === -1 ? raw : raw.slice(0, queryAt);
  const query = queryAt === -1 ? '' : raw.slice(queryAt + 1);
  if (query !== '' && query !== 'ref=main') {
    throw new CalibrationConflictError('Probe path is not allowed');
  }
  if (pathname.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new CalibrationConflictError('Probe path is not allowed');
  }
  const allowed = pathname === CALIBRATION_PROBE_INDEX_PATH
    || /^data\/probes\/cases\/AF-9\d{5}\.json$/.test(pathname);
  if (!allowed || pathname.includes('AF-000001') || pathname.includes('data/cases/') || pathname.includes('data/index.json')) {
    throw new CalibrationConflictError('Probe path is not allowed');
  }
  return pathname;
}

export function nextProbeCaseId(used: readonly string[]): string {
  let max = 899999;
  for (const id of used) {
    if (!PROBE_CASE_ID.test(id)) {
      throw new CalibrationConflictError('Probe index contains a real case id');
    }
    max = Math.max(max, Number(id.slice(3)));
  }
  const next = max + 1;
  if (next > 999999) {
    throw new CalibrationConflictError('Probe case identifier space exhausted');
  }
  return `AF-${String(next).padStart(6, '0')}`;
}

export function probeIndexAllowsCertification(index: ProbeIndex): boolean {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return false;
  const keys = Object.keys(index);
  if (keys.some((key) => !['schema_version', 'archive', 'cases', 'source_keys'].includes(key))) return false;
  if (index.archive !== 'probe' || index.schema_version !== CALIBRATION_PROBE_SCHEMA_VERSION) return false;
  if (!index.cases || !index.source_keys || Array.isArray(index.cases) || Array.isArray(index.source_keys)) return false;
  for (const [id, path] of Object.entries(index.cases)) {
    if (!PROBE_CASE_ID.test(id) || path !== `${CALIBRATION_PROBE_ROOT}/cases/${id}.json`) return false;
  }
  for (const [key, id] of Object.entries(index.source_keys)) {
    if (!SOURCE_KEY_PATTERN.test(key) || index.cases[id] == null) return false;
  }
  return true;
}

const CLOCK = '2026-11-08T18:00:00.000Z';

export class CalibrationProbeWriter {
  constructor(
    private readonly credential: string | CalibrationAccessToken,
    private readonly transport: typeof fetch,
  ) {
    if (typeof credential === 'string' && !credential.trim()) {
      throw new Error('Missing calibration GitHub credential');
    }
  }

  async ensureIndex(): Promise<{ index: ProbeIndex; sha: string }> {
    const existing = await this.read(CALIBRATION_PROBE_INDEX_PATH);
    if (existing) return { index: parseProbeIndex(existing.content), sha: existing.sha };
    try {
      const sha = await this.save(CALIBRATION_PROBE_INDEX_PATH, canonical(emptyProbeIndex()), 'cal: init probe index');
      return { index: emptyProbeIndex(), sha };
    } catch (err) {
      if (err instanceof CalibrationConflictError && err.message === 'Probe index already exists') {
        const raced = await this.read(CALIBRATION_PROBE_INDEX_PATH);
        if (!raced) throw err;
        return { index: parseProbeIndex(raced.content), sha: raced.sha };
      }
      throw err;
    }
  }

  async readIndex(): Promise<ProbeIndex> {
    const file = await this.read(CALIBRATION_PROBE_INDEX_PATH);
    if (!file) throw new CalibrationWriteError('Missing probe index');
    return parseProbeIndex(file.content);
  }

  async readCase(caseId: string): Promise<Record<string, unknown> | null> {
    const file = await this.read(probeCasePath(caseId));
    if (!file) return null;
    return JSON.parse(file.content) as Record<string, unknown>;
  }

  async insert(input: CalibrationCaseInput): Promise<GitHubCaseWriteResult> {
    const id = input.case_id;
    const key = input.source?.source_case_key;
    if (!PROBE_CASE_ID.test(id) || !key || !SOURCE_KEY_PATTERN.test(key)) {
      throw new CalibrationConflictError('Probe case id is outside the reserved range');
    }
    assertNoForeignArchive(input);
    const casePath = probeCasePath(id);
    const idxFile = await this.read(CALIBRATION_PROBE_INDEX_PATH);
    if (!idxFile) throw new CalibrationWriteError('Missing probe index');
    const index = parseProbeIndex(idxFile.content);
    const existing = index.source_keys[key];
    if (existing) {
      if (existing !== id) throw new CalibrationConflictError('Source key references a different case');
      return { status: 'already_exists', caseId: existing };
    }
    if (index.cases[id]) throw new CalibrationConflictError('Case ID already assigned');
    const orphan = await this.read(casePath);
    if (orphan) {
      const parsed = JSON.parse(orphan.content) as CalibrationCaseInput;
      if (parsed.source?.source_case_key !== key) {
        throw new CalibrationConflictError('Existing unindexed case differs');
      }
      index.cases[id] = casePath;
      index.source_keys[key] = id;
      const indexCommit = await this.save(CALIBRATION_PROBE_INDEX_PATH, canonical(index), `cal: reconcile probe ${id}`, idxFile.sha);
      return { status: 'created', caseId: id, caseCommit: 'pre-existing', indexCommit };
    }
    const caseCommit = await this.save(casePath, canonical(input), `cal: record probe ${id}`);
    index.cases[id] = casePath;
    index.source_keys[key] = id;
    try {
      const indexCommit = await this.save(CALIBRATION_PROBE_INDEX_PATH, canonical(index), `cal: index probe ${id}`, idxFile.sha);
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

  async reconcile(caseId: string): Promise<GitHubCaseWriteResult> {
    const casePath = probeCasePath(caseId);
    const caseFile = await this.read(casePath);
    if (!caseFile) throw new CalibrationWriteError('Missing case file for reconciliation');
    const parsed = JSON.parse(caseFile.content) as CalibrationCaseInput;
    assertNoForeignArchive(parsed);
    const key = parsed.source?.source_case_key;
    if (!key || !SOURCE_KEY_PATTERN.test(key)) {
      throw new CalibrationConflictError('Case file has no source key');
    }
    const indexFile = await this.read(CALIBRATION_PROBE_INDEX_PATH);
    if (!indexFile) throw new CalibrationWriteError('Missing probe index');
    const index = parseProbeIndex(indexFile.content);
    const indexed = index.source_keys[key];
    if (indexed && indexed !== caseId) {
      throw new CalibrationConflictError('Source key references a different case');
    }
    if (index.cases[caseId] && indexed === caseId) return { status: 'already_exists', caseId };
    if (index.cases[caseId] && index.cases[caseId] !== casePath) {
      throw new CalibrationConflictError('Case ID already assigned');
    }
    index.cases[caseId] = casePath;
    index.source_keys[key] = caseId;
    const indexCommit = await this.save(
      CALIBRATION_PROBE_INDEX_PATH,
      canonical(index),
      `cal: reconcile probe ${caseId}`,
      indexFile.sha,
    );
    return { status: 'created', caseId, caseCommit: 'pre-existing', indexCommit };
  }

  private async read(path: string): Promise<GithubFile | null> {
    const result = await this.request<{ content: string; sha: string }>('GET', `${assertProbeContentsPath(path)}?ref=main`);
    if (!result) return null;
    return { sha: result.sha, content: Buffer.from(result.content.replace(/\s/g, ''), 'base64').toString('utf8') };
  }

  private async save(path: string, content: string, message: string, sha?: string): Promise<string> {
    assertNoForeignArchive(JSON.parse(content) as unknown);
    const pathname = assertProbeContentsPath(path);
    const payload = { message, content: Buffer.from(content, 'utf8').toString('base64'), branch: 'main', ...(sha ? { sha } : {}) };
    try {
      const response = await this.request<GithubWrite>('PUT', pathname, payload);
      const receipt = response?.content?.sha ?? response?.commit?.sha;
      if (!receipt) throw new CalibrationWriteError('Missing commit receipt');
      return receipt;
    } catch (err) {
      if (!sha && err instanceof CalibrationWriteError && err.kind === 'occupied') {
        throw new CalibrationConflictError(
          pathname === CALIBRATION_PROBE_INDEX_PATH ? 'Probe index already exists' : 'Case file already exists',
        );
      }
      throw err;
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
    const pathname = assertProbeContentsPath(path);
    const url = new URL(`https://api.github.com/repos/${CALIBRATION_GITHUB_REPOSITORY}/contents/${pathname}`);
    if (path.includes('?')) url.searchParams.set('ref', 'main');
    if (url.hostname !== 'api.github.com') throw new CalibrationConflictError('Probe path is not allowed');
    if (url.pathname !== `/repos/${CALIBRATION_GITHUB_REPOSITORY}/contents/${pathname}`) {
      throw new CalibrationConflictError('Probe path is not allowed');
    }
    if (url.search !== (path.includes('?') ? '?ref=main' : '')) {
      throw new CalibrationConflictError('Probe path is not allowed');
    }
    const response = await this.transport(url, {
      method,
      headers: {
        Authorization: await this.authorization(),
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
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
    const value = typeof this.credential === 'string' ? this.credential : await this.credential.authorization();
    const token = value.trim();
    if (!token || /\s/.test(token)) throw new Error('Missing calibration GitHub credential');
    return `Bearer ${token}`;
  }
}

export async function recordProbeObservation(
  writer: CalibrationProbeWriter,
  input: unknown,
  options?: { maxAllocationAttempts?: number },
): Promise<ProbeRecordResult> {
  assertNoForeignArchive(input);
  const quote = validateHumanQuote(input);
  let current = await writer.ensureIndex();
  const occupied = new Set<string>();
  const maxAttempts = options?.maxAllocationAttempts ?? 5;
  let allocation = 0;
  while (allocation < maxAttempts) {
    const existingId = current.index.source_keys[quote.source.source_case_key];
    if (existingId) {
      await assertSameObservation(writer, existingId, quote);
      return {
        status: 'already_exists',
        caseId: existingId,
        caseCommit: 'pre-existing',
        indexCommit: 'pre-existing',
        photoArchiveStatus: 'not_provided',
        photoRefs: [],
      };
    }
    const caseId = nextProbeCaseId([...Object.keys(current.index.cases), ...occupied]);
    const document = {
      ...quote,
      case_id: caseId,
      photo_refs: [] as string[],
      photo_archive_status: 'not_provided' as const,
      created_at: CLOCK,
      updated_at: CLOCK,
    };
    try {
      const result = await writer.insert(document);
      if (result.status === 'partial') {
        const caseBefore = await writer.readCase(result.caseId);
        const recovered = await writer.reconcile(result.caseId);
        const caseAfter = await writer.readCase(result.caseId);
        if (JSON.stringify(caseBefore) !== JSON.stringify(caseAfter)) {
          throw new CalibrationConflictError('Probe reconciliation rewrote the case file');
        }
        return {
          status: 'reconciled',
          caseId: result.caseId,
          caseCommit: result.caseCommit,
          indexCommit: recovered.status === 'created' ? recovered.indexCommit : 'pre-existing',
          photoArchiveStatus: 'not_provided',
          photoRefs: [],
        };
      }
      if (result.status === 'already_exists') {
        await assertSameObservation(writer, result.caseId, quote);
        return {
          status: 'already_exists',
          caseId: result.caseId,
          caseCommit: 'pre-existing',
          indexCommit: 'pre-existing',
          photoArchiveStatus: 'not_provided',
          photoRefs: [],
        };
      }
      return {
        status: 'created',
        caseId: result.caseId,
        caseCommit: result.caseCommit,
        indexCommit: result.indexCommit,
        photoArchiveStatus: 'not_provided',
        photoRefs: [],
      };
    } catch (err) {
      const collision = err instanceof CalibrationConflictError && (
        err.message === 'Case file already exists' ||
        err.message === 'Case ID already assigned' ||
        err.message === 'Existing unindexed case differs'
      );
      if (collision) {
        occupied.add(caseId);
        allocation += 1;
        current = await writer.ensureIndex();
        continue;
      }
      throw err;
    }
  }
  throw new CalibrationConflictError('Concurrent case allocation was not resolved');
}

async function assertSameObservation(
  writer: CalibrationProbeWriter,
  caseId: string,
  quote: ReturnType<typeof validateHumanQuote>,
): Promise<void> {
  const stored = await writer.readCase(caseId);
  if (!stored || calibrationObservationFingerprint(stored) !== calibrationObservationFingerprint(quote)) {
    throw new CalibrationConflictError('Source key already records a different observation');
  }
}

function parseProbeIndex(content: string): ProbeIndex {
  const index = JSON.parse(content) as ProbeIndex;
  if (!probeIndexAllowsCertification(index)) {
    throw new CalibrationConflictError('Probe index can reach the real case range');
  }
  return index;
}

function assertNoForeignArchive(value: unknown): void {
  const text = JSON.stringify(value);
  if (FOREIGN_ARCHIVE_TEXT.some((needle) => text.includes(needle))) {
    throw new CalibrationConflictError('Probe observation references a foreign archive');
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

async function readGithubErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { message?: unknown };
    return typeof payload.message === 'string' ? payload.message.slice(0, 300) : '';
  } catch {
    return '';
  }
}
