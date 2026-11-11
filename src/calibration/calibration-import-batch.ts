import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { CalibrationValidationError } from './calibration-case';
import {
  calibrationObservationFingerprint,
  type CalibrationPhotoStore,
} from './calibration-engine';
import {
  importCalibrationCase,
  prepareCalibrationImport,
  readCalibrationImportDocument,
  type CalibrationImportInput,
  type ImportCategory,
  type ImportReport,
} from './calibration-import';
import { CalibrationConflictError } from './calibration-github-writer';
import { validateCalibrationImage } from './calibration-image-archive.service';

const MAX_BATCH = 10;
const MAX_QUOTE_BYTES = 64 * 1024;
const SOURCE_KEY = /^[a-zA-Z0-9_.:-]{4,150}$/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /\d{10,}/;
const HALT_CATEGORIES = new Set<ImportCategory>([
  'wrong_target',
  'flags',
  'missing',
  'forbidden',
  'scope',
  'real_index',
  'rejected',
]);
const DISPOSITIONS = [
  'listo_para_importar',
  'duplicado_en_lote',
  'requiere_correccion',
  'registrado',
  'already_exists',
  'pending_private_archive',
  'detenido_por_seguridad',
] as const;

export type BatchDisposition = (typeof DISPOSITIONS)[number];

export type BatchReason =
  | 'unreadable'
  | 'unsafe_path'
  | 'symlink'
  | 'probe_key'
  | 'fixture_key'
  | 'conflicting_key'
  | 'shared_photo'
  | 'invalid'
  | 'incomplete'
  | 'conflict'
  | 'repository'
  | 'probes'
  | 'batch_limit'
  | 'not_a_directory'
  | 'halted'
  | 'real_index'
  | ImportCategory;

export type BatchItem = {
  slot: number;
  sourceKey?: string;
  disposition: BatchDisposition;
  labelEligible: boolean;
  reason?: BatchReason;
  duplicateImages?: number;
  caseId?: string;
  photoRefs?: string[];
  contentMatch?: boolean;
  manifestMatch?: boolean;
  photoArchiveStatus?: ImportReport['photoArchiveStatus'];
  protectedCaseUnchanged?: boolean;
  storageFailure?: ImportReport['storageFailure'];
};

export type BatchReport = {
  service: 'calibration-import-batch';
  mode: 'prepare' | 'apply';
  result: 'ok' | 'error';
  category?: 'rejected' | 'incomplete' | 'invalid' | 'halted';
  reason?: BatchReason;
  items: BatchItem[];
  counts: Partial<Record<BatchDisposition, number>>;
};

export type CalibrationBatchOptions = {
  apply?: boolean;
  transport?: typeof fetch;
  photos?: CalibrationPhotoStore;
  clock?: () => string;
  maxTransientAttempts?: number;
};

type ContainerFailure = {
  category: 'rejected' | 'incomplete' | 'invalid';
  reason?: BatchReason;
};

type LocalItem = {
  slot: number;
  sourceKey?: string;
  disposition:
    | 'listo_para_importar'
    | 'duplicado_en_lote'
    | 'requiere_correccion';
  reason?: BatchReason;
  duplicateImages?: number;
  input?: CalibrationImportInput;
  imageShas?: string[];
  seal?: string;
};

/** Prepara un directorio de expedientes. Solo `--apply` reutiliza el importador. */
export async function importCalibrationBatch(
  env: NodeJS.ProcessEnv,
  directory: string | undefined,
  options: CalibrationBatchOptions = {},
): Promise<BatchReport> {
  const mode = options.apply ? 'apply' : 'prepare';
  const opened = openContainer(directory);
  if ('failure' in opened) return containerReport(mode, opened.failure);
  const loaded = loadExpedientes(opened.path);
  if ('failure' in loaded) return containerReport(mode, loaded.failure);
  const classified = classifyExpedientes(loaded.items);
  if (!options.apply) return summarize(mode, classified.map(localItem));
  return summarize(mode, await applyExpedientes(env, classified, options));
}

