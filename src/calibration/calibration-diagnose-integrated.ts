import { createHash } from 'node:crypto';
import { validateHumanQuote } from './calibration-case';
import {
  CAL010_CLOUDINARY_PREFIX,
  cloudinaryCredentials,
  createCloudinaryGateway,
} from './calibration-cloudinary-archive';
import { calibrationDiagnosticTarget } from './calibration-diagnose';
import {
  assertProbeWriteRequest,
} from './calibration-diagnose-probe-write';
import { calibrationObservationFingerprint } from './calibration-engine';
import type { CalibrationPhotoStore, CalibrationPhotoStoreFailure } from './calibration-engine';
import {
  CALIBRATION_GITHUB_REPOSITORY,
  CalibrationCredentialError,
  CalibrationGithubApp,
  readGithubAppConfig,
  type GithubInstallationGrant,
} from './calibration-github-app';
import { CalibrationConflictError, CalibrationWriteError } from './calibration-github-writer';
import { CalibrationProbeWriter } from './calibration-probe';
import {
  CAL010_PROTECTED_CASE_ID,
  CAL010_SOURCE_KEY,
  assertCal010Floor,
  cal010Quote,
  createCal010PhotoArchive,
  recoverCal010Manifest,
  recordCal010Observation,
  syntheticCal010Image,
} from './calibration-probe-flow';

const REPOSITORIES_URL = 'https://api.github.com/installation/repositories?per_page=100';
const REAL_INDEX_URL = `https://api.github.com/repos/${CALIBRATION_GITHUB_REPOSITORY}/contents/data/index.json?ref=main`;
const FORBIDDEN_TEXT = ['27b61d9ab76b915baa754954bfb34ec8', 'cal008-probe', 'AF-000001'];

export type IntegratedCategory =
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

export type IntegratedReport = {
  service: 'calibration-integrated';
  result: 'ok' | 'error';
  category?: IntegratedCategory;
  status?: 'created' | 'already_exists' | 'reconciled' | 'partial';
  caseId?: string;
  sourceKey?: typeof CAL010_SOURCE_KEY;
  photoRef?: 'IMG-000001';
  contentMatch?: boolean;
  manifestMatch?: boolean;
  photoArchiveStatus?: 'not_provided' | 'pending_private_archive' | 'archived_private';
  probeCaseCount?: number;
  realCaseCountBefore?: number;
  realCaseCountAfter?: number;
  realIndexUnchanged?: boolean;
  protectedCaseUnchanged?: boolean;
  storageFailure?: CalibrationPhotoStoreFailure;
};

export async function diagnoseCalibrationIntegrated(
  env: NodeJS.ProcessEnv,
  deps: { transport?: typeof fetch; photos?: CalibrationPhotoStore } = {},
): Promise<IntegratedReport> {
  if (!calibrationDiagnosticTarget(env)) return error('wrong_target');
  if (env.CALIBRATION_INGEST_ENABLED !== 'false' || env.DB_SYNCHRONIZE !== 'false') return error('flags');
  const transport = deps.transport ?? fetch;
  const guarded = guard(transport);
  try {
    const config = readGithubAppConfig(withoutLineSeparators(env));
    if (!config) return error('missing');
    const photos = deps.photos ?? livePhotos(env, transport);
    if (!photos) return error('missing');
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
    let index;
    try {
      index = await writer.readIndex();
      assertCal010Floor(index);
    } catch (err) {
      return halted(categoryOf(err), before, null, writer, guarded, app);
    }
    const protectedBefore = await writer.readCase(CAL010_PROTECTED_CASE_ID);
    if (!protectedBefore) return halted('invalid_index', before, null, writer, guarded, app);
    const quote = validateHumanQuote(cal010Quote());
    const imageSha = createHash('sha256').update(syntheticCal010Image()).digest('hex');
    const existingId = index.source_keys[CAL010_SOURCE_KEY];
    if (existingId) {
      const inspected = await inspectExisting(writer, existingId, quote, imageSha);
      if (inspected.stop) return halted(inspected.category, before, protectedBefore, writer, guarded, app);
      if (inspected.complete) {
        return finish(writer, guarded, app, before, protectedBefore, {
          status: 'already_exists',
          caseId: existingId,
        });
      }
      if (inspected.orphan) {
        try {
          await recoverCal010Manifest(writer, photos, existingId);
        } catch (err) {
          return halted(categoryOf(err) === 'read_failed' ? 'partial' : categoryOf(err), before, protectedBefore, writer, guarded, app);
        }
        return finish(writer, guarded, app, before, protectedBefore, {
          status: 'already_exists',
          caseId: existingId,
        });
      }
    }
    let recorded;
    try {
      recorded = await recordCal010Observation(writer, photos, { maxTransientAttempts: 0 });
      if (recorded.orphanPhotoRefs.length > 0) {
        await recoverCal010Manifest(writer, photos, recorded.caseId);
      }
    } catch (err) {
      const category = categoryOf(err);
      return halted(category === 'read_failed' ? 'partial' : category, before, protectedBefore, writer, guarded, app);
    }
    return finish(writer, guarded, app, before, protectedBefore, recorded);
  } catch (err) {
    return error(categoryOf(err));
  }
}

