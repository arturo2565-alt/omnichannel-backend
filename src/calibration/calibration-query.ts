import { createHash } from 'node:crypto';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { presentVehicle, type VehiclePresentation } from './vehicle-presentation';

/**
 * Consulta de solo lectura. No escribe índices, expedientes ni fotografías.
 * El rol admin existe en el usuario, pero ninguna ruta lo autoriza: el acceso
 * exige owner y un correo incluido en CALIBRATION_READ_ACTORS.
 */

export const CALIBRATION_QUERY_SCAN_LIMIT = 200;
const CASE_ID = /^AF-\d{6}$/;
const REAL_CASE_ID = /^AF-0\d{5}$/;
const PHOTO_ID = /^IMG-\d{6}$/;
const QUOTE_ID = /^CQ-\d{6}$/;
const REPAIR_ID = /^RQ-\d{6}$/;
const WORK_ID = /^(?:AF|RQ)-\d{6}$/;
const RECORDED_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const EVIDENCE_FILTER = new Set(['photographs', 'text', 'pending']);
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /\d{10,}/;
const PLATE = /\b[A-Z]{3}-?\d{3,4}(?:-?[A-Z])?\b/;
const ACTOR = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SERVICES = new Set(['exterior_bath', 'bath_with_bodywork', 'color_change']);
const WORK = new Set(['bodywork', 'disassembly', 'interior_frames']);
const TREATMENTS = new Set(['repair_paint', 'paint', 'replace_paint', 'replace', 'other', 'uncertain']);
const EVIDENCE = new Set(['customer_provided', 'visual_inference', 'unknown']);
const COMMERCIAL_EVIDENCE = new Set(['customer_provided', 'unknown']);
const ARCHIVE = new Set(['not_provided', 'pending_private_archive', 'archived_private']);
const REPAIR_LABOR = new Set(['mount_and_paint', 'paint', 'repair']);

export class CalibrationQueryError extends Error {
  constructor(readonly code: 'hidden' | 'forbidden' | 'invalid' | 'missing' | 'unavailable') {
    super(code);
    this.name = 'CalibrationQueryError';
  }
}

export type PhotoLocator = {
  publicId: string;
  version: number;
  format: 'jpg' | 'png' | 'webp';
  sha256: string;
};

export type CalibrationArchive = {
  read(path: string): Promise<string | null>;
  photo(locator: PhotoLocator): Promise<Buffer>;
};

export type QueryList = {
  q?: string;
  limit?: string;
  cursor?: string;
  archive?: string;
  service?: string;
  evidence?: string;
};

export function calibrationPhotoManifestPath(caseId: string, photoId: string): string | null {
  if (!REAL_CASE_ID.test(caseId) || !PHOTO_ID.test(photoId)) return null;
  const path = `data/photos/${caseId}/${photoId}.json`;
  return calibrationPathAllowed(path) ? path : null;
}

export function calibrationPathAllowed(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 160) return false;
  if (path.includes('..') || path.includes('\\') || path.includes('?') || path.includes('#') || path.includes('%') || path.includes('\0')) {
    return false;
  }
  if (path.startsWith('data/probes') || path.includes('/probes/')) return false;
  return path === 'data/index.json'
    || path === 'data/commercial/index.json'
    || path === 'data/repairs/index.json'
    || /^data\/cases\/AF-\d{6}\.json$/.test(path)
    || /^data\/photos\/AF-0\d{5}\/IMG-\d{6}\.json$/.test(path)
    || /^data\/commercial\/quotes\/CQ-\d{6}\.json$/.test(path)
    || /^data\/repairs\/quotes\/RQ-\d{6}\.json$/.test(path);
}

export function calibrationQueryAccess(
  env: NodeJS.ProcessEnv,
  user: AuthenticatedUser | undefined,
): 'open' | 'hidden' | 'forbidden' {
  if (!queryVisible(env)) return 'hidden';
  if (user?.role !== 'owner' || !actorPermitted(user.email, env)) return 'forbidden';
  return 'open';
}

function actorPermitted(email: unknown, env: NodeJS.ProcessEnv): boolean {
  if (typeof email !== 'string') return false;
  const normalized = email.trim().toLowerCase();
  if (!ACTOR.test(normalized) || normalized.length > 254) return false;
  return new Set(readActors(env)).has(normalized);
}

