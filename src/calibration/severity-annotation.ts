import { createHash } from 'node:crypto';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { calibrationQueryAccess } from './calibration-access';

/**
 * Anotación severity-v1 por pieza. No reescribe el expediente ni el precio.
 * Una propuesta de IA no queda validada. La validación solo sale de la
 * sesión autenticada del propietario.
 */

export const SEVERITY_SCHEMA_VERSION = '1.0.0';
export const SEVERITY_SCALE_VERSION = 'severity-v1';
export const SEVERITY_LEVELS = ['leve', 'medio_leve', 'medio', 'medio_fuerte', 'fuerte'] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];
export type SeverityStatus = 'proposed' | 'validated' | 'unknown';
export type SeverityProvenance = 'visual_inference' | 'human_declaration' | 'insufficient_evidence' | 'authenticated_owner';
export type SeverityEvidenceKind = 'photographs' | 'text_only' | 'not_provided';

const LEVELS = new Set<string>(SEVERITY_LEVELS);
const SUBJECT_ID = /^(?:AF|RQ)-\d{6}$/;
const LINE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ITEMS = 30;
const CATALOG_PATH = 'data/annotations/severity/index.json';
const WRITE_PATH = /^data\/annotations\/severity\/(?:index\.json|(?:visual\/AF-\d{6}|repairs\/RQ-\d{6})\/(?:index\.json|SV-\d{6}\.json))$/;
const READ_PATH = /^data\/(?:cases\/AF-\d{6}|repairs\/quotes\/RQ-\d{6})\.json$/;
const BLOCKED = ['data/commercial/', 'data/photos/', 'data/evidence/', 'data/probes', 'data/index.json'];
const OBSERVATION_FIELDS = new Set(['subjectId', 'lineId', 'assessment', 'level']);
const CONFIRM_FIELDS = new Set(['subjectId', 'lineId', 'level', 'lineReviewed']);
const CLIENT_AUTHORITY = [
  'validated', 'operatorRole', 'operator_role', 'humanValidated', 'human_validated',
  'confirmation', 'email', 'name', 'role', 'price', 'price_mxn', 'priceMxn',
  'quoted_total_mxn', 'damage_severity', 'authorization', 'actorKey', 'actor_key',
];

export class SeverityError extends Error {
  constructor(readonly code: 'invalid' | 'missing' | 'conflict' | 'rejected' | 'limit' | 'forbidden' | 'unauthorized' | 'hidden') {
    super(code);
    this.name = 'SeverityError';
  }
}

export type SeverityFiles = {
  read(path: string): Promise<{ content: string; sha: string } | null>;
  write(path: string, content: string, sha?: string): Promise<string>;
};

export type SeverityNote = {
  annotationId: string;
  lineId: string;
  level: SeverityLevel | null;
  status: SeverityStatus;
  provenance: SeverityProvenance;
  scaleVersion: typeof SEVERITY_SCALE_VERSION | null;
  part: string;
  treatment: string | null;
  evidenceKind: SeverityEvidenceKind;
  history: Array<{
    annotationId: string;
    level: SeverityLevel | null;
    status: SeverityStatus;
    provenance: SeverityProvenance;
    scaleVersion: typeof SEVERITY_SCALE_VERSION | null;
  }>;
};

type SubjectLine = {
  kind: 'visual_case' | 'repair_quote';
  part: string;
  treatment: string | null;
  evidenceKind: SeverityEvidenceKind;
};

type StoredItem = {
  annotation_id: string;
  line_id: string;
  level: SeverityLevel | null;
  status: SeverityStatus;
  provenance: SeverityProvenance;
  scale_version: typeof SEVERITY_SCALE_VERSION | null;
  authorization: 'authenticated_owner' | null;
  actor_key: string | null;
  part: string;
  treatment: string | null;
  evidence_kind: SeverityEvidenceKind;
  current: boolean;
  supersedes: string | null;
};

export function severitySubjectPath(subjectId: string): string {
  if (subjectId.startsWith('AF-')) return `data/annotations/severity/visual/${subjectId}/index.json`;
  if (subjectId.startsWith('RQ-')) return `data/annotations/severity/repairs/${subjectId}/index.json`;
  throw new SeverityError('invalid');
}

