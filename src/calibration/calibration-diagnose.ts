import { CALIBRATION_SCHEMA_VERSION } from './calibration-case';
import { cloudinaryCredentials } from './calibration-cloudinary-archive';
import {
  CALIBRATION_GITHUB_REPOSITORY,
  CalibrationCredentialError,
  CalibrationGithubApp,
  readGithubAppConfig,
  type GithubInstallationGrant,
} from './calibration-github-app';
import {
  CalibrationGithubWriter,
  CalibrationWriteError,
  type CalibrationIndex,
} from './calibration-github-writer';

/**
 * CAL-007B.1. Read-only probes. They do not mount a route and they refuse
 * every method except the installation-token request and the two GETs below.
 */
export const CALIBRATION_DIAGNOSTIC_PROJECT_ID = 'db653a25-d8c0-4026-9026-b8f74fb9f1fb';
export const CALIBRATION_DIAGNOSTIC_ENVIRONMENT_ID = 'faf009cb-88a2-4ac8-80bd-7e3f60bbca8b';
export const CALIBRATION_DIAGNOSTIC_SERVICE_ID = 'b40bff1c-2da4-4460-b5f4-507d9d994d0a';

const INDEX_URL = `https://api.github.com/repos/${CALIBRATION_GITHUB_REPOSITORY}/contents/data/index.json?ref=main`;
const REPOSITORIES_URL = 'https://api.github.com/installation/repositories?per_page=100';
const TOKEN_URL = /^https:\/\/api\.github\.com\/app\/installations\/\d{1,12}\/access_tokens$/;

export type CalibrationDiagnosticCategory =
  | 'missing'
  | 'incomplete'
  | 'forbidden'
  | 'rejected'
  | 'scope'
  | 'invalid_index'
  | 'read_failed'
  | 'wrong_target';

export type CalibrationDiagnosticReport = {
  service: 'github' | 'cloudinary';
  result: 'ok' | 'error';
  category?: CalibrationDiagnosticCategory;
  caseCount?: number;
};

export function calibrationDiagnosticTarget(env: NodeJS.ProcessEnv): boolean {
  const environment = (env.RAILWAY_ENVIRONMENT_NAME ?? env.RAILWAY_ENVIRONMENT ?? '').trim();
  const service = (env.RAILWAY_SERVICE_NAME ?? env.RAILWAY_SERVICE ?? '').trim();
  return environment === 'staging'
    && service === 'pegazuz-backend-staging'
    && env.RAILWAY_PROJECT_ID?.trim() === CALIBRATION_DIAGNOSTIC_PROJECT_ID
    && env.RAILWAY_ENVIRONMENT_ID?.trim() === CALIBRATION_DIAGNOSTIC_ENVIRONMENT_ID
    && env.RAILWAY_SERVICE_ID?.trim() === CALIBRATION_DIAGNOSTIC_SERVICE_ID;
}

export function assertDiagnosticRequest(method: string, url: string): void {
  const verb = method.toUpperCase();
  if (verb === 'POST' && TOKEN_URL.test(url)) return;
  if (verb === 'GET' && (url === INDEX_URL || url === REPOSITORIES_URL)) return;
  if (verb === 'GET' && /^https:\/\/api\.cloudinary\.com\/v1_1\/[a-z0-9][a-z0-9-]{0,62}\/usage$/i.test(url)) return;
  throw new Error('Calibration diagnostic refused a write');
}

export async function diagnoseCalibrationGithub(
  env: NodeJS.ProcessEnv,
  transport: typeof fetch = fetch,
): Promise<CalibrationDiagnosticReport> {
  const guarded = guard(transport);
  try {
    const config = readGithubAppConfig(withoutLineSeparators(env));
    if (!config) return error('github', 'missing');
    const app = new CalibrationGithubApp(config, guarded);
    await app.authorization();
    const grant = app.installationGrant();
    if (!grant || !contentsGrantIsExpected(grant)) return error('github', 'scope');
    const names = await installationRepositories(guarded, await app.authorization());
    if (!names) return error('github', 'read_failed');
    if (names.length !== 1 || names[0] !== CALIBRATION_GITHUB_REPOSITORY) return error('github', 'scope');
    const writer = new CalibrationGithubWriter(app, guarded);
    const index = await writer.readIndex();
    if (!indexIsSound(index)) return error('github', 'invalid_index');
    return { service: 'github', result: 'ok', caseCount: Object.keys(index.cases).length };
  } catch (err) {
    return error('github', categoryOf(err));
  }
}