export async function readCalibrationSummary(archive: CalibrationArchive) {
  const visual = await readVisualIndex(archive);
  const commercial = await readCommercialIndex(archive);
  const repairs = await readRepairIndex(archive);
  let archived = 0;
  let pending = 0;
  let photos = 0;
  for (const id of newestWindow(visual.ids)) {
    const record = await readCaseRecord(archive, id);
    if (!record) continue;
    if (record.archiveStatus === 'archived_private') archived += 1;
    if (record.archiveStatus === 'pending_private_archive') pending += 1;
    photos += record.photos.filter((photo) => photo.verified).length;
  }
  const evidenceTruncated = visual.ids.length > CALIBRATION_QUERY_SCAN_LIMIT;
  return {
    repairs: {
      recordCount: visual.ids.length + repairs.opportunityCount,
      caseCount: visual.ids.length,
      opportunityCount: repairs.opportunityCount,
      truncated: false,
    },
    paint: {
      opportunityCount: commercial.opportunityCount,
      quoteCount: commercial.quoteCount,
      truncated: false,
    },
    evidence: {
      photoCount: photos,
      truncated: evidenceTruncated,
    },
    pending: {
      caseCount: pending,
      truncated: evidenceTruncated,
    },
  };
}

export async function listCalibrationCases(archive: CalibrationArchive, query: QueryList) {
  const page = readPage(query, CASE_ID);
  const archiveFilter = readArchiveFilter(query.archive);
  const visual = await readVisualIndex(archive);
  const records = [];
  for (const id of visual.ids.slice(0, CALIBRATION_QUERY_SCAN_LIMIT)) {
    const record = await readCaseRecord(archive, id);
    if (!record) continue;
    if (archiveFilter && record.archiveStatus !== archiveFilter) continue;
    if (!matchesQuery(page.q, [record.id, record.make, record.model, record.year])) continue;
    records.push(withoutRecordedAt(record));
  }
  return paginate(records, page, visual.ids.length > CALIBRATION_QUERY_SCAN_LIMIT);
}

export async function readCalibrationCase(archive: CalibrationArchive, caseId: string) {
  if (!CASE_ID.test(caseId)) throw new CalibrationQueryError('invalid');
  const record = await readCaseRecord(archive, caseId);
  if (!record) throw new CalibrationQueryError('missing');
  return withoutRecordedAt(record);
}

export async function listCalibrationOpportunities(archive: CalibrationArchive, query: QueryList) {
  const page = readPage(query, QUOTE_ID);
  const service = readServiceFilter(query.service);
  const commercial = await readCommercialIndex(archive);
  const records: {
    headQuoteId: string;
    opportunityKey: string;
    revisionCount: number;
    service: string | null;
    integrity: string;
    make: string | null;
    model: string | null;
    year: number | null;
    presentation: VehiclePresentation;
    quotedMxn: number | null;
  }[] = [];
  for (const row of commercial.rows.slice(0, CALIBRATION_QUERY_SCAN_LIMIT)) {
    const detail = await readOpportunity(archive, row);
    if (!detail) continue;
    if (service && detail.service !== service) continue;
    const head = detail.revisions[detail.revisions.length - 1];
    if (!matchesQuery(page.q, [
      detail.headQuoteId,
      detail.opportunityKey,
      head?.make,
      head?.presentation.make,
      head?.model,
      head?.year,
      detail.service,
    ])) continue;
    records.push({
      headQuoteId: detail.headQuoteId,
      opportunityKey: detail.opportunityKey,
      revisionCount: detail.revisions.length,
      service: detail.service,
      integrity: detail.integrity,
      make: head?.make ?? null,
      model: head?.model ?? null,
      year: head?.year ?? null,
      presentation: head?.presentation ?? presentVehicle({}),
      quotedMxn: head?.quotedMxn ?? null,
    });
  }
  return paginate(records, page, commercial.truncated);
}

