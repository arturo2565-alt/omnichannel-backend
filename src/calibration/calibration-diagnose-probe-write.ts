import { validateHumanQuote } from './calibration-case';
import { calibrationObservationFingerprint } from './calibration-engine';
import {
  CALIBRATION_GITHUB_REPOSITORY,
  CalibrationCredentialError,
  CalibrationGithubApp,
  readGithubAppConfig,
  type GithubInstallationGrant,
} from './calibration-github-app';
import { CalibrationConflictError, CalibrationWriteError } from './calibration-github-writer';
import { calibrationDiagnosticTarget } from './calibration-diagnose';
import {
  CALIBRATION_PROBE_FIRST_ID,
  CalibrationProbeWriter,
  assertProbeContentsPath,
  recordProbeObservation,
} from './calibration-probe';

/** Fixed observation for CAL-009D. No photographs and no personal data. */
export const CALIBRATION_PROBE_CERTIFICATION_KEY = 'probe-cal-009d-001';

const TOKEN_URL = /^https:\/\/api\.github\.com\/app\/installations\/\d{1,12}\/access_tokens$/;
const REPOSITORIES_URL = 'https://api.github.com/installation/repositories?per_page=100';
const REAL_INDEX_URL = `https://api.github.com/repos/${CALIBRATION_GITHUB_REPOSITORY}/contents/data/index.json?ref=main`;

export type ProbeWriteCategory =
  | 'wrong_target'
  | 'flags'
  | 'missing'
  | 'incomplete'
  | 'forbidden'
  | 'rejected'
  | 'scope'
  | 'invalid_index'
  | 'read_failed'
  | 'conflict'
  | 'partial'
  | 'real_index';

export type ProbeWriteReport = {
  service: 'github-probe-write';
  result: 'ok' | 'error';
  category?: ProbeWriteCategory;
  status?: 'created' | 'already_exists' | 'reconciled';
  caseId?: string;
  sourceKey?: typeof CALIBRATION_PROBE_CERTIFICATION_KEY;
  contentMatch?: boolean;
  photoArchiveStatus?: 'not_provided';
  photoCount?: 0;
  probeCaseCount?: number;
  realCaseCountBefore?: number;
  realCaseCountAfter?: number;
  realIndexUnchanged?: boolean;
};

export function calibrationProbeCertificationQuote() {
  return {
    source: {
      kind: 'autofix_human_quote',
      source_case_key: CALIBRATION_PROBE_CERTIFICATION_KEY,
      quoted_at: null,
    },
    vehicle: {
      make: 'Mazda',
      make_evidence: 'visual_inference',
      model: null,
      model_evidence: 'unknown',
      year: null,
      year_evidence: 'unknown',
      variant: null,
    },
    line_items: [
      {
        line_id: 'L1',
        part: 'salpicadera delantera derecha',
        treatment: 'repair_paint',
        price_mxn: 1250,
        damage_severity: 'unknown',
        validation: 'human_confirmed',
      },
    ],
    visual_observations: ['Deformación visible en el arco de la salpicadera.'],
    status: 'human_verified',
  };
}

/**
 * Allows the installation token, the repository list, a read of the real
 * index, and Contents calls under data/probes/. Every other request stops.
 */
export function assertProbeWriteRequest(method: string, rawUrl: string): void {
  const verb = method.toUpperCase();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Calibration probe write refused a request');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' || url.username || url.password || url.hash) {
    throw new Error('Calibration probe write refused a request');
  }
  if (verb === 'POST' && TOKEN_URL.test(url.origin + url.pathname) && url.search === '') return;
  if (verb === 'GET' && url.href === REPOSITORIES_URL) return;
  const prefix = `/repos/${CALIBRATION_GITHUB_REPOSITORY}/contents/`;
  if (!url.pathname.startsWith(prefix) || url.pathname.includes('%')) {
    throw new Error('Calibration probe write refused a request');
  }
  const path = url.pathname.slice(prefix.length);
  if (verb === 'GET' && path === 'data/index.json' && url.search === '?ref=main') return;
  if ((verb === 'GET' || verb === 'PUT') && (url.search === '' || url.search === '?ref=main')) {
    try {
      assertProbeContentsPath(url.search === '' ? path : `${path}?ref=main`);
    } catch {
      throw new Error('Calibration probe write refused a request');
    }
    return;
  }
  throw new Error('Calibration probe write refused a request');
}