export async function diagnoseCalibrationCloudinary(
  env: NodeJS.ProcessEnv,
  transport: typeof fetch = fetch,
): Promise<CalibrationDiagnosticReport> {
  const clean = withoutLineSeparators(env);
  const cloudName = clean.CLOUDINARY_CLOUD_NAME?.trim() ?? '';
  const apiKey = clean.CLOUDINARY_API_KEY?.trim() ?? '';
  const apiSecret = clean.CLOUDINARY_API_SECRET?.trim() ?? '';
  if (!cloudName && !apiKey && !apiSecret) return error('cloudinary', 'missing');
  if (!cloudName || !apiKey || !apiSecret) return error('cloudinary', 'incomplete');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(cloudName)) return error('cloudinary', 'rejected');
  const credentials = cloudinaryCredentials(clean);
  if (!credentials) return error('cloudinary', 'missing');
  const url = `https://api.cloudinary.com/v1_1/${credentials.cloudName}/usage`;
  try {
    const response = await guard(transport)(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.apiKey}:${credentials.apiSecret}`).toString('base64')}`,
      },
    });
    await response.arrayBuffer().catch(() => undefined);
    if (response.status === 401 || response.status === 403) return error('cloudinary', 'forbidden');
    if (!response.ok) return error('cloudinary', 'rejected');
    return { service: 'cloudinary', result: 'ok' };
  } catch {
    return error('cloudinary', 'rejected');
  }
}

function contentsGrantIsExpected(grant: GithubInstallationGrant): boolean {
  if (grant.repositorySelection === 'all') return false;
  if (grant.permissions.contents !== 'write') return false;
  return Object.keys(grant.permissions).every((key) => key === 'contents' || key === 'metadata')
    && (grant.permissions.metadata == null || grant.permissions.metadata === 'read');
}

async function installationRepositories(
  transport: typeof fetch,
  token: string,
): Promise<string[] | null> {
  const response = await transport(REPOSITORIES_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
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

function indexIsSound(index: CalibrationIndex): boolean {
  if (index.schema_version !== CALIBRATION_SCHEMA_VERSION) return false;
  if (Array.isArray(index.cases) || Array.isArray(index.source_keys)) return false;
  for (const [caseId, path] of Object.entries(index.cases)) {
    if (!/^AF-[0-9]{6}$/.test(caseId) || path !== `data/cases/${caseId}.json`) return false;
  }
  for (const caseId of Object.values(index.source_keys)) {
    if (typeof caseId !== 'string' || !index.cases[caseId]) return false;
  }
  return true;
}

function categoryOf(err: unknown): CalibrationDiagnosticCategory {
  if (err instanceof CalibrationCredentialError) return err.kind;
  if (err instanceof CalibrationWriteError && err.kind === 'forbidden') return 'forbidden';
  if (err instanceof SyntaxError || (err instanceof CalibrationWriteError && err.message === 'Invalid master index')) {
    return 'invalid_index';
  }
  if (err instanceof Error && err.message === 'Calibration diagnostic refused a write') return 'rejected';
  return 'read_failed';
}

function error(
  service: CalibrationDiagnosticReport['service'],
  category: CalibrationDiagnosticCategory,
): CalibrationDiagnosticReport {
  return { service, result: 'error', category };
}

function guard(transport: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    assertDiagnosticRequest(init?.method ?? 'GET', url);
    return transport(input, init);
  };
}

function withoutLineSeparators(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const key of [
    'CALIBRATION_GITHUB_APP_PRIVATE_KEY',
    'CLOUDINARY_API_SECRET',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_CLOUD_NAME',
  ]) {
    const value = copy[key];
    if (value) copy[key] = value.replace(/[\u2028\u2029]/g, '');
  }
  return copy;
}