export async function listCalibrationRepairs(archive: CalibrationArchive, query: QueryList) {
  const page = readPage(query, REPAIR_ID);
  const repairs = await readRepairIndex(archive);
  const records: {
    headQuoteId: string;
    revisionCount: number;
    integrity: 'complete' | 'incomplete';
    make: string | null;
    model: string | null;
    year: number | null;
    presentation: VehiclePresentation;
    quotedMxn: number | null;
    evidence: 'text_only';
    photoStatus: 'not_provided';
  }[] = [];
  for (const row of repairs.rows.slice(0, CALIBRATION_QUERY_SCAN_LIMIT)) {
    const detail = await readRepairOpportunity(archive, row);
    if (!detail) continue;
    const head = detail.revisions[detail.revisions.length - 1];
    if (!matchesQuery(page.q, [
      detail.headQuoteId,
      head?.make,
      head?.presentation.make,
      head?.model,
      head?.year,
      ...(head?.lines ?? []).map((line) => line.part),
    ])) continue;
    records.push({
      headQuoteId: detail.headQuoteId,
      revisionCount: detail.revisions.length,
      integrity: detail.integrity,
      make: head?.make ?? null,
      model: head?.model ?? null,
      year: head?.year ?? null,
      presentation: head?.presentation ?? presentVehicle({}),
      quotedMxn: head?.quotedTotalMxn ?? null,
      evidence: 'text_only',
      photoStatus: 'not_provided',
    });
  }
  return paginate(records, page, repairs.truncated);
}

export async function listCalibrationRepairWork(archive: CalibrationArchive, query: QueryList) {
  const page = readPage(query, WORK_ID);
  const evidenceFilter = readEvidenceFilter(query.evidence);
  const visual = await readVisualIndex(archive);
  const repairs = await readRepairIndex(archive);
  const records: RepairWorkItem[] = [];
  for (const id of newestWindow(visual.ids)) {
    const record = await readCaseRecord(archive, id);
    if (!record) continue;
    const evidence = caseEvidence(record.archiveStatus);
    if (evidenceFilter && evidence !== evidenceFilter) continue;
    if (!matchesQuery(page.q, [record.id, record.make, record.model, record.year])) continue;
    records.push({
      contract: 'visual',
      id: record.id,
      evidence,
      integrity: record.integrity,
      make: record.make,
      model: record.model,
      year: record.year,
      quotedTotalMxn: record.quotedTotalMxn,
      recordedAt: record.recordedAt,
    });
  }
  for (const row of newestWindow(repairs.allRows)) {
    const detail = await readRepairOpportunity(archive, row);
    if (!detail) continue;
    const head = detail.revisions[detail.revisions.length - 1];
    if (evidenceFilter && evidenceFilter !== 'text') continue;
    if (!matchesQuery(page.q, [
      detail.headQuoteId,
      head?.make,
      head?.presentation.make,
      head?.model,
      head?.year,
      ...(head?.lines ?? []).map((line) => line.part),
    ])) continue;
    records.push({
      contract: 'repair',
      id: detail.headQuoteId,
      evidence: 'text',
      integrity: detail.integrity,
      make: head?.make ?? null,
      model: head?.model ?? null,
      year: head?.year ?? null,
      presentation: head?.presentation ?? presentVehicle({}),
      quotedMxn: head?.quotedTotalMxn ?? null,
      revisionCount: detail.revisions.length,
      recordedAt: head?.recordedAt ?? '',
    });
  }
  records.sort(compareRepairWork);
  const visible = records.map(withoutRecordedAt);
  return paginate(
    visible,
    page,
    visual.ids.length > CALIBRATION_QUERY_SCAN_LIMIT || repairs.allRows.length > CALIBRATION_QUERY_SCAN_LIMIT,
  );
}

export async function readCalibrationRepair(archive: CalibrationArchive, quoteId: string) {
  if (!REPAIR_ID.test(quoteId)) throw new CalibrationQueryError('invalid');
  const repairs = await readRepairIndex(archive);
  const row = repairs.allRows.find((item) => item.quoteIds.includes(quoteId));
  if (!row) throw new CalibrationQueryError('missing');
  const detail = await readRepairOpportunity(archive, row);
  if (!detail) throw new CalibrationQueryError('missing');
  return {
    ...detail,
    revisions: detail.revisions.map((revision) => withoutRecordedAt(revision)),
  };
}

export async function readCalibrationQuote(archive: CalibrationArchive, quoteId: string) {
  if (!QUOTE_ID.test(quoteId)) throw new CalibrationQueryError('invalid');
  const commercial = await readCommercialIndex(archive);
  const row = commercial.rows.find((item) => item.quoteIds.includes(quoteId));
  if (!row) throw new CalibrationQueryError('missing');
  const detail = await readOpportunity(archive, row);
  if (!detail) throw new CalibrationQueryError('missing');
  return detail;
}

