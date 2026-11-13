import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CALIBRATION_DIAGNOSTIC_ENVIRONMENT_ID,
  CALIBRATION_DIAGNOSTIC_PROJECT_ID,
  CALIBRATION_DIAGNOSTIC_SERVICE_ID,
} from './calibration-diagnose';
import { CalibrationConflictError } from './calibration-github-writer';
import { CalibrationValidationError } from './calibration-case';
import {
  commercialObservationFingerprint,
  validateCommercialQuote,
} from './commercial-quote';
import {
  commercialContentsGrantIsExpected,
  importCommercialQuote,
  importCommercialQuoteFile,
  readCommercialQuoteFile,
} from './commercial-quote-import';
import { nextCommercialQuoteId, recordCommercialObservation } from './commercial-quote-store';
import {
  CommercialGithubWriter,
  assertCommercialRequestPath,
  assertCommercialTransport,
  type CommercialIndex,
} from './commercial-quote-writer';

const CLOCK = '2026-11-13T20:00:00.000Z';
const OPPORTUNITY = 'autofix-oportunidad-20261113-exterior-001';
const SOURCE = 'autofix-comercial-20261113-exterior-001';
const SEALED = {
  'data/index.json': '{"cases":{"AF-000001":"x","AF-000002":"x","AF-000003":"x"}}',
  'data/cases/AF-000001.json': '{"case_id":"AF-000001"}',
  'data/cases/AF-000002.json': '{"case_id":"AF-000002"}',
  'data/cases/AF-000003.json': '{"case_id":"AF-000003"}',
  'data/probes/index.json': '{"archive":"probe","cases":{"AF-900000":"y","AF-900001":"y"}}',
};

function stagingEnv(patch: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    RAILWAY_ENVIRONMENT_NAME: 'staging',
    RAILWAY_SERVICE_NAME: 'pegazuz-backend-staging',
    RAILWAY_PROJECT_ID: CALIBRATION_DIAGNOSTIC_PROJECT_ID,
    RAILWAY_ENVIRONMENT_ID: CALIBRATION_DIAGNOSTIC_ENVIRONMENT_ID,
    RAILWAY_SERVICE_ID: CALIBRATION_DIAGNOSTIC_SERVICE_ID,
    CALIBRATION_INGEST_ENABLED: 'false',
    DB_SYNCHRONIZE: 'false',
    ...patch,
  };
}

function vehicle(patch: Record<string, unknown> = {}) {
  return {
    make: 'Mazda',
    make_evidence: 'customer_provided',
    model: '3',
    model_evidence: 'customer_provided',
    year: 2019,
    year_evidence: 'customer_provided',
    variant: 'Sedan',
    variant_evidence: 'customer_provided',
    ...patch,
  };
}

function colors(patch: Record<string, unknown> = {}) {
  return {
    current: null,
    current_evidence: 'unknown',
    requested: null,
    requested_evidence: 'unknown',
    ...patch,
  };
}

function exterior(patch: {
  source?: Record<string, unknown>;
  vehicle?: Record<string, unknown>;
  service?: string;
  colors?: Record<string, unknown>;
  work_scope?: string[];
  prices?: Record<string, unknown>;
  images?: unknown;
  photo_refs?: unknown;
} = {}) {
  const input: Record<string, unknown> = {
    schema_version: '1.0.0',
    status: 'human_verified',
    source: {
      kind: 'autofix_human_commercial_quote',
      source_case_key: SOURCE,
      opportunity_key: OPPORTUNITY,
      prior_quote_id: null,
      quoted_at: null,
      ...patch.source,
    },
    vehicle: vehicle(patch.vehicle),
    service: patch.service ?? 'exterior_bath',
    colors: colors(patch.colors),
    work_scope: patch.work_scope ?? [],
    prices: {
      quoted: { amount_mxn: 28000, validation: 'human_confirmed' },
      ...patch.prices,
    },
  };
  if ('images' in patch) input.images = patch.images;
  if ('photo_refs' in patch) input.photo_refs = patch.photo_refs;
  return input;
}

function response(status: number, value: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => value } as Response;
}

