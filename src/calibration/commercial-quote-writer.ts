import {
  CalibrationConflictError,
  CalibrationWriteError,
  classifyGithubFailure,
  type CalibrationAccessToken,
} from './calibration-github-writer';
import {
  COMMERCIAL_QUOTE_ID,
  COMMERCIAL_SCHEMA_VERSION,
  COMMERCIAL_SOURCE_KEY,
  assertStoredCommercialQuote,
  commercialObservationFingerprint,
  reservedCommercialKey,
  type StoredCommercialQuote,
} from './commercial-quote';

/**
 * Escritura optimista solo dentro de data/commercial/. No abre el índice visual,
 * los expedientes AF ni las sondas. Una cotización ya escrita no se reescribe.
 */
export const COMMERCIAL_REPOSITORY = 'arturo2565-alt/pegazuz-calibration-data';
export const COMMERCIAL_INDEX_PATH = 'data/commercial/index.json';
const CONTENTS_PREFIX = `/repos/${COMMERCIAL_REPOSITORY}/contents/`;
const TOKEN_URL = /^https:\/\/api\.github\.com\/app\/installations\/\d{1,12}\/access_tokens$/;
const REPOSITORIES_URL = 'https://api.github.com/installation/repositories?per_page=100';
const COMMERCIAL_PATH = /^data\/commercial\/(?:index\.json|quotes\/CQ-\d{6}\.json)$/;
const BLOCKED = [
  'data/index.json',
  'data/cases/',
  'data/photos/',
  'data/probes',
  'AF-000001',
  'AF-000002',
  'AF-000003',
  'AF-900000',
  'AF-900001',
  'cal008-probe',
  'cal010-probe',
];

export type CommercialOpportunity = {
  root_quote_id: string;
  head_quote_id: string;
  quote_ids: string[];
};

export type CommercialIndex = {
  schema_version: typeof COMMERCIAL_SCHEMA_VERSION;
  archive: 'commercial';
  opportunities: Record<string, CommercialOpportunity>;
  source_keys: Record<string, string>;
};

export type CommercialWriteResult =
  | { status: 'created'; quoteId: string; quoteCommit: string; indexCommit: string }
  | { status: 'already_exists'; quoteId: string }
  | { status: 'partial'; quoteId: string; quoteCommit: string; reason: string };

export interface CommercialArchive {
  readIndex(): Promise<CommercialIndex>;
  readQuote(quoteId: string): Promise<Record<string, unknown> | null>;
  insert(document: StoredCommercialQuote): Promise<CommercialWriteResult>;
  reconcile(quoteId: string): Promise<CommercialWriteResult>;
}

type GithubFile = { content: string; sha: string };
type GithubWrite = { commit: { sha: string } };

export function emptyCommercialIndex(): CommercialIndex {
  return {
    schema_version: COMMERCIAL_SCHEMA_VERSION,
    archive: 'commercial',
    opportunities: {},
    source_keys: {},
  };
}

export function commercialQuotePath(quoteId: string): string {
  if (!COMMERCIAL_QUOTE_ID.test(quoteId)) {
    throw new CalibrationConflictError('Invalid commercial quote id');
  }
  return `data/commercial/quotes/${quoteId}.json`;
}

export function assertCommercialRequestPath(path: string): void {
  const bare = path.split('?')[0];
  if (BLOCKED.some((needle) => bare.includes(needle)) || !COMMERCIAL_PATH.test(bare)) {
    throw new CalibrationConflictError('Commercial import refused a visual path');
  }
}

export function assertCommercialTransport(rawUrl: string, method: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CalibrationConflictError('Commercial import refused a visual path');
  }
  const verb = method.toUpperCase();
  if (verb === 'POST' && TOKEN_URL.test(`${url.origin}${url.pathname}`) && url.search === '') return;
  if (verb === 'GET' && rawUrl === REPOSITORIES_URL) return;
  if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' || !url.pathname.startsWith(CONTENTS_PREFIX)) {
    throw new CalibrationConflictError('Commercial import refused a visual path');
  }
  if (verb === 'GET' && url.search !== '?ref=main') {
    throw new CalibrationConflictError('Commercial import refused a visual path');
  }
  if (verb === 'PUT' && url.search !== '') {
    throw new CalibrationConflictError('Commercial import refused a visual path');
  }
  if (verb !== 'GET' && verb !== 'PUT') {
    throw new CalibrationConflictError('Commercial import refused a visual path');
  }
  assertCommercialRequestPath(decodeURIComponent(url.pathname.slice(CONTENTS_PREFIX.length)));
}

