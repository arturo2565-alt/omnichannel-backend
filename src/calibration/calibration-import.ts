import { readFileSync } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';
import { CalibrationValidationError, validateHumanQuote, type ValidatedHumanQuote } from './calibration-case';
import {
  CalibrationCloudinaryArchive,
  cloudinaryCredentials,
  createCloudinaryGateway,
} from './calibration-cloudinary-archive';
import { calibrationDiagnosticTarget } from './calibration-diagnose';
import {
  CalibrationEngine,
  calibrationObservationFingerprint,
  type CalibrationPhotoStore,
  type CalibrationPhotoStoreFailure,
} from './calibration-engine';
import {
  CALIBRATION_GITHUB_REPOSITORY,
  CalibrationCredentialError,
  CalibrationGithubApp,
  readGithubAppConfig,
  type GithubInstallationGrant,
} from './calibration-github-app';
import {
  CalibrationConflictError,
  CalibrationGithubWriter,
  CalibrationWriteError,
} from './calibration-github-writer';
import { validateCalibrationImage } from './calibration-image-archive.service';

const TOKEN_URL = /^https:\/\/api\.github\.com\/app\/installations\/\d{1,12}\/access_tokens$/;
const REPOSITORIES_URL = 'https://api.github.com/installation/repositories?per_page=100';
const PROTECTED_CASE_ID = 'AF-000001';
const RESERVED_SOURCE_KEYS = new Set(['probe-cal-009d-001', 'probe-cal-010-001']);
const FORBIDDEN_TEXT = ['cal008-probe', 'cal010-probe', 'data/probes', 'AF-900000', 'AF-900001'];

export type ImportCategory =
  | 'wrong_target'
  | 'flags'
  | 'missing'
  | 'incomplete'
  | 'forbidden'
  | 'rejected'
  | 'scope'
  | 'conflict'
  | 'partial'
  | 'real_index'
  | 'invalid';

export type ImportReport = {
  service: 'calibration-import';
  result: 'ok' | 'error';
  category?: ImportCategory;
  status?: 'created' | 'already_exists' | 'reconciled' | 'partial';
  caseId?: string;
  sourceKey?: string;
  photoRefs?: string[];
  duplicateImages?: number;
  contentMatch?: boolean;
  manifestMatch?: boolean;
  photoArchiveStatus?: 'not_provided' | 'pending_private_archive' | 'archived_private';
  realCaseCountBefore?: number;
  realCaseCountAfter?: number;
  protectedCaseUnchanged?: boolean;
  storageFailure?: CalibrationPhotoStoreFailure;
};

export type CalibrationImportInput = {
  source_case_key?: unknown;
  quoted_at?: unknown;
  human_verified?: unknown;
  vehicle?: unknown;
  line_items?: unknown;
  visual_observations?: unknown;
  images?: Buffer[];
};

export function prepareCalibrationImport(input: CalibrationImportInput): {
  quote: ValidatedHumanQuote;
  images: Buffer[];
  duplicateImages: number;
} {
  if (input.human_verified !== true) {
    throw new CalibrationConflictError('An authorized quote must be human verified');
  }
  const quote = validateHumanQuote({
    source: {
      kind: 'autofix_human_quote',
      source_case_key: input.source_case_key,
      quoted_at: input.quoted_at ?? null,
    },
    vehicle: input.vehicle,
    line_items: input.line_items,
    visual_observations: input.visual_observations ?? [],
    status: 'human_verified',
  });
  if (RESERVED_SOURCE_KEYS.has(quote.source.source_case_key) || quote.source.source_case_key.startsWith('probe-')) {
    throw new CalibrationConflictError('Source key belongs to the calibration probe');
  }
  const images = input.images ?? [];
  if (images.length < 1 || images.length > 4) {
    throw new CalibrationConflictError('The import accepts one to four original photographs');
  }
  const seen = new Set<string>();
  const unique: Buffer[] = [];
  let duplicateImages = 0;
  for (const bytes of images) {
    const { sha256 } = validateCalibrationImage(bytes);
    if (seen.has(sha256)) {
      duplicateImages += 1;
      continue;
    }
    seen.add(sha256);
    unique.push(bytes);
  }
  return { quote, images: unique, duplicateImages };
}