export function assertSeverityRead(path: string): void {
  const bare = path.split('?')[0];
  if (BLOCKED.some((needle) => bare.includes(needle)) || (!WRITE_PATH.test(bare) && !READ_PATH.test(bare))) {
    throw new SeverityError('rejected');
  }
}

export function assertSeverityWrite(path: string): void {
  const bare = path.split('?')[0];
  if (BLOCKED.some((needle) => bare.includes(needle)) || READ_PATH.test(bare) || !WRITE_PATH.test(bare)) {
    throw new SeverityError('rejected');
  }
}

export async function ingestSeverityAssessment(
  files: SeverityFiles,
  request: {
    subjectId: string;
    lineId: string;
    assessment: 'visual_inference' | 'human_declaration' | 'insufficient_evidence';
    level?: SeverityLevel;
  },
): Promise<{ status: 'recorded' | 'already_recorded' | 'retained'; annotationId: string }> {
  rejectClientFields(request, OBSERVATION_FIELDS);
  const subjectId = request.subjectId;
  const lineId = request.lineId;
  if (!SUBJECT_ID.test(subjectId) || !LINE_ID.test(lineId)) throw new SeverityError('invalid');
  const provenance = request.assessment;
  if (provenance !== 'visual_inference' && provenance !== 'human_declaration' && provenance !== 'insufficient_evidence') {
    throw new SeverityError('rejected');
  }
  const level = provenance === 'insufficient_evidence' ? null : request.level ?? null;
  if (provenance === 'insufficient_evidence' && request.level != null) throw new SeverityError('rejected');
  if (provenance !== 'insufficient_evidence' && !isLevel(level)) throw new SeverityError('invalid');
  const status: SeverityStatus = provenance === 'insufficient_evidence' ? 'unknown' : 'proposed';
  return storeObservation(files, subjectId, lineId, {
    level,
    status,
    provenance,
    authorization: null,
    actorKey: null,
  });
}

export async function confirmSeverity(
  files: SeverityFiles,
  env: NodeJS.ProcessEnv,
  user: AuthenticatedUser | undefined,
  request: { subjectId: string; lineId: string; level: SeverityLevel; lineReviewed: true },
): Promise<{ status: 'validated' | 'already_validated'; annotationId: string }> {
  const access = calibrationQueryAccess(env, user);
  if (access === 'hidden') throw new SeverityError('hidden');
  if (!user) throw new SeverityError('unauthorized');
  if (access !== 'open') throw new SeverityError('forbidden');
  rejectClientFields(request, CONFIRM_FIELDS);
  if (request.lineReviewed !== true || !isLevel(request.level)) throw new SeverityError('rejected');
  const stored = await storeObservation(files, request.subjectId, request.lineId, {
    level: request.level,
    status: 'validated',
    provenance: 'authenticated_owner',
    authorization: 'authenticated_owner',
    actorKey: actorKey(user.userId),
  });
  if (stored.status === 'retained') throw new SeverityError('conflict');
  return stored.status === 'already_recorded'
    ? { status: 'already_validated', annotationId: stored.annotationId }
    : { status: 'validated', annotationId: stored.annotationId };
}

export function presentSeverityIndex(content: string, subjectId: string): SeverityNote[] {
  const items = parseItems(content, subjectId);
  const lineIds = [...new Set(items.filter((item) => item.current && publicItem(item)).map((item) => item.line_id))];
  return lineIds.flatMap((lineId) => {
    const current = items.find((item) => item.current && item.line_id === lineId && publicItem(item));
    if (!current) return [];
    const history = items
      .filter((item) => !item.current && item.line_id === lineId && publicItem(item))
      .map(publicHistory);
    return [{
      annotationId: current.annotation_id,
      lineId: current.line_id,
      level: current.level,
      status: current.status,
      provenance: current.provenance,
      scaleVersion: current.scale_version,
      part: current.part,
      treatment: current.treatment,
      evidenceKind: current.evidence_kind,
      history,
    }];
  });
}