export function parseCommercialIndex(content: string): CommercialIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new CalibrationWriteError('Invalid commercial index');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CalibrationWriteError('Invalid commercial index');
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema_version !== COMMERCIAL_SCHEMA_VERSION || record.archive !== 'commercial') {
    throw new CalibrationWriteError('Invalid commercial index');
  }
  if ('cases' in record || 'photo_refs' in record) {
    throw new CalibrationWriteError('Invalid commercial index');
  }
  if (!isRecord(record.opportunities) || !isRecord(record.source_keys)) {
    throw new CalibrationWriteError('Invalid commercial index');
  }
  const index = emptyCommercialIndex();
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(record.opportunities)) {
    if (!COMMERCIAL_SOURCE_KEY.test(key) || reservedCommercialKey(key) || !isRecord(value)) {
      throw new CalibrationWriteError('Invalid commercial index');
    }
    const ids = value.quote_ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || !COMMERCIAL_QUOTE_ID.test(id))) {
      throw new CalibrationWriteError('Invalid commercial index');
    }
    if (value.root_quote_id !== ids[0] || value.head_quote_id !== ids[ids.length - 1]) {
      throw new CalibrationWriteError('Invalid commercial index');
    }
    if (new Set(ids).size !== ids.length) throw new CalibrationWriteError('Invalid commercial index');
    for (const id of ids) {
      if (seen.has(id)) throw new CalibrationWriteError('Invalid commercial index');
      seen.add(id);
    }
    index.opportunities[key] = {
      root_quote_id: ids[0] as string,
      head_quote_id: ids[ids.length - 1] as string,
      quote_ids: [...ids] as string[],
    };
  }
  for (const [key, id] of Object.entries(record.source_keys)) {
    if (!COMMERCIAL_SOURCE_KEY.test(key) || reservedCommercialKey(key) || typeof id !== 'string' || !seen.has(id)) {
      throw new CalibrationWriteError('Invalid commercial index');
    }
    index.source_keys[key] = id;
  }
  const indexed = new Set(Object.values(index.source_keys));
  if (indexed.size !== seen.size) throw new CalibrationWriteError('Invalid commercial index');
  for (const id of seen) {
    if (!indexed.has(id)) throw new CalibrationWriteError('Invalid commercial index');
  }
  return index;
}

export function commercialCounts(index: CommercialIndex): { opportunityCount: number; quoteCount: number } {
  return {
    opportunityCount: Object.keys(index.opportunities).length,
    quoteCount: Object.keys(index.source_keys).length,
  };
}

export class CommercialGithubWriter implements CommercialArchive {
  constructor(
    private readonly credential: string | CalibrationAccessToken,
    private readonly transport: typeof fetch = fetch,
    private readonly repository = COMMERCIAL_REPOSITORY,
  ) {
    if (typeof credential === 'string' && !credential.trim()) {
      throw new Error('Missing calibration GitHub credential');
    }
    if (this.repository !== COMMERCIAL_REPOSITORY) {
      throw new Error('Calibration GitHub repository is not allowed');
    }
  }

  async readIndex(): Promise<CommercialIndex> {
    const file = await this.read(COMMERCIAL_INDEX_PATH);
    if (!file) return emptyCommercialIndex();
    return parseCommercialIndex(file.content);
  }

  async readQuote(quoteId: string): Promise<Record<string, unknown> | null> {
    const file = await this.read(commercialQuotePath(quoteId));
    if (!file) return null;
    return JSON.parse(file.content) as Record<string, unknown>;
  }

