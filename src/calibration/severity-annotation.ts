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
export const SEVERITY_INFERENCE_METHOD = 'visual_assessment';
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
const DECLARATION_FIELDS = new Set(['subjectId', 'lineId', 'level']);
const CONFIRM_FIELDS = new Set(['subjectId', 'lineId', 'level', 'lineReviewed']);
const CLIENT_AUTHORITY = [
  'validated', 'operatorRole', 'operator_role', 'humanValidated', 'human_validated',
  'confirmation', 'email', 'name', 'role', 'price', 'price_mxn', 'priceMxn',
  'quoted_total_mxn', 'damage_severity', 'authorization', 'actorKey', 'actor_key',
  'inferenceMethod', 'inference_method', 'humanDeclaration', 'human_declaration',
];
const GENERIC_ZONE = new Set([
  'pintura', 'mano de obra', 'hojalateria', 'reparacion', 'montaje', 'servicio',
  'general', 'varios', 'refaccion', 'labor', 'trabajo', 'global', 'piezas',
]);
const AF_TREATMENTS = new Set(['repair_paint', 'paint', 'replace_paint', 'replace', 'other', 'uncertain']);

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
  zoneId: string;
  inferenceMethod: typeof SEVERITY_INFERENCE_METHOD | null;
  authorization: 'authenticated_owner' | 'authorized_intake' | null;
  history: Array<{
    annotationId: string;
    level: SeverityLevel | null;
    status: SeverityStatus;
    provenance: SeverityProvenance;
    scaleVersion: typeof SEVERITY_SCALE_VERSION | null;
    inferenceMethod: typeof SEVERITY_INFERENCE_METHOD | null;
  }>;
};

type SubjectLine = {
  kind: 'visual_case' | 'repair_quote';
  part: string;
  treatment: string | null;
  evidenceKind: SeverityEvidenceKind;
  zoneId: string;
};