export function parseCalibrationBatchArgs(argv: readonly string[]): {
  apply: boolean;
  directory?: string;
  failure?: ContainerFailure;
} {
  let apply = false;
  const paths: string[] = [];
  for (const arg of argv) {
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg.startsWith('--'))
      return { apply: false, failure: { category: 'invalid' } };
    paths.push(arg);
  }
  if (paths.length !== 1) return { apply, failure: { category: 'incomplete' } };
  return { apply, directory: paths[0] };
}

function openContainer(
  directory: string | undefined,
): { path: string } | { failure: ContainerFailure } {
  if (
    typeof directory !== 'string' ||
    directory.length === 0 ||
    directory.includes('\0')
  ) {
    return { failure: { category: 'incomplete' } };
  }
  let info: Stats;
  try {
    info = lstatSync(directory);
  } catch {
    return { failure: { category: 'invalid' } };
  }
  if (info.isSymbolicLink())
    return { failure: { category: 'rejected', reason: 'symlink' } };
  if (!info.isDirectory())
    return { failure: { category: 'rejected', reason: 'not_a_directory' } };
  let real: string;
  try {
    real = realpathSync(directory);
  } catch {
    return { failure: { category: 'invalid' } };
  }
  const placed = placement(real);
  if (placed) return { failure: { category: 'rejected', reason: placed } };
  return { path: real };
}

function placement(real: string): 'repository' | 'probes' | null {
  const root = realpathSync(join(__dirname, '..', '..'));
  const rel = relative(root, real);
  const inside =
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
  if (inside) return 'repository';
  const segments = real.split(sep);
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index] === 'data' && segments[index + 1] === 'probes')
      return 'probes';
  }
  return null;
}

function loadExpedientes(
  directory: string,
): { items: LocalItem[] } | { failure: ContainerFailure } {
  let names: string[];
  try {
    names = readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          acceptedName(entry.name) &&
          (entry.isDirectory() || entry.isSymbolicLink()),
      )
      .map((entry) => entry.name)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  } catch {
    return { failure: { category: 'invalid' } };
  }
  if (names.length > MAX_BATCH)
    return { failure: { category: 'rejected', reason: 'batch_limit' } };
  return {
    items: names.map((name, index) =>
      loadExpediente(directory, name, index + 1),
    ),
  };
}

function loadExpediente(
  directory: string,
  name: string,
  slot: number,
): LocalItem {
  const child = join(directory, name);
  const rel = relative(directory, child);
  if (rel.startsWith('..') || rel === '..' || isAbsolute(rel)) {
    return { slot, disposition: 'requiere_correccion', reason: 'unsafe_path' };
  }
  let info: Stats;
  try {
    info = lstatSync(child);
  } catch {
    return { slot, disposition: 'requiere_correccion', reason: 'unreadable' };
  }
  if (info.isSymbolicLink())
    return { slot, disposition: 'requiere_correccion', reason: 'symlink' };
  if (!info.isDirectory())
    return { slot, disposition: 'requiere_correccion', reason: 'unreadable' };
  const quotePath = join(child, 'caso.json');
  let quoteInfo: Stats;
  try {
    quoteInfo = lstatSync(quotePath);
  } catch {
    return { slot, disposition: 'requiere_correccion', reason: 'unreadable' };
  }
  if (quoteInfo.isSymbolicLink())
    return { slot, disposition: 'requiere_correccion', reason: 'symlink' };
  let input: CalibrationImportInput;
  try {
    input = readCalibrationImportDocument(quotePath);
  } catch (err) {
    const sourceKey = peekedKey(quotePath);
    return {
      slot,
      ...(sourceKey ? { sourceKey } : {}),
      disposition: 'requiere_correccion',
      reason: failureReason(err),
    };
  }
  const sourceKey = reportableKey(input.source_case_key);
  try {
    const prepared = prepareCalibrationImport(input);
    const fixture = fixtureOf(prepared.quote.source.source_case_key);
    const imageShas = prepared.images.map(
      (bytes) => validateCalibrationImage(bytes).sha256,
    );
    return {
      slot,
      sourceKey: prepared.quote.source.source_case_key,
      disposition: fixture ? 'requiere_correccion' : 'listo_para_importar',
      ...(fixture ? { reason: fixture } : {}),
      duplicateImages: prepared.duplicateImages,
      ...(fixture ? {} : { input }),
      imageShas,
      seal: `${calibrationObservationFingerprint(prepared.quote)}:${imageShas.join(',')}`,
    };
  } catch (err) {
    const reason = failureReason(err);
    return {
      slot,
      ...(sourceKey ? { sourceKey } : {}),
      disposition: 'requiere_correccion',
      reason,
      ...(reason === 'probe_key' ? { imageShas: checksums(input.images) } : {}),
    };
  }
}

