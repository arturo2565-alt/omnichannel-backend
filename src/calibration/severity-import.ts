import { SeverityError, SeverityGithub, describeSeverityLine, importSeverityProposal, type SeverityFiles, type SeverityLevel } from './severity-annotation';

/**
 * La anotación es opcional. Si el expediente ya quedó guardado y la escritura
 * de la anotación falla, la importación sigue en pie y el informe queda
 * pendiente: un reintento completa solo esa anotación. No queda enriquecida
 * mientras la severidad pedida no esté registrada. Nunca valida.
 */

const HISTORICAL = new Set(['AF-000001', 'AF-000002', 'AF-000003']);
const BANNED = new Set([
  'validated', 'operatorrole', 'operator_role', 'authorization', 'actorkey', 'actor_key',
  'humanvalidated', 'human_validated', 'confirmation', 'price', 'price_mxn', 'pricemxn',
]);
const ASSESSMENTS = new Set(['visual_inference', 'human_declaration', 'insufficient_evidence']);

export type SeverityRequest = {
  lineId: string;
  assessment: 'visual_inference' | 'human_declaration' | 'insufficient_evidence';
  level?: SeverityLevel | null;
};

export type SeverityItemReport = {
  lineId: string;
  zoneId: string | null;
  status: 'recorded' | 'already_recorded' | 'pending' | 'conflict' | 'rejected';
  annotationId?: string;
};

export type SeverityImportReport = {
  status: SeverityItemReport['status'];
  enriched: false | true;
  subjectId: string;
  items: SeverityItemReport[];
};

export function separateSeverityImport(input: unknown): { document: unknown; severity: unknown } {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.prototype.hasOwnProperty.call(input, 'severity')) {
    return { document: input, severity: undefined };
  }
  const document = { ...(input as Record<string, unknown>) };
  const severity = document.severity;
  delete document.severity;
  return { document, severity };
}

export function readSeverityRequests(value: unknown): SeverityRequest[] | null {
  if (value == null) return null;
  if (claimsAuthority(value)) throw new SeverityError('rejected');
  if (!Array.isArray(value)) throw new SeverityError('invalid');
  if (value.length === 0) return null;
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new SeverityError('invalid');
    const record = item as Record<string, unknown>;
    const assessment = record.assessment;
    if (typeof record.lineId !== 'string' || typeof assessment !== 'string' || !ASSESSMENTS.has(assessment)) {
      throw new SeverityError('invalid');
    }
    if (assessment === 'insufficient_evidence' && record.level != null) throw new SeverityError('rejected');
    return {
      lineId: record.lineId,
      assessment: assessment as SeverityRequest['assessment'],
      level: record.level as SeverityLevel | null | undefined,
    };
  });
}

export async function applySeverityImport(
  files: SeverityFiles,
  subjectId: string,
  requests: readonly SeverityRequest[],
): Promise<SeverityImportReport> {
  if (subjectId.startsWith('CQ-') || HISTORICAL.has(subjectId)) {
    return summarize(subjectId, requests.map((item) => ({ lineId: item.lineId, zoneId: null, status: 'rejected' })));
  }
  const items: Array<SeverityItemReport & { request?: SeverityRequest; write?: boolean }> = [];
  const byZone = new Map<string, number>();
  for (const request of requests) {
    try {
      const target = await describeSeverityLine(files, subjectId, request.lineId);
      const lead = byZone.get(target.zoneId);
      if (lead == null) {
        byZone.set(target.zoneId, items.length);
        items.push({ lineId: request.lineId, zoneId: target.zoneId, status: 'pending', request, write: true });
        continue;
      }
      const current = items[lead];
      const same = current.request?.assessment === request.assessment && current.request?.level === request.level;
      if (!same) current.write = false;
      items.push({
        lineId: request.lineId,
        zoneId: target.zoneId,
        status: same ? 'pending' : 'conflict',
        write: false,
      });
      if (!same) current.status = 'conflict';
    } catch (err) {
      const code = err instanceof SeverityError ? err.code : '';
      items.push({
        lineId: request.lineId,
        zoneId: null,
        status: code === 'rejected' || code === 'missing' || code === 'invalid' ? 'rejected' : 'pending',
      });
    }
  }
  for (const item of items) {
    if (!item.write || !item.request || item.status === 'conflict') continue;
    try {
      const saved = await importSeverityProposal(files, {
        subjectId,
        lineId: item.lineId,
        assessment: item.request.assessment,
        level: item.request.level,
      });
      for (const sibling of items) {
        if (sibling.zoneId === item.zoneId && sibling.status === 'pending') {
          sibling.status = saved.status;
          sibling.annotationId = saved.annotationId;
        }
      }
    } catch {
      item.status = 'pending';
    }
  }
  return summarize(subjectId, items.map(({ lineId, zoneId, status, annotationId }) => ({ lineId, zoneId, status, annotationId })));
}

export function openImportedSeverityFiles(
  transport: typeof fetch,
  authorization: () => Promise<string>,
): SeverityFiles {
  return new SeverityGithub(transport, authorization);
}

function summarize(subjectId: string, items: SeverityItemReport[]): SeverityImportReport {
  const statuses = new Set(items.map((item) => item.status));
  const status = statuses.has('pending')
    ? 'pending'
    : statuses.has('conflict')
      ? 'conflict'
      : statuses.has('rejected')
        ? 'rejected'
        : statuses.has('recorded')
          ? 'recorded'
          : 'already_recorded';
  const enriched = items.length > 0 && items.every((item) => item.status === 'recorded' || item.status === 'already_recorded');
  return { status, enriched, subjectId, items };
}

function claimsAuthority(value: unknown, key = ''): boolean {
  if (BANNED.has(key.toLowerCase())) return true;
  if (Array.isArray(value)) return value.some((item) => claimsAuthority(item));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([nested, item]) => claimsAuthority(item, nested));
}