export function presentSeverityCatalog(content: string): Array<Omit<SeverityNote, 'history'> & {
  subjectId: string;
  subjectKind: 'visual_case' | 'repair_quote';
}> {
  try {
    const parsed = JSON.parse(content) as { records?: unknown };
    if (!Array.isArray(parsed.records)) return [];
    return parsed.records.flatMap((item) => {
      const record = item as StoredItem & { subject_id?: unknown; subject_kind?: unknown };
      const note = publicItem(record);
      if (!note || note.current !== true) return [];
      if (typeof record.subject_id !== 'string') return [];
      if (record.subject_kind !== 'visual_case' && record.subject_kind !== 'repair_quote') return [];
      return [{
        subjectId: record.subject_id,
        subjectKind: record.subject_kind,
        annotationId: note.annotation_id,
        lineId: note.line_id,
        level: note.level,
        status: note.status,
        provenance: note.provenance,
        scaleVersion: note.scale_version,
        part: note.part,
        treatment: note.treatment,
        evidenceKind: note.evidence_kind,
      }];
    });
  } catch {
    return [];
  }
}

async function storeObservation(
  files: SeverityFiles,
  subjectId: string,
  lineId: string,
  next: {
    level: SeverityLevel | null;
    status: SeverityStatus;
    provenance: SeverityProvenance;
    authorization: 'authenticated_owner' | null;
    actorKey: string | null;
  },
): Promise<{ status: 'recorded' | 'already_recorded' | 'retained'; annotationId: string }> {
  if (!SUBJECT_ID.test(subjectId) || !LINE_ID.test(lineId)) throw new SeverityError('invalid');
  if (next.status === 'validated' && (next.authorization !== 'authenticated_owner' || !next.actorKey || !SHA256.test(next.actorKey))) {
    throw new SeverityError('rejected');
  }
  if (next.status !== 'validated' && (next.authorization != null || next.actorKey != null)) throw new SeverityError('rejected');
  const subject = await readSubjectLine(files, subjectId, lineId);
  if (!subject) throw new SeverityError('missing');
  const indexPath = severitySubjectPath(subjectId);
  const indexFile = await files.read(indexPath);
  const items = indexFile ? requireItems(indexFile.content, subjectId) : [];
  const current = items.find((item) => item.current && item.line_id === lineId) ?? null;
  if (current?.status === 'validated' && next.status !== 'validated') {
    return { status: 'retained', annotationId: current.annotation_id };
  }
  if (current && current.status !== 'unknown' && next.status === 'unknown') {
    return { status: 'retained', annotationId: current.annotation_id };
  }
  if (
    current
    && current.level === next.level
    && current.status === next.status
    && current.provenance === next.provenance
    && current.part === subject.part
    && current.treatment === subject.treatment
  ) {
    return { status: 'already_recorded', annotationId: current.annotation_id };
  }
  if (items.length >= MAX_ITEMS) throw new SeverityError('limit');
  const annotationId = nextId(items.map((item) => item.annotation_id));
  const scale = next.level ? SEVERITY_SCALE_VERSION : null;
  const document = {
    schema_version: SEVERITY_SCHEMA_VERSION,
    scale_version: scale,
    annotation_id: annotationId,
    subject_kind: subject.kind,
    subject_id: subjectId,
    line_id: lineId,
    part: subject.part,
    treatment: subject.treatment,
    level: next.level,
    status: next.status,
    provenance: next.provenance,
    authorization: next.authorization,
    actor_key: next.actorKey,
    evidence_kind: subject.evidenceKind,
    supersedes: current?.annotation_id ?? null,
  };
  await files.write(annotationPath(subjectId, annotationId), canonical(document));
  if (current) current.current = false;
  items.push({
    annotation_id: annotationId,
    line_id: lineId,
    level: next.level,
    status: next.status,
    provenance: next.provenance,
    scale_version: scale,
    authorization: next.authorization,
    actor_key: next.actorKey,
    part: subject.part,
    treatment: subject.treatment,
    evidence_kind: subject.evidenceKind,
    current: true,
    supersedes: current?.annotation_id ?? null,
  });
  await files.write(indexPath, canonical({
    schema_version: SEVERITY_SCHEMA_VERSION,
    scale_version: SEVERITY_SCALE_VERSION,
    subject_kind: subject.kind,
    subject_id: subjectId,
    items,
  }), indexFile?.sha);
  await publishCatalog(files, subjectId, subject.kind, items);
  return { status: 'recorded', annotationId };
}

