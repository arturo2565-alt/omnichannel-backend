import { createHash } from 'node:crypto';

/**
 * CAL-005 prototype. Server-side only: do not expose GitHub tokens to ChatGPT.
 * Deliberately not wired into NestJS routes or live systems.
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

export class CalibrationConflictError extends Error {}
export class CalibrationWriteError extends Error {}

const CASE_PATTERN = /^AF-[0-9]{6}$/;
const SOURCE_KEY_PATTERN = /^[a-zA-Z0-9_.:-]{4,150}$/;
const TARGET_REPO = 'arturo2565-alt/pegazuz-calibration-data';

/** Encodes UTF-8 strings safely without external dependencies. */
function b64(value: string): string { return Buffer.from(value, 'utf8').toString('base64'); }
function canonical(value: unknown): string { return JSON.stringify(value, null, 2) + '\n'; }

export class CalibrationGithubWriter {
  constructor(
    private readonly token: string,
    private readonly transport: typeof fetch = fetch,
    private readonly repository = TARGET_REPO,
  ) {
    if (!token || !token.trim()) throw new Error('Missing calibration GitHub credential');
  }

  private async request<T>(method: 'GET' | 'PUT', path: string, body?: object): Promise<T | null> {
    const response = await this.transport(
      `https://api.github.com/repos/${this.repository}/contents/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) {
      // Never log request body or authorization token. Fail closed on conflicts.
      throw new CalibrationWriteError(`GitHub ${method} returned ${response.status}`);
    }
    return await response.json() as T;
  }

  private async read(path: string): Promise<GithubFile | null> {
    const result = await this.request<{ content: string; sha: string }>('GET', path + '?ref=main');
    if (!result) return null;
    return { sha: result.sha, content: Buffer.from(result.content.replace(/\s/g, ''), 'base64').toString('utf8') };
  }

  private async save(path: string, content: string, message: string, sha?: string): Promise<string> {
    const payload = { message, content: b64(content), branch: 'main', ...(sha ? { sha } : {}) };
    const response = await this.request<GithubWrite>('PUT', path, payload);
    if (!response?.commit?.sha) throw new CalibrationWriteError('Missing commit receipt');
    return response.commit.sha;
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
    const index = JSON.parse(idxFile.content) as {
      schema_version: string;
      cases: Record<string, string>;
      source_keys: Record<string, string>;
    };
    if (!index.cases || !index.source_keys) throw new CalibrationWriteError('Invalid master index');
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
    } catch {
      return { status: 'partial', caseId: id, caseCommit, reason: 'Index update requires reconciliation' };
    }
  }
}
