import { lstatSync, readFileSync, type Stats } from 'node:fs';
import { calibrationDiagnosticTarget } from './calibration-diagnose';
import {
  CALIBRATION_GITHUB_REPOSITORY,
  CalibrationCredentialError,
  CalibrationGithubApp,
  readGithubAppConfig,
  type GithubInstallationGrant,
} from './calibration-github-app';
import {
  CalibrationConflictError,
  CalibrationWriteError,
} from './calibration-github-writer';
import { CalibrationValidationError } from './calibration-case';
import {
  RepairGithubWriter,
  assertRepairTransport,
  type RepairArchive,
} from './repair-quote-writer';
import {
  recordRepairObservation,
  type RepairRecordResult,
} from './repair-quote-store';
import { validateRepairQuote, type ValidatedRepairQuote } from './repair-quote';

const TOKEN_URL =
  /^https:\/\/api\.github\.com\/app\/installations\/\d{1,12}\/access_tokens$/;
const REPOSITORIES_URL =
  'https://api.github.com/installation/repositories?per_page=100';
const MAX_QUOTE_BYTES = 64 * 1024;

export type RepairImportCategory =
  | 'wrong_target'
  | 'flags'
  | 'missing'
  | 'incomplete'
  | 'forbidden'
  | 'rejected'
  | 'scope'
  | 'conflict'
  | 'partial'
  | 'invalid'
  | 'personal_data'
  | 'unauthorized_price';

export type RepairImportReport = {
  service: 'repair-quote-import';
  result: 'ok' | 'error';
  category?: RepairImportCategory;
  status?: RepairRecordResult['status'];
  quoteId?: string;
  sourceKey?: string;
  opportunityKey?: string;
  revision?: number;
  opportunityCount?: number;
  quoteCount?: number;
};

export function prepareRepairQuote(input: unknown): ValidatedRepairQuote {
  return validateRepairQuote(input);
}

export function readRepairQuoteFile(filePath: string): unknown {
  const quotePath = regularFile(filePath);
  try {
    return JSON.parse(readFileSync(quotePath, 'utf8')) as unknown;
  } catch (err) {
    if (err instanceof CalibrationConflictError) throw err;
    throw new CalibrationConflictError('The import file is unreadable');
  }
}

export async function importRepairQuote(
  env: NodeJS.ProcessEnv,
  input: unknown,
  deps: {
    transport?: typeof fetch;
    archive?: RepairArchive;
    clock?: () => string;
  } = {},
): Promise<RepairImportReport> {
  if (!calibrationDiagnosticTarget(env)) return error('wrong_target');
  if (
    env.CALIBRATION_INGEST_ENABLED !== 'false' ||
    env.DB_SYNCHRONIZE !== 'false'
  )
    return error('flags');
  let quote: ValidatedRepairQuote;
  try {
    quote = prepareRepairQuote(input);
  } catch (err) {
    return error(categoryOf(err));
  }
  try {
    const archive =
      deps.archive ?? (await openRepairArchive(env, deps.transport ?? fetch));
    if (!archive) return error('missing');
    const recorded = await recordRepairObservation(archive, quote, deps.clock);
    return {
      service: 'repair-quote-import',
      result: 'ok',
      status: recorded.status,
      quoteId: recorded.quoteId,
      sourceKey: quote.source.source_case_key,
      opportunityKey: quote.source.opportunity_key,
      revision: recorded.revision,
      opportunityCount: recorded.opportunityCount,
      quoteCount: recorded.quoteCount,
    };
  } catch (err) {
    return error(categoryOf(err));
  }
}

export async function importRepairQuoteFile(
  env: NodeJS.ProcessEnv,
  filePath: string,
  deps: {
    transport?: typeof fetch;
    archive?: RepairArchive;
    clock?: () => string;
  } = {},
): Promise<RepairImportReport> {
  if (!calibrationDiagnosticTarget(env)) return error('wrong_target');
  if (
    env.CALIBRATION_INGEST_ENABLED !== 'false' ||
    env.DB_SYNCHRONIZE !== 'false'
  )
    return error('flags');
  try {
    return await importRepairQuote(env, readRepairQuoteFile(filePath), deps);
  } catch (err) {
    return error(categoryOf(err));
  }
}

export function repairContentsGrantIsExpected(
  grant: GithubInstallationGrant,
): boolean {
  if (grant.repositorySelection === 'all') return false;
  if (grant.permissions.contents !== 'write') return false;
  return (
    Object.keys(grant.permissions).every(
      (key) => key === 'contents' || key === 'metadata',
    ) &&
    (grant.permissions.metadata == null ||
      grant.permissions.metadata === 'read')
  );
}

