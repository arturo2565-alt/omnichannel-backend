import { createHash, generateKeyPairSync } from 'node:crypto';
import { CalibrationCloudinaryArchive, type CloudinaryGateway } from './calibration-cloudinary-archive';
import {
  CALIBRATION_DIAGNOSTIC_ENVIRONMENT_ID,
  CALIBRATION_DIAGNOSTIC_PROJECT_ID,
  CALIBRATION_DIAGNOSTIC_SERVICE_ID,
} from './calibration-diagnose';
import { importCalibrationCase } from './calibration-import';
import { readCalibrationCase } from './calibration-query';
import { minimalDecodablePng } from './calibration-image-archive.service';
import { importCommercialQuote } from './commercial-quote-import';
import { CommercialGithubWriter } from './commercial-quote-writer';
import { importRepairQuote } from './repair-quote-import';
import { RepairGithubWriter } from './repair-quote-writer';
import { ColorError, assertColorRead, assertColorWrite, type ColorFiles } from './color-annotation';
import { memoryGithub } from '../../test/calibration-memory-github';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PROTECTED = '{"case_id":"AF-000001","photo_refs":[],"photo_archive_status":"pending_private_archive"}\n';

function stagingEnv(): NodeJS.ProcessEnv {
  return {
    RAILWAY_ENVIRONMENT_NAME: 'staging',
    RAILWAY_SERVICE_NAME: 'pegazuz-backend-staging',
    RAILWAY_PROJECT_ID: CALIBRATION_DIAGNOSTIC_PROJECT_ID,
    RAILWAY_ENVIRONMENT_ID: CALIBRATION_DIAGNOSTIC_ENVIRONMENT_ID,
    RAILWAY_SERVICE_ID: CALIBRATION_DIAGNOSTIC_SERVICE_ID,
    CALIBRATION_INGEST_ENABLED: 'false',
    DB_SYNCHRONIZE: 'false',
    CALIBRATION_GITHUB_APP_ID: '12345',
    CALIBRATION_GITHUB_INSTALLATION_ID: '67890',
    CALIBRATION_GITHUB_APP_PRIVATE_KEY: pem,
  };
}

function response(status: number, value: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => value } as Response;
}

function colorFiles(files: Map<string, { text: string; sha: string }>, gate: { fail: boolean } = { fail: false }): ColorFiles {
  return {
    async read(path) {
      assertColorRead(path);
      const file = files.get(path);
      return file ? { content: file.text, sha: file.sha } : null;
    },
    async write(path, content, sha) {
      if (gate.fail) throw new ColorError('rejected');
      assertColorWrite(path);
      const current = files.get(path);
      if ((sha == null) !== (current == null) || (sha != null && current?.sha !== sha)) throw new ColorError('conflict');
      const next = `color-${files.size + 1}`;
      files.set(path, { text: content, sha: next });
      return next;
    },
  };
}

function repairMemory() {
  const files = new Map<string, { text: string; sha: string }>();
  const transport = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const marker = '/contents/';
    const path = decodeURIComponent(url.slice(url.indexOf(marker) + marker.length).split('?')[0]);
    if (!path.startsWith('data/repairs/')) throw new Error(`protected path ${path}`);
    if (method === 'GET') {
      const file = files.get(path);
      return file
        ? response(200, { sha: file.sha, content: Buffer.from(file.text).toString('base64') })
        : response(404, {});
    }
    const body = JSON.parse(init?.body ?? '{}') as { content?: string; sha?: string };
    const existing = files.get(path);
    if (existing && body.sha !== existing.sha) return response(409, {});
    if (existing && !body.sha) return response(422, {});
    if (!existing && body.sha) return response(409, {});
    const sha = `commit-${files.size + 1}`;
    files.set(path, { text: Buffer.from(body.content ?? '', 'base64').toString('utf8'), sha });
    return response(201, { commit: { sha } });
  });
  return { files, transport: transport as unknown as typeof fetch };
}