type StoredItem = {
  annotation_id: string;
  line_id: string;
  level: SeverityLevel | null;
  status: SeverityStatus;
  provenance: SeverityProvenance;
  scale_version: typeof SEVERITY_SCALE_VERSION | null;
  authorization: 'authenticated_owner' | 'authorized_intake' | null;
  actor_key: string | null;
  part: string;
  treatment: string | null;
  evidence_kind: SeverityEvidenceKind;
  zone_id: string;
  inference_method: typeof SEVERITY_INFERENCE_METHOD | null;
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

export function severityAnnotationPathAllowed(path: string): boolean {
  try {
    assertSeverityWrite(path);
    return true;
  } catch {
    return false;
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
    assessment: 'visual_inference' | 'insufficient_evidence';
    level?: SeverityLevel;
  },
): Promise<{ status: 'recorded' | 'already_recorded' | 'retained'; annotationId: string }> {
  rejectClientFields(request, OBSERVATION_FIELDS);
  const subjectId = request.subjectId;
  const lineId = request.lineId;
  if (!SUBJECT_ID.test(subjectId) || !LINE_ID.test(lineId)) throw new SeverityError('invalid');
  const assessment = request.assessment as string;
  if (assessment !== 'visual_inference' && assessment !== 'insufficient_evidence') throw new SeverityError('rejected');
  const level = assessment === 'insufficient_evidence' ? null : request.level ?? null;
  if (assessment === 'insufficient_evidence' && request.level != null) throw new SeverityError('rejected');
  if (assessment === 'visual_inference' && !isLevel(level)) throw new SeverityError('invalid');
  const stored = await storeObservation(files, subjectId, lineId, {
    level,
    status: assessment === 'insufficient_evidence' ? 'unknown' : 'proposed',
    provenance: assessment,
    authorization: null,
    actorKey: null,
    inferenceMethod: assessment === 'visual_inference' ? SEVERITY_INFERENCE_METHOD : null,
  });
  if (stored.status === 'conflict') throw new SeverityError('conflict');
  return { status: stored.status, annotationId: stored.annotationId };
}

export async function recordDeclaredSeverity(
  files: SeverityFiles,
  request: { subjectId: string; lineId: string; level: SeverityLevel },
): Promise<{ status: 'recorded' | 'already_recorded' | 'retained'; annotationId: string }> {
  rejectClientFields(request, DECLARATION_FIELDS);
  if (!SUBJECT_ID.test(request.subjectId) || !LINE_ID.test(request.lineId) || !isLevel(request.level)) {
    throw new SeverityError('invalid');
  }
  const stored = await storeObservation(files, request.subjectId, request.lineId, {
    level: request.level,
    status: 'proposed',
    provenance: 'human_declaration',
    authorization: null,
    actorKey: null,
    inferenceMethod: null,
  });
  if (stored.status === 'conflict') throw new SeverityError('conflict');
  return { status: stored.status, annotationId: stored.annotationId };
}

const IMPORT_FIELDS = new Set(['subjectId', 'lineId', 'assessment', 'level']);

export async function describeSeverityLine(
  files: SeverityFiles,
  subjectId: string,
  lineId: string,
): Promise<{ zoneId: string; part: string; treatment: string | null }> {
  const subject = await readSubjectLine(files, subjectId, lineId);
  if (!subject) throw new SeverityError('missing');
  return { zoneId: subject.zoneId, part: subject.part, treatment: subject.treatment };
}

/** Propuesta de importación. Nunca valida y no sustituye una clasificación distinta. */
export async function importSeverityProposal(
  files: SeverityFiles,
  request: {
    subjectId: string;
    lineId: string;
    assessment: 'visual_inference' | 'human_declaration' | 'insufficient_evidence';
    level?: SeverityLevel | null;
  },
): Promise<{ status: 'recorded' | 'already_recorded' | 'conflict'; annotationId: string }> {
  rejectClientFields(request, IMPORT_FIELDS);
  const assessment = String(request.assessment);
  if (assessment !== 'visual_inference' && assessment !== 'human_declaration' && assessment !== 'insufficient_evidence') {
    throw new SeverityError('rejected');
  }
  if (assessment === 'insufficient_evidence' && request.level != null) throw new SeverityError('rejected');
  const level = assessment === 'insufficient_evidence' ? null : request.level ?? null;
  if (assessment !== 'insufficient_evidence' && !isLevel(level)) throw new SeverityError('invalid');
  const stored = await storeObservation(files, request.subjectId, request.lineId, {
    level,
    status: assessment === 'insufficient_evidence' ? 'unknown' : 'proposed',
    provenance: assessment,
    authorization: null,
    actorKey: null,
    inferenceMethod: assessment === 'visual_inference' ? SEVERITY_INFERENCE_METHOD : null,
  }, { conflictOnDifference: true });
  if (stored.status === 'recorded' || stored.status === 'already_recorded') {
    return { status: stored.status, annotationId: stored.annotationId };
  }
  return { status: 'conflict', annotationId: stored.annotationId };
}

export type DeclaredConfirmation = {
  lineId: string;
  annotationId: string;
  level: SeverityLevel;
};

export type DeclaredConfirmationReport = {
  confirmed: DeclaredConfirmation[];
  already: DeclaredConfirmation[];
  conflicts: DeclaredConfirmation[];
  complete: boolean;
};

const DECLARATION_BATCH_FIELDS = new Set(['subjectId', 'declarationsReviewed', 'items']);
const DECLARATION_ITEM_FIELDS = new Set(['lineId', 'annotationId', 'level']);

export async function confirmDeclaredSeverities(
  files: SeverityFiles,
  env: NodeJS.ProcessEnv,
  user: AuthenticatedUser | undefined,
  request: { subjectId: string; declarationsReviewed: true; items: DeclaredConfirmation[] },
): Promise<DeclaredConfirmationReport> {
  const access = calibrationQueryAccess(env, user);
  if (access === 'hidden') throw new SeverityError('hidden');
  if (!user) throw new SeverityError('unauthorized');
  if (access !== 'open') throw new SeverityError('forbidden');
  rejectClientFields(request, DECLARATION_BATCH_FIELDS);
  if (request.declarationsReviewed !== true) throw new SeverityError('rejected');
  if (!SUBJECT_ID.test(request.subjectId)) throw new SeverityError('invalid');
  if (!Array.isArray(request.items) || request.items.length < 1 || request.items.length > 12) throw new SeverityError('rejected');
  const seen = new Set<string>();
  for (const item of request.items) {
    rejectClientFields(item, DECLARATION_ITEM_FIELDS);
    if (!LINE_ID.test(item.lineId) || !/^SV-\d{6}$/.test(item.annotationId) || !isLevel(item.level)) {
      throw new SeverityError('rejected');
    }
    if (seen.has(item.lineId)) throw new SeverityError('rejected');
    seen.add(item.lineId);
  }
  const confirmed: DeclaredConfirmation[] = [];
  const already: DeclaredConfirmation[] = [];
  const conflicts: DeclaredConfirmation[] = [];
  for (const item of request.items) {
    const outcome = await confirmDeclaredItem(files, user, request.subjectId, item);
    if (outcome === 'confirmed') confirmed.push(item);
    else if (outcome === 'already') already.push(item);
    else conflicts.push(item);
  }
  return {
    confirmed,
    already,
    conflicts,
    complete: conflicts.length === 0,
  };
}

async function confirmDeclaredItem(
  files: SeverityFiles,
  user: AuthenticatedUser,
  subjectId: string,
  item: DeclaredConfirmation,
): Promise<'confirmed' | 'already' | 'conflict'> {
  try {
    const subject = await readSubjectLine(files, subjectId, item.lineId);
    if (!subject) return 'conflict';
    const indexFile = await files.read(severitySubjectPath(subjectId));
    const items = indexFile ? requireItems(indexFile.content, subjectId) : [];
    const reviewed = items.find((entry) => entry.annotation_id === item.annotationId && entry.line_id === item.lineId) ?? null;
    const current = items.find((entry) => entry.current && entry.zone_id === subject.zoneId) ?? null;
    if (!reviewed || !isPendingDeclaration(reviewed, item, subject.zoneId, subject.part)) return 'conflict';
    if (current?.annotation_id === reviewed.annotation_id) {
      const stored = await storeObservation(files, subjectId, item.lineId, {
        level: item.level,
        status: 'validated',
        provenance: 'authenticated_owner',
        authorization: 'authenticated_owner',
        actorKey: actorKey(user.userId),
        inferenceMethod: null,
      }, { expectedAnnotationId: reviewed.annotation_id });
      return stored.status === 'recorded' ? 'confirmed' : 'conflict';
    }
    if (
      current
      && current.status === 'validated'
      && current.provenance === 'authenticated_owner'
      && current.level === item.level
      && supersedes(items, current.annotation_id, reviewed.annotation_id)
    ) {
      return 'already';
    }
    return 'conflict';
  } catch (err) {
    if (err instanceof SeverityError && (err.code === 'conflict' || err.code === 'missing' || err.code === 'rejected')) return 'conflict';
    throw err;
  }
}

function isPendingDeclaration(
  note: StoredItem,
  item: DeclaredConfirmation,
  zoneId: string,
  part: string,
): boolean {
  return note.zone_id === zoneId
    && note.part === part
    && note.level === item.level
    && note.status === 'proposed'
    && note.provenance === 'human_declaration'
    && note.inference_method == null
    && note.authorization == null
    && note.actor_key == null;
}

function supersedes(items: StoredItem[], fromId: string, targetId: string): boolean {
  const byId = new Map(items.map((item) => [item.annotation_id, item]));
  let cursor = byId.get(fromId) ?? null;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.annotation_id)) {
    if (cursor.supersedes === targetId) return true;
    seen.add(cursor.annotation_id);
    cursor = cursor.supersedes ? byId.get(cursor.supersedes) ?? null : null;
  }
  return false;
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
    inferenceMethod: null,
  });
  if (stored.status === 'retained' || stored.status === 'conflict') throw new SeverityError('conflict');
  return stored.status === 'already_recorded'
    ? { status: 'already_validated', annotationId: stored.annotationId }
    : { status: 'validated', annotationId: stored.annotationId };
}

