import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CALIBRATION_DIAGNOSTIC_ENVIRONMENT_ID,
  CALIBRATION_DIAGNOSTIC_PROJECT_ID,
  CALIBRATION_DIAGNOSTIC_SERVICE_ID,
} from './calibration-diagnose';
import { importRepairQuote } from './repair-quote-import';
import { RepairGithubWriter, assertRepairTransport } from './repair-quote-writer';
import { SeverityError, assertSeverityRead, assertSeverityWrite, type SeverityFiles } from './severity-annotation';
import { applySeverityImport } from './severity-import';

/**
 * Archivo en memoria. No abre expedientes reales ni el repositorio privado.
 */

function stagingEnv(): NodeJS.ProcessEnv {
  return {
    RAILWAY_ENVIRONMENT_NAME: 'staging',
    RAILWAY_SERVICE_NAME: 'pegazuz-backend-staging',
    RAILWAY_PROJECT_ID: CALIBRATION_DIAGNOSTIC_PROJECT_ID,
    RAILWAY_ENVIRONMENT_ID: CALIBRATION_DIAGNOSTIC_ENVIRONMENT_ID,
    RAILWAY_SERVICE_ID: CALIBRATION_DIAGNOSTIC_SERVICE_ID,
    CALIBRATION_INGEST_ENABLED: 'false',
    DB_SYNCHRONIZE: 'false',
  };
}

function response(status: number, value: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => value } as Response;
}

function memoryRepair() {
  const files = new Map<string, { text: string; sha: string }>();
  const calls: string[] = [];
  let serial = 1;
  const transport = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push(`${method} ${url}`);
    const marker = '/contents/';
    const path = decodeURIComponent(url.slice(url.indexOf(marker) + marker.length).split('?')[0]);
    if (!path.startsWith('data/repairs/')) throw new Error(`protected path ${path}`);
    if (method === 'GET') {
      const file = files.get(path);
      return file
        ? response(200, { sha: file.sha, content: Buffer.from(file.text).toString('base64') })
        : response(404, { message: 'Not Found' });
    }
    const body = JSON.parse(init?.body ?? '{}') as { content?: string; sha?: string };
    const existing = files.get(path);
    if (existing && body.sha !== existing.sha) return response(409, { message: 'Conflict' });
    if (existing && !body.sha) return response(422, { message: 'sha was not supplied' });
    if (!existing && body.sha) return response(409, { message: 'Conflict' });
    const sha = `commit-${serial}`;
    serial += 1;
    files.set(path, { text: Buffer.from(body.content ?? '', 'base64').toString('utf8'), sha });
    return response(201, { commit: { sha } });
  });
  return { files, calls, transport: transport as unknown as typeof fetch };
}

function annotations(files: Map<string, { text: string; sha: string }>, gate: { fail: boolean } = { fail: false }): SeverityFiles {
  return {
    async read(path) {
      assertSeverityRead(path);
      const file = files.get(path);
      return file ? { content: file.text, sha: file.sha } : null;
    },
    async write(path, content, sha) {
      if (gate.fail) throw new SeverityError('rejected');
      assertSeverityWrite(path);
      const current = files.get(path);
      if ((sha == null) !== (current == null) || (sha != null && current?.sha !== sha)) throw new SeverityError('conflict');
      files.set(path, { text: content, sha: `annotation-${files.size + 1}` });
    },
  };
}

function money(amount: number) {
  return { quoted: { amount_mxn: amount, validation: 'human_confirmed' } };
}

function quote(sourceKey: string, lines: unknown[], total: number, severity?: unknown) {
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
      make: null,
      make_evidence: 'unknown',
      model: 'Aveo',
      model_evidence: 'customer_provided',
      year: 2026,
      year_evidence: 'customer_provided',
      variant: null,
      variant_evidence: 'unknown',
    },
    lines,
    quoted_total_mxn: total,
    conditions: ['Tiempo estimado de 3 a 4 dias habiles.'],
    ...(severity === undefined ? {} : { severity }),
  };
}

function labor(part: string, kind: 'repair' | 'paint' | 'mount_and_paint', amount: number, lineId: string) {
  return { line_id: lineId, part, role: 'labor', labor: kind, prices: money(amount) };
}

function part(name: string, amount: number, lineId: string) {
  return { line_id: lineId, part: name, role: 'part', labor: null, prices: money(amount) };
}