async function inspectExisting(
  writer: CalibrationProbeWriter,
  caseId: string,
  quote: ReturnType<typeof validateHumanQuote>,
  imageSha: string,
): Promise<{ stop: boolean; complete: boolean; orphan: boolean; category: IntegratedCategory }> {
  if (caseId === CAL010_PROTECTED_CASE_ID || !/^AF-9\d{5}$/.test(caseId)) {
    return { stop: true, complete: false, orphan: false, category: 'conflict' };
  }
  const stored = await writer.readCase(caseId);
  if (!stored || calibrationObservationFingerprint(stored) !== calibrationObservationFingerprint(quote)) {
    return { stop: true, complete: false, orphan: false, category: 'conflict' };
  }
  const manifest = await writer.readPhotoManifest(caseId, 'IMG-000001');
  if (manifest && manifest.content_sha256 !== imageSha) {
    return { stop: true, complete: false, orphan: false, category: 'conflict' };
  }
  const refs = Array.isArray(stored.photo_refs) ? stored.photo_refs : [];
  const linked = stored.photo_archive_status === 'archived_private' && refs.length === 1 && refs[0] === 'IMG-000001';
  if (linked && manifestMatches(manifest, caseId, imageSha)) {
    return { stop: false, complete: true, orphan: false, category: 'conflict' };
  }
  if (!linked && manifestMatches(manifest, caseId, imageSha)) {
    return { stop: false, complete: false, orphan: true, category: 'partial' };
  }
  return { stop: false, complete: false, orphan: false, category: 'partial' };
}

function manifestMatches(manifest: Record<string, unknown> | null, caseId: string, imageSha: string): boolean {
  if (!manifest) return false;
  const publicId = manifest.asset_public_id;
  return manifest.storage_status === 'verified'
    && manifest.case_id === caseId
    && manifest.photo_id === 'IMG-000001'
    && manifest.content_sha256 === imageSha
    && typeof publicId === 'string'
    && publicId.startsWith(`${CAL010_CLOUDINARY_PREFIX}/${caseId}/`)
    && !FORBIDDEN_TEXT.some((needle) => publicId.includes(needle));
}

async function finish(
  writer: CalibrationProbeWriter,
  transport: typeof fetch,
  app: CalibrationGithubApp,
  before: { sha: string; text: string; count: number },
  protectedBefore: Record<string, unknown>,
  recorded: {
    status: 'created' | 'already_exists' | 'reconciled';
    caseId: string;
    storageFailure?: CalibrationPhotoStoreFailure;
  },
): Promise<IntegratedReport> {
  const stored = await writer.readCase(recorded.caseId);
  const manifest = await writer.readPhotoManifest(recorded.caseId, 'IMG-000001');
  const index = await writer.readIndex();
  const imageSha = createHash('sha256').update(syntheticCal010Image()).digest('hex');
  const quote = validateHumanQuote(cal010Quote());
  const manifestMatch = manifestMatches(manifest, recorded.caseId, imageSha);
  const refs = Array.isArray(stored?.photo_refs) ? stored.photo_refs : [];
  const contentMatch = stored != null
    && stored.case_id === recorded.caseId
    && recorded.caseId !== CAL010_PROTECTED_CASE_ID
    && calibrationObservationFingerprint(stored) === calibrationObservationFingerprint(quote)
    && stored.photo_archive_status === 'archived_private'
    && refs.length === 1
    && refs[0] === 'IMG-000001'
    && manifestMatch;
  const after = await readRealIndex(transport, await app.authorization());
  const protectedAfter = await writer.readCase(CAL010_PROTECTED_CASE_ID);
  const realIndexUnchanged = after != null && after.sha === before.sha && after.text === before.text;
  const protectedCaseUnchanged = JSON.stringify(protectedAfter) === JSON.stringify(protectedBefore);
  const base: Omit<IntegratedReport, 'service' | 'result' | 'category' | 'status'> = {
    caseId: recorded.caseId,
    sourceKey: CAL010_SOURCE_KEY,
    photoRef: 'IMG-000001',
    contentMatch,
    manifestMatch,
    photoArchiveStatus: stored?.photo_archive_status as IntegratedReport['photoArchiveStatus'],
    probeCaseCount: Object.keys(index.cases).length,
    realCaseCountBefore: before.count,
    realCaseCountAfter: after?.count,
    realIndexUnchanged,
    protectedCaseUnchanged,
  };
  if (!contentMatch || !realIndexUnchanged || !protectedCaseUnchanged || !after) {
    return {
      service: 'calibration-integrated',
      result: 'error',
      category: !realIndexUnchanged || !protectedCaseUnchanged ? 'real_index' : 'partial',
      status: 'partial',
      ...base,
      ...(recorded.storageFailure ? { storageFailure: recorded.storageFailure } : {}),
    };
  }
  return {
    service: 'calibration-integrated',
    result: 'ok',
    status: recorded.status,
    ...base,
  };
}