function memoryTransport(failIndexPuts = 0) {
  const files = new Map<string, { text: string; sha: string }>();
  const calls: string[] = [];
  let serial = 1;
  const fetch = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push(`${method} ${url}`);
    const marker = '/contents/';
    const start = url.indexOf(marker);
    const path = decodeURIComponent(url.slice(start + marker.length).split('?')[0]);
    if (!path.startsWith('data/commercial/')) throw new Error(`visual path ${path}`);
    if (method === 'GET') {
      const file = files.get(path);
      if (!file) return response(404, { message: 'Not Found' });
      return response(200, { sha: file.sha, content: Buffer.from(file.text).toString('base64') });
    }
    const body = JSON.parse(init?.body ?? '{}') as { content?: string; sha?: string };
    if (path.endsWith('index.json') && failIndexPuts > 0) {
      failIndexPuts -= 1;
      return response(409, { message: 'Conflict' });
    }
    const existing = files.get(path);
    if (existing && body.sha !== existing.sha) return response(409, { message: 'Conflict' });
    if (existing && !body.sha) return response(422, { message: 'sha wasn\'t supplied' });
    if (!existing && body.sha) return response(409, { message: 'Conflict' });
    const text = Buffer.from(body.content ?? '', 'base64').toString('utf8');
    const sha = `commit-${serial}`;
    serial += 1;
    files.set(path, { text, sha });
    return response(201, { commit: { sha } });
  });
  return { fetch: fetch as unknown as typeof fetch, files, calls };
}

function open(failIndexPuts = 0) {
  const transport = memoryTransport(failIndexPuts);
  const writer = new CommercialGithubWriter('test-token', transport.fetch);
  const record = (input: unknown, clock = () => CLOCK) => recordCommercialObservation(writer, input, clock);
  return { transport, writer, record };
}

function quoteText(files: Map<string, { text: string }>, quoteId: string): string {
  const file = files.get(`data/commercial/quotes/${quoteId}.json`);
  if (!file) throw new Error(`missing ${quoteId}`);
  return file.text;
}

function quoteOf(files: Map<string, { text: string }>, quoteId: string): Record<string, unknown> {
  return JSON.parse(quoteText(files, quoteId)) as Record<string, unknown>;
}

function indexOf(files: Map<string, { text: string }>): CommercialIndex {
  const file = files.get('data/commercial/index.json');
  if (!file) throw new Error('missing commercial index');
  return JSON.parse(file.text) as CommercialIndex;
}

function quotePuts(calls: string[]): number {
  return calls.filter((call) => call.startsWith('PUT ') && call.includes('/quotes/')).length;
}