async function readSubjectLine(files: SeverityFiles, subjectId: string, lineId: string): Promise<SubjectLine | null> {
  if (subjectId.startsWith('CQ-')) throw new SeverityError('invalid');
  const path = subjectId.startsWith('AF-')
    ? `data/cases/${subjectId}.json`
    : `data/repairs/quotes/${subjectId}.json`;
  const file = await files.read(path);
  if (!file) return null;
  try {
    const parsed = JSON.parse(file.content) as Record<string, unknown>;
    if (subjectId.startsWith('AF-')) {
      if (parsed.case_id !== subjectId || !Array.isArray(parsed.line_items)) return null;
      const line = parsed.line_items.find((item) => {
        const record = item as { line_id?: unknown };
        return record?.line_id === lineId;
      }) as { part?: unknown; treatment?: unknown } | undefined;
      if (!line || typeof line.part !== 'string' || typeof line.treatment !== 'string') return null;
      const photos = parsed.photo_archive_status === 'archived_private' ? 'photographs' : 'not_provided';
      return { kind: 'visual_case', part: line.part, treatment: line.treatment, evidenceKind: photos };
    }
    if (parsed.quote_id !== subjectId || !Array.isArray(parsed.lines)) return null;
    const line = parsed.lines.find((item) => {
      const record = item as { line_id?: unknown };
      return record?.line_id === lineId;
    }) as { role?: unknown; part?: unknown } | undefined;
    if (line?.role === 'labor') throw new SeverityError('rejected');
    if (!line || line.role !== 'part' || typeof line.part !== 'string') return null;
    return { kind: 'repair_quote', part: line.part, treatment: null, evidenceKind: 'text_only' };
  } catch (err) {
    if (err instanceof SeverityError) throw err;
    return null;
  }
}

async function publishCatalog(
  files: SeverityFiles,
  subjectId: string,
  kind: SubjectLine['kind'],
  items: StoredItem[],
): Promise<void> {
  const currentFile = await files.read(CATALOG_PATH);
  const records = currentFile ? parseCatalog(currentFile.content) : [];
  const kept = records.filter((item) => item.subject_id !== subjectId);
  for (const item of items.filter((entry) => entry.current)) {
    kept.push({ ...item, subject_id: subjectId, subject_kind: kind });
  }
  const next = canonical({
    schema_version: SEVERITY_SCHEMA_VERSION,
    scale_version: SEVERITY_SCALE_VERSION,
    records: kept,
  });
  if (currentFile?.content === next) return;
  await files.write(CATALOG_PATH, next, currentFile?.sha);
}

function parseCatalog(content: string): Array<StoredItem & { subject_id: string; subject_kind: SubjectLine['kind'] }> {
  const parsed = JSON.parse(content) as { records?: unknown };
  if (!Array.isArray(parsed.records)) throw new SeverityError('conflict');
  return parsed.records.flatMap((item) => {
    const record = item as StoredItem & { subject_id?: unknown; subject_kind?: unknown };
    if (typeof record.subject_id !== 'string' || (record.subject_kind !== 'visual_case' && record.subject_kind !== 'repair_quote')) {
      return [];
    }
    return [{ ...record, subject_id: record.subject_id, subject_kind: record.subject_kind }];
  });
}

