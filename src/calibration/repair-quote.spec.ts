import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CALIBRATION_DIAGNOSTIC_ENVIRONMENT_ID,
  CALIBRATION_DIAGNOSTIC_PROJECT_ID,
  CALIBRATION_DIAGNOSTIC_SERVICE_ID,
} from './calibration-diagnose';
import { CalibrationConflictError } from './calibration-github-writer';
import { CalibrationValidationError } from './calibration-case';
import { validateRepairQuote } from './repair-quote';
import {
  importRepairQuote,
  importRepairQuoteFile,
  readRepairQuoteFile,
  repairContentsGrantIsExpected,
} from './repair-quote-import';
import {
  nextRepairQuoteId,
  recordRepairObservation,
} from './repair-quote-store';
import {
  REPAIR_REPOSITORY,
  RepairGithubWriter,
  assertRepairRequestPath,
  assertRepairTransport,
  type RepairIndex,
} from './repair-quote-writer';

const CLOCK = '2026-11-13T21:30:00.000Z';
const OPPORTUNITY = 'sintetico-oportunidad-fascia-001';
const SOURCE = 'sintetico-textual-fascia-001';
const PART = 'fascia delantera';
const CONDITION =
  'Tiempo estimado de 3 a 4 dias habiles, sujeto a disponibilidad de la refaccion.';
const SEALED: Record<string, string> = {
  'data/index.json':
    '{"cases":{"AF-000001":"x","AF-000002":"x","AF-000003":"x"}}',
  'data/cases/AF-000001.json': '{"case_id":"AF-000001"}',
  'data/cases/AF-000002.json': '{"case_id":"AF-000002"}',
  'data/cases/AF-000003.json': '{"case_id":"AF-000003"}',
  'data/photos/AF-000003/IMG-000001.json': '{"photo_ref":"IMG-000001"}',
  'data/commercial/index.json': '{"archive":"commercial"}',
  'data/commercial/quotes/CQ-000001.json': '{"quote_id":"CQ-000001"}',
  'data/commercial/quotes/CQ-000002.json': '{"quote_id":"CQ-000002"}',
  'data/commercial/quotes/CQ-000003.json': '{"quote_id":"CQ-000003"}',
  'data/commercial/quotes/CQ-000004.json': '{"quote_id":"CQ-000004"}',
  'data/commercial/quotes/CQ-000005.json': '{"quote_id":"CQ-000005"}',
  'data/probes/index.json':
    '{"archive":"probe","cases":{"AF-900000":"y","AF-900001":"y"}}',
  'data/probes/cases/AF-900000.json': '{"case_id":"AF-900000"}',
  'data/probes/cases/AF-900001.json': '{"case_id":"AF-900001"}',
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
    make: null,
    make_evidence: 'unknown',
    model: 'Aveo',
    model_evidence: 'customer_provided',
    year: 2026,
    year_evidence: 'customer_provided',
    variant: null,
    variant_evidence: 'unknown',
    ...patch,
  };
}

function line(
  role: 'part' | 'labor',
  labor: string | null,
  amount: number,
  lineId: string,
  prices: Record<string, unknown> = {},
) {
  return {
    line_id: lineId,
    part: PART,
    role,
    labor,
    prices: {
      quoted: { amount_mxn: amount, validation: 'human_confirmed' },
      ...prices,
    },
  };
}

function fascia(
  patch: {
    source?: Record<string, unknown>;
    vehicle?: Record<string, unknown>;
    lines?: unknown[];
    quoted_total_mxn?: number;
    conditions?: unknown;
    images?: unknown;
    photo_status?: unknown;
    evidence?: unknown;
  } = {},
) {
  const input: Record<string, unknown> = {
    schema_version: '1.0.0',
    status: 'human_verified',
    evidence: patch.evidence ?? 'text_only',
    photo_status: patch.photo_status ?? 'not_provided',
    source: {
      kind: 'autofix_human_repair_quote',
      source_case_key: SOURCE,
      opportunity_key: OPPORTUNITY,
      prior_quote_id: null,
      quoted_at: null,
      ...patch.source,
    },
    vehicle: vehicle(patch.vehicle),
    lines: patch.lines ?? [
      line('part', null, 2900, 'L01'),
      line('labor', 'mount_and_paint', 3400, 'L02'),
    ],
    quoted_total_mxn: patch.quoted_total_mxn ?? 6300,
    conditions: patch.conditions ?? [CONDITION],
  };
  if ('images' in patch) input.images = patch.images;
  return input;
}