describe('CAL-015A commercial quote contract', () => {
  it('accepts an exterior bath without photographs and does not infer a collected price', () => {
    const quote = validateCommercialQuote(exterior());
    expect(quote.service).toBe('exterior_bath');
    expect(quote.work_scope).toEqual([]);
    expect(quote.colors.requested).toBeNull();
    expect(quote.prices.quoted).toEqual({ amount_mxn: 28000, validation: 'human_confirmed' });
    expect(quote.prices.contracted).toEqual({ amount_mxn: null, validation: 'not_provided' });
    expect(quote.prices.collected).toEqual({ amount_mxn: null, validation: 'not_provided' });
    expect(quote.prices.collected.amount_mxn).not.toBe(quote.prices.quoted.amount_mxn);
  });

  it('keeps each price validation independent', () => {
    const quote = validateCommercialQuote(exterior({
      prices: {
        quoted: { amount_mxn: 28000, validation: 'human_confirmed' },
        contracted: { amount_mxn: 27000, validation: 'human_confirmed' },
        collected: { amount_mxn: 25000, validation: 'human_confirmed' },
      },
    }));
    expect(quote.prices.quoted.validation).toBe('human_confirmed');
    expect(quote.prices.contracted.amount_mxn).toBe(27000);
    expect(quote.prices.collected.amount_mxn).toBe(25000);
    expect(() => validateCommercialQuote(exterior({
      prices: { collected: { amount_mxn: 28000 } },
    }))).toThrow(CalibrationValidationError);
    try {
      validateCommercialQuote(exterior({ prices: { collected: { amount_mxn: 28000 } } }));
    } catch (err) {
      expect(err).toMatchObject({ code: 'unauthorized_price' });
    }
    expect(() => validateCommercialQuote(exterior({
      prices: { contracted: { amount_mxn: 27000, validation: 'not_provided' } },
    }))).toThrow('unconfirmed price');
  });

  it('accepts a bath with bodywork only when bodywork is declared', () => {
    const quote = validateCommercialQuote(exterior({
      service: 'bath_with_bodywork',
      work_scope: ['bodywork'],
      colors: { current: 'blanco', current_evidence: 'customer_provided' },
      source: {
        source_case_key: 'autofix-comercial-20261113-hojalateria-001',
        opportunity_key: 'autofix-oportunidad-20261113-hojalateria-001',
      },
    }));
    expect(quote.service).toBe('bath_with_bodywork');
    expect(quote.work_scope).toEqual(['bodywork']);
    expect(quote.colors.current).toBe('blanco');
    expect(quote.colors.requested).toBeNull();
    expect(() => validateCommercialQuote(exterior({ service: 'bath_with_bodywork' }))).toThrow('must include bodywork');
    expect(() => validateCommercialQuote(exterior({
      service: 'bath_with_bodywork',
      work_scope: ['bodywork'],
      colors: { requested: 'negro', requested_evidence: 'customer_provided' },
    }))).toThrow('color change');
  });

  it('requires the requested color for a color change and stores only declared work', () => {
    const quote = validateCommercialQuote(exterior({
      service: 'color_change',
      work_scope: ['interior_frames', 'disassembly'],
      colors: { requested: 'gris oscuro', requested_evidence: 'customer_provided' },
      vehicle: {
        make: null,
        make_evidence: 'unknown',
        model: null,
        model_evidence: 'unknown',
        year: null,
        year_evidence: 'unknown',
        variant: null,
        variant_evidence: 'unknown',
      },
      source: {
        source_case_key: 'autofix-comercial-20261113-color-001',
        opportunity_key: 'autofix-oportunidad-20261113-color-001',
      },
      prices: { quoted: { amount_mxn: 47000, validation: 'human_confirmed' } },
    }));
    expect(quote.service).toBe('color_change');
    expect(quote.colors.requested).toBe('gris oscuro');
    expect(quote.colors.current).toBeNull();
    expect(quote.work_scope).toEqual(['disassembly', 'interior_frames']);
    expect(quote.vehicle.make).toBeNull();
    expect(() => validateCommercialQuote(exterior({ service: 'color_change' }))).toThrow('requires the requested color');
  });

  it('accepts an incomplete vehicle and rejects invented identity', () => {
    const quote = validateCommercialQuote(exterior({
      vehicle: {
        model: null,
        model_evidence: 'unknown',
        year: null,
        year_evidence: 'unknown',
        variant: null,
        variant_evidence: 'unknown',
      },
    }));
    expect(quote.vehicle.make).toBe('Mazda');
    expect(quote.vehicle.model).toBeNull();
    expect(quote.vehicle.year).toBeNull();
    expect(() => validateCommercialQuote(exterior({
      vehicle: { model: '3', model_evidence: 'unknown' },
    }))).toThrow(CalibrationValidationError);
    expect(() => validateCommercialQuote(exterior({
      vehicle: { make_evidence: 'visual_inference' },
    }))).toThrow('without a visual expediente');
  });

  it('rejects photographs, personal data, undeclared work and reserved keys', () => {
    expect(() => validateCommercialQuote(exterior({ images: [] }))).toThrow('does not accept photographs');
    expect(() => validateCommercialQuote(exterior({ photo_refs: [] }))).toThrow('does not accept photographs');
    expect(() => validateCommercialQuote(exterior({ colors: { current: '551234567890', current_evidence: 'customer_provided' } }))).toThrow(CalibrationValidationError);
    expect(() => validateCommercialQuote({ ...exterior(), nombre: 'Ana' })).toThrow('personal data');
    expect(() => validateCommercialQuote(exterior({ vehicle: { variant: 'ABC-123-A', variant_evidence: 'customer_provided' } }))).toThrow('personal data');
    expect(() => validateCommercialQuote(exterior({ work_scope: ['ceramic'] }))).toThrow('undeclared job');
    expect(() => validateCommercialQuote(exterior({ source: { source_case_key: 'probe-cal-009d-001' } }))).toThrow('stable commercial key');
    expect(() => validateCommercialQuote(exterior({ work_scope: ['bodywork'] }))).toThrow('Bodywork belongs');
    const forward = validateCommercialQuote(exterior({ service: 'color_change', work_scope: ['interior_frames', 'disassembly'], colors: { requested: 'gris', requested_evidence: 'customer_provided' } }));
    const reverse = validateCommercialQuote(exterior({ service: 'color_change', work_scope: ['disassembly', 'interior_frames'], colors: { requested: 'gris', requested_evidence: 'customer_provided' } }));
    expect(commercialObservationFingerprint(forward)).toBe(commercialObservationFingerprint(reverse));
  });

  it('allocates CQ identifiers without reading AF identifiers', () => {
    expect(nextCommercialQuoteId(['AF-000001', 'AF-000002', 'AF-000003', 'AF-900000', 'AF-900001'])).toBe('CQ-000001');
    expect(nextCommercialQuoteId(['CQ-000004', 'AF-000009'])).toBe('CQ-000005');
  });
});

