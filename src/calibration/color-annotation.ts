import { createHash } from 'node:crypto';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { calibrationQueryAccess } from './calibration-access';

/**
 * Anotación color-v1 del vehículo. No reescribe el expediente ni el precio.
 * Una declaración humana no queda validada. Una propuesta visual no la sustituye.
 * La corrección solo sale de la sesión autenticada del propietario.
 */

export const COLOR_SCHEMA_VERSION = '1.0.0';
export const COLOR_CONTRACT_VERSION = 'color-v1';
export type ColorStatus = 'proposed' | 'validated' | 'unknown';
export type ColorProvenance = 'human_declaration' | 'visual_inference' | 'unknown' | 'authenticated_owner';
export type ColorDatumProvenance = 'human_declaration' | 'visual_inference' | 'unknown';

const SUBJECT_ID = /^(?:AF|RQ|CQ)-\d{6}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COLOR_TEXT = /^[\p{L}\p{N}][\p{L}\p{N} .'-]{0,39}$/u;
const FINISH_TEXT = /^(?:mate|brillante|perlado|metálico|metalico|metalizado|sólido|solido|tricapa|bicapa)$/iu;
const PAINT_CODE = /^[A-Za-z0-9]{2,12}$/;
const MAX_ITEMS = 30;
const CATALOG_PATH = 'data/annotations/color/index.json';
const WRITE_PATH = /^data\/annotations\/color\/(?:index\.json|(?:visual\/AF-\d{6}|repairs\/RQ-\d{6}|commercial\/CQ-\d{6})\/(?:index\.json|CL-\d{6}\.json))$/;
const READ_PATH = /^data\/(?:cases\/AF-\d{6}|repairs\/quotes\/RQ-\d{6}|commercial\/quotes\/CQ-\d{6})\.json$/;
const COMMERCIAL_WRITE = /^data\/annotations\/color\/(?:index\.json|commercial\/CQ-\d{6}\/(?:index\.json|CL-\d{6}\.json))$/;
const WRITE_BLOCKED = [
  'data/cases/', 'data/repairs/quotes/', 'data/commercial/quotes/', 'data/commercial/index.json',
  'data/repairs/index.json', 'data/photos/', 'data/evidence/', 'data/probes', 'data/index.json',
];
const IMPORT_FIELDS = new Set([
  'exteriorColor', 'exteriorProvenance', 'requestedColor', 'requestedProvenance',
  'originalColor', 'originalProvenance',
  'finish', 'finishProvenance', 'paintCode', 'paintCodeProvenance',
]);
const CONFIRM_FIELDS = new Set(['subjectId', 'exteriorColor', 'requestedColor', 'finish', 'paintCode', 'colorReviewed']);
const CLIENT_AUTHORITY = [
  'validated', 'operatorRole', 'operator_role', 'humanValidated', 'human_validated',
  'confirmation', 'email', 'name', 'role', 'price', 'price_mxn', 'priceMxn',
  'quoted_total_mxn', 'authorization', 'actorKey', 'actor_key', 'authenticated_owner',
];

export class ColorError extends Error {
  constructor(readonly code: 'invalid' | 'missing' | 'conflict' | 'rejected' | 'limit' | 'forbidden' | 'unauthorized' | 'hidden') {
    super(code);
    this.name = 'ColorError';
  }
}

export type ColorFiles = {
  read(path: string): Promise<{ content: string; sha: string } | null>;
  write(path: string, content: string, sha?: string): Promise<string>;
};

export type ColorReading = {
  exteriorColor: string | null;
  exteriorProvenance: ColorDatumProvenance;
  requestedColor: string | null;
  requestedProvenance: ColorDatumProvenance | null;
  originalColor: string | null;
  originalProvenance: 'human_declaration' | null;
  finish: string | null;
  finishProvenance: 'human_declaration' | null;
  paintCode: string | null;
  paintCodeProvenance: 'human_declaration' | null;
};

export type ColorNote = {
  annotationId: string;
  contractVersion: typeof COLOR_CONTRACT_VERSION;
  status: ColorStatus;
  exteriorColor: string | null;
  exteriorProvenance: ColorProvenance;
  requestedColor: string | null;
  requestedProvenance: ColorProvenance | null;
  originalColor: string | null;
  originalProvenance: ColorProvenance | null;
  finish: string | null;
  finishProvenance: ColorProvenance | null;
  paintCode: string | null;
  paintCodeProvenance: ColorProvenance | null;
  history: Array<Omit<ColorNote, 'history'>>;
};

type SubjectKind = 'visual_case' | 'repair_quote' | 'commercial_quote';

type StoredItem = {
  annotation_id: string;
  contract_version: typeof COLOR_CONTRACT_VERSION;
  exterior_color: string | null;
  exterior_provenance: ColorProvenance;
  requested_color: string | null;
  requested_provenance: ColorProvenance | null;
  original_color: string | null;
  original_provenance: ColorProvenance | null;
  finish: string | null;
  finish_provenance: ColorProvenance | null;
  paint_code: string | null;
  paint_code_provenance: ColorProvenance | null;
  status: ColorStatus;
  authorization: 'authenticated_owner' | null;
  actor_key: string | null;
  current: boolean;
  supersedes: string | null;
};

export function colorSubjectPath(subjectId: string): string {
  if (subjectId.startsWith('AF-')) return `data/annotations/color/visual/${subjectId}/index.json`;
  if (subjectId.startsWith('RQ-')) return `data/annotations/color/repairs/${subjectId}/index.json`;
  if (subjectId.startsWith('CQ-')) return `data/annotations/color/commercial/${subjectId}/index.json`;
  throw new ColorError('invalid');
}

export function assertColorRead(path: string): void {
  const bare = path.split('?')[0];
  if (bare.includes('data/probes') || bare.includes('data/photos/') || bare.includes('data/evidence/') || bare.includes('data/index.json')) {
    throw new ColorError('rejected');
  }
  if (!WRITE_PATH.test(bare) && !READ_PATH.test(bare)) throw new ColorError('rejected');
}

export function assertColorWrite(path: string): void {
  const bare = path.split('?')[0];
  if (WRITE_BLOCKED.some((needle) => bare.includes(needle)) || !WRITE_PATH.test(bare)) throw new ColorError('rejected');
}

export function colorAnnotationPathAllowed(path: string): boolean {
  try {
    assertColorWrite(path);
    return true;
  } catch {
    return false;
  }
}

export function colorCommercialPathAllowed(path: string): boolean {
  const bare = path.split('?')[0];
  return COMMERCIAL_WRITE.test(bare);
}

export async function importColorReading(
  files: ColorFiles,
  subjectId: string,
  reading: ColorReading,
): Promise<{ status: 'recorded' | 'already_recorded' | 'retained' | 'conflict'; annotationId: string }> {
  rejectClientFields(reading, IMPORT_FIELDS);
  assertReading(reading);
  const stored = await storeColor(files, subjectId, {
    exteriorColor: reading.exteriorColor,
    exteriorProvenance: reading.exteriorProvenance,
    requestedColor: reading.requestedColor,
    requestedProvenance: reading.requestedProvenance,
    originalColor: reading.originalColor ?? null,
    originalProvenance: reading.originalProvenance ?? null,
    finish: reading.finish,
    finishProvenance: reading.finishProvenance,
    paintCode: reading.paintCode,
    paintCodeProvenance: reading.paintCodeProvenance,
    status: readingStatus(reading),
    authorization: null,
    actorKey: null,
  }, { conflictOnDifference: true });
  return stored;
}

export async function confirmVehicleColor(
  files: ColorFiles,
  env: NodeJS.ProcessEnv,
  user: AuthenticatedUser | undefined,
  request: {
    subjectId: string;
    exteriorColor: string;
    requestedColor?: string | null;
    finish?: string | null;
    paintCode?: string | null;
    colorReviewed: true;
  },
): Promise<{ status: 'validated' | 'already_validated'; annotationId: string }> {
  const access = calibrationQueryAccess(env, user);
  if (access === 'hidden') throw new ColorError('hidden');
  if (!user) throw new ColorError('unauthorized');
  if (access !== 'open') throw new ColorError('forbidden');
  rejectClientFields(request, CONFIRM_FIELDS);
  if (request.colorReviewed !== true) throw new ColorError('rejected');
  if (!SUBJECT_ID.test(request.subjectId) || !isColor(request.exteriorColor)) throw new ColorError('invalid');
  const requested = request.requestedColor ?? null;
  const finish = request.finish ?? null;
  const paintCode = request.paintCode ?? null;
  if (requested != null && !isColor(requested)) throw new ColorError('invalid');
  if (finish != null && !FINISH_TEXT.test(finish)) throw new ColorError('rejected');
  if (paintCode != null && !PAINT_CODE.test(paintCode)) throw new ColorError('rejected');
  const stored = await storeColor(files, request.subjectId, {
    exteriorColor: request.exteriorColor.trim(),
    exteriorProvenance: 'authenticated_owner',
    requestedColor: requested?.trim() ?? null,
    requestedProvenance: requested ? 'authenticated_owner' : null,
    originalColor: null,
    originalProvenance: null,
    finish,
    finishProvenance: finish ? 'authenticated_owner' : null,
    paintCode,
    paintCodeProvenance: paintCode ? 'authenticated_owner' : null,
    status: 'validated',
    authorization: 'authenticated_owner',
    actorKey: actorKey(user.userId),
  });
  if (stored.status === 'retained' || stored.status === 'conflict') throw new ColorError('conflict');
  return stored.status === 'already_recorded'
    ? { status: 'already_validated', annotationId: stored.annotationId }
    : { status: 'validated', annotationId: stored.annotationId };
}

export function presentColorIndex(content: string, subjectId: string): ColorNote[] {
  const items = parseItems(content, subjectId);
  const current = items.find((item) => item.current && publicItem(item));
  if (!current) return [];
  const history = items
    .filter((item) => !item.current && publicItem(item))
    .map(publicNote);
  return [{ ...publicNote(current), history }];
}

export function presentColorCatalog(content: string): Array<Omit<ColorNote, 'history'> & {
  subjectId: string;
  subjectKind: SubjectKind;
}> {
  try {
    const parsed = JSON.parse(content) as { records?: unknown };
    if (!Array.isArray(parsed.records)) return [];
    return parsed.records.flatMap((item) => {
      const record = item as StoredItem & { subject_id?: unknown; subject_kind?: unknown };
      const note = publicItem(record);
      if (!note || note.current !== true || typeof record.subject_id !== 'string') return [];
      if (record.subject_kind !== 'visual_case' && record.subject_kind !== 'repair_quote' && record.subject_kind !== 'commercial_quote') {
        return [];
      }
      return [{
        subjectId: record.subject_id,
        subjectKind: record.subject_kind,
        ...publicNote(note),
      }];
    });
  } catch {
    return [];
  }
}

async function storeColor(
  files: ColorFiles,
  subjectId: string,
  next: {
    exteriorColor: string | null;
    exteriorProvenance: ColorProvenance;
    requestedColor: string | null;
    requestedProvenance: ColorProvenance | null;
    originalColor: string | null;
    originalProvenance: ColorProvenance | null;
    finish: string | null;
    finishProvenance: ColorProvenance | null;
    paintCode: string | null;
    paintCodeProvenance: ColorProvenance | null;
    status: ColorStatus;
    authorization: 'authenticated_owner' | null;
    actorKey: string | null;
  },
  options: { conflictOnDifference?: boolean } = {},
): Promise<{ status: 'recorded' | 'already_recorded' | 'retained' | 'conflict'; annotationId: string }> {
  if (!SUBJECT_ID.test(subjectId)) throw new ColorError('invalid');
  if (next.status === 'validated' && (next.authorization !== 'authenticated_owner' || !next.actorKey || !SHA256.test(next.actorKey))) {
    throw new ColorError('rejected');
  }
  if (next.status !== 'validated' && (next.authorization != null || next.actorKey != null || next.exteriorProvenance === 'authenticated_owner')) {
    throw new ColorError('rejected');
  }
  const kind = await readSubjectKind(files, subjectId);
  if (!kind) throw new ColorError('missing');
  const indexPath = colorSubjectPath(subjectId);
  const indexFile = await files.read(indexPath);
  const items = indexFile ? requireItems(indexFile.content, subjectId) : [];
  const current = items.find((item) => item.current) ?? null;
  if (sameColor(current, next)) return { status: 'already_recorded', annotationId: current?.annotation_id ?? '' };
  if (current?.status === 'validated' && next.status !== 'validated') {
    return { status: 'retained', annotationId: current.annotation_id };
  }
  if (current && holdsHuman(current) && next.exteriorProvenance === 'visual_inference') {
    return { status: 'retained', annotationId: current.annotation_id };
  }
  if (current && current.status !== 'unknown' && next.status === 'unknown') {
    return { status: 'retained', annotationId: current.annotation_id };
  }
  if (options.conflictOnDifference && current && holdsHuman(current) && nextHoldsHuman(next)) {
    return { status: 'conflict', annotationId: current.annotation_id };
  }
  if (options.conflictOnDifference && current?.exterior_provenance === 'visual_inference' && next.exteriorProvenance === 'visual_inference') {
    return { status: 'conflict', annotationId: current.annotation_id };
  }
  if (items.length >= MAX_ITEMS) throw new ColorError('limit');
  const annotationId = nextId(items.map((item) => item.annotation_id));
  const document = {
    schema_version: COLOR_SCHEMA_VERSION,
    contract_version: COLOR_CONTRACT_VERSION,
    annotation_id: annotationId,
    subject_kind: kind,
    subject_id: subjectId,
    exterior_color: next.exteriorColor,
    exterior_provenance: next.exteriorProvenance,
    requested_color: next.requestedColor,
    requested_provenance: next.requestedProvenance,
    original_color: next.originalColor,
    original_provenance: next.originalProvenance,
    finish: next.finish,
    finish_provenance: next.finishProvenance,
    paint_code: next.paintCode,
    paint_code_provenance: next.paintCodeProvenance,
    status: next.status,
    authorization: next.authorization,
    actor_key: next.actorKey,
    supersedes: current?.annotation_id ?? null,
  };
  await files.write(annotationPath(subjectId, annotationId), canonical(document));
  if (current) current.current = false;
  items.push({
    annotation_id: annotationId,
    contract_version: COLOR_CONTRACT_VERSION,
    exterior_color: next.exteriorColor,
    exterior_provenance: next.exteriorProvenance,
    requested_color: next.requestedColor,
    requested_provenance: next.requestedProvenance,
    original_color: next.originalColor,
    original_provenance: next.originalProvenance,
    finish: next.finish,
    finish_provenance: next.finishProvenance,
    paint_code: next.paintCode,
    paint_code_provenance: next.paintCodeProvenance,
    status: next.status,
    authorization: next.authorization,
    actor_key: next.actorKey,
    current: true,
    supersedes: current?.annotation_id ?? null,
  });
  await files.write(indexPath, canonical({
    schema_version: COLOR_SCHEMA_VERSION,
    contract_version: COLOR_CONTRACT_VERSION,
    subject_kind: kind,
    subject_id: subjectId,
    items,
  }), indexFile?.sha);
  await publishCatalog(files, subjectId, kind, items);
  return { status: 'recorded', annotationId };
}

async function readSubjectKind(files: ColorFiles, subjectId: string): Promise<SubjectKind | null> {
  const path = subjectId.startsWith('AF-')
    ? `data/cases/${subjectId}.json`
    : subjectId.startsWith('RQ-')
      ? `data/repairs/quotes/${subjectId}.json`
      : `data/commercial/quotes/${subjectId}.json`;
  const file = await files.read(path);
  if (!file) return null;
  try {
    const parsed = JSON.parse(file.content) as { case_id?: unknown; quote_id?: unknown };
    if (subjectId.startsWith('AF-')) return parsed.case_id === subjectId ? 'visual_case' : null;
    if (subjectId.startsWith('RQ-')) return parsed.quote_id === subjectId ? 'repair_quote' : null;
    return parsed.quote_id === subjectId ? 'commercial_quote' : null;
  } catch {
    return null;
  }
}

async function publishCatalog(files: ColorFiles, subjectId: string, kind: SubjectKind, items: StoredItem[]): Promise<void> {
  const currentFile = await files.read(CATALOG_PATH);
  const records = currentFile ? parseCatalog(currentFile.content) : [];
  const kept = records.filter((item) => item.subject_id !== subjectId);
  for (const item of items.filter((entry) => entry.current)) {
    kept.push({ ...item, subject_id: subjectId, subject_kind: kind });
  }
  const next = canonical({
    schema_version: COLOR_SCHEMA_VERSION,
    contract_version: COLOR_CONTRACT_VERSION,
    records: kept,
  });
  if (currentFile?.content === next) return;
  await files.write(CATALOG_PATH, next, currentFile?.sha);
}

function parseCatalog(content: string): Array<StoredItem & { subject_id: string; subject_kind: SubjectKind }> {
  const parsed = JSON.parse(content) as { records?: unknown };
  if (!Array.isArray(parsed.records)) throw new ColorError('conflict');
  return parsed.records.flatMap((item) => {
    const record = item as StoredItem & { subject_id?: unknown; subject_kind?: unknown };
    if (typeof record.subject_id !== 'string') return [];
    if (record.subject_kind !== 'visual_case' && record.subject_kind !== 'repair_quote' && record.subject_kind !== 'commercial_quote') {
      return [];
    }
    return [{ ...record, subject_id: record.subject_id, subject_kind: record.subject_kind }];
  });
}

function requireItems(content: string, subjectId: string): StoredItem[] {
  const parsed = JSON.parse(content) as { subject_id?: unknown; items?: unknown };
  if (parsed.subject_id !== subjectId || !Array.isArray(parsed.items)) throw new ColorError('conflict');
  return parsed.items.flatMap((item) => {
    const note = item as StoredItem;
    return note && typeof note.annotation_id === 'string' ? [note] : [];
  });
}

function parseItems(content: string, subjectId: string): StoredItem[] {
  try {
    return requireItems(content, subjectId);
  } catch {
    return [];
  }
}

function publicItem(item: StoredItem | null): StoredItem | null {
  if (!item || !/^CL-\d{6}$/.test(item.annotation_id) || item.contract_version !== COLOR_CONTRACT_VERSION) return null;
  if (item.status === 'validated') {
    if (item.authorization !== 'authenticated_owner' || !item.actor_key || !SHA256.test(item.actor_key)) return null;
    if (item.exterior_provenance !== 'authenticated_owner' || !item.exterior_color) return null;
  } else if (item.authorization != null || item.actor_key != null || item.exterior_provenance === 'authenticated_owner') {
    return null;
  }
  if (item.status === 'unknown' && (item.exterior_color != null || item.requested_color != null || item.original_color != null)) return null;
  if (item.status === 'proposed' && item.exterior_provenance === 'visual_inference' && !item.exterior_color) return null;
  if (item.status === 'validated' && item.exterior_provenance === 'visual_inference') return null;
  if (item.requested_color == null && item.requested_provenance != null) return null;
  if (item.requested_color != null && item.requested_provenance == null) return null;
  if ((item.original_color == null) !== (item.original_provenance == null)) return null;
  if (item.finish == null && item.finish_provenance != null) return null;
  if (item.paint_code == null && item.paint_code_provenance != null) return null;
  const serialized = JSON.stringify(item).toLowerCase();
  if (serialized.includes('@') || serialized.includes('operator_role') || serialized.includes('price')) return null;
  return item;
}

function publicNote(item: StoredItem): Omit<ColorNote, 'history'> {
  return {
    annotationId: item.annotation_id,
    contractVersion: item.contract_version,
    status: item.status,
    exteriorColor: item.exterior_color,
    exteriorProvenance: item.exterior_provenance,
    requestedColor: item.requested_color,
    requestedProvenance: item.requested_provenance,
    originalColor: item.original_color ?? null,
    originalProvenance: item.original_provenance ?? null,
    finish: item.finish,
    finishProvenance: item.finish_provenance,
    paintCode: item.paint_code,
    paintCodeProvenance: item.paint_code_provenance,
  };
}

function sameColor(current: StoredItem | null, next: {
  exteriorColor: string | null;
  exteriorProvenance: ColorProvenance;
  requestedColor: string | null;
  requestedProvenance: ColorProvenance | null;
  originalColor: string | null;
  originalProvenance: ColorProvenance | null;
  finish: string | null;
  finishProvenance: ColorProvenance | null;
  paintCode: string | null;
  paintCodeProvenance: ColorProvenance | null;
  status: ColorStatus;
}): boolean {
  if (!current) return false;
  return current.exterior_color === next.exteriorColor
    && current.exterior_provenance === next.exteriorProvenance
    && current.requested_color === next.requestedColor
    && current.requested_provenance === next.requestedProvenance
    && (current.original_color ?? null) === next.originalColor
    && (current.original_provenance ?? null) === next.originalProvenance
    && current.finish === next.finish
    && current.finish_provenance === next.finishProvenance
    && current.paint_code === next.paintCode
    && current.paint_code_provenance === next.paintCodeProvenance
    && current.status === next.status;
}

function holdsHuman(item: StoredItem): boolean {
  return item.exterior_provenance === 'human_declaration'
    || item.requested_provenance === 'human_declaration'
    || item.original_provenance === 'human_declaration';
}

function nextHoldsHuman(next: { exteriorProvenance: ColorProvenance; requestedProvenance: ColorProvenance | null; originalProvenance: ColorProvenance | null }): boolean {
  return next.exteriorProvenance === 'human_declaration'
    || next.requestedProvenance === 'human_declaration'
    || next.originalProvenance === 'human_declaration';
}

function readingStatus(reading: ColorReading): ColorStatus {
  if (reading.exteriorColor == null && reading.requestedColor == null && reading.originalColor == null) return 'unknown';
  return 'proposed';
}

function assertReading(reading: ColorReading): void {
  const provenance = reading.exteriorProvenance;
  if (provenance !== 'human_declaration' && provenance !== 'visual_inference' && provenance !== 'unknown') {
    throw new ColorError('rejected');
  }
  if (reading.exteriorColor == null) {
    if (provenance !== 'unknown') throw new ColorError('rejected');
  } else if (!isColor(reading.exteriorColor) || provenance === 'unknown') {
    throw new ColorError('invalid');
  }
  if (reading.requestedColor == null) {
    if (reading.requestedProvenance != null) throw new ColorError('rejected');
  } else if (reading.requestedProvenance !== 'human_declaration' || !isColor(reading.requestedColor)) {
    throw new ColorError('rejected');
  }
  if (reading.originalColor == null) {
    if (reading.originalProvenance != null) throw new ColorError('rejected');
  } else if (reading.originalProvenance !== 'human_declaration' || !isColor(reading.originalColor)) {
    throw new ColorError('rejected');
  }
  if (reading.finish == null) {
    if (reading.finishProvenance != null) throw new ColorError('rejected');
  } else if (reading.finishProvenance !== 'human_declaration' || !FINISH_TEXT.test(reading.finish)) {
    throw new ColorError('rejected');
  }
  if (reading.paintCode == null) {
    if (reading.paintCodeProvenance != null) throw new ColorError('rejected');
  } else if (reading.paintCodeProvenance !== 'human_declaration' || !PAINT_CODE.test(reading.paintCode)) {
    throw new ColorError('rejected');
  }
}

function annotationPath(subjectId: string, annotationId: string): string {
  const folder = subjectId.startsWith('AF-')
    ? `visual/${subjectId}`
    : subjectId.startsWith('RQ-')
      ? `repairs/${subjectId}`
      : `commercial/${subjectId}`;
  return `data/annotations/color/${folder}/${annotationId}.json`;
}

function nextId(used: string[]): string {
  const values = used.map((id) => Number(id.slice(3))).filter((value) => Number.isInteger(value));
  const next = (values.length ? Math.max(...values) : 0) + 1;
  if (next > 999999) throw new ColorError('limit');
  return `CL-${String(next).padStart(6, '0')}`;
}

function isColor(value: unknown): value is string {
  return typeof value === 'string' && COLOR_TEXT.test(value.trim()) && !/[@]|https?:|price|\d{6,}/i.test(value);
}

function actorKey(userId: string): string {
  if (typeof userId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(userId)) throw new ColorError('rejected');
  return createHash('sha256').update(`color-owner\0${userId}`).digest('hex');
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function rejectClientFields(input: object, allowed: Set<string>): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ColorError('invalid');
  const record = input as Record<string, unknown>;
  if (CLIENT_AUTHORITY.some((key) => Object.prototype.hasOwnProperty.call(record, key))) throw new ColorError('rejected');
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new ColorError('rejected');
}

export class ColorGithub implements ColorFiles {
  constructor(
    private readonly transport: typeof fetch,
    private readonly authorization: () => Promise<string>,
    private readonly repository = 'arturo2565-alt/pegazuz-calibration-data',
  ) {}

  async read(path: string): Promise<{ content: string; sha: string } | null> {
    assertColorRead(path);
    const response = await this.request('GET', path);
    if (response.status === 404) return null;
    if (!response.ok) throw new ColorError('rejected');
    const payload = await response.json() as { content?: unknown; sha?: unknown };
    if (typeof payload.content !== 'string' || typeof payload.sha !== 'string') throw new ColorError('rejected');
    return {
      sha: payload.sha,
      content: Buffer.from(payload.content.replace(/\s/g, ''), 'base64').toString('utf8'),
    };
  }

  async write(path: string, content: string, sha?: string): Promise<string> {
    assertColorWrite(path);
    if (content.includes('https://') || content.includes('http://') || content.includes('@')) throw new ColorError('rejected');
    const response = await this.request('PUT', path, {
      message: `color: ${path.split('/').slice(-2).join('/')}`,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: 'main',
      ...(sha ? { sha } : {}),
    });
    if (!response.ok) throw new ColorError('rejected');
    const payload = await response.json() as { commit?: { sha?: string } };
    if (!payload.commit?.sha) throw new ColorError('rejected');
    return payload.commit.sha;
  }

  private async request(method: 'GET' | 'PUT', path: string, body?: object): Promise<Response> {
    const url = `https://api.github.com/repos/${this.repository}/contents/${path}${method === 'GET' ? '?ref=main' : ''}`;
    const parsed = new URL(url);
    if (parsed.hostname !== 'api.github.com' || !parsed.pathname.includes('/pegazuz-calibration-data/contents/data/')) {
      throw new ColorError('rejected');
    }
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