function response(status: number, value: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  } as Response;
}

function memoryTransport(failIndexPuts = 0) {
  const files = new Map<string, { text: string; sha: string }>();
  for (const [path, text] of Object.entries(SEALED))
    files.set(path, { text, sha: 'sealed' });
  const calls: string[] = [];
  let serial = 1;
  const fetch = jest.fn(
    async (url: string, init?: { method?: string; body?: string }) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push(`${method} ${url}`);
      const marker = '/contents/';
      const start = url.indexOf(marker);
      const path = decodeURIComponent(
        url.slice(start + marker.length).split('?')[0],
      );
      if (!path.startsWith('data/repairs/'))
        throw new Error(`protected path ${path}`);
      if (method === 'GET') {
        const file = files.get(path);
        if (!file) return response(404, { message: 'Not Found' });
        return response(200, {
          sha: file.sha,
          content: Buffer.from(file.text).toString('base64'),
        });
      }
      const body = JSON.parse(init?.body ?? '{}') as {
        content?: string;
        sha?: string;
      };
      if (path.endsWith('index.json') && failIndexPuts > 0) {
        failIndexPuts -= 1;
        return response(409, { message: 'Conflict' });
      }
      const existing = files.get(path);
      if (existing && body.sha !== existing.sha)
        return response(409, { message: 'Conflict' });
      if (existing && !body.sha)
        return response(422, { message: "sha wasn't supplied" });
      if (!existing && body.sha) return response(409, { message: 'Conflict' });
      const text = Buffer.from(body.content ?? '', 'base64').toString('utf8');
      const sha = `commit-${serial}`;
      serial += 1;
      files.set(path, { text, sha });
      return response(201, { commit: { sha } });
    },
  );
  return { fetch: fetch as unknown as typeof fetch, files, calls };
}

function open(failIndexPuts = 0) {
  const transport = memoryTransport(failIndexPuts);
  const writer = new RepairGithubWriter('test-token', transport.fetch);
  const record = (input: unknown, clock = () => CLOCK) =>
    recordRepairObservation(writer, input, clock);
  return { transport, writer, record };
}

function expectSealed(files: Map<string, { text: string; sha: string }>) {
  for (const [path, text] of Object.entries(SEALED)) {
    expect(files.get(path)).toEqual({ text, sha: 'sealed' });
  }
}

function repairQuoteNames(files: Map<string, { text: string }>): string[] {
  return [...files.keys()]
    .filter((key) => key.startsWith('data/repairs/quotes/'))
    .sort();
}

function quoteText(
  files: Map<string, { text: string }>,
  quoteId: string,
): string {
  const file = files.get(`data/repairs/quotes/${quoteId}.json`);
  if (!file) throw new Error(`missing ${quoteId}`);
  return file.text;
}

function quoteOf(
  files: Map<string, { text: string }>,
  quoteId: string,
): Record<string, unknown> {
  return JSON.parse(quoteText(files, quoteId)) as Record<string, unknown>;
}

function indexOf(files: Map<string, { text: string }>): RepairIndex {
  const file = files.get('data/repairs/index.json');
  if (!file) throw new Error('missing repair index');
  return JSON.parse(file.text) as RepairIndex;
}

function quotePuts(calls: string[]): number {
  return calls.filter(
    (call) => call.startsWith('PUT ') && call.includes('/quotes/'),
  ).length;
}