describe('CAL-015A commercial archive', () => {
  const sealed = { ...SEALED };

  it('stores exterior, bodywork and color change as separate opportunities', async () => {
    const { transport, record } = open();
    await record(exterior());
    await record(exterior({
      service: 'bath_with_bodywork',
      work_scope: ['bodywork'],
      colors: { current: 'blanco', current_evidence: 'customer_provided' },
      source: {
        source_case_key: 'autofix-comercial-20261113-hojalateria-001',
        opportunity_key: 'autofix-oportunidad-20261113-hojalateria-001',
      },
      prices: { quoted: { amount_mxn: 35000, validation: 'human_confirmed' } },
    }));
    await record(exterior({
      service: 'color_change',
      work_scope: ['interior_frames', 'disassembly'],
      colors: { requested: 'gris oscuro', requested_evidence: 'customer_provided' },
      vehicle: {
        make: null,
        make_evidence: 'unknown',
        model: null,
        model_evidence: 'unknown',
        year: null,
        year_evidence: 'unknown',
        variant: null,
        variant_evidence: 'unknown',
      },
      source: {
        source_case_key: 'autofix-comercial-20261113-color-001',
        opportunity_key: 'autofix-oportunidad-20261113-color-001',
      },
      prices: { quoted: { amount_mxn: 47000, validation: 'human_confirmed' } },
    }));
    const index = indexOf(transport.files);
    expect(Object.keys(index.opportunities)).toHaveLength(3);
    expect(Object.keys(index.source_keys)).toHaveLength(3);
    expect(quoteOf(transport.files, 'CQ-000001').service).toBe('exterior_bath');
    expect(quoteOf(transport.files, 'CQ-000002')).toMatchObject({
      service: 'bath_with_bodywork',
      work_scope: ['bodywork'],
      prices: { collected: { amount_mxn: null, validation: 'not_provided' } },
    });
    expect(quoteOf(transport.files, 'CQ-000003')).toMatchObject({
      service: 'color_change',
      vehicle: { make: null, make_evidence: 'unknown', year: null },
      colors: { requested: 'gris oscuro', requested_evidence: 'customer_provided' },
      work_scope: ['disassembly', 'interior_frames'],
    });
    expect(transport.calls.some((call) => call.includes('data/cases') || call.includes('data/probes'))).toBe(false);
  });

  it('stores an exterior bath apart from the visual index', async () => {
    const { transport, record } = open();
    const created = await record(exterior());
    expect(created).toMatchObject({
      status: 'created',
      quoteId: 'CQ-000001',
      opportunityKey: OPPORTUNITY,
      revision: 1,
      opportunityCount: 1,
      quoteCount: 1,
    });
    expect(quoteOf(transport.files, 'CQ-000001')).toMatchObject({
      quote_id: 'CQ-000001',
      revision: 1,
      recorded_at: CLOCK,
      service: 'exterior_bath',
      prices: {
        quoted: { amount_mxn: 28000, validation: 'human_confirmed' },
        contracted: { amount_mxn: null, validation: 'not_provided' },
        collected: { amount_mxn: null, validation: 'not_provided' },
      },
    });
    const index = indexOf(transport.files);
    expect(index.archive).toBe('commercial');
    expect(index).not.toHaveProperty('cases');
    expect(index.opportunities[OPPORTUNITY].quote_ids).toEqual(['CQ-000001']);
    expect(transport.calls.every((call) => call.includes('/contents/data/commercial/'))).toBe(true);
    expect(sealed).toEqual(SEALED);
  });

  it('links a later contracted price and a later collected price to the same opportunity', async () => {
    const { transport, record } = open();
    await record(exterior());
    const original = quoteText(transport.files, 'CQ-000001');
    const contracted = await record(exterior({
      source: {
        source_case_key: 'autofix-comercial-20261113-exterior-002',
        prior_quote_id: 'CQ-000001',
      },
      prices: {
        quoted: { amount_mxn: 28000, validation: 'human_confirmed' },
        contracted: { amount_mxn: 27000, validation: 'human_confirmed' },
      },
    }));
    expect(contracted).toMatchObject({
      status: 'created',
      quoteId: 'CQ-000002',
      revision: 2,
      opportunityCount: 1,
      quoteCount: 2,
    });
    const afterContract = quoteText(transport.files, 'CQ-000001');
    const collected = await record(exterior({
      source: {
        source_case_key: 'autofix-comercial-20261113-exterior-003',
        prior_quote_id: 'CQ-000002',
      },
      prices: {
        quoted: { amount_mxn: 28000, validation: 'human_confirmed' },
        contracted: { amount_mxn: 27000, validation: 'human_confirmed' },
        collected: { amount_mxn: 25000, validation: 'human_confirmed' },
      },
    }));
    expect(collected).toMatchObject({ quoteId: 'CQ-000003', revision: 3, opportunityCount: 1, quoteCount: 3 });
    expect(quoteText(transport.files, 'CQ-000001')).toBe(original);
    expect(quoteText(transport.files, 'CQ-000001')).toBe(afterContract);
    expect(quoteOf(transport.files, 'CQ-000002').prices).toMatchObject({
      collected: { amount_mxn: null, validation: 'not_provided' },
    });
    expect(quoteOf(transport.files, 'CQ-000003').prices).toMatchObject({
      quoted: { amount_mxn: 28000, validation: 'human_confirmed' },
      contracted: { amount_mxn: 27000, validation: 'human_confirmed' },
      collected: { amount_mxn: 25000, validation: 'human_confirmed' },
    });
    const index = indexOf(transport.files);
    expect(Object.keys(index.opportunities)).toEqual([OPPORTUNITY]);
    expect(index.opportunities[OPPORTUNITY]).toEqual({
      root_quote_id: 'CQ-000001',
      head_quote_id: 'CQ-000003',
      quote_ids: ['CQ-000001', 'CQ-000002', 'CQ-000003'],
    });
  });

  it('revises the quoted price as a new observation and keeps the original', async () => {
    const { transport, record } = open();
    await record(exterior());
    const original = quoteText(transport.files, 'CQ-000001');
    const revised = await record(exterior({
      source: {
        source_case_key: 'autofix-comercial-20261113-exterior-002',
        prior_quote_id: 'CQ-000001',
      },
      prices: { quoted: { amount_mxn: 30000, validation: 'human_confirmed' } },
    }));
    expect(revised).toMatchObject({ quoteId: 'CQ-000002', opportunityCount: 1, quoteCount: 2 });
    expect(quoteText(transport.files, 'CQ-000001')).toBe(original);
    expect(quoteOf(transport.files, 'CQ-000001').prices).toMatchObject({
      quoted: { amount_mxn: 28000, validation: 'human_confirmed' },
    });
    expect(quoteOf(transport.files, 'CQ-000002').prices).toMatchObject({
      quoted: { amount_mxn: 30000, validation: 'human_confirmed' },
      collected: { amount_mxn: null, validation: 'not_provided' },
    });
  });

  it('returns already_exists for the same observation and conflict for a different one', async () => {
    const { transport, record } = open();
    await record(exterior());
    const original = quoteText(transport.files, 'CQ-000001');
    const puts = quotePuts(transport.calls);
    const duplicate = await record(exterior(), () => '2026-11-14T00:00:00.000Z');
    expect(duplicate.status).toBe('already_exists');
    expect(quoteText(transport.files, 'CQ-000001')).toBe(original);
    expect(quotePuts(transport.calls)).toBe(puts);
    await expect(record(exterior({
      prices: { quoted: { amount_mxn: 1, validation: 'human_confirmed' } },
    }))).rejects.toThrow('different observation');
    expect(quoteText(transport.files, 'CQ-000001')).toBe(original);
    expect([...transport.files.keys()].filter((key) => key.includes('/quotes/'))).toEqual([
      'data/commercial/quotes/CQ-000001.json',
    ]);
  });

  it('rejects an unlinked second root and a branch behind the head', async () => {
    const { transport, record } = open();
    await record(exterior());
    await record(exterior({
      source: {
        source_case_key: 'autofix-comercial-20261113-exterior-002',
        prior_quote_id: 'CQ-000001',
      },
      prices: { quoted: { amount_mxn: 30000, validation: 'human_confirmed' } },
    }));
    await expect(record(exterior({
      source: { source_case_key: 'autofix-comercial-20261113-exterior-003' },
    }))).rejects.toThrow('must name its previous observation');
    await expect(record(exterior({
      source: {
        source_case_key: 'autofix-comercial-20261113-exterior-003',
        prior_quote_id: 'CQ-000001',
      },
    }))).rejects.toThrow('latest observation');
    await expect(record(exterior({
      source: {
        source_case_key: 'autofix-comercial-20261113-otra-001',
        opportunity_key: 'autofix-oportunidad-20261113-otra-001',
        prior_quote_id: 'CQ-000002',
      },
    }))).rejects.toThrow('another opportunity');
    expect(Object.keys(indexOf(transport.files).opportunities)).toEqual([OPPORTUNITY]);
    expect(indexOf(transport.files).opportunities[OPPORTUNITY].quote_ids).toEqual(['CQ-000001', 'CQ-000002']);
  });

  it('reconciles a partial index write and retries the same quote', async () => {
    const { transport, record } = open(1);
    const created = await record(exterior());
    expect(created).toMatchObject({ status: 'reconciled', quoteId: 'CQ-000001', quoteCount: 1 });
    const original = quoteText(transport.files, 'CQ-000001');
    expect(quotePuts(transport.calls)).toBe(1);
    const retry = await record(exterior(), () => '2026-11-14T00:00:00.000Z');
    expect(retry.status).toBe('already_exists');
    expect(quoteText(transport.files, 'CQ-000001')).toBe(original);
    expect(quotePuts(transport.calls)).toBe(1);
    expect(indexOf(transport.files).source_keys[SOURCE]).toBe('CQ-000001');
  });

  it('refuses visual paths for historical cases and probes', () => {
    for (const path of [
      'data/index.json',
      'data/cases/AF-000001.json',
      'data/cases/AF-000002.json',
      'data/cases/AF-000003.json',
      'data/photos/AF-000002/IMG-000001.json',
      'data/probes/index.json',
      'data/probes/cases/AF-900000.json',
      'data/commercial/quotes/AF-000004.json',
    ]) {
      expect(() => assertCommercialRequestPath(path)).toThrow('visual path');
    }
    expect(() => assertCommercialTransport(
      'https://api.github.com/repos/arturo2565-alt/pegazuz-calibration-data/contents/data/cases/AF-000003.json?ref=main',
      'GET',
    )).toThrow(CalibrationConflictError);
    expect(() => assertCommercialRequestPath('data/commercial/index.json')).not.toThrow();
    expect(() => assertCommercialRequestPath('data/commercial/quotes/CQ-000001.json')).not.toThrow();
  });
});