const SUMMARY_FIELDS = new Set(['subjectId', 'summaryReviewed', 'items', 'lineId', 'annotationId', 'level']);

/**
 * Una sola aprobación autenticada del resumen.
 * La procedencia sigue siendo human_declaration.
 * No es la confirmación posterior authenticated_owner.
 */
export async function approveIntakeSummary(
  files: SeverityFiles,
  env: NodeJS.ProcessEnv,
  user: AuthenticatedUser | undefined,
  request: {
    subjectId: string;
    summaryReviewed: boolean;
    items: Array<{ lineId: string; annotationId: string; level: SeverityLevel }>;
  },
): Promise<{
  approved: Array<{ lineId: string; annotationId: string; status: 'validated' | 'already' }>;
  conflicts: Array<{ lineId: string; reason: 'conflict' | 'missing' | 'not_human' }>;
  complete: boolean;
}> {
  const access = calibrationQueryAccess(env, user);
  if (access === 'hidden') throw new SeverityError('hidden');
  if (!user) throw new SeverityError('unauthorized');
  if (access !== 'open' || user.role !== 'owner') throw new SeverityError('forbidden');
  rejectClientFields(request, SUMMARY_FIELDS);
  if (request.summaryReviewed !== true) throw new SeverityError('rejected');
  if (!SUBJECT_ID.test(request.subjectId) || !Array.isArray(request.items) || request.items.length < 1 || request.items.length > 12) {
    throw new SeverityError('invalid');
  }
  const seen = new Set<string>();
  const approved: Array<{ lineId: string; annotationId: string; status: 'validated' | 'already' }> = [];
  const conflicts: Array<{ lineId: string; reason: 'conflict' | 'missing' | 'not_human' }> = [];
  for (const item of request.items) {
    rejectClientFields(item, SUMMARY_FIELDS);
    if (seen.has(item.lineId)) throw new SeverityError('invalid');
    seen.add(item.lineId);
    const outcome = await approveIntakeItem(files, user, request.subjectId, item);
    if (outcome.status === 'conflict' || outcome.status === 'missing' || outcome.status === 'not_human') {
      conflicts.push({ lineId: item.lineId, reason: outcome.status });
    } else {
      approved.push({ lineId: item.lineId, annotationId: outcome.annotationId, status: outcome.status });
    }
  }
  return { approved, conflicts, complete: conflicts.length === 0 };
}