describe('CAL-017A repair quote contract', () => {
  it('keeps two prices of the same part on different roles', () => {
    const quote = validateRepairQuote(fascia());
    expect(quote.evidence).toBe('text_only');
    expect(quote.photo_status).toBe('not_provided');
    expect(
      quote.lines.map((item) => [
        item.part,
        item.role,
        item.labor,
        item.prices.quoted.amount_mxn,
      ]),
    ).toEqual([
      [PART, 'part', null, 2900],
      [PART, 'labor', 'mount_and_paint', 3400],
    ]);
    expect(quote.quoted_total_mxn).toBe(6300);
    expect(quote.lines[0].prices.contracted).toEqual({
      amount_mxn: null,
      validation: 'not_provided',
    });
    expect(quote.lines[1].prices.collected).toEqual({
      amount_mxn: null,
      validation: 'not_provided',
    });
    expect(quote.lines[1].prices.collected.amount_mxn).not.toBe(
      quote.lines[1].prices.quoted.amount_mxn,
    );
    expect(quote.conditions).toEqual([CONDITION]);
  });

  it('rejects a repeated role, mixed labor, and an unadmitted treatment', () => {
    expect(() =>
      validateRepairQuote(
        fascia({
          lines: [
            line('part', null, 2900, 'L01'),
            line('part', null, 1000, 'L02'),
          ],
          quoted_total_mxn: 3900,
        }),
      ),
    ).toThrow('repeats a price role');
    expect(() =>
      validateRepairQuote(
        fascia({
          lines: [
            line('part', 'mount_and_paint', 2900, 'L01'),
            line('labor', 'paint', 3400, 'L02'),
          ],
        }),
      ),
    ).toThrow('cannot carry labor');
    expect(() =>
      validateRepairQuote(
        fascia({
          lines: [
            line('part', null, 2900, 'L01'),
            line('labor', 'replace_paint', 3400, 'L02'),
          ],
        }),
      ),
    ).toThrow('not admitted');
    expect(() =>
      validateRepairQuote(
        fascia({
          lines: [
            line('part', null, 2900, 'L01'),
            line('labor', 'mount', 3400, 'L02'),
          ],
        }),
      ),
    ).toThrow('not admitted');
    expect(() =>
      validateRepairQuote(
        fascia({
          lines: [
            line('labor', 'paint', 1500, 'L01'),
            line('labor', 'repair', 1800, 'L02'),
          ],
          quoted_total_mxn: 3300,
        }),
      ),
    ).not.toThrow();
  });

  it('accepts the declared total and rejects a divergent total', () => {
    expect(validateRepairQuote(fascia()).quoted_total_mxn).toBe(6300);
    expect(() =>
      validateRepairQuote(fascia({ quoted_total_mxn: 6301 })),
    ).toThrow('does not match');
    expect(() =>
      validateRepairQuote(fascia({ quoted_total_mxn: 2900 })),
    ).toThrow('does not match');
    expect(() =>
      validateRepairQuote(fascia({ quoted_total_mxn: 9700 })),
    ).toThrow('does not match');
  });

  it('accepts a partially unknown vehicle and rejects a visual inference', () => {
    const quote = validateRepairQuote(fascia());
    expect(quote.vehicle).toMatchObject({
      make: null,
      make_evidence: 'unknown',
      model: 'Aveo',
      year: 2026,
      variant: null,
      variant_evidence: 'unknown',
    });
    expect(() =>
      validateRepairQuote(
        fascia({
          vehicle: { make: 'Aveo', make_evidence: 'unknown' },
        }),
      ),
    ).toThrow(CalibrationValidationError);
    expect(() =>
      validateRepairQuote(
        fascia({
          vehicle: { make_evidence: 'visual_inference' },
        }),
      ),
    ).toThrow('without a visual expediente');
    expect(() =>
      validateRepairQuote(fascia({ evidence: 'visual_inference' })),
    ).toThrow('visual diagnosis');
  });

  it('rejects photographs, personal data, and reserved keys', () => {
    expect(() => validateRepairQuote(fascia({ images: [] }))).toThrow(
      'does not accept photographs',
    );
    const nested = fascia();
    (nested.lines as Record<string, unknown>[])[1].images = ['vista.png'];
    expect(() => validateRepairQuote(nested)).toThrow(
      'does not accept photographs',
    );
    expect(() =>
      validateRepairQuote(fascia({ photo_status: 'archived_private' })),
    ).toThrow('cannot claim photographs');
    expect(() => validateRepairQuote({ ...fascia(), nombre: 'Ana' })).toThrow(
      'personal data',
    );
    expect(() =>
      validateRepairQuote(
        fascia({
          vehicle: {
            variant: 'ABC-123-A',
            variant_evidence: 'customer_provided',
          },
        }),
      ),
    ).toThrow('personal data');
    expect(() =>
      validateRepairQuote(fascia({ conditions: ['551234567890'] })),
    ).toThrow('personal data');
    expect(() =>
      validateRepairQuote(
        fascia({
          source: { source_case_key: 'probe-cal-009d-001' },
        }),
      ),
    ).toThrow('stable repair key');
    expect(() =>
      validateRepairQuote(
        fascia({
          lines: [
            line('part', null, 2900, 'L01', {
              collected: { amount_mxn: 2900 },
            }),
          ],
          quoted_total_mxn: 2900,
        }),
      ),
    ).toThrow(CalibrationValidationError);
  });

  it('allocates RQ identifiers without reading AF or CQ identifiers', () => {
    expect(
      nextRepairQuoteId(['AF-000001', 'AF-000003', 'CQ-000005', 'AF-900001']),
    ).toBe('RQ-000001');
    expect(nextRepairQuoteId(['RQ-000004', 'CQ-000009', 'AF-000009'])).toBe(
      'RQ-000005',
    );
    expect(REPAIR_REPOSITORY).toBe('arturo2565-alt/pegazuz-calibration-data');
  });
});