  async insert(document: StoredCommercialQuote): Promise<CommercialWriteResult> {
    const stored = assertStoredCommercialQuote(document);
    const indexFile = await this.read(COMMERCIAL_INDEX_PATH);
    const index = indexFile ? parseCommercialIndex(indexFile.content) : emptyCommercialIndex();
    const existing = index.source_keys[stored.source.source_case_key];
    if (existing) {
      if (existing !== stored.quote_id) {
        throw new CalibrationConflictError('Source key references a different quote');
      }
      const current = await this.read(commercialQuotePath(existing));
      const parsed = current ? JSON.parse(current.content) as Record<string, unknown> : null;
      if (!parsed || commercialObservationFingerprint(parsed) !== commercialObservationFingerprint(stored)) {
        throw new CalibrationConflictError('Source key already records a different observation');
      }
      return { status: 'already_exists', quoteId: existing };
    }
    if (quoteIsAssigned(index, stored.quote_id)) {
      throw new CalibrationConflictError('Quote ID already assigned');
    }
    const quotePath = commercialQuotePath(stored.quote_id);
    const orphan = await this.read(quotePath);
    if (orphan) return this.keepOrphan(index, indexFile?.sha, stored, orphan.content);
    assertLinkable(index, stored);
    const quoteCommit = await this.save(quotePath, canonical(stored), `commercial: record ${stored.quote_id}`);
    applyLink(index, stored);
    return this.finishIndex(index, indexFile?.sha, stored.quote_id, quoteCommit, `commercial: index ${stored.quote_id}`);
  }

  async reconcile(quoteId: string): Promise<CommercialWriteResult> {
    const path = commercialQuotePath(quoteId);
    const quoteFile = await this.read(path);
    if (!quoteFile) throw new CalibrationWriteError('Missing quote file for reconciliation');
    const stored = assertStoredCommercialQuote(JSON.parse(quoteFile.content));
    if (stored.quote_id !== quoteId) {
      throw new CalibrationConflictError('Existing unindexed quote differs');
    }
    const indexFile = await this.read(COMMERCIAL_INDEX_PATH);
    const index = indexFile ? parseCommercialIndex(indexFile.content) : emptyCommercialIndex();
    const indexed = index.source_keys[stored.source.source_case_key];
    if (indexed && indexed !== quoteId) {
      throw new CalibrationConflictError('Source key references a different quote');
    }
    const opportunity = index.opportunities[stored.source.opportunity_key];
    if (opportunity?.quote_ids.includes(quoteId) && indexed === quoteId) {
      return { status: 'already_exists', quoteId };
    }
    assertLinkable(index, stored);
    applyLink(index, stored);
    const indexCommit = await this.save(
      COMMERCIAL_INDEX_PATH,
      canonical(index),
      `commercial: reconcile ${quoteId}`,
      indexFile?.sha,
    );
    return { status: 'created', quoteId, quoteCommit: 'pre-existing', indexCommit };
  }

  private async keepOrphan(
    index: CommercialIndex,
    indexSha: string | undefined,
    incoming: StoredCommercialQuote,
    content: string,
  ): Promise<CommercialWriteResult> {
    const stored = assertStoredCommercialQuote(JSON.parse(content));
    if (
      stored.quote_id !== incoming.quote_id
      || stored.source.source_case_key !== incoming.source.source_case_key
      || commercialObservationFingerprint(stored) !== commercialObservationFingerprint(incoming)
    ) {
      throw new CalibrationConflictError('Existing unindexed quote differs');
    }
    assertLinkable(index, stored);
    applyLink(index, stored);
    const indexCommit = await this.save(
      COMMERCIAL_INDEX_PATH,
      canonical(index),
      `commercial: reconcile orphan ${stored.quote_id}`,
      indexSha,
    );
    return { status: 'created', quoteId: stored.quote_id, quoteCommit: 'pre-existing', indexCommit };
  }

  private async finishIndex(
    index: CommercialIndex,
    indexSha: string | undefined,
    quoteId: string,
    quoteCommit: string,
    message: string,
  ): Promise<CommercialWriteResult> {
    try {
      const indexCommit = await this.save(COMMERCIAL_INDEX_PATH, canonical(index), message, indexSha);
      return { status: 'created', quoteId, quoteCommit, indexCommit };
    } catch (err) {
      if (
        err instanceof CalibrationWriteError
        && (err.kind === 'conflict' || err.kind === 'transient' || err.kind === 'rate_limit')
      ) {
        return { status: 'partial', quoteId, quoteCommit, reason: 'Index update requires reconciliation' };
      }
      throw err;
    }
  }

  private async read(path: string): Promise<GithubFile | null> {
    assertCommercialRequestPath(path);
    const result = await this.request<{ content: string; sha: string }>('GET', path);
    if (!result) return null;
    return {
      sha: result.sha,
      content: Buffer.from(result.content.replace(/\s/g, ''), 'base64').toString('utf8'),
    };
  }