export async function diagnoseCalibrationProbeWrite(
  env: NodeJS.ProcessEnv,
  transport: typeof fetch = fetch,
): Promise<ProbeWriteReport> {
  if (!calibrationDiagnosticTarget(env)) return error('wrong_target');
  if (env.CALIBRATION_INGEST_ENABLED !== 'false' || env.DB_SYNCHRONIZE !== 'false') return error('flags');
  const guarded = guard(transport);
  try {
    const config = readGithubAppConfig(withoutLineSeparators(env));
    if (!config) return error('missing');
    const app = new CalibrationGithubApp(config, guarded);
    await app.authorization();
    const grant = app.installationGrant();
    if (!grant || !contentsGrantIsExpected(grant)) return error('scope');
    const names = await installationRepositories(guarded, await app.authorization());
    if (!names) return error('read_failed');
    if (names.length !== 1 || names[0] !== CALIBRATION_GITHUB_REPOSITORY) return error('scope');
    const before = await readRealIndex(guarded, await app.authorization());
    if (!before) return error('invalid_index');
    const writer = new CalibrationProbeWriter(app, guarded);
    const quote = validateHumanQuote(calibrationProbeCertificationQuote());
    let recorded;
    try {
      recorded = await recordProbeObservation(writer, quote);
    } catch (err) {
      const after = await readRealIndex(guarded, await app.authorization());
      return {
        ...error(categoryOf(err)),
        sourceKey: CALIBRATION_PROBE_CERTIFICATION_KEY,
        realCaseCountBefore: before.count,
        realCaseCountAfter: after?.count,
        realIndexUnchanged: after != null && after.sha === before.sha && after.text === before.text,
      };
    }
    const stored = await writer.readCase(recorded.caseId);
    const index = await writer.readIndex();
    const contentMatch = stored != null
      && stored.case_id === recorded.caseId
      && stored.photo_archive_status === 'not_provided'
      && Array.isArray(stored.photo_refs)
      && stored.photo_refs.length === 0
      && calibrationObservationFingerprint(stored) === calibrationObservationFingerprint(quote)
      && index.archive === 'probe'
      && index.cases[recorded.caseId] === `data/probes/cases/${recorded.caseId}.json`
      && index.source_keys[CALIBRATION_PROBE_CERTIFICATION_KEY] === recorded.caseId
      && recorded.caseId >= CALIBRATION_PROBE_FIRST_ID;
    const after = await readRealIndex(guarded, await app.authorization());
    const realIndexUnchanged = after != null && after.sha === before.sha && after.text === before.text;
    if (!contentMatch || !realIndexUnchanged || !after) {
      return {
        ...error(realIndexUnchanged ? 'rejected' : 'real_index'),
        status: recorded.status,
        caseId: recorded.caseId,
        sourceKey: CALIBRATION_PROBE_CERTIFICATION_KEY,
        contentMatch,
        probeCaseCount: Object.keys(index.cases).length,
        realCaseCountBefore: before.count,
        realCaseCountAfter: after?.count,
        realIndexUnchanged,
      };
    }
    return {
      service: 'github-probe-write',
      result: 'ok',
      status: recorded.status,
      caseId: recorded.caseId,
      sourceKey: CALIBRATION_PROBE_CERTIFICATION_KEY,
      contentMatch: true,
      photoArchiveStatus: 'not_provided',
      photoCount: 0,
      probeCaseCount: Object.keys(index.cases).length,
      realCaseCountBefore: before.count,
      realCaseCountAfter: after.count,
      realIndexUnchanged: true,
    };
  } catch (err) {
    return error(categoryOf(err));
  }
}