export async function readCalibrationPhoto(
  archive: CalibrationArchive,
  caseId: string,
  photoId: string,
): Promise<{ mime: 'image/jpeg' | 'image/png' | 'image/webp'; bytes: Buffer }> {
  if (!calibrationPhotoManifestPath(caseId, photoId)) throw new CalibrationQueryError('invalid');
  const manifest = await readPhotoManifest(archive, caseId, photoId);
  if (!manifest?.locator) throw new CalibrationQueryError('missing');
  let bytes: Buffer;
  try {
    bytes = await archive.photo(manifest.locator);
  } catch {
    throw new CalibrationQueryError('unavailable');
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 5_242_880) {
    throw new CalibrationQueryError('unavailable');
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== manifest.locator.sha256) throw new CalibrationQueryError('unavailable');
  return { mime: manifest.mime, bytes };
}

function queryVisible(env: NodeJS.ProcessEnv): boolean {
  if (String(env.CALIBRATION_READ_ENABLED ?? '').trim() !== 'true') return false;
  if (String(env.CALIBRATION_INGEST_ENABLED ?? '').trim() === 'true') return false;
  if (String(env.PEGAZUZ_ENV ?? '').trim().toLowerCase() !== 'staging') return false;
  const railwayEnv = String(env.RAILWAY_ENVIRONMENT_NAME ?? '').trim();
  if (railwayEnv === 'production') return false;
  const service = String(env.RAILWAY_SERVICE_NAME ?? '').trim();
  return service !== 'omnichannel-backend' && service !== 'Postgres';
}

function readActors(env: NodeJS.ProcessEnv): string[] {
  return String(env.CALIBRATION_READ_ACTORS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => ACTOR.test(item))
    .slice(0, 20);
}

async function readText(archive: CalibrationArchive, path: string): Promise<string | null> {
  if (!calibrationPathAllowed(path)) throw new CalibrationQueryError('unavailable');
  try {
    const text = await archive.read(path);
    if (text == null) return null;
    if (text.length > 262_144) throw new CalibrationQueryError('unavailable');
    return text;
  } catch (err) {
    if (err instanceof CalibrationQueryError) throw err;
    throw new CalibrationQueryError('unavailable');
  }
}