  private async save(path: string, content: string, message: string, sha?: string): Promise<string> {
    assertCommercialRequestPath(path);
    const payload = { message, content: Buffer.from(content, 'utf8').toString('base64'), branch: 'main', ...(sha ? { sha } : {}) };
    try {
      const response = await this.request<GithubWrite>('PUT', path, payload);
      if (!response?.commit?.sha) throw new CalibrationWriteError('Missing commit receipt');
      return response.commit.sha;
    } catch (err) {
      if (!sha && err instanceof CalibrationWriteError && err.kind === 'occupied') {
        throw new CalibrationConflictError('Quote file already exists');
      }
      throw err;
    }
  }

  private async request<T>(method: 'GET' | 'PUT', path: string, body?: object): Promise<T | null> {
    return this.dispatch(method, path, body, false);
  }

  private async dispatch<T>(
    method: 'GET' | 'PUT',
    path: string,
    body: object | undefined,
    refreshed: boolean,
  ): Promise<T | null> {
    const bare = path.split('?')[0];
    const url = `https://api.github.com/repos/${this.repository}/contents/${bare}${method === 'GET' ? '?ref=main' : ''}`;
    assertCommercialTransport(url, method);
    const response = await this.transport(url, {
      method,
      headers: {
        Authorization: await this.authorization(),
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 401 && !refreshed && typeof this.credential !== 'string') {
      this.credential.invalidate();
      return this.dispatch(method, path, body, true);
    }
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) {
      const detail = await readGithubErrorMessage(response);
      throw new CalibrationWriteError(
        `GitHub ${method} returned ${response.status}`,
        response.status,
        classifyGithubFailure(response.status, detail),
      );
    }
    return await response.json() as T;
  }

  private async authorization(): Promise<string> {
    const value = typeof this.credential === 'string' ? this.credential : await this.credential.authorization();
    const token = value.trim();
    if (!token || /\s/.test(token)) throw new Error('Missing calibration GitHub credential');
    return `Bearer ${token}`;
  }
}

function quoteIsAssigned(index: CommercialIndex, quoteId: string): boolean {
  return Object.values(index.opportunities).some((item) => item.quote_ids.includes(quoteId))
    || Object.values(index.source_keys).includes(quoteId);
}

function ownerOf(index: CommercialIndex, quoteId: string | null): string | null {
  if (!quoteId) return null;
  for (const [key, item] of Object.entries(index.opportunities)) {
    if (item.quote_ids.includes(quoteId)) return key;
  }
  return null;
}

function assertLinkable(index: CommercialIndex, document: StoredCommercialQuote): void {
  const key = document.source.opportunity_key;
  const prior = document.source.prior_quote_id;
  const current = index.opportunities[key];
  const owner = ownerOf(index, prior);
  if (prior && !owner) throw new CalibrationConflictError('The previous observation does not exist');
  if (prior && owner !== key) {
    throw new CalibrationConflictError('The previous observation belongs to another opportunity');
  }
  if (!current) {
    if (prior) throw new CalibrationConflictError('The previous observation does not exist');
    if (document.revision !== 1) throw new CalibrationConflictError('Revision sequence is invalid');
    return;
  }
  if (current.quote_ids.includes(document.quote_id)) {
    if (current.quote_ids[document.revision - 1] !== document.quote_id) {
      throw new CalibrationConflictError('Revision sequence is invalid');
    }
    return;
  }
  if (prior !== current.head_quote_id) {
    throw new CalibrationConflictError(
      prior
        ? 'A revision must extend the latest observation'
        : 'An opportunity revision must name its previous observation',
    );
  }
  if (document.revision !== current.quote_ids.length + 1) {
    throw new CalibrationConflictError('Revision sequence is invalid');
  }
}

function applyLink(index: CommercialIndex, document: StoredCommercialQuote): void {
  assertLinkable(index, document);
  const key = document.source.opportunity_key;
  const id = document.quote_id;
  const sourceKey = document.source.source_case_key;
  const current = index.opportunities[key];
  if (!current) {
    index.opportunities[key] = { root_quote_id: id, head_quote_id: id, quote_ids: [id] };
  } else if (!current.quote_ids.includes(id)) {
    current.quote_ids = [...current.quote_ids, id];
    current.head_quote_id = id;
  }
  const indexed = index.source_keys[sourceKey];
  if (indexed && indexed !== id) throw new CalibrationConflictError('Source key references a different quote');
  index.source_keys[sourceKey] = id;
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readGithubErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { message?: unknown };
    return typeof payload.message === 'string' ? payload.message.slice(0, 300) : '';
  } catch {
    return '';
  }
}