export function readCalibrationImportDocument(filePath: string): CalibrationImportInput {
  const text = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(text) as {
    source_case_key?: unknown;
    quoted_at?: unknown;
    human_verified?: unknown;
    vehicle?: unknown;
    line_items?: unknown;
    visual_observations?: unknown;
    images?: unknown;
  };
  const listed = parsed.images;
  if (!Array.isArray(listed) || !listed.every((item): item is string => typeof item === 'string')) {
    throw new CalibrationConflictError('The import accepts one to four original photographs');
  }
  const folder = dirname(filePath);
  const images = listed.map((item) => readFileSync(isAbsolute(item) ? item : join(folder, item)));
  return { ...parsed, images };
}

export function loadCalibrationImportFile(filePath: string): ReturnType<typeof prepareCalibrationImport> {
  return prepareCalibrationImport(readCalibrationImportDocument(filePath));
}

export async function importCalibrationCase(
  env: NodeJS.ProcessEnv,
  input: CalibrationImportInput,
  deps: {
    transport?: typeof fetch;
    photos?: CalibrationPhotoStore;
    clock?: () => string;
    maxTransientAttempts?: number;
  } = {},
): Promise<ImportReport> {
  if (!calibrationDiagnosticTarget(env)) return error('wrong_target');
  if (env.CALIBRATION_INGEST_ENABLED !== 'false' || env.DB_SYNCHRONIZE !== 'false') return error('flags');
  let prepared: ReturnType<typeof prepareCalibrationImport>;
  try {
    prepared = prepareCalibrationImport(input);
  } catch (err) {
    return error(categoryOf(err));
  }
  const transport = deps.transport ?? fetch;
  const guarded = guard(transport);
  try {
    const config = readGithubAppConfig(withoutLineSeparators(env));
    if (!config) return error('missing');
    const photos = guardPhotos(deps.photos ?? livePhotos(env, transport));
    if (!photos) return error('missing');
    const app = new CalibrationGithubApp(config, guarded);
    await app.authorization();
    const grant = app.installationGrant();
    if (!grant || !contentsGrantIsExpected(grant)) return error('scope');
    const names = await installationRepositories(guarded, await app.authorization());
    if (!names) return error('rejected');
    if (names.length !== 1 || names[0] !== CALIBRATION_GITHUB_REPOSITORY) return error('scope');
    const writer = new CalibrationGithubWriter(app, guarded);
    const index = await writer.readIndex();
    const protectedBefore = await writer.readCase(PROTECTED_CASE_ID);
    const realCaseCountBefore = Object.keys(index.cases).length;
    if (!protectedBefore || index.cases[PROTECTED_CASE_ID] !== `data/cases/${PROTECTED_CASE_ID}.json`) {
      return error('real_index');
    }
    const existingId = index.source_keys[prepared.quote.source.source_case_key];
    if (existingId === PROTECTED_CASE_ID || (existingId != null && !realCaseId(existingId))) {
      return halted('conflict', writer, protectedBefore, realCaseCountBefore);
    }
    if (existingId && !(await sameCompleteObservation(writer, existingId, prepared))) {
      const stored = await writer.readCase(existingId);
      if (!stored || calibrationObservationFingerprint(stored) !== calibrationObservationFingerprint(prepared.quote)) {
        return halted('conflict', writer, protectedBefore, realCaseCountBefore);
      }
    }
    if (existingId && await sameCompleteObservation(writer, existingId, prepared)) {
      return finish(writer, protectedBefore, realCaseCountBefore, {
        status: 'already_exists',
        caseId: existingId,
        photoArchiveStatus: 'archived_private',
        photoRefs: photoIds(prepared.images.length),
      }, prepared);
    }
    const engine = new CalibrationEngine(writer, photos, deps.clock ?? (() => new Date().toISOString()), {
      sleep: async () => undefined,
      random: () => 0,
      retry: { maxTransientAttempts: deps.maxTransientAttempts ?? 3 },
    });
    let recorded;
    try {
      recorded = await engine.record(prepared.quote, prepared.images);
      if (!realCaseId(recorded.caseId)) throw new CalibrationConflictError('Real import selected a protected case');
      if (recorded.orphanPhotoRefs.length > 0) {
        await engine.recoverOrphanManifests(recorded.caseId, recorded.orphanPhotoRefs);
      }
    } catch (err) {
      return halted(categoryOf(err) === 'rejected' ? 'partial' : categoryOf(err), writer, protectedBefore, realCaseCountBefore);
    }
    return finish(writer, protectedBefore, realCaseCountBefore, recorded, prepared);
  } catch (err) {
    return error(categoryOf(err));
  }
}