describe('CAL-015A commercial importer', () => {
  it('stays closed unless the staging target and the safety flags match', async () => {
    const transport = jest.fn();
    expect(await importCommercialQuote({}, exterior(), { transport: transport as unknown as typeof fetch }))
      .toMatchObject({ result: 'error', category: 'wrong_target' });
    expect(await importCommercialQuote(stagingEnv({ CALIBRATION_INGEST_ENABLED: 'true' }), exterior(), {
      transport: transport as unknown as typeof fetch,
    })).toMatchObject({ category: 'flags' });
    expect(await importCommercialQuote(stagingEnv({ DB_SYNCHRONIZE: 'true' }), exterior(), {
      transport: transport as unknown as typeof fetch,
    })).toMatchObject({ category: 'flags' });
    expect(await importCommercialQuote(stagingEnv(), exterior(), { transport: transport as unknown as typeof fetch }))
      .toMatchObject({ result: 'error', category: 'missing' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('imports a local quote without photographs and reports a conflict without writing another', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commercial-quote-'));
    try {
      const { transport, writer } = open();
      const file = join(directory, 'cotizacion.json');
      writeFileSync(file, JSON.stringify(exterior()));
      const report = await importCommercialQuoteFile(stagingEnv(), file, { archive: writer, clock: () => CLOCK });
      expect(report).toEqual({
        service: 'commercial-quote-import',
        result: 'ok',
        status: 'created',
        quoteId: 'CQ-000001',
        sourceKey: SOURCE,
        opportunityKey: OPPORTUNITY,
        revision: 1,
        opportunityCount: 1,
        quoteCount: 1,
      });
      const conflict = await importCommercialQuote(stagingEnv(), exterior({
        prices: { quoted: { amount_mxn: 1, validation: 'human_confirmed' } },
      }), { archive: writer, clock: () => CLOCK });
      expect(conflict).toEqual({ service: 'commercial-quote-import', result: 'error', category: 'conflict' });
      expect([...transport.files.keys()].filter((key) => key.includes('/quotes/'))).toHaveLength(1);
      writeFileSync(join(directory, 'fotos.json'), JSON.stringify(exterior({ images: ['vista.png'] })));
      const refused = await importCommercialQuoteFile(stagingEnv(), join(directory, 'fotos.json'), { archive: writer });
      expect(refused).toMatchObject({ result: 'error', category: 'invalid' });
      expect(quotePuts(transport.calls)).toBe(1);
      const link = join(directory, 'enlace.json');
      symlinkSync(file, link);
      expect(() => readCommercialQuoteFile(link)).toThrow('directory');
      writeFileSync(join(directory, 'grande.json'), `{"pad":"${'x'.repeat(70 * 1024)}"}`);
      expect(() => readCommercialQuoteFile(join(directory, 'grande.json'))).toThrow('missing');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the reader from setting the process exit code and stays out of the visual modules', () => {
    const main = readFileSync('src/calibration/commercial-quote-import-main.ts', 'utf8');
    const reader = main.slice(0, main.indexOf('export async function writeCommercialImport'));
    expect(reader).not.toContain('process.exitCode');
    for (const file of [
      'src/calibration/commercial-quote.ts',
      'src/calibration/commercial-quote-store.ts',
      'src/calibration/commercial-quote-writer.ts',
      'src/calibration/commercial-quote-import.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toContain('CalibrationEngine');
      expect(source).not.toContain('calibration-engine');
      expect(source).not.toContain('calibration-import');
      expect(source).not.toContain('CalibrationGithubWriter');
    }
    const app = readFileSync('src/app.module.ts', 'utf8');
    expect(app).not.toContain('CalibrationModule');
    expect(app).not.toContain('commercial-quote');
    expect(commercialContentsGrantIsExpected({
      repositorySelection: 'selected',
      permissions: { contents: 'write', metadata: 'read' },
    })).toBe(true);
    expect(commercialContentsGrantIsExpected({
      repositorySelection: 'all',
      permissions: { contents: 'write' },
    })).toBe(false);
  });
});