async function halted(
  category: IntegratedCategory,
  before: { sha: string; text: string; count: number },
  protectedBefore: Record<string, unknown> | null,
  writer?: CalibrationProbeWriter,
  transport?: typeof fetch,
  app?: CalibrationGithubApp,
): Promise<IntegratedReport> {
  let after: { sha: string; text: string; count: number } | null = null;
  let protectedAfter: Record<string, unknown> | null = null;
  if (transport && app) {
    try {
      after = await readRealIndex(transport, await app.authorization());
    } catch {
      after = null;
    }
  }
  if (writer && protectedBefore) {
    try {
      protectedAfter = await writer.readCase(CAL010_PROTECTED_CASE_ID);
    } catch {
      protectedAfter = null;
    }
  }
  const knownAfter = after != null;
  return {
    ...error(category),
    sourceKey: CAL010_SOURCE_KEY,
    realCaseCountBefore: before.count,
    realCaseCountAfter: after?.count,
    realIndexUnchanged: knownAfter ? after!.sha === before.sha && after!.text === before.text : undefined,
    protectedCaseUnchanged: protectedBefore != null && protectedAfter != null
      ? JSON.stringify(protectedAfter) === JSON.stringify(protectedBefore)
      : undefined,
  };
}

function livePhotos(env: NodeJS.ProcessEnv, transport: typeof fetch): CalibrationPhotoStore | null {
  const clean = withoutLineSeparators(env);
  const credentials = cloudinaryCredentials(clean);
  if (!credentials || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(credentials.cloudName)) return null;
  const gateway = createCloudinaryGateway(clean, cloudinaryGuard(transport));
  if (!gateway) return null;
  return createCal010PhotoArchive(gateway);
}

function contentsGrantIsExpected(grant: GithubInstallationGrant): boolean {
  if (grant.repositorySelection === 'all') return false;
  if (grant.permissions.contents !== 'write') return false;
  return Object.keys(grant.permissions).every((key) => key === 'contents' || key === 'metadata')
    && (grant.permissions.metadata == null || grant.permissions.metadata === 'read');
}

async function installationRepositories(transport: typeof fetch, token: string): Promise<string[] | null> {
  const response = await transport(REPOSITORIES_URL, { method: 'GET', headers: githubHeaders(token) });
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
  const response = await transport(REAL_INDEX_URL, { method: 'GET', headers: githubHeaders(token) });
  if (!response.ok) return null;
  const payload = await response.json() as { sha?: unknown; content?: unknown };
  if (typeof payload.sha !== 'string' || typeof payload.content !== 'string') return null;
  const text = Buffer.from(payload.content.replace(/\s/g, ''), 'base64').toString('utf8');
  const index = JSON.parse(text) as { cases?: unknown };
  if (!index || typeof index.cases !== 'object' || Array.isArray(index.cases) || index.cases == null) return null;
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

function categoryOf(err: unknown): IntegratedCategory {
  if (err instanceof CalibrationCredentialError) return err.kind;
  if (err instanceof CalibrationConflictError) {
    if (err.message === 'Source key already records a different observation') return 'conflict';
    if (err.message === 'Probe index can reach the real case range' || err.message === 'Protected probe case is missing') {
      return 'invalid_index';
    }
    if (err.message === 'Probe path is not allowed') return 'scope';
    return 'rejected';
  }
  if (err instanceof CalibrationWriteError) {
    if (err.kind === 'forbidden') return 'forbidden';
    if (err.message === 'Missing probe index') return 'invalid_index';
    if (err.kind === 'conflict' || err.kind === 'validation' || err.kind === 'transient' || err.kind === 'rate_limit') {
      return 'partial';
    }
  }
  if (err instanceof Error && err.message === 'Calibration probe write refused a request') return 'rejected';
  return 'read_failed';
}

function error(category: IntegratedCategory): IntegratedReport {
  return { service: 'calibration-integrated', result: 'error', category };
}

function guard(transport: typeof fetch): typeof fetch {
  return async (input, init) => {
    assertProbeWriteRequest(init?.method ?? 'GET', String(input));
    return transport(input, init);
  };
}

/** Downloads stay on Cloudinary and off the CAL-008 asset, the protected case, and the real case. */
export function assertIntegratedCloudinaryRequest(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Calibration probe write refused a request');
  }
  const allowedHost = url.protocol === 'https:' && (url.hostname === 'res.cloudinary.com' || url.hostname === 'api.cloudinary.com');
  const foreign = FORBIDDEN_TEXT.some((needle) => url.href.includes(needle)) || url.href.includes('AF-900000');
  if (!allowedHost || foreign || url.username || url.password) {
    throw new Error('Calibration probe write refused a request');
  }
}

function cloudinaryGuard(transport: typeof fetch): typeof fetch {
  return async (input, init) => {
    assertIntegratedCloudinaryRequest(String(input));
    return transport(input, init);
  };
}

function withoutLineSeparators(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const key of ['CALIBRATION_GITHUB_APP_PRIVATE_KEY', 'CLOUDINARY_API_SECRET', 'CLOUDINARY_API_KEY', 'CLOUDINARY_CLOUD_NAME']) {
    const value = copy[key];
    if (value) copy[key] = value.replace(/[\u2028\u2029]/g, '');
  }
  return copy;
}