function classifyExpedientes(items: LocalItem[]): LocalItem[] {
  const groups = new Map<string, LocalItem[]>();
  for (const item of items) {
    if (
      item.disposition !== 'listo_para_importar' ||
      !item.sourceKey ||
      !item.seal
    )
      continue;
    const group = groups.get(item.sourceKey) ?? [];
    group.push(item);
    groups.set(item.sourceKey, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const same = group.every((item) => item.seal === group[0]?.seal);
    for (const [index, item] of group.entries()) {
      if (same && index === 0) continue;
      item.input = undefined;
      item.disposition = same ? 'duplicado_en_lote' : 'requiere_correccion';
      if (!same) item.reason = 'conflicting_key';
    }
  }
  const owners = new Map<string, Set<string>>();
  for (const item of items) {
    if (!item.sourceKey || !item.imageShas) continue;
    for (const sha of item.imageShas) {
      const keys = owners.get(sha) ?? new Set<string>();
      keys.add(item.sourceKey);
      owners.set(sha, keys);
    }
  }
  const shared = new Set<string>();
  for (const [sha, keys] of owners) {
    if (keys.size > 1) shared.add(sha);
  }
  for (const item of items) {
    if (
      item.disposition !== 'listo_para_importar' &&
      item.disposition !== 'duplicado_en_lote'
    )
      continue;
    if (!item.imageShas?.some((sha) => shared.has(sha))) continue;
    item.input = undefined;
    item.disposition = 'requiere_correccion';
    item.reason = 'shared_photo';
  }
  return items;
}

async function applyExpedientes(
  env: NodeJS.ProcessEnv,
  items: LocalItem[],
  options: CalibrationBatchOptions,
): Promise<BatchItem[]> {
  const applied: BatchItem[] = [];
  let stopped = false;
  for (const item of items) {
    if (item.disposition !== 'listo_para_importar' || !item.input) {
      applied.push(
        stopped && item.disposition === 'listo_para_importar'
          ? stoppedItem(item)
          : localItem(item),
      );
      continue;
    }
    if (stopped) {
      applied.push(stoppedItem(item));
      continue;
    }
    const remote = await importCalibrationCase(env, item.input, {
      transport: options.transport,
      photos: options.photos,
      clock: options.clock,
      maxTransientAttempts: options.maxTransientAttempts,
    });
    const judged = judgeRemote(item.sourceKey, remote);
    applied.push(remoteItem(item, remote, judged));
    if (judged.disposition === 'detenido_por_seguridad') stopped = true;
  }
  return applied;
}

function judgeRemote(
  sourceKey: string | undefined,
  report: ImportReport,
): {
  disposition: BatchDisposition;
  labelEligible: boolean;
  reason?: BatchReason;
} {
  if (sourceKey && report.sourceKey && report.sourceKey !== sourceKey) {
    return {
      disposition: 'detenido_por_seguridad',
      labelEligible: false,
      reason: 'real_index',
    };
  }
  if (
    report.protectedCaseUnchanged === false ||
    report.category === 'real_index'
  ) {
    return {
      disposition: 'detenido_por_seguridad',
      labelEligible: false,
      reason: 'real_index',
    };
  }
  if (report.category && HALT_CATEGORIES.has(report.category)) {
    return {
      disposition: 'detenido_por_seguridad',
      labelEligible: false,
      reason: report.category,
    };
  }
  const verified =
    report.result === 'ok' &&
    report.photoArchiveStatus === 'archived_private' &&
    report.contentMatch === true &&
    report.manifestMatch === true;
  if (
    verified &&
    (report.status === 'created' || report.status === 'reconciled')
  ) {
    return { disposition: 'registrado', labelEligible: true };
  }
  if (verified && report.status === 'already_exists') {
    return { disposition: 'already_exists', labelEligible: true };
  }
  if (
    report.caseId &&
    (report.photoArchiveStatus === 'pending_private_archive' ||
      report.status === 'partial' ||
      report.category === 'partial')
  ) {
    return { disposition: 'pending_private_archive', labelEligible: false };
  }
  if (report.category === 'conflict') {
    return {
      disposition: 'requiere_correccion',
      labelEligible: false,
      reason: 'conflict',
    };
  }
  if (report.category === 'incomplete') {
    return {
      disposition: 'requiere_correccion',
      labelEligible: false,
      reason: 'incomplete',
    };
  }
  if (report.category === 'invalid') {
    return {
      disposition: 'requiere_correccion',
      labelEligible: false,
      reason: 'invalid',
    };
  }
  if (report.category === 'partial') {
    return {
      disposition: 'detenido_por_seguridad',
      labelEligible: false,
      reason: 'halted',
    };
  }
  return {
    disposition: 'detenido_por_seguridad',
    labelEligible: false,
    reason: 'halted',
  };
}

function localItem(item: LocalItem): BatchItem {
  return {
    slot: item.slot,
    ...(item.sourceKey ? { sourceKey: item.sourceKey } : {}),
    disposition: item.disposition,
    labelEligible: false,
    ...(item.reason ? { reason: item.reason } : {}),
    ...(item.duplicateImages != null
      ? { duplicateImages: item.duplicateImages }
      : {}),
  };
}

function stoppedItem(item: LocalItem): BatchItem {
  return {
    slot: item.slot,
    ...(item.sourceKey ? { sourceKey: item.sourceKey } : {}),
    disposition: 'detenido_por_seguridad',
    labelEligible: false,
    reason: 'halted',
    ...(item.duplicateImages != null
      ? { duplicateImages: item.duplicateImages }
      : {}),
  };
}

function remoteItem(
  item: LocalItem,
  report: ImportReport,
  judged: {
    disposition: BatchDisposition;
    labelEligible: boolean;
    reason?: BatchReason;
  },
): BatchItem {
  return {
    slot: item.slot,
    ...(item.sourceKey ? { sourceKey: item.sourceKey } : {}),
    disposition: judged.disposition,
    labelEligible: judged.labelEligible,
    ...(judged.reason ? { reason: judged.reason } : {}),
    ...(item.duplicateImages != null
      ? { duplicateImages: item.duplicateImages }
      : {}),
    ...(report.caseId ? { caseId: report.caseId } : {}),
    ...(report.photoRefs ? { photoRefs: report.photoRefs } : {}),
    ...(typeof report.contentMatch === 'boolean'
      ? { contentMatch: report.contentMatch }
      : {}),
    ...(typeof report.manifestMatch === 'boolean'
      ? { manifestMatch: report.manifestMatch }
      : {}),
    ...(report.photoArchiveStatus
      ? { photoArchiveStatus: report.photoArchiveStatus }
      : {}),
    ...(typeof report.protectedCaseUnchanged === 'boolean'
      ? { protectedCaseUnchanged: report.protectedCaseUnchanged }
      : {}),
    ...(report.storageFailure ? { storageFailure: report.storageFailure } : {}),
  };
}

function summarize(mode: BatchReport['mode'], items: BatchItem[]): BatchReport {
  const counts: BatchReport['counts'] = {};
  for (const disposition of DISPOSITIONS) {
    const count = items.filter(
      (item) => item.disposition === disposition,
    ).length;
    if (count > 0) counts[disposition] = count;
  }
  const halted = items.some(
    (item) => item.disposition === 'detenido_por_seguridad',
  );
  const ready =
    mode === 'prepare'
      ? items.every(
          (item) =>
            item.disposition === 'listo_para_importar' ||
            item.disposition === 'duplicado_en_lote',
        )
      : items.every(
          (item) =>
            item.disposition === 'registrado' ||
            item.disposition === 'already_exists' ||
            item.disposition === 'duplicado_en_lote',
        );
  return {
    service: 'calibration-import-batch',
    mode,
    result: ready && !halted ? 'ok' : 'error',
    ...(halted ? { category: 'halted' } : {}),
    items,
    counts,
  };
}

function containerReport(
  mode: BatchReport['mode'],
  failure: ContainerFailure,
): BatchReport {
  return {
    service: 'calibration-import-batch',
    mode,
    result: 'error',
    category: failure.category,
    ...(failure.reason ? { reason: failure.reason } : {}),
    items: [],
    counts: {},
  };
}

function checksums(images: Buffer[] | undefined): string[] | undefined {
  if (!images?.length) return undefined;
  const seen = new Set<string>();
  const shas: string[] = [];
  for (const bytes of images) {
    try {
      const sha = validateCalibrationImage(bytes).sha256;
      if (seen.has(sha)) continue;
      seen.add(sha);
      shas.push(sha);
    } catch {
      return undefined;
    }
  }
  return shas;
}

function acceptedName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.startsWith('.') &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  );
}