function repairQuote(sourceKey: string, conditions: string[]) {
  return {
    schema_version: '1.0.0',
    status: 'human_verified',
    evidence: 'text_only',
    photo_status: 'not_provided',
    source: {
      kind: 'autofix_human_repair_quote',
      source_case_key: sourceKey,
      opportunity_key: `${sourceKey}-oportunidad`,
      prior_quote_id: null,
      quoted_at: null,
    },
    vehicle: {
      make: 'Volkswagen',
      make_evidence: 'customer_provided',
      model: 'Jetta',
      model_evidence: 'customer_provided',
      year: 2015,
      year_evidence: 'customer_provided',
      variant: null,
      variant_evidence: 'unknown',
    },
    lines: [
      { line_id: 'L01', part: 'puerta', role: 'labor', labor: 'paint', prices: { quoted: { amount_mxn: 1800, validation: 'human_confirmed' }, contracted: { amount_mxn: null, validation: 'not_provided' }, collected: { amount_mxn: null, validation: 'not_provided' } } },
    ],
    quoted_total_mxn: 1800,
    conditions,
  };
}

function commercial(sourceKey: string, colors: Record<string, unknown>, service = 'exterior_bath') {
  return {
    schema_version: '1.0.0',
    status: 'human_verified',
    source: {
      kind: 'autofix_human_commercial_quote',
      source_case_key: sourceKey,
      opportunity_key: `${sourceKey}-oportunidad`,
      prior_quote_id: null,
      quoted_at: null,
    },
    vehicle: {
      make: 'Mazda',
      make_evidence: 'customer_provided',
      model: '3',
      model_evidence: 'customer_provided',
      year: 2015,
      year_evidence: 'customer_provided',
      variant: null,
      variant_evidence: 'unknown',
    },
    service,
    colors,
    work_scope: service === 'color_change' ? ['disassembly'] : [],
    prices: {
      quoted: { amount_mxn: 28000, validation: 'human_confirmed' },
      contracted: { amount_mxn: null, validation: 'not_provided' },
      collected: { amount_mxn: null, validation: 'not_provided' },
    },
  };
}

function commercialMemory() {
  const files = new Map<string, { text: string; sha: string }>();
  const transport = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const marker = '/contents/';
    const path = decodeURIComponent(url.slice(url.indexOf(marker) + marker.length).split('?')[0]);
    if (!path.startsWith('data/commercial/')) throw new Error(`visual path ${path}`);
    if (method === 'GET') {
      const file = files.get(path);
      return file
        ? response(200, { sha: file.sha, content: Buffer.from(file.text).toString('base64') })
        : response(404, {});
    }
    const body = JSON.parse(init?.body ?? '{}') as { content?: string; sha?: string };
    const existing = files.get(path);
    if (existing && body.sha !== existing.sha) return response(409, {});
    if (existing && !body.sha) return response(422, {});
    if (!existing && body.sha) return response(409, {});
    const sha = `commit-${files.size + 1}`;
    files.set(path, { text: Buffer.from(body.content ?? '', 'base64').toString('utf8'), sha });
    return response(201, { commit: { sha } });
  });
  return { files, transport: transport as unknown as typeof fetch };
}