export function assertRealImportRequest(method: string, rawUrl: string): void {
  const verb = method.toUpperCase();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Calibration import refused a request');
  }
  const mentionsProtectedCase = url.href.includes(PROTECTED_CASE_ID);
  const forbidden = FORBIDDEN_TEXT.some((needle) => url.href.includes(needle)) || (mentionsProtectedCase && verb === 'PUT');
  if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' || url.username || url.password || forbidden) {
    throw new Error('Calibration import refused a request');
  }
  if (verb === 'POST' && TOKEN_URL.test(url.origin + url.pathname) && url.search === '') return;
  if (verb === 'GET' && url.href === REPOSITORIES_URL) return;
  const prefix = `/repos/${CALIBRATION_GITHUB_REPOSITORY}/contents/`;
  const allowedSearch = verb === 'GET' ? '?ref=main' : '';
  if (!url.pathname.startsWith(prefix) || url.search !== allowedSearch) {
    throw new Error('Calibration import refused a request');
  }
  const path = url.pathname.slice(prefix.length);
  if (path === 'data/index.json') return;
  if (verb === 'GET' && path === `data/cases/${PROTECTED_CASE_ID}.json`) return;
  if ((verb === 'GET' || verb === 'PUT') && /^data\/cases\/AF-0\d{5}\.json$/.test(path) && !path.endsWith(`${PROTECTED_CASE_ID}.json`)) return;
  if ((verb === 'GET' || verb === 'PUT') && /^data\/photos\/AF-0\d{5}\/IMG-[0-9]{6}\.json$/.test(path) && !path.includes(PROTECTED_CASE_ID)) return;
  throw new Error('Calibration import refused a request');
}

async function sameCompleteObservation(
  writer: CalibrationGithubWriter,
  caseId: string,
  prepared: ReturnType<typeof prepareCalibrationImport>,
): Promise<boolean> {
  const stored = await writer.readCase(caseId);
  if (!stored || calibrationObservationFingerprint(stored) !== calibrationObservationFingerprint(prepared.quote)) return false;
  const refs = Array.isArray(stored.photo_refs) ? stored.photo_refs : [];
  const expected = photoIds(prepared.images.length);
  if (stored.photo_archive_status !== 'archived_private' || refs.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (refs[index] !== expected[index]) return false;
    const manifest = await writer.readPhotoManifest(caseId, expected[index]);
    const sha = validateCalibrationImage(prepared.images[index]).sha256;
    const publicId = manifest?.asset_public_id;
    if (
      !manifest
      || manifest.storage_status !== 'verified'
      || manifest.content_sha256 !== sha
      || manifest.case_id !== caseId
      || typeof publicId !== 'string'
      || !publicId.startsWith(`pegazuz_calibration/${caseId}/`)
      || FORBIDDEN_TEXT.some((needle) => publicId.includes(needle))
    ) return false;
  }
  return true;
}

async function finish(
  writer: CalibrationGithubWriter,
  protectedBefore: Record<string, unknown>,
  realCaseCountBefore: number,
  recorded: {
    status: 'created' | 'already_exists' | 'reconciled';
    caseId: string;
    photoArchiveStatus: ImportReport['photoArchiveStatus'];
    photoRefs: string[];
    storageFailure?: CalibrationPhotoStoreFailure;
  },
  prepared: ReturnType<typeof prepareCalibrationImport>,
): Promise<ImportReport> {
  const complete = realCaseId(recorded.caseId) && await sameCompleteObservation(writer, recorded.caseId, prepared);
  const protectedAfter = await writer.readCase(PROTECTED_CASE_ID);
  const index = await writer.readIndex();
  const protectedCaseUnchanged = JSON.stringify(protectedAfter) === JSON.stringify(protectedBefore)
    && index.cases[PROTECTED_CASE_ID] === `data/cases/${PROTECTED_CASE_ID}.json`;
  const base: ImportReport = {
    service: 'calibration-import',
    result: complete && protectedCaseUnchanged ? 'ok' : 'error',
    category: complete && protectedCaseUnchanged ? undefined : protectedCaseUnchanged ? 'partial' : 'real_index',
    status: complete && protectedCaseUnchanged ? recorded.status : 'partial',
    caseId: recorded.caseId,
    sourceKey: prepared.quote.source.source_case_key,
    photoRefs: complete ? photoIds(prepared.images.length) : recorded.photoRefs,
    duplicateImages: prepared.duplicateImages,
    contentMatch: complete,
    manifestMatch: complete,
    photoArchiveStatus: complete ? 'archived_private' : recorded.photoArchiveStatus,
    realCaseCountBefore,
    realCaseCountAfter: Object.keys(index.cases).length,
    protectedCaseUnchanged,
    ...(recorded.storageFailure && !complete ? { storageFailure: recorded.storageFailure } : {}),
  };
  return base;
}