describe('CAL-017A repair archive', () => {
  it('stores the textual quote apart from AF and CQ', async () => {
    const { transport, record } = open();
    const created = await record(fascia());
    expect(created).toMatchObject({
      status: 'created',
      quoteId: 'RQ-000001',
      opportunityKey: OPPORTUNITY,
      revision: 1,
      opportunityCount: 1,
      quoteCount: 1,
    });
    expect(quoteOf(transport.files, 'RQ-000001')).toMatchObject({
      quote_id: 'RQ-000001',
      revision: 1,
      recorded_at: CLOCK,
      evidence: 'text_only',
      photo_status: 'not_provided',
      quoted_total_mxn: 6300,
      lines: [
        {
          part: PART,
          role: 'part',
          labor: null,
          prices: { quoted: { amount_mxn: 2900 } },
        },
        {
          part: PART,
          role: 'labor',
          labor: 'mount_and_paint',
          prices: { quoted: { amount_mxn: 3400 } },
        },
      ],
    });
    expect(JSON.stringify(quoteOf(transport.files, 'RQ-000001'))).not.toContain(
      'images',
    );
    const index = indexOf(transport.files);
    expect(index.archive).toBe('repairs');
    expect(index).not.toHaveProperty('cases');
    expect(index.opportunities[OPPORTUNITY].quote_ids).toEqual(['RQ-000001']);
    expect(
      transport.calls.every((call) => call.includes('/contents/data/repairs/')),
    ).toBe(true);
    expectSealed(transport.files);
  });

  it('returns already_exists for the same observation and conflict for a different one', async () => {
    const { transport, record } = open();
    await record(fascia());
    const original = quoteText(transport.files, 'RQ-000001');
    const puts = quotePuts(transport.calls);
    const duplicate = await record(fascia(), () => '2026-11-14T00:00:00.000Z');
    expect(duplicate.status).toBe('already_exists');
    expect(quoteText(transport.files, 'RQ-000001')).toBe(original);
    expect(quotePuts(transport.calls)).toBe(puts);
    await expect(
      record(
        fascia({
          lines: [
            line('part', null, 3000, 'L01'),
            line('labor', 'mount_and_paint', 3400, 'L02'),
          ],
          quoted_total_mxn: 6400,
        }),
      ),
    ).rejects.toThrow('different observation');
    expect(quoteText(transport.files, 'RQ-000001')).toBe(original);
    expect(repairQuoteNames(transport.files)).toEqual([
      'data/repairs/quotes/RQ-000001.json',
    ]);
    expectSealed(transport.files);
  });

  it('records a new revision of the same opportunity and rejects a branch', async () => {
    const { transport, record } = open();
    await record(fascia());
    const original = quoteText(transport.files, 'RQ-000001');
    const revised = await record(
      fascia({
        source: {
          source_case_key: 'sintetico-textual-fascia-002',
          prior_quote_id: 'RQ-000001',
        },
      }),
    );
    expect(revised).toMatchObject({
      status: 'created',
      quoteId: 'RQ-000002',
      revision: 2,
      opportunityCount: 1,
      quoteCount: 2,
    });
    expect(quoteText(transport.files, 'RQ-000001')).toBe(original);
    await expect(
      record(
        fascia({
          source: { source_case_key: 'sintetico-textual-fascia-003' },
        }),
      ),
    ).rejects.toThrow('must name its previous observation');
    await expect(
      record(
        fascia({
          source: {
            source_case_key: 'sintetico-textual-fascia-003',
            prior_quote_id: 'RQ-000001',
          },
        }),
      ),
    ).rejects.toThrow('latest observation');
    await expect(
      record(
        fascia({
          source: {
            source_case_key: 'sintetico-textual-otra-001',
            opportunity_key: 'sintetico-oportunidad-otra-001',
            prior_quote_id: 'RQ-000002',
          },
        }),
      ),
    ).rejects.toThrow('another opportunity');
    expect(indexOf(transport.files).opportunities[OPPORTUNITY]).toEqual({
      root_quote_id: 'RQ-000001',
      head_quote_id: 'RQ-000002',
      quote_ids: ['RQ-000001', 'RQ-000002'],
    });
    expectSealed(transport.files);
  });

  it('links a later contracted price and a later collected price without editing the original', async () => {
    const { transport, record } = open();
    await record(fascia());
    const original = quoteText(transport.files, 'RQ-000001');
    const contracted = await record(
      fascia({
        source: {
          source_case_key: 'sintetico-textual-fascia-002',
          prior_quote_id: 'RQ-000001',
        },
        lines: [
          line('part', null, 2900, 'L01', {
            contracted: { amount_mxn: 2900, validation: 'human_confirmed' },
          }),
          line('labor', 'mount_and_paint', 3400, 'L02', {
            contracted: { amount_mxn: 3400, validation: 'human_confirmed' },
          }),
        ],
      }),
    );
    expect(contracted).toMatchObject({
      quoteId: 'RQ-000002',
      revision: 2,
      opportunityCount: 1,
      quoteCount: 2,
    });
    expect(quoteOf(transport.files, 'RQ-000002').lines).toMatchObject([
      {
        prices: {
          contracted: { amount_mxn: 2900, validation: 'human_confirmed' },
          collected: { validation: 'not_provided' },
        },
      },
      {
        prices: {
          contracted: { amount_mxn: 3400, validation: 'human_confirmed' },
          collected: { validation: 'not_provided' },
        },
      },
    ]);
    const collected = await record(
      fascia({
        source: {
          source_case_key: 'sintetico-textual-fascia-003',
          prior_quote_id: 'RQ-000002',
        },
        lines: [
          line('part', null, 2900, 'L01', {
            contracted: { amount_mxn: 2900, validation: 'human_confirmed' },
            collected: { amount_mxn: 2900, validation: 'human_confirmed' },
          }),
          line('labor', 'mount_and_paint', 3400, 'L02', {
            contracted: { amount_mxn: 3400, validation: 'human_confirmed' },
            collected: { amount_mxn: 3400, validation: 'human_confirmed' },
          }),
        ],
      }),
    );
    expect(collected).toMatchObject({
      quoteId: 'RQ-000003',
      revision: 3,
      opportunityCount: 1,
      quoteCount: 3,
    });
    expect(quoteText(transport.files, 'RQ-000001')).toBe(original);
    expect(quoteOf(transport.files, 'RQ-000001')).toMatchObject({
      lines: [
        {
          prices: {
            contracted: { amount_mxn: null, validation: 'not_provided' },
          },
        },
        {
          prices: {
            collected: { amount_mxn: null, validation: 'not_provided' },
          },
        },
      ],
    });
    expect(
      indexOf(transport.files).opportunities[OPPORTUNITY].head_quote_id,
    ).toBe('RQ-000003');
    expectSealed(transport.files);
  });

  it('reconciles a partial index write and retries the same quote', async () => {
    const { transport, record } = open(1);
    const created = await record(fascia());
    expect(created).toMatchObject({
      status: 'reconciled',
      quoteId: 'RQ-000001',
      quoteCount: 1,
    });
    const original = quoteText(transport.files, 'RQ-000001');
    expect(quotePuts(transport.calls)).toBe(1);
    const retry = await record(fascia(), () => '2026-11-14T00:00:00.000Z');
    expect(retry.status).toBe('already_exists');
    expect(quoteText(transport.files, 'RQ-000001')).toBe(original);
    expect(quotePuts(transport.calls)).toBe(1);
    expect(indexOf(transport.files).source_keys[SOURCE]).toBe('RQ-000001');
    expectSealed(transport.files);
  });

  it('refuses visual, commercial, and probe paths', () => {
    for (const path of [
      'data/index.json',
      'data/cases/AF-000001.json',
      'data/cases/AF-000002.json',
      'data/cases/AF-000003.json',
      'data/photos/AF-000003/IMG-000001.json',
      'data/commercial/index.json',
      'data/commercial/quotes/CQ-000001.json',
      'data/commercial/quotes/CQ-000005.json',
      'data/probes/index.json',
      'data/probes/cases/AF-900000.json',
      'data/repairs/quotes/CQ-000006.json',
      'data/repairs/quotes/AF-000004.json',
    ]) {
      expect(() => assertRepairRequestPath(path)).toThrow('protected path');
    }
    expect(() =>
      assertRepairTransport(
        'https://api.github.com/repos/arturo2565-alt/pegazuz-calibration-data/contents/data/commercial/quotes/CQ-000001.json?ref=main',
        'GET',
      ),
    ).toThrow(CalibrationConflictError);
    expect(() =>
      assertRepairTransport(
        'https://api.github.com/repos/arturo2565-alt/pegazuz-calibration-data/contents/data/cases/AF-000003.json?ref=main',
        'GET',
      ),
    ).toThrow(CalibrationConflictError);
    expect(() =>
      assertRepairTransport(
        'https://api.github.com/repos/arturo2565-alt/pegazuz-calibration-data/contents/data/probes/index.json?ref=main',
        'GET',
      ),
    ).toThrow(CalibrationConflictError);
    expect(() =>
      assertRepairRequestPath('data/repairs/index.json'),
    ).not.toThrow();
    expect(() =>
      assertRepairRequestPath('data/repairs/quotes/RQ-000001.json'),
    ).not.toThrow();
  });
});