function open() {
  const memory = memoryRepair();
  const gate = { fail: false };
  const writer = new RepairGithubWriter('ensayo', memory.transport);
  const files = annotations(memory.files, gate);
  const run = (input: unknown) => importRepairQuote(stagingEnv(), input, {
    archive: writer,
    severityFiles: files,
    clock: () => '2026-11-17T16:00:00.000Z',
  });
  return { memory, gate, run };
}

function notes(files: Map<string, { text: string }>) {
  return [...files.entries()].filter(([path]) => /SV-\d{6}\.json$/.test(path));
}

describe('CAL-021C severity on repair import', () => {
  it('classifies a repair and paint zone once and leaves both prices in the quote', async () => {
    const { memory, run } = open();
    const input = quote('sintetico-puerta-001', [
      labor('puerta delantera derecha', 'repair', 1800, 'L01'),
      labor('puerta delantera derecha', 'paint', 900, 'L02'),
    ], 2700, [
      { lineId: 'L01', assessment: 'visual_inference', level: 'medio' },
      { lineId: 'L02', assessment: 'visual_inference', level: 'medio' },
    ]);
    const report = await run(input);
    const stored = memory.files.get('data/repairs/quotes/RQ-000001.json')?.text ?? '';
    const saved = notes(memory.files);
    expect(report).toMatchObject({ result: 'ok', quoteId: 'RQ-000001', enriched: true });
    expect(report.severity?.items.every((item) => item.zoneId === 'rq:puerta delantera derecha')).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0][1].text).toContain('"treatment": "repair_paint"');
    expect(saved[0][1].text).toContain('"status": "proposed"');
    expect(saved[0][1].text).not.toContain('1800');
    expect(stored).toContain('"amount_mxn": 1800');
    expect(stored).toContain('"amount_mxn": 900');
  });

  it('classifies a replaced part and its mount as one zone', async () => {
    const { memory, run } = open();
    const report = await run(quote('sintetico-fascia-001', [
      part('fascia delantera', 2900, 'L01'),
      labor('fascia delantera', 'mount_and_paint', 3400, 'L02'),
    ], 6300, [{ lineId: 'L02', assessment: 'human_declaration', level: 'medio_fuerte' }]));
    const saved = notes(memory.files);
    expect(report.enriched).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0][1].text).toContain('"treatment": "replace_paint"');
    expect(saved[0][1].text).toContain('"provenance": "human_declaration"');
    expect(saved[0][1].text).toContain('"status": "proposed"');
    expect(saved[0][1].text).not.toContain('"status": "validated"');
    expect(memory.files.get('data/repairs/quotes/RQ-000001.json')?.text).toContain('"amount_mxn": 2900');
  });

  it('imports a quote that has no classification', async () => {
    const { memory, run } = open();
    const report = await run(quote('sintetico-sin-clase-001', [
      labor('cofre', 'repair', 700, 'L01'),
    ], 700));
    expect(report).toMatchObject({ result: 'ok', quoteId: 'RQ-000001' });
    expect(report.severity).toBeUndefined();
    expect(report.enriched).toBeUndefined();
    expect(notes(memory.files)).toHaveLength(0);
  });

  it('keeps the quote when the annotation fails and completes only that annotation later', async () => {
    const { memory, gate, run } = open();
    const input = quote('sintetico-pendiente-001', [
      labor('salpicadera izquierda', 'repair', 1100, 'L01'),
    ], 1100, [{ lineId: 'L01', assessment: 'visual_inference', level: 'leve' }]);
    gate.fail = true;
    const failed = await run(input);
    const stored = memory.files.get('data/repairs/quotes/RQ-000001.json')?.text;
    expect(failed).toMatchObject({ result: 'ok', enriched: false });
    expect(failed.severity?.status).toBe('pending');
    expect(notes(memory.files)).toHaveLength(0);
    gate.fail = false;
    const recovered = await run(input);
    expect(recovered).toMatchObject({ result: 'ok', status: 'already_exists', enriched: true });
    expect(recovered.severity?.status).toBe('recorded');
    expect(memory.files.get('data/repairs/quotes/RQ-000001.json')?.text).toBe(stored);
    expect(notes(memory.files)).toHaveLength(1);
  });

  it('does not duplicate an identical retry and keeps the first classification on conflict', async () => {
    const { memory, run } = open();
    const input = quote('sintetico-conflicto-001', [
      labor('puerta trasera izquierda', 'paint', 600, 'L01'),
    ], 600, [{ lineId: 'L01', assessment: 'visual_inference', level: 'medio_leve' }]);
    await run(input);
    const stored = memory.files.get('data/repairs/quotes/RQ-000001.json')?.text;
    const repeated = await run(input);
    expect(repeated.severity?.status).toBe('already_recorded');
    expect(notes(memory.files)).toHaveLength(1);
    const disagreed = quote('sintetico-conflicto-002', [
      labor('puerta', 'repair', 500, 'L01'),
      labor('puerta', 'paint', 400, 'L02'),
    ], 900, [
      { lineId: 'L01', assessment: 'visual_inference', level: 'leve' },
      { lineId: 'L02', assessment: 'visual_inference', level: 'fuerte' },
    ]);
    const fresh = open();
    const conflict = await fresh.run(disagreed);
    expect(conflict.enriched).toBe(false);
    expect(conflict.severity?.status).toBe('conflict');
    expect(notes(fresh.memory.files)).toHaveLength(0);
    const changed = await run({
      ...input,
      severity: [{ lineId: 'L01', assessment: 'visual_inference', level: 'fuerte' }],
    });
    expect(changed.severity?.status).toBe('conflict');
    expect(changed.enriched).toBe(false);
    expect(notes(memory.files)).toHaveLength(1);
    expect(notes(memory.files)[0][1].text).toContain('"level": "medio_leve"');
    expect(memory.files.get('data/repairs/quotes/RQ-000001.json')?.text).toBe(stored);
  });

  it('does not invent a level for a generic service or for missing evidence', async () => {
    const { memory, run } = open();
    const generic = await run(quote('sintetico-generico-001', [
      labor('Pintura', 'paint', 400, 'L01'),
    ], 400, [{ lineId: 'L01', assessment: 'visual_inference', level: 'fuerte' }]));
    expect(generic).toMatchObject({ result: 'ok', enriched: false });
    expect(generic.severity?.status).toBe('rejected');
    expect(notes(memory.files)).toHaveLength(0);
    expect(memory.files.get('data/repairs/quotes/RQ-000001.json')?.text).toContain('"amount_mxn": 400');
    const desk = open();
    const recorded = await desk.run(quote('sintetico-desconocido-001', [
      labor('cofre', 'repair', 700, 'L01'),
    ], 700, [{ lineId: 'L01', assessment: 'insufficient_evidence' }]));
    expect(recorded.enriched).toBe(true);
    expect(notes(desk.memory.files)[0][1].text).toContain('"status": "unknown"');
    expect(notes(desk.memory.files)[0][1].text).toContain('"level": null');
    const invented = await open().run(quote('sintetico-inventado-001', [
      labor('cofre', 'repair', 700, 'L01'),
    ], 700, [{ lineId: 'L01', assessment: 'insufficient_evidence', level: 'leve' }]));
    expect(invented).toMatchObject({ result: 'error', category: 'rejected' });
  });

  it('does not annotate a commercial quote and does not let importers confirm', async () => {
    const files = new Map<string, { text: string; sha: string }>();
    const report = await applySeverityImport(annotations(files), 'CQ-000006', [
      { lineId: 'L01', assessment: 'visual_inference', level: 'fuerte' },
    ]);
    expect(report).toMatchObject({ status: 'rejected', enriched: false, subjectId: 'CQ-000006' });
    expect(files.size).toBe(0);
    const prefix = 'https://api.github.com/repos/arturo2565-alt/pegazuz-calibration-data/contents/';
    expect(() => assertRepairTransport(`${prefix}data/annotations/severity/repairs/RQ-000010/index.json?ref=main`, 'GET')).not.toThrow();
    expect(() => assertRepairTransport(`${prefix}data/annotations/severity/visual/AF-000010/SV-000001.json`, 'PUT')).toThrow();
    const directory = __dirname;
    const commercial = readFileSync(join(directory, 'commercial-quote-import.ts'), 'utf8');
    expect(commercial).not.toContain('applySeverityImport');
    expect(commercial).not.toContain('importSeverityProposal');
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.ts') || name.endsWith('.spec.ts') || name === 'severity-import.ts') continue;
      if (!name.includes('import')) continue;
      const source = readFileSync(join(directory, name), 'utf8');
      expect(source).not.toContain('confirmSeverity');
      expect(source).not.toContain('operatorRole');
      expect(source).not.toContain('authenticated_owner');
      expect(source).not.toContain('EvidenceReviewDesk');
    }
  });
});