async function halted(
  category: ImportCategory,
  writer: CalibrationGithubWriter,
  protectedBefore: Record<string, unknown>,
  realCaseCountBefore: number,
): Promise<ImportReport> {
  let protectedAfter: Record<string, unknown> | null = null;
  try {
    protectedAfter = await writer.readCase(PROTECTED_CASE_ID);
  } catch {
    protectedAfter = null;
  }
  return {
    ...error(category),
    realCaseCountBefore,
    protectedCaseUnchanged: protectedAfter != null && JSON.stringify(protectedAfter) === JSON.stringify(protectedBefore),
  };
}

function guardPhotos(photos: CalibrationPhotoStore | null): CalibrationPhotoStore | null {
  if (!photos) return null;
  return {
    async store(input) {
      if (!realCaseId(input.caseId)) throw new CalibrationConflictError('Real import selected a protected case');
      const stored = await photos.store(input);
      const publicId = stored.assetPublicId ?? '';
      if (publicId && (!publicId.startsWith(`pegazuz_calibration/${input.caseId}/`) || FORBIDDEN_TEXT.some((needle) => publicId.includes(needle)))) {
        return { sha256: stored.sha256, verified: false, assetPublicId: null, assetVersion: null, failure: 'receipt_rejected' };
      }
      return stored;
    },
  };
}

function livePhotos(env: NodeJS.ProcessEnv, transport: typeof fetch): CalibrationPhotoStore | null {
  const clean = withoutLineSeparators(env);
  const credentials = cloudinaryCredentials(clean);
  if (!credentials) return null;
  const gateway = createCloudinaryGateway(clean, cloudinaryGuard(transport));
  if (!gateway) return null;
  return new CalibrationCloudinaryArchive(gateway);
}

function realCaseId(caseId: string): boolean {
  return /^AF-0\d{5}$/.test(caseId) && caseId !== PROTECTED_CASE_ID;
}

function photoIds(count: number): string[] {
  return Array.from({ length: count }, (_item, index) => `IMG-${String(index + 1).padStart(6, '0')}`);
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
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
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

function categoryOf(err: unknown): ImportCategory {
  if (err instanceof CalibrationCredentialError) return err.kind === 'forbidden' ? 'forbidden' : 'rejected';
  if (err instanceof CalibrationConflictError) {
    if (err.message === 'Source key already records a different observation' || err.message === 'Source key belongs to the calibration probe') {
      return 'conflict';
    }
    if (err.message === 'An authorized quote must be human verified' || err.message === 'The import accepts one to four original photographs') {
      return 'incomplete';
    }
    return 'rejected';
  }
  if (err instanceof CalibrationWriteError) return err.kind === 'forbidden' ? 'forbidden' : 'partial';
  if (err instanceof Error && err.message === 'Calibration import refused a request') return 'rejected';
  if (err instanceof CalibrationValidationError) return 'invalid';
  return 'invalid';
}

function error(category: ImportCategory): ImportReport {
  return { service: 'calibration-import', result: 'error', category };
}

function guard(transport: typeof fetch): typeof fetch {
  return async (input, init) => {
    assertRealImportRequest(init?.method ?? 'GET', String(input));
    return transport(input, init);
  };
}

function cloudinaryGuard(transport: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const allowedHost = url.protocol === 'https:' && (url.hostname === 'res.cloudinary.com' || url.hostname === 'api.cloudinary.com');
    const foreign = FORBIDDEN_TEXT.some((needle) => url.href.includes(needle)) || url.href.includes(PROTECTED_CASE_ID);
    if (!allowedHost || foreign || url.username || url.password) {
      throw new Error('Calibration import refused a request');
    }
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