function regularFile(filePath: string): string {
  if (
    typeof filePath !== 'string' ||
    filePath.length === 0 ||
    filePath.includes('\0')
  ) {
    throw new CalibrationConflictError(
      'The import file is missing or unreadable',
    );
  }
  let info: Stats;
  try {
    const listed = lstatSync(filePath);
    if (!listed)
      throw new CalibrationConflictError(
        'The import file is missing or unreadable',
      );
    info = listed;
  } catch (err) {
    if (err instanceof CalibrationConflictError) throw err;
    throw new CalibrationConflictError(
      'The import file is missing or unreadable',
    );
  }
  if (info.isSymbolicLink()) {
    throw new CalibrationConflictError(
      'The import file must stay inside its directory',
    );
  }
  if (!info.isFile() || info.size < 2 || info.size > MAX_QUOTE_BYTES) {
    throw new CalibrationConflictError(
      'The import file is missing or unreadable',
    );
  }
  return filePath;
}

async function openRepairArchive(
  env: NodeJS.ProcessEnv,
  transport: typeof fetch,
): Promise<RepairArchive | null> {
  const guarded = guard(transport);
  const config = readGithubAppConfig(withoutLineSeparators(env));
  if (!config) return null;
  const app = new CalibrationGithubApp(config, guarded);
  await app.authorization();
  const grant = app.installationGrant();
  if (!grant || !repairContentsGrantIsExpected(grant)) {
    throw new CalibrationCredentialError(
      'forbidden',
      'Calibration GitHub App permissions were rejected',
    );
  }
  const names = await installationRepositories(
    guarded,
    await app.authorization(),
  );
  if (!names) {
    throw new CalibrationCredentialError(
      'rejected',
      'Calibration GitHub repository list was rejected',
    );
  }
  if (names.length !== 1 || names[0] !== CALIBRATION_GITHUB_REPOSITORY) {
    throw new CalibrationCredentialError(
      'forbidden',
      'Calibration GitHub App permissions were rejected',
    );
  }
  return new RepairGithubWriter(app, guarded);
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
    throw new CalibrationCredentialError(
      'forbidden',
      'Calibration GitHub App permissions were rejected',
    );
  }
  if (!response.ok) return null;
  const payload = (await response.json()) as {
    total_count?: unknown;
    repositories?: unknown;
  };
  if (
    typeof payload.total_count !== 'number' ||
    !Array.isArray(payload.repositories)
  )
    return null;
  if (payload.total_count !== payload.repositories.length) return [];
  const names: string[] = [];
  for (const repository of payload.repositories) {
    if (
      !repository ||
      typeof repository !== 'object' ||
      Array.isArray(repository)
    )
      return null;
    const fullName = (repository as { full_name?: unknown }).full_name;
    if (typeof fullName !== 'string') return null;
    names.push(fullName);
  }
  return names;
}

function guard(transport: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (!(method === 'POST' && TOKEN_URL.test(url.split('?')[0]))) {
      assertRepairTransport(url, method);
    }
    return transport(input, init);
  };
}

function withoutLineSeparators(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  const value = copy.CALIBRATION_GITHUB_APP_PRIVATE_KEY;
  if (value)
    copy.CALIBRATION_GITHUB_APP_PRIVATE_KEY = value.replace(
      /[\u2028\u2029]/g,
      '',
    );
  return copy;
}

function categoryOf(err: unknown): RepairImportCategory {
  if (err instanceof CalibrationValidationError) {
    if (err.code === 'personal_data') return 'personal_data';
    if (err.code === 'unauthorized_price') return 'unauthorized_price';
    if (err.code === 'incomplete') return 'incomplete';
    return 'invalid';
  }
  if (err instanceof CalibrationConflictError) {
    if (
      err.message === 'Source key already records a different observation' ||
      err.message ===
        'An opportunity revision must name its previous observation' ||
      err.message === 'A revision must extend the latest observation' ||
      err.message === 'The previous observation does not exist' ||
      err.message ===
        'The previous observation belongs to another opportunity' ||
      err.message === 'Existing unindexed quote differs' ||
      err.message === 'Source key references a different quote'
    ) {
      return 'conflict';
    }
    if (err.message === 'The import file is missing or unreadable')
      return 'incomplete';
    return 'rejected';
  }
  if (err instanceof CalibrationCredentialError)
    return err.kind === 'forbidden' ? 'forbidden' : 'rejected';
  if (err instanceof CalibrationWriteError)
    return err.kind === 'forbidden' ? 'forbidden' : 'partial';
  return 'rejected';
}

function error(category: RepairImportCategory): RepairImportReport {
  return { service: 'repair-quote-import', result: 'error', category };
}