function contentsGrantIsExpected(grant: GithubInstallationGrant): boolean {
  if (grant.repositorySelection === 'all') return false;
  if (grant.permissions.contents !== 'write') return false;
  return Object.keys(grant.permissions).every((key) => key === 'contents' || key === 'metadata')
    && (grant.permissions.metadata == null || grant.permissions.metadata === 'read');
}

async function installationRepositories(transport: typeof fetch, token: string): Promise<string[] | null> {
  const response = await transport(REPOSITORIES_URL, {
    method: 'GET',
    headers: githubHeaders(token),
  });
  if (response.status === 401 || response.status === 403) {
    throw new CalibrationCredentialError('forbidden', 'Calibration GitHub App permissions were rejected');
  }
  if (!response.ok) return null;
  const payload = await response.json() as { total_count?: unknown; repositories?: unknown };
  if (typeof payload.total_count !== 'number' || !Array.isArray(payload.repositories)) return null;
  if (payload.total_count !== payload.repositories.length) return [];
  const names: string[] = [];
  for (const repository of payload.repositories) {
    if (!repository || typeof repository !== 'object' || Array.isArray(repository)) return null;
    const fullName = (repository as { full_name?: unknown }).full_name;
    if (typeof fullName !== 'string') return null;
    names.push(fullName);
  }
  return names;
}

async function readRealIndex(
  transport: typeof fetch,
  token: string,
): Promise<{ sha: string; text: string; count: number } | null> {
  const response = await transport(REAL_INDEX_URL, {
    method: 'GET',
    headers: githubHeaders(token),
  });
  if (!response.ok) return null;
  const payload = await response.json() as { sha?: unknown; content?: unknown };
  if (typeof payload.sha !== 'string' || typeof payload.content !== 'string') return null;
  const text = Buffer.from(payload.content.replace(/\s/g, ''), 'base64').toString('utf8');
  const index = JSON.parse(text) as { schema_version?: unknown; cases?: unknown; source_keys?: unknown };
  if (!index || typeof index.cases !== 'object' || Array.isArray(index.cases) || index.cases == null) return null;
  if (typeof index.source_keys !== 'object' || Array.isArray(index.source_keys) || index.source_keys == null) return null;
  for (const [caseId, path] of Object.entries(index.cases)) {
    if (!/^AF-[0-9]{6}$/.test(caseId) || path !== `data/cases/${caseId}.json`) return null;
  }
  return { sha: payload.sha, text, count: Object.keys(index.cases).length };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function categoryOf(err: unknown): ProbeWriteCategory {
  if (err instanceof CalibrationCredentialError) return err.kind;
  if (err instanceof CalibrationConflictError) {
    if (err.message === 'Source key already records a different observation') return 'conflict';
    if (err.message === 'Probe index can reach the real case range') return 'invalid_index';
    if (err.message === 'Probe path is not allowed') return 'scope';
    return 'rejected';
  }
  if (err instanceof CalibrationWriteError) {
    if (err.kind === 'forbidden') return 'forbidden';
    if (err.kind === 'conflict' || err.kind === 'validation' || err.kind === 'transient' || err.kind === 'rate_limit') {
      return 'partial';
    }
  }
  if (err instanceof Error && err.message === 'Calibration probe write refused a request') return 'rejected';
  return 'read_failed';
}

function error(category: ProbeWriteCategory): ProbeWriteReport {
  return { service: 'github-probe-write', result: 'error', category };
}

function guard(transport: typeof fetch): typeof fetch {
  return async (input, init) => {
    assertProbeWriteRequest(init?.method ?? 'GET', String(input));
    return transport(input, init);
  };
}

function withoutLineSeparators(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  const value = copy.CALIBRATION_GITHUB_APP_PRIVATE_KEY;
  if (value) copy.CALIBRATION_GITHUB_APP_PRIVATE_KEY = value.replace(/[\u2028\u2029]/g, '');
  return copy;
}