async function approveIntakeItem(
  files: SeverityFiles,
  user: AuthenticatedUser,
  subjectId: string,
  item: { lineId: string; annotationId: string; level: SeverityLevel },
): Promise<{ status: 'validated' | 'already' | 'conflict' | 'missing' | 'not_human'; annotationId: string }> {
  if (!LINE_ID.test(item.lineId) || !/^SV-\d{6}$/.test(item.annotationId) || !isLevel(item.level)) {
    return { status: 'conflict', annotationId: item.annotationId };
  }
  const subject = await readSubjectLine(files, subjectId, item.lineId);
  if (!subject) return { status: 'missing', annotationId: item.annotationId };
  const indexFile = await files.read(severitySubjectPath(subjectId));
  const items = indexFile ? requireItems(indexFile.content, subjectId) : [];
  const reviewed = items.find((entry) => entry.annotation_id === item.annotationId && entry.line_id === item.lineId) ?? null;
  const current = items.find((entry) => entry.current && entry.zone_id === subject.zoneId) ?? null;
  if (
    current
    && current.status === 'validated'
    && current.authorization === 'authorized_intake'
    && current.provenance === 'human_declaration'
    && current.level === item.level
    && (current.annotation_id === item.annotationId || (reviewed && supersedes(items, current.annotation_id, reviewed.annotation_id)))
  ) {
    return { status: 'already', annotationId: current.annotation_id };
  }
  if (!reviewed || !current || current.annotation_id !== reviewed.annotation_id) {
    return { status: 'conflict', annotationId: current?.annotation_id ?? item.annotationId };
  }
  if (reviewed.status !== 'proposed' || reviewed.provenance !== 'human_declaration' || reviewed.level !== item.level || reviewed.inference_method != null) {
    return { status: 'not_human', annotationId: reviewed.annotation_id };
  }
  const stored = await storeObservation(files, subjectId, item.lineId, {
    level: item.level,
    status: 'validated',
    provenance: 'human_declaration',
    authorization: 'authorized_intake',
    actorKey: actorKey(user.userId),
    inferenceMethod: null,
  }, { expectedAnnotationId: reviewed.annotation_id });
  if (stored.status !== 'recorded') return { status: 'conflict', annotationId: stored.annotationId };
  return { status: 'validated', annotationId: stored.annotationId };
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
      zoneId: current.zone_id,
      inferenceMethod: current.inference_method,
      authorization: current.authorization,
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
        zoneId: note.zone_id,
        inferenceMethod: note.inference_method,
        authorization: note.authorization,
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
    authorization: 'authenticated_owner' | 'authorized_intake' | null;
    actorKey: string | null;
    inferenceMethod: typeof SEVERITY_INFERENCE_METHOD | null;
  },
  options: { conflictOnDifference?: boolean; expectedAnnotationId?: string } = {},
): Promise<{ status: 'recorded' | 'already_recorded' | 'retained' | 'conflict'; annotationId: string }> {
  if (!SUBJECT_ID.test(subjectId) || !LINE_ID.test(lineId)) throw new SeverityError('invalid');
  if (next.provenance === 'visual_inference' && next.inferenceMethod !== SEVERITY_INFERENCE_METHOD) throw new SeverityError('rejected');
  if (next.provenance !== 'visual_inference' && next.inferenceMethod != null) throw new SeverityError('rejected');
  const intake = next.status === 'validated' && next.authorization === 'authorized_intake' && next.provenance === 'human_declaration';
  const ownerValidation = next.status === 'validated' && next.authorization === 'authenticated_owner' && next.provenance === 'authenticated_owner';
  if (next.status === 'validated' && (!intake && !ownerValidation || !next.actorKey || !SHA256.test(next.actorKey))) {
    throw new SeverityError('rejected');
  }
  if (next.status !== 'validated' && (next.authorization != null || next.actorKey != null)) throw new SeverityError('rejected');
  const subject = await readSubjectLine(files, subjectId, lineId);
  if (!subject) throw new SeverityError('missing');
  const indexPath = severitySubjectPath(subjectId);
  const indexFile = await files.read(indexPath);
  const items = indexFile ? requireItems(indexFile.content, subjectId) : [];
  const current = items.find((item) => item.current && item.zone_id === subject.zoneId) ?? null;
  if (options.expectedAnnotationId) {
    const unchanged = current
      && current.annotation_id === options.expectedAnnotationId
      && current.line_id === lineId
      && current.level === next.level
      && current.status === 'proposed'
      && current.provenance === 'human_declaration'
      && current.inference_method == null
      && current.part === subject.part
      && current.zone_id === subject.zoneId;
    if (!unchanged) return { status: 'conflict', annotationId: current?.annotation_id ?? options.expectedAnnotationId };
  }
  if (current?.status === 'validated' && next.status !== 'validated') {
    return { status: 'retained', annotationId: current.annotation_id };
  }
  if (current?.status === 'proposed' && current.provenance === 'human_declaration' && next.provenance === 'visual_inference') {
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
    && current.zone_id === subject.zoneId
    && current.inference_method === next.inferenceMethod
  ) {
    return { status: 'already_recorded', annotationId: current.annotation_id };
  }
  if (options.conflictOnDifference && current) {
    return { status: 'conflict', annotationId: current.annotation_id };
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
    zone_id: subject.zoneId,
    inference_method: next.inferenceMethod,
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
    zone_id: subject.zoneId,
    inference_method: next.inferenceMethod,
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
      if (!line || typeof line.part !== 'string' || !line.part.trim() || !AF_TREATMENTS.has(String(line.treatment))) return null;
      const photos = parsed.photo_archive_status === 'archived_private' ? 'photographs' : 'not_provided';
      return {
        kind: 'visual_case',
        part: line.part,
        treatment: String(line.treatment),
        evidenceKind: photos,
        zoneId: `af:${lineId}`,
      };
    }
    const lines = parseRepairLines(parsed.lines);
    if (parsed.quote_id !== subjectId || !lines) return null;
    const cited = lines.find((item) => item.line_id === lineId);
    if (!cited) return null;
    if (!identifiesZone(cited.part)) throw new SeverityError('rejected');
    const zone = normalizePart(cited.part);
    const siblings = lines.filter((item) => identifiesZone(item.part) && normalizePart(item.part) === zone);
    const treatment = repairZoneTreatment(siblings);
    const display = [...siblings].sort((left, right) => left.line_id.localeCompare(right.line_id))[0]?.part ?? cited.part;
    return {
      kind: 'repair_quote',
      part: display,
      treatment,
      evidenceKind: 'text_only',
      zoneId: `rq:${zone}`,
    };
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
    const intake = item.authorization === 'authorized_intake' && item.provenance === 'human_declaration';
    const ownerValidation = item.authorization === 'authenticated_owner' && item.provenance === 'authenticated_owner';
    if ((!intake && !ownerValidation) || !item.actor_key || !SHA256.test(item.actor_key) || !isLevel(item.level)) return null;
  } else if (item.authorization != null || item.actor_key != null || item.provenance === 'authenticated_owner') {
    return null;
  }
  if (item.status === 'unknown' && item.level != null) return null;
  if (item.status === 'proposed' && !isLevel(item.level)) return null;
  if (typeof item.zone_id !== 'string' || item.zone_id.length > 120) return null;
  if (item.provenance === 'visual_inference' && item.inference_method !== SEVERITY_INFERENCE_METHOD) return null;
  if (item.provenance !== 'visual_inference' && item.inference_method != null) return null;
  if (item.status === 'validated' && item.inference_method != null) return null;
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
    inferenceMethod: item.inference_method,
  };
}