function fixtureOf(key: string): 'probe_key' | 'fixture_key' | null {
  if (key.startsWith('probe-')) return 'probe_key';
  if (
    key.startsWith('autofix-sim-') ||
    key.startsWith('case-test-') ||
    key.startsWith('seed-case-')
  ) {
    return 'fixture_key';
  }
  return null;
}

function peekedKey(filePath: string): string | undefined {
  try {
    const info = lstatSync(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_QUOTE_BYTES)
      return undefined;
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as {
      source_case_key?: unknown;
    };
    return reportableKey(parsed.source_case_key);
  } catch {
    return undefined;
  }
}

function reportableKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || !SOURCE_KEY.test(value)) return undefined;
  if (
    EMAIL.test(value) ||
    PHONE.test(value) ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    return undefined;
  }
  const vin = value
    .split(/[^A-Za-z0-9]/)
    .some(
      (part) =>
        /^[A-HJ-NPR-Z0-9]{17}$/i.test(part) &&
        /\d/.test(part) &&
        /[A-Z]/i.test(part),
    );
  return vin ? undefined : value;
}

function failureReason(err: unknown): BatchReason {
  const message = err instanceof Error ? err.message : '';
  if (message.includes('calibration probe')) return 'probe_key';
  if (message.includes('stay inside')) return 'unsafe_path';
  if (message.includes('human verified') || message.includes('one to four'))
    return 'incomplete';
  if (message.includes('missing') || message.includes('unreadable'))
    return 'unreadable';
  if (
    message.includes('Unsupported calibration image') ||
    message.includes('Invalid calibration image')
  )
    return 'invalid';
  if (err instanceof CalibrationValidationError) {
    if (err.code === 'personal_data' || err.code === 'invalid')
      return 'invalid';
    return 'incomplete';
  }
  if (err instanceof CalibrationConflictError) return 'invalid';
  return 'unreadable';
}