function requireItems(content: string, subjectId: string): StoredItem[] {
  const parsed = JSON.parse(content) as { subject_id?: unknown; items?: unknown };
  if (parsed.subject_id !== subjectId || !Array.isArray(parsed.items)) throw new SeverityError('conflict');
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
  if (!item) return null;
  if (!LINE_ID.test(item.line_id) || !/^SV-\d{6}$/.test(item.annotation_id)) return null;
  if (item.status === 'validated') {
    if (item.authorization !== 'authenticated_owner' || !item.actor_key || !SHA256.test(item.actor_key)) return null;
    if (item.provenance !== 'authenticated_owner' || !isLevel(item.level)) return null;
  } else if (item.authorization != null || item.actor_key != null || item.provenance === 'authenticated_owner') {
    return null;
  }
  if (item.status === 'unknown' && item.level != null) return null;
  if (item.status === 'proposed' && !isLevel(item.level)) return null;
  if (item.status === 'proposed' && item.provenance !== 'visual_inference' && item.provenance !== 'human_declaration') return null;
  if (item.status === 'unknown' && item.provenance !== 'insufficient_evidence') return null;
  const serialized = JSON.stringify(item).toLowerCase();
  if (serialized.includes('@') || serialized.includes('operator_role') || serialized.includes('price')) return null;
  return item;
}

function publicHistory(item: StoredItem) {
  return {
    annotationId: item.annotation_id,
    level: item.level,
    status: item.status,
    provenance: item.provenance,
    scaleVersion: item.scale_version,
  };
}

function annotationPath(subjectId: string, annotationId: string): string {
  const folder = subjectId.startsWith('AF-') ? `visual/${subjectId}` : `repairs/${subjectId}`;
  return `data/annotations/severity/${folder}/${annotationId}.json`;
}

function nextId(used: string[]): string {
  const values = used.map((id) => Number(id.slice(3))).filter((value) => Number.isInteger(value));
  const next = (values.length ? Math.max(...values) : 0) + 1;
  if (next > 999999) throw new SeverityError('limit');
  return `SV-${String(next).padStart(6, '0')}`;
}

function isLevel(value: unknown): value is SeverityLevel {
  return typeof value === 'string' && LEVELS.has(value);
}

function actorKey(userId: string): string {
  if (typeof userId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(userId)) throw new SeverityError('rejected');
  return createHash('sha256').update(`severity-owner\0${userId}`).digest('hex');
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function rejectClientFields(input: object, allowed: Set<string>): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SeverityError('invalid');
  const record = input as Record<string, unknown>;
  if (CLIENT_AUTHORITY.some((key) => Object.prototype.hasOwnProperty.call(record, key))) throw new SeverityError('rejected');
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new SeverityError('rejected');
}

export class SeverityGithub implements SeverityFiles {
  constructor(
    private readonly transport: typeof fetch,
    private readonly authorization: () => Promise<string>,
    private readonly repository = 'arturo2565-alt/pegazuz-calibration-data',
  ) {}

  async read(path: string): Promise<{ content: string; sha: string } | null> {
    assertSeverityRead(path);
    const response = await this.request('GET', path);
    if (response.status === 404) return null;
    if (!response.ok) throw new SeverityError('rejected');
    const payload = await response.json() as { content?: unknown; sha?: unknown };
    if (typeof payload.content !== 'string' || typeof payload.sha !== 'string') throw new SeverityError('rejected');
    return {
      sha: payload.sha,
      content: Buffer.from(payload.content.replace(/\s/g, ''), 'base64').toString('utf8'),
    };
  }

  async write(path: string, content: string, sha?: string): Promise<string> {
    assertSeverityWrite(path);
    if (content.includes('https://') || content.includes('http://') || content.includes('@')) throw new SeverityError('rejected');
    const response = await this.request('PUT', path, {
      message: `severity: ${path.split('/').slice(-2).join('/')}`,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: 'main',
      ...(sha ? { sha } : {}),
    });
    if (!response.ok) throw new SeverityError('rejected');
    const payload = await response.json() as { commit?: { sha?: string } };
    if (!payload.commit?.sha) throw new SeverityError('rejected');
    return payload.commit.sha;
  }

  private async request(method: 'GET' | 'PUT', path: string, body?: object): Promise<Response> {
    const url = `https://api.github.com/repos/${this.repository}/contents/${path}${method === 'GET' ? '?ref=main' : ''}`;
    const parsed = new URL(url);
    if (parsed.hostname !== 'api.github.com' || !parsed.pathname.includes('/pegazuz-calibration-data/contents/data/')) {
      throw new SeverityError('rejected');
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