export function severityZoneForLine(line: {
  lineId?: string | null;
  part?: string | null;
  role?: unknown;
  labor?: unknown;
}): string | null {
  if (!line?.lineId || typeof line.part !== 'string' || !line.part.trim()) return null;
  if (line.role == null) return `af:${line.lineId}`;
  if (line.role !== 'part' && line.role !== 'labor') return null;
  if (line.role === 'labor' && line.labor !== 'repair' && line.labor !== 'paint' && line.labor !== 'mount_and_paint') return null;
  if (!identifiesZone(line.part)) return null;
  return `rq:${normalizePart(line.part)}`;
}

function normalizePart(value: string): string {
  return value.trim().toLocaleLowerCase('es-MX').replace(/\s+/g, ' ').normalize('NFD').replace(/\p{M}/gu, '');
}

function identifiesZone(value: string): boolean {
  const name = normalizePart(value);
  return Boolean(name) && name.length <= 80 && !GENERIC_ZONE.has(name);
}

function repairZoneTreatment(lines: RepairObservation[]): string {
  const replaced = lines.some((line) => line.role === 'part');
  const labors = new Set(lines.flatMap((line) => line.labor ? [line.labor] : []));
  if (replaced && (labors.has('paint') || labors.has('mount_and_paint'))) return 'replace_paint';
  if (replaced) return 'replace';
  if (labors.has('repair') && (labors.has('paint') || labors.has('mount_and_paint'))) return 'repair_paint';
  if (labors.has('repair')) return 'repair';
  if (labors.has('mount_and_paint')) return 'mount_and_paint';
  return 'paint';
}

type RepairObservation = {
  line_id: string;
  part: string;
  role: 'part' | 'labor';
  labor: 'repair' | 'paint' | 'mount_and_paint' | null;
};

function parseRepairLines(value: unknown): RepairObservation[] | null {
  if (!Array.isArray(value)) return null;
  const lines: RepairObservation[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const line = item as Record<string, unknown>;
    if (typeof line.line_id !== 'string' || typeof line.part !== 'string') return null;
    if (line.role !== 'part' && line.role !== 'labor') return null;
    const labor = line.labor === 'repair' || line.labor === 'paint' || line.labor === 'mount_and_paint' ? line.labor : null;
    if (line.role === 'part' && line.labor != null) return null;
    if (line.role === 'labor' && !labor) return null;
    lines.push({
      line_id: line.line_id,
      part: line.part,
      role: line.role,
      labor,
    });
  }
  return lines;
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