describe('CAL-030 color import', () => {
  it('anota el color de una reparación sin duplicarlo ni mover el precio', async () => {
    const memory = repairMemory();
    const gate = { fail: false };
    const writer = new RepairGithubWriter('ensayo', memory.transport);
    const files = colorFiles(memory.files, gate);
    const input = repairQuote('sintetico-jetta-blanco', ['Volkswagen Jetta blanco']);
    const run = () => importRepairQuote(stagingEnv(), input, {
      archive: writer,
      colorFiles: files,
      clock: () => '2026-11-17T16:00:00.000Z',
    });
    gate.fail = true;
    const failed = await run();
    const stored = memory.files.get('data/repairs/quotes/RQ-000001.json')?.text ?? '';
    expect(failed).toMatchObject({ result: 'ok', quoteId: 'RQ-000001', enriched: false });
    expect(failed.color).toMatchObject({ status: 'pending', enriched: false });
    expect(stored).toContain('"amount_mxn": 1800');
    expect(stored).not.toContain('exterior_color');
    gate.fail = false;
    const recovered = await run();
    expect(recovered).toMatchObject({ result: 'ok', status: 'already_exists', quoteId: 'RQ-000001', enriched: true });
    expect(recovered.color?.status).toBe('recorded');
    expect(memory.files.get('data/repairs/quotes/RQ-000001.json')?.text).toBe(stored);
    const again = await run();
    expect(again.color?.status).toBe('already_recorded');
    const notes = [...memory.files.keys()].filter((path) => /CL-\d{6}\.json$/.test(path));
    expect(notes).toHaveLength(1);
    expect(memory.files.get(notes[0])?.text).toContain('"exterior_color": "blanco"');
    expect(memory.files.get(notes[0])?.text).toContain('"exterior_provenance": "human_declaration"');
    expect(memory.files.get(notes[0])?.text).not.toContain('"status": "validated"');
    expect(memory.files.get('data/repairs/quotes/RQ-000001.json')?.text).toBe(stored);
  });

  it('anota el cambio comercial y permite una cotización sin color', async () => {
    const memory = commercialMemory();
    const writer = new CommercialGithubWriter('test-token', memory.transport);
    const files = colorFiles(memory.files);
    const plain = await importCommercialQuote(stagingEnv(), commercial('sintetico-sin-color', {
      current: null,
      current_evidence: 'unknown',
      requested: null,
      requested_evidence: 'unknown',
    }), { archive: writer, colorFiles: files, clock: () => '2026-11-17T16:00:00.000Z' });
    expect(plain).toMatchObject({ result: 'ok', quoteId: 'CQ-000001' });
    expect(plain.color).toBeUndefined();
    const change = await importCommercialQuote(stagingEnv(), commercial('sintetico-cambio', {
      current: 'blanco',
      current_evidence: 'customer_provided',
      requested: 'negro',
      requested_evidence: 'customer_provided',
    }, 'color_change'), { archive: writer, colorFiles: files, clock: () => '2026-11-17T16:00:00.000Z' });
    const stored = memory.files.get('data/commercial/quotes/CQ-000002.json')?.text ?? '';
    expect(change).toMatchObject({ color: { status: 'recorded', enriched: true }, enriched: true });
    const bath = await importCommercialQuote(stagingEnv(), commercial('sintetico-bano', {
      current: null,
      current_evidence: 'unknown',
      requested: 'plata',
      requested_evidence: 'customer_provided',
    }, 'color_change'), { archive: writer, colorFiles: files, clock: () => '2026-11-17T16:00:00.000Z' });
    expect(bath.color).toMatchObject({ status: 'recorded', enriched: true });
    const bathNote = [...memory.files.keys()].find((path) => path.includes('CQ-000003') && path.endsWith('CL-000001.json'));
    expect(memory.files.get(bathNote ?? '')?.text).toContain('"requested_color": "plata"');
    expect(memory.files.get(bathNote ?? '')?.text).toContain('"exterior_color": null');
    expect(memory.files.get('data/commercial/quotes/CQ-000003.json')?.text).toContain('"amount_mxn": 28000');
    expect(stored).toContain('"amount_mxn": 28000');
    expect(stored).not.toContain('exterior_provenance');
    const note = [...memory.files.keys()].find((path) => path.includes('CQ-000002') && path.endsWith('CL-000001.json'));
    expect(memory.files.get(note ?? '')?.text).toContain('"exterior_color": "blanco"');
    expect(memory.files.get(note ?? '')?.text).toContain('"requested_color": "negro"');
    expect(memory.files.get(note ?? '')?.text).not.toContain('authenticated_owner');
    const repeated = await importCommercialQuote(stagingEnv(), commercial('sintetico-cambio', {
      current: 'blanco',
      current_evidence: 'customer_provided',
      requested: 'negro',
      requested_evidence: 'customer_provided',
    }, 'color_change'), { archive: writer, colorFiles: files, clock: () => '2026-11-17T16:00:00.000Z' });
    expect(repeated.color?.status).toBe('already_recorded');
    expect(memory.files.get('data/commercial/quotes/CQ-000002.json')?.text).toBe(stored);
  });

  it('captura el color de un expediente visual sin segundo asiento y sin nuevo identificador', async () => {
    const github = memoryGithub();
    github.files.set('data/cases/AF-000001.json', { sha: 'case-000001', text: PROTECTED });
    const calls: string[] = [];
    const transport: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'POST' && url.includes('/access_tokens')) {
        return response(201, {
          token: 'ghs_installation_token_one',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          permissions: { contents: 'write', metadata: 'read' },
          repository_selection: 'selected',
        });
      }
      if (method === 'GET' && url.includes('/installation/repositories')) {
        return response(200, { total_count: 1, repositories: [{ full_name: 'arturo2565-alt/pegazuz-calibration-data' }] });
      }
      return github.transport(input, init);
    };
    const stored = new Map<string, Buffer>();
    const gateway: CloudinaryGateway = {
      async uploadAuthenticated({ publicId, bytes }) {
        stored.set(publicId, Buffer.from(bytes));
        return { assetId: 'asset', publicId, version: 4, bytes: bytes.length, format: 'png', type: 'authenticated', resourceType: 'image' };
      },
      async downloadAuthenticated({ publicId }) {
        const bytes = stored.get(publicId);
        if (!bytes) throw new Error('missing');
        return bytes;
      },
    };
    const image = minimalDecodablePng([9, 9, 9]);
    const photos = new CalibrationCloudinaryArchive(gateway);
    const quote = {
      source_case_key: 'autofix-color-rojo',
      quoted_at: null,
      human_verified: true as const,
      vehicle: {
        make: 'Mazda',
        make_evidence: 'customer_provided',
        model: '3',
        model_evidence: 'customer_provided',
        year: 2015,
        year_evidence: 'customer_provided',
        variant: null,
      },
      line_items: [{
        line_id: 'L1',
        part: 'puerta',
        treatment: 'repair_paint',
        price_mxn: 3600,
        damage_severity: 'unknown',
        validation: 'human_confirmed',
      }],
      visual_observations: ['El vehiculo se observa de color blanco.'],
      operator_statement: 'Mazda 3 2015 rojo',
      images: [image],
    };
    const report = await importCalibrationCase(stagingEnv(), quote, {
      transport,
      photos,
      clock: () => '2026-11-17T16:00:00.000Z',
    });
    const casePath = `data/cases/${report.caseId}.json`;
    const storedCase = github.files.get(casePath)?.text ?? '';
    expect(report).toMatchObject({ result: 'ok', caseId: 'AF-000004' });
    expect(report).toMatchObject({ color: { status: 'recorded', enriched: true }, enriched: true });
    const detail = await readCalibrationCase({
      async read(path: string) {
        return github.files.get(path)?.text ?? null;
      },
      async photo() {
        return Buffer.alloc(0);
      },
    }, report.caseId ?? '');
    expect(detail.colorAnnotation).toMatchObject({
      contractVersion: 'color-v1',
      exteriorColor: 'rojo',
      exteriorProvenance: 'human_declaration',
      requestedColor: null,
      originalColor: null,
      status: 'proposed',
    });
    expect(detail.colorAnnotation?.status).not.toBe('validated');
    expect(detail.lines[0].priceMxn).toBe(3600);
    expect(storedCase).toContain('"price_mxn": 3600');
    expect(storedCase).not.toContain('exterior_color');
    expect(github.files.get('data/cases/AF-000001.json')?.text).toBe(PROTECTED);
    const note = [...github.files.keys()].find((path) => path.includes('CL-'));
    expect(github.files.get(note ?? '')?.text).toContain('"exterior_color": "rojo"');
    expect(github.files.get(note ?? '')?.text).toContain('"exterior_provenance": "human_declaration"');
    expect(github.files.get(note ?? '')?.text).not.toContain('"status": "validated"');
    const repeated = await importCalibrationCase(stagingEnv(), quote, {
      transport,
      photos,
      clock: () => '2026-11-17T16:00:00.000Z',
    });
    expect(repeated).toMatchObject({ result: 'ok', status: 'already_exists', caseId: 'AF-000004' });
    expect(repeated.color?.status).toBe('already_recorded');
    expect(github.files.get(casePath)?.text).toBe(storedCase);
    expect([...github.files.keys()].filter((path) => /CL-\d{6}\.json$/.test(path))).toHaveLength(1);
    const disagreed = await importCalibrationCase(stagingEnv(), { ...quote, operator_statement: 'Mazda 3 azul' }, {
      transport,
      photos,
      clock: () => '2026-11-17T16:00:00.000Z',
    });
    expect(disagreed.color?.status).toBe('conflict');
    expect(github.files.get(casePath)?.text).toBe(storedCase);
    expect(github.files.get(note ?? '')?.text).toContain('"exterior_color": "rojo"');
    expect(createHash('sha256').update(storedCase).digest('hex')).toBe(createHash('sha256').update(github.files.get(casePath)?.text ?? '').digest('hex'));
    void calls;
  });

  it('registra el color de un baño exterior sin volverlo cambio de color', async () => {
    const memory = commercialMemory();
    const preserved = '{"quote_id":"CQ-000006","prices":{"quoted":{"amount_mxn":32000}}}\n';
    memory.files.set('data/commercial/quotes/CQ-000006.json', { text: preserved, sha: 'cq-6' });
    memory.files.set('data/commercial/index.json', {
      text: JSON.stringify({
        schema_version: '1.0.0',
        archive: 'commercial',
        opportunities: {
          'historico-cq-000006-oportunidad': {
            root_quote_id: 'CQ-000006',
            head_quote_id: 'CQ-000006',
            quote_ids: ['CQ-000006'],
          },
        },
        source_keys: { 'historico-cq-000006': 'CQ-000006' },
      }),
      sha: 'index-6',
    });
    const gate = { fail: false };
    const writer = new CommercialGithubWriter('test-token', memory.transport);
    const files = colorFiles(memory.files, gate);
    const empty = { current: null, current_evidence: 'unknown', requested: null, requested_evidence: 'unknown' };
    const paint = (source: string, statement: string, service = 'exterior_bath', colors: Record<string, unknown> = empty) => {
      const quote = commercial(source, colors, service);
      return importCommercialQuote(stagingEnv(), {
        ...quote,
        work_scope: service === 'bath_with_bodywork' ? ['bodywork'] : quote.work_scope,
        operator_statement: statement,
      }, { archive: writer, colorFiles: files, clock: () => '2026-11-17T16:00:00.000Z' });
    };
    gate.fail = true;
    const failed = await paint('sintetico-bano-exterior', 'Baño exterior en plata');
    const stored = memory.files.get('data/commercial/quotes/CQ-000007.json')?.text ?? '';
    expect(failed).toMatchObject({ result: 'ok', quoteId: 'CQ-000007', enriched: false });
    expect(failed.color).toMatchObject({ status: 'pending', enriched: false });
    expect(stored).toContain('"service": "exterior_bath"');
    expect(stored).toContain('"requested": null');
    expect(stored).toContain('"amount_mxn": 28000');
    expect(stored).not.toContain('operator_statement');
    expect(stored).not.toContain('plata');
    expect(memory.files.get('data/commercial/quotes/CQ-000006.json')?.text).toBe(preserved);
    gate.fail = false;
    const recovered = await paint('sintetico-bano-exterior', 'Baño exterior en plata');
    expect(recovered).toMatchObject({ result: 'ok', status: 'already_exists', quoteId: 'CQ-000007', enriched: true });
    const note = [...memory.files.keys()].find((path) => path.includes('CQ-000007') && path.endsWith('CL-000001.json'));
    const noteText = memory.files.get(note ?? '')?.text ?? '';
    expect(noteText).toContain('"requested_color": "plata"');
    expect(noteText).toContain('"requested_provenance": "human_declaration"');
    expect(noteText).toContain('"exterior_color": null');
    expect(noteText).not.toContain('"status": "validated"');
    expect(memory.files.get('data/commercial/quotes/CQ-000007.json')?.text).toBe(stored);
    const again = await paint('sintetico-bano-exterior', 'Baño exterior en plata');
    expect(again.color?.status).toBe('already_recorded');
    expect([...memory.files.keys()].filter((path) => path.includes('CQ-000007') && /CL-\d{6}\.json$/.test(path))).toHaveLength(1);
    const kept = await paint('sintetico-conserva', 'Baño exterior conservando el color original blanco');
    const keptQuote = memory.files.get(`data/commercial/quotes/${kept.quoteId}.json`)?.text ?? '';
    const keptNote = [...memory.files.keys()].find((path) => kept.quoteId && path.includes(kept.quoteId) && path.endsWith('CL-000001.json'));
    expect(keptQuote).toContain('"service": "exterior_bath"');
    expect(keptQuote).toContain('"requested": null');
    expect(memory.files.get(keptNote ?? '')?.text).toContain('"original_color": "blanco"');
    expect(memory.files.get(keptNote ?? '')?.text).toContain('"requested_color": null');
    const body = await paint('sintetico-hojalata', 'Baño con hojalatería en color rojo', 'bath_with_bodywork');
    const bodyQuote = memory.files.get(`data/commercial/quotes/${body.quoteId}.json`)?.text ?? '';
    const bodyNote = [...memory.files.keys()].find((path) => body.quoteId && path.includes(body.quoteId) && path.endsWith('CL-000001.json'));
    expect(bodyQuote).toContain('"service": "bath_with_bodywork"');
    expect(bodyQuote).toContain('"requested": null');
    expect(bodyQuote).toContain('"amount_mxn": 28000');
    expect(memory.files.get(bodyNote ?? '')?.text).toContain('"requested_color": "rojo"');
    const change = await paint('sintetico-cambio-texto', 'Cambio de blanco a negro', 'color_change', {
      current: 'blanco',
      current_evidence: 'customer_provided',
      requested: 'negro',
      requested_evidence: 'customer_provided',
    });
    const changeQuote = memory.files.get(`data/commercial/quotes/${change.quoteId}.json`)?.text ?? '';
    const changeNote = [...memory.files.keys()].find((path) => change.quoteId && path.includes(change.quoteId) && path.endsWith('CL-000001.json'));
    expect(changeQuote).toContain('"service": "color_change"');
    expect(changeQuote).toContain('"requested": "negro"');
    expect(memory.files.get(changeNote ?? '')?.text).toContain('"exterior_color": "blanco"');
    expect(memory.files.get(changeNote ?? '')?.text).toContain('"requested_color": "negro"');
    const plain = await importCommercialQuote(stagingEnv(), commercial('sintetico-sin-color-2', empty), {
      archive: writer,
      colorFiles: files,
      clock: () => '2026-11-17T16:00:00.000Z',
    });
    expect(plain.color).toBeUndefined();
    const ambiguous = await paint('sintetico-ambiguo', 'rojo o azul');
    const ambiguousNote = [...memory.files.keys()].find((path) => ambiguous.quoteId && path.includes(ambiguous.quoteId) && path.endsWith('CL-000001.json'));
    expect(memory.files.get(ambiguousNote ?? '')?.text).toContain('"status": "unknown"');
    expect(memory.files.get(ambiguousNote ?? '')?.text).toContain('"exterior_color": null');
    const seen = await paint('sintetico-visual', 'Mazda 3 rojo. Se observa de color blanco.');
    const seenNote = memory.files.get([...memory.files.keys()].find((path) => seen.quoteId && path.includes(seen.quoteId) && path.endsWith('CL-000001.json')) ?? '')?.text ?? '';
    expect(seenNote).toContain('"exterior_color": "rojo"');
    expect(seenNote).toContain('"exterior_provenance": "human_declaration"');
    expect(seenNote).not.toContain('"exterior_color": "blanco"');
    const conflict = await paint('sintetico-bano-exterior', 'Baño exterior en negro');
    expect(conflict.color?.status).toBe('conflict');
    expect(memory.files.get('data/commercial/quotes/CQ-000007.json')?.text).toBe(stored);
    expect(memory.files.get(note ?? '')?.text).toContain('"requested_color": "plata"');
    expect(memory.files.get('data/commercial/quotes/CQ-000006.json')?.text).toBe(preserved);
  });
});