async function readJson(archive: CalibrationArchive, path: string): Promise<unknown | null> {
  const text = await readText(archive, path);
  if (text == null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function readVisualIndex(archive: CalibrationArchive): Promise<{ ids: string[] }> {
  const parsed = await readJson(archive, 'data/index.json');
  const cases = objectOf(parsed)?.cases;
  if (!cases || typeof cases !== 'object' || Array.isArray(cases)) return { ids: [] };
  return { ids: Object.keys(cases).filter((id) => CASE_ID.test(id)).sort() };
}

async function readCommercialIndex(archive: CalibrationArchive) {
  return readOpportunityIndex(archive, 'data/commercial/index.json', QUOTE_ID);
}

async function readRepairIndex(archive: CalibrationArchive) {
  return readOpportunityIndex(archive, 'data/repairs/index.json', REPAIR_ID);
}

async function readOpportunityIndex(archive: CalibrationArchive, path: string, pattern: RegExp) {
  const parsed = await readJson(archive, path);
  const opportunities = objectOf(parsed)?.opportunities;
  const empty = { rows: [] as OpportunityRow[], allRows: [] as OpportunityRow[], opportunityCount: 0, quoteCount: 0, truncated: false };
  if (!opportunities || typeof opportunities !== 'object' || Array.isArray(opportunities)) return empty;
  const entries = Object.entries(opportunities);
  const allRows = entries.flatMap(([key, value]) => {
    const safeKey = cleanText(key, 150);
    const ids = Array.isArray(objectOf(value)?.quote_ids)
      ? (objectOf(value)?.quote_ids as unknown[]).filter((id): id is string => typeof id === 'string' && pattern.test(id))
      : [];
    if (!safeKey || ids.length === 0) return [];
    return [{ key: safeKey, quoteIds: ids }];
  });
  return {
    rows: allRows.slice(0, CALIBRATION_QUERY_SCAN_LIMIT),
    allRows,
    opportunityCount: allRows.length,
    quoteCount: allRows.reduce((sum, row) => sum + row.quoteIds.length, 0),
    truncated: entries.length > CALIBRATION_QUERY_SCAN_LIMIT,
  };
}

async function readCaseRecord(archive: CalibrationArchive, caseId: string) {
  const parsed = objectOf(await readJson(archive, `data/cases/${caseId}.json`));
  if (!parsed || parsed.case_id !== caseId) return null;
  const vehicle = objectOf(parsed.vehicle) ?? {};
  const lines = Array.isArray(parsed.line_items) ? parsed.line_items.flatMap(readLine) : [];
  const refs = Array.isArray(parsed.photo_refs)
    ? parsed.photo_refs.filter((id): id is string => typeof id === 'string' && PHOTO_ID.test(id))
    : [];
  const archiveStatus = ARCHIVE.has(String(parsed.photo_archive_status))
    ? String(parsed.photo_archive_status) as 'not_provided' | 'pending_private_archive' | 'archived_private'
    : 'pending_private_archive';
  const observations = Array.isArray(parsed.visual_observations)
    ? parsed.visual_observations.flatMap((item) => {
      const text = cleanText(item, 240);
      return text ? [text] : [];
    })
    : [];
  const photos = await Promise.all(refs.map((id) => readPhotoSummary(archive, caseId, id)));
  const droppedObservation = Array.isArray(parsed.visual_observations)
    && observations.length !== parsed.visual_observations.length;
  const integrity = visualIntegrity(archiveStatus, refs, photos, droppedObservation || lines.length !== (Array.isArray(parsed.line_items) ? parsed.line_items.length : 0));
  return {
    id: caseId,
    make: identityText(vehicle.make, vehicle.make_evidence),
    model: identityText(vehicle.model, vehicle.model_evidence),
    year: identityYear(vehicle.year, vehicle.year_evidence),
    variant: identityText(vehicle.variant, vehicle.variant_evidence),
    makeEvidence: evidence(vehicle.make_evidence),
    modelEvidence: evidence(vehicle.model_evidence),
    yearEvidence: evidence(vehicle.year_evidence),
    archiveStatus,
    integrity,
    lineCount: lines.length,
    photoCount: refs.length,
    quotedTotalMxn: lines.reduce((sum, line) => sum + line.priceMxn, 0),
    lines,
    observations,
    photos,
    recordedAt: recordedStamp(parsed.updated_at) || recordedStamp(parsed.created_at),
  };
}

async function readPhotoSummary(archive: CalibrationArchive, caseId: string, photoId: string) {
  const manifest = await readPhotoManifest(archive, caseId, photoId);
  if (!manifest) return { id: photoId, status: 'missing' as const, bytes: null, verified: false };
  return {
    id: photoId,
    status: manifest.locator ? 'verified' as const : 'unverified' as const,
    bytes: manifest.bytes,
    verified: Boolean(manifest.locator),
  };
}

async function readPhotoManifest(archive: CalibrationArchive, caseId: string, photoId: string): Promise<{
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  bytes: number | null;
  locator: PhotoLocator | null;
} | null> {
  const path = calibrationPhotoManifestPath(caseId, photoId);
  if (!path) return null;
  const ownerCase = objectOf(await readJson(archive, `data/cases/${caseId}.json`));
  const refs = Array.isArray(ownerCase?.photo_refs) ? ownerCase.photo_refs : [];
  if (!ownerCase || ownerCase.case_id !== caseId || !refs.includes(photoId)) return null;
  const parsed = objectOf(await readJson(archive, path));
  if (!parsed || parsed.photo_id !== photoId || parsed.case_id !== caseId) return null;
  const mime = parsed.mime_type === 'image/jpeg' || parsed.mime_type === 'image/png' || parsed.mime_type === 'image/webp'
    ? parsed.mime_type
    : null;
  const sha = typeof parsed.content_sha256 === 'string' && /^[a-f0-9]{64}$/.test(parsed.content_sha256)
    ? parsed.content_sha256
    : null;
  const bytes = Number.isInteger(parsed.size_bytes) && Number(parsed.size_bytes) > 0 ? Number(parsed.size_bytes) : null;
  const publicId = typeof parsed.asset_public_id === 'string' ? parsed.asset_public_id : '';
  const version = Number(parsed.asset_version);
  const format = mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : null;
  const owned = Boolean(
    mime && sha && format
    && parsed.storage_provider === 'cloudinary'
    && parsed.storage_status === 'verified'
    && parsed.delivery_type === 'authenticated'
    && Number.isInteger(version) && version > 0
    && publicId === `pegazuz_calibration/${caseId}/${sha.slice(0, 32)}`
    && !publicId.includes('probe')
    && !publicId.includes('AF-900'),
  );
  return {
    mime: mime ?? 'image/jpeg',
    bytes,
    locator: owned && sha && format ? { publicId, version, format, sha256: sha } : null,
  };
}

async function readOpportunity(
  archive: CalibrationArchive,
  row: { key: string; quoteIds: string[] },
) {
  const revisions: NonNullable<Awaited<ReturnType<typeof readQuoteRecord>>>[] = [];
  for (const id of row.quoteIds) {
    const quote = await readQuoteRecord(archive, id);
    if (quote) revisions.push(quote);
  }
  if (revisions.length === 0) return null;
  const chainBroken = revisions.some((quote, index) => quote.revision !== index + 1);
  return {
    headQuoteId: row.quoteIds[row.quoteIds.length - 1],
    opportunityKey: row.key,
    service: revisions[revisions.length - 1]?.service ?? null,
    integrity: chainBroken || revisions.some((quote) => quote.integrity === 'incomplete') ? 'incomplete' : 'complete',
    revisions,
  };
}

async function readQuoteRecord(archive: CalibrationArchive, quoteId: string) {
  const parsed = objectOf(await readJson(archive, `data/commercial/quotes/${quoteId}.json`));
  if (!parsed || parsed.quote_id !== quoteId) return null;
  const vehicle = objectOf(parsed.vehicle) ?? {};
  const colors = objectOf(parsed.colors) ?? {};
  const prices = objectOf(parsed.prices) ?? {};
  const quoted = readPrice(objectOf(prices.quoted), true);
  const contracted = readPrice(objectOf(prices.contracted), false);
  const collected = readPrice(objectOf(prices.collected), false);
  const service = SERVICES.has(String(parsed.service)) ? String(parsed.service) : null;
  const workScope = Array.isArray(parsed.work_scope)
    ? parsed.work_scope.filter((item): item is string => typeof item === 'string' && WORK.has(item))
    : [];
  const incomplete = !service || !quoted || parsed.status !== 'human_verified';
  const identity = readPresentedIdentity(vehicle);
  return {
    id: quoteId,
    revision: Number.isInteger(parsed.revision) ? Number(parsed.revision) : null,
    service,
    ...identity,
    currentColor: identityText(colors.current, colors.current_evidence, COMMERCIAL_EVIDENCE),
    requestedColor: identityText(colors.requested, colors.requested_evidence, COMMERCIAL_EVIDENCE),
    workScope,
    quotedMxn: quoted?.amount ?? null,
    quotedValidation: quoted?.validation ?? null,
    contractedMxn: contracted?.amount ?? null,
    contractedValidation: contracted?.validation ?? null,
    collectedMxn: collected?.amount ?? null,
    collectedValidation: collected?.validation ?? null,
    integrity: incomplete ? 'incomplete' as const : 'complete' as const,
  };
}

async function readRepairOpportunity(
  archive: CalibrationArchive,
  row: { key: string; quoteIds: string[] },
) {
  const revisions: NonNullable<Awaited<ReturnType<typeof readRepairQuoteRecord>>>[] = [];
  for (const id of row.quoteIds) {
    const quote = await readRepairQuoteRecord(archive, id);
    if (quote) revisions.push(quote);
  }
  if (revisions.length === 0) return null;
  const chainBroken = revisions.some((quote, index) => quote.revision !== index + 1)
    || revisions.length !== row.quoteIds.length;
  return {
    headQuoteId: row.quoteIds[row.quoteIds.length - 1],
    evidence: 'text_only' as const,
    photoStatus: 'not_provided' as const,
    integrity: chainBroken || revisions.some((quote) => quote.integrity === 'incomplete') ? 'incomplete' as const : 'complete' as const,
    revisions,
  };
}

async function readRepairQuoteRecord(archive: CalibrationArchive, quoteId: string) {
  const parsed = objectOf(await readJson(archive, `data/repairs/quotes/${quoteId}.json`));
  if (!parsed || parsed.quote_id !== quoteId) return null;
  const vehicle = objectOf(parsed.vehicle) ?? {};
  const rawLines = Array.isArray(parsed.lines) ? parsed.lines : [];
  const lines = rawLines.flatMap(readRepairLine);
  const rawConditions = Array.isArray(parsed.conditions) ? parsed.conditions : [];
  const conditions = rawConditions.flatMap((item) => {
    const text = cleanText(item, 240);
    return text ? [text] : [];
  });
  const quotedTotal = Number(parsed.quoted_total_mxn);
  const quotedSum = lines.reduce((sum, line) => sum + line.quotedMxn, 0);
  const totalMatches = Number.isInteger(quotedTotal) && quotedTotal >= 1 && quotedTotal === quotedSum;
  const declared = parsed.evidence === 'text_only'
    && parsed.photo_status === 'not_provided'
    && parsed.status === 'human_verified'
    && Number.isInteger(parsed.revision)
    && Number(parsed.revision) >= 1;
  const dropped = lines.length !== rawLines.length || conditions.length !== rawConditions.length;
  return {
    id: quoteId,
    revision: Number.isInteger(parsed.revision) ? Number(parsed.revision) : null,
    ...readPresentedIdentity(vehicle),
    lines,
    conditions,
    quotedTotalMxn: totalMatches ? quotedTotal : null,
    integrity: declared && totalMatches && !dropped && lines.length > 0 ? 'complete' as const : 'incomplete' as const,
    recordedAt: recordedStamp(parsed.recorded_at),
  };
}

function readRepairLine(value: unknown) {
  const line = objectOf(value);
  if (!line) return [];
  const part = cleanText(line.part, 80);
  const lineId = cleanText(line.line_id, 8);
  const role = line.role === 'part' || line.role === 'labor' ? line.role : null;
  const labor = line.labor == null ? null : (REPAIR_LABOR.has(String(line.labor)) ? String(line.labor) : null);
  const prices = objectOf(line.prices);
  const quoted = readPrice(objectOf(prices?.quoted), true);
  const contracted = readPrice(objectOf(prices?.contracted), false);
  const collected = readPrice(objectOf(prices?.collected), false);
  const laborFits = role === 'part' ? labor == null && line.labor == null : role === 'labor' && labor != null;
  if (!part || !lineId || !/^L\d{2}$/.test(lineId) || !role || !laborFits || !quoted || !contracted || !collected) return [];
  return [{
    lineId,
    part,
    role,
    labor,
    quotedMxn: quoted.amount as number,
    quotedValidation: quoted.validation,
    contractedMxn: contracted.amount,
    contractedValidation: contracted.validation,
    collectedMxn: collected.amount,
    collectedValidation: collected.validation,
  }];
}

function readLine(value: unknown) {
  const line = objectOf(value);
  if (!line || line.validation !== 'human_confirmed') return [];
  const part = cleanText(line.part, 80);
  const price = Number(line.price_mxn);
  if (!part || !TREATMENTS.has(String(line.treatment)) || !Number.isInteger(price) || price < 1) return [];
  return [{
    lineId: cleanText(line.line_id, 40),
    part,
    treatment: String(line.treatment),
    priceMxn: price,
    severity: ['minor', 'moderate', 'severe', 'unknown'].includes(String(line.damage_severity))
      ? String(line.damage_severity)
      : 'unknown',
  }];
}

function readPrice(value: Record<string, unknown> | null, required: boolean): { amount: number | null; validation: string } | null {
  if (!value) return required ? null : { amount: null, validation: 'not_provided' };
  if (value.validation === 'not_provided' && value.amount_mxn == null) {
    return required ? null : { amount: null, validation: 'not_provided' };
  }
  const amount = Number(value.amount_mxn);
  if (value.validation === 'human_confirmed' && Number.isInteger(amount) && amount >= 1) {
    return { amount, validation: 'human_confirmed' };
  }
  return null;
}

function visualIntegrity(
  status: string,
  refs: string[],
  photos: { verified: boolean }[],
  dropped: boolean,
): 'complete' | 'incomplete' {
  if (dropped) return 'incomplete';
  if (status === 'not_provided') return refs.length === 0 ? 'complete' : 'incomplete';
  if (status !== 'archived_private' || refs.length === 0) return 'incomplete';
  if (photos.length > 0 && photos.some((photo) => !photo.verified)) return 'incomplete';
  return 'complete';
}

function readPresentedIdentity(vehicle: Record<string, unknown>) {
  const make = identityText(vehicle.make, vehicle.make_evidence, COMMERCIAL_EVIDENCE);
  const model = identityText(vehicle.model, vehicle.model_evidence, COMMERCIAL_EVIDENCE);
  const year = identityYear(vehicle.year, vehicle.year_evidence);
  return {
    make,
    model,
    year,
    variant: identityText(vehicle.variant, vehicle.variant_evidence, COMMERCIAL_EVIDENCE),
    presentation: presentVehicle({ make, model, year }),
  };
}

function identityText(value: unknown, evidenceValue: unknown, allowed = EVIDENCE): string | null {
  const kind = evidence(evidenceValue, allowed);
  if (kind === 'unknown') return null;
  return cleanText(value, 80);
}

function identityYear(value: unknown, evidenceValue: unknown): number | null {
  if (evidence(evidenceValue) === 'unknown') return null;
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return null;
  return year;
}

function evidence(value: unknown, allowed = EVIDENCE): string {
  return allowed.has(String(value)) ? String(value) : 'unknown';
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > max) return null;
  if (EMAIL.test(text) || PHONE.test(text) || PLATE.test(text) || hasVin(text)) return null;
  return text;
}

function hasVin(value: string): boolean {
  return value.split(/[^A-Za-z0-9]/).some((part) => (
    /^[A-HJ-NPR-Z0-9]{17}$/i.test(part) && /\d/.test(part) && /[A-Z]/i.test(part)
  ));
}

function objectOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readPage(query: QueryList, cursorPattern: RegExp): { q: string; limit: number; cursor: string | null } {
  const limit = query.limit == null || query.limit === '' ? 20 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new CalibrationQueryError('invalid');
  const cursor = query.cursor == null || query.cursor === '' ? null : String(query.cursor);
  if (cursor && !cursorPattern.test(cursor)) throw new CalibrationQueryError('invalid');
  const q = query.q == null ? '' : String(query.q).trim().toLowerCase();
  if (q.length > 80) throw new CalibrationQueryError('invalid');
  return { q, limit, cursor };
}

type OpportunityRow = { key: string; quoteIds: string[] };

type RepairWorkItem = {
  contract: 'visual' | 'repair';
  id: string;
  evidence: 'photographs' | 'text' | 'pending' | 'not_provided';
  integrity: 'complete' | 'incomplete';
  make: string | null;
  model: string | null;
  year: number | null;
  presentation?: VehiclePresentation;
  quotedTotalMxn?: number;
  quotedMxn?: number | null;
  revisionCount?: number;
  recordedAt: string;
};

function newestWindow<T>(items: T[]): T[] {
  return items.length > CALIBRATION_QUERY_SCAN_LIMIT
    ? items.slice(items.length - CALIBRATION_QUERY_SCAN_LIMIT)
    : items;
}

function caseEvidence(status: string): RepairWorkItem['evidence'] {
  if (status === 'archived_private') return 'photographs';
  if (status === 'pending_private_archive') return 'pending';
  return 'not_provided';
}

function recordedStamp(value: unknown): string {
  return typeof value === 'string' && RECORDED_STAMP.test(value) ? value : '';
}

function compareRepairWork(left: RepairWorkItem, right: RepairWorkItem): number {
  if (left.recordedAt !== right.recordedAt) return left.recordedAt < right.recordedAt ? 1 : -1;
  return left.id < right.id ? 1 : -1;
}

function withoutRecordedAt<T extends { recordedAt: string }>(record: T): Omit<T, 'recordedAt'> {
  const { recordedAt, ...visible } = record;
  void recordedAt;
  return visible;
}

function readEvidenceFilter(value: string | undefined): RepairWorkItem['evidence'] | null {
  if (value == null || value === '') return null;
  if (!EVIDENCE_FILTER.has(value)) throw new CalibrationQueryError('invalid');
  return value as RepairWorkItem['evidence'];
}

function readArchiveFilter(value: string | undefined): string | null {
  if (value == null || value === '') return null;
  if (!ARCHIVE.has(value)) throw new CalibrationQueryError('invalid');
  return value;
}

function readServiceFilter(value: string | undefined): string | null {
  if (value == null || value === '') return null;
  if (!SERVICES.has(value)) throw new CalibrationQueryError('invalid');
  return value;
}

function matchesQuery(q: string, fields: unknown[]): boolean {
  if (!q) return true;
  return fields.some((field) => String(field ?? '').toLowerCase().includes(q));
}

function paginate<T extends { id?: string; headQuoteId?: string }>(
  records: T[],
  page: { limit: number; cursor: string | null },
  truncated: boolean,
) {
  const start = page.cursor
    ? records.findIndex((record) => (record.id ?? record.headQuoteId) === page.cursor) + 1
    : 0;
  if (page.cursor && start <= 0) throw new CalibrationQueryError('invalid');
  const slice = records.slice(start, start + page.limit);
  const last = slice[slice.length - 1];
  return {
    items: slice,
    limit: page.limit,
    nextCursor: start + slice.length < records.length ? (last?.id ?? last?.headQuoteId ?? null) : null,
    truncated,
  };
}