describe('CAL-017A repair importer', () => {
  it('stays closed unless the staging target and the safety flags match', async () => {
    const transport = jest.fn();
    expect(
      await importRepairQuote({}, fascia(), {
        transport: transport as unknown as typeof fetch,
      }),
    ).toMatchObject({ result: 'error', category: 'wrong_target' });
    expect(
      await importRepairQuote(
        stagingEnv({ CALIBRATION_INGEST_ENABLED: 'true' }),
        fascia(),
        {
          transport: transport as unknown as typeof fetch,
        },
      ),
    ).toMatchObject({ category: 'flags' });
    expect(
      await importRepairQuote(
        stagingEnv({ DB_SYNCHRONIZE: 'true' }),
        fascia(),
        {
          transport: transport as unknown as typeof fetch,
        },
      ),
    ).toMatchObject({ category: 'flags' });
    expect(
      await importRepairQuote(stagingEnv(), fascia(), {
        transport: transport as unknown as typeof fetch,
      }),
    ).toMatchObject({ result: 'error', category: 'missing' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('imports a local quote, reports conflict, and rejects photographs and a bad total', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'repair-quote-'));
    try {
      const { transport, writer } = open();
      const refusedTotal = await importRepairQuote(
        stagingEnv(),
        fascia({ quoted_total_mxn: 2900 }),
        {
          archive: writer,
          clock: () => CLOCK,
        },
      );
      expect(refusedTotal).toMatchObject({
        result: 'error',
        category: 'invalid',
      });
      const personal = await importRepairQuote(
        stagingEnv(),
        { ...fascia(), nombre: 'Ana' },
        { archive: writer },
      );
      expect(personal).toMatchObject({ category: 'personal_data' });
      expect(repairQuoteNames(transport.files)).toEqual([]);
      const file = join(directory, 'cotizacion.json');
      writeFileSync(file, JSON.stringify(fascia()));
      const report = await importRepairQuoteFile(stagingEnv(), file, {
        archive: writer,
        clock: () => CLOCK,
      });
      expect(report).toEqual({
        service: 'repair-quote-import',
        result: 'ok',
        status: 'created',
        quoteId: 'RQ-000001',
        sourceKey: SOURCE,
        opportunityKey: OPPORTUNITY,
        revision: 1,
        opportunityCount: 1,
        quoteCount: 1,
      });
      const conflict = await importRepairQuote(
        stagingEnv(),
        fascia({
          lines: [
            line('part', null, 3000, 'L01'),
            line('labor', 'mount_and_paint', 3400, 'L02'),
          ],
          quoted_total_mxn: 6400,
        }),
        { archive: writer, clock: () => CLOCK },
      );
      expect(conflict).toEqual({
        service: 'repair-quote-import',
        result: 'error',
        category: 'conflict',
      });
      expect(repairQuoteNames(transport.files)).toEqual([
        'data/repairs/quotes/RQ-000001.json',
      ]);
      writeFileSync(
        join(directory, 'fotos.json'),
        JSON.stringify(fascia({ images: ['vista.png'] })),
      );
      const refused = await importRepairQuoteFile(
        stagingEnv(),
        join(directory, 'fotos.json'),
        { archive: writer },
      );
      expect(refused).toMatchObject({ result: 'error', category: 'invalid' });
      expect(quotePuts(transport.calls)).toBe(1);
      const link = join(directory, 'enlace.json');
      symlinkSync(file, link);
      expect(() => readRepairQuoteFile(link)).toThrow('directory');
      writeFileSync(
        join(directory, 'grande.json'),
        `{"pad":"${'x'.repeat(70 * 1024)}"}`,
      );
      expect(() => readRepairQuoteFile(join(directory, 'grande.json'))).toThrow(
        'missing',
      );
      expectSealed(transport.files);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the reader from setting the process exit code and stays out of the other archives', () => {
    const main = readFileSync(
      'src/calibration/repair-quote-import-main.ts',
      'utf8',
    );
    const reader = main.slice(
      0,
      main.indexOf('export async function writeRepairImport'),
    );
    expect(reader).not.toContain('process.exitCode');
    for (const file of [
      'src/calibration/repair-quote.ts',
      'src/calibration/repair-quote-store.ts',
      'src/calibration/repair-quote-writer.ts',
      'src/calibration/repair-quote-import.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toContain('CalibrationEngine');
      expect(source).not.toContain('calibration-engine');
      expect(source).not.toContain('calibration-import');
      expect(source).not.toContain('CalibrationGithubWriter');
      expect(source).not.toContain('commercial-quote');
    }
    const app = readFileSync('src/app.module.ts', 'utf8');
    expect(app).not.toContain('CalibrationModule');
    expect(app).not.toContain('repair-quote');
    expect(
      repairContentsGrantIsExpected({
        repositorySelection: 'selected',
        permissions: { contents: 'write', metadata: 'read' },
      }),
    ).toBe(true);
    expect(
      repairContentsGrantIsExpected({
        repositorySelection: 'all',
        permissions: { contents: 'write' },
      }),
    ).toBe(false);
  });
});
