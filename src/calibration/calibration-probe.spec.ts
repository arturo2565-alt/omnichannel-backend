import { readFileSync } from 'node:fs';
import { CalibrationGithubWriter } from './calibration-github-writer';
import {
  CALIBRATION_PROBE_FIRST_ID,
  CALIBRATION_PROBE_INDEX_PATH,
  CalibrationProbeWriter,
  assertProbeContentsPath,
  nextProbeCaseId,
  recordProbeObservation,
} from './calibration-probe';
import { memoryGithub } from '../../test/calibration-memory-github';

function quote(key = 'probe-cal-009c-001', price = 1250) {
  return {
    source: { kind: 'autofix_human_quote', source_case_key: key, quoted_at: null },
    vehicle: {
      make: 'Mazda',
      make_evidence: 'visual_inference',
      model: null,
      model_evidence: 'unknown',
      year: null,
      year_evidence: 'unknown',
      variant: null,
    },
    line_items: [
      {
        line_id: 'L1',
        part: 'salpicadera delantera derecha',
        treatment: 'repair_paint',
        price_mxn: price,
        damage_severity: 'unknown',
        validation: 'human_confirmed',
      },
    ],
    visual_observations: ['Deformación visible en el arco de la salpicadera.'],
    status: 'human_verified',
  };
}

function tracked(options?: { failIndexWrites?: number }) {
  const github = memoryGithub(options);
  const calls: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return github.transport(input, init);
  };
  return {
    github,
    calls,
    realBefore: github.files.get('data/index.json')!.text,
    writer: new CalibrationProbeWriter('test-token', transport),
  };
}

function assertClosed(calls: string[]) {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    const url = new URL(call.slice(call.indexOf(' ') + 1));
    expect(url.hostname).toBe('api.github.com');
    expect(url.pathname.startsWith('/repos/arturo2565-alt/pegazuz-calibration-data/contents/data/probes/')).toBe(true);
    expect(url.pathname.includes('/contents/data/index.json')).toBe(false);
    expect(url.pathname.includes('/contents/data/cases/')).toBe(false);
    expect(url.pathname.includes('AF-000001')).toBe(false);
  }
}

describe('CAL-009C probe space inside the private repository', () => {
  const fetchSpy = jest.spyOn(globalThis, 'fetch');

  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  afterAll(() => {
    fetchSpy.mockRestore();
  });

  it('initializes an empty probe index without reading the real counter', async () => {
    const { github, calls, realBefore, writer } = tracked();
    const created = await writer.ensureIndex();
    expect(created.index).toEqual({
      schema_version: '1.0.0',
      archive: 'probe',
      cases: {},
      source_keys: {},
    });
    expect(nextProbeCaseId([])).toBe(CALIBRATION_PROBE_FIRST_ID);
    expect(github.files.get('data/index.json')!.text).toBe(realBefore);
    expect(github.files.has('data/cases/AF-000001.json')).toBe(false);
    assertClosed(calls);
    const repeated = await writer.ensureIndex();
    expect(repeated.index.cases).toEqual({});
    expect(calls.filter((call) => call.startsWith('PUT '))).toHaveLength(1);
  });

  it('creates AF-900000 and reads the case and the probe index back', async () => {
    const { github, calls, realBefore, writer } = tracked();
    const created = await recordProbeObservation(writer, quote());
    expect(created).toMatchObject({
      status: 'created',
      caseId: 'AF-900000',
      photoArchiveStatus: 'not_provided',
      photoRefs: [],
    });
    expect(await writer.readCase('AF-900000')).toMatchObject({
      case_id: 'AF-900000',
      photo_refs: [],
      photo_archive_status: 'not_provided',
    });
    const index = await writer.readIndex();
    expect(index.archive).toBe('probe');
    expect(index.cases['AF-900000']).toBe('data/probes/cases/AF-900000.json');
    expect(github.files.get('data/index.json')!.text).toBe(realBefore);
    expect(JSON.stringify([...github.files.values()])).not.toContain('27b61d9ab76b915baa754954bfb34ec8');
    expect(JSON.stringify([...github.files.values()])).not.toContain('cal008-probe');
    assertClosed(calls);
  });

  it('keeps the same source key idempotent and rejects a different observation', async () => {
    const { github, writer } = tracked();
    await recordProbeObservation(writer, quote());
    const repeated = await recordProbeObservation(writer, quote());
    expect(repeated).toMatchObject({ status: 'already_exists', caseId: 'AF-900000' });
    await expect(recordProbeObservation(writer, quote('probe-cal-009c-001', 1400))).rejects.toThrow(
      'Source key already records a different observation',
    );
    expect(github.files.has('data/probes/cases/AF-900001.json')).toBe(false);
    expect(github.files.has('data/cases/AF-900000.json')).toBe(false);
  });

  it('reconciles one SHA 409 without a second case or a rewritten case file', async () => {
    const { github, calls, realBefore, writer } = tracked({ failIndexWrites: 1 });
    const result = await recordProbeObservation(writer, quote());
    expect(result).toMatchObject({ status: 'reconciled', caseId: 'AF-900000' });
    expect(github.files.has('data/probes/cases/AF-900001.json')).toBe(false);
    const index = JSON.parse(github.files.get(CALIBRATION_PROBE_INDEX_PATH)!.text) as {
      cases: Record<string, string>;
    };
    expect(index.cases['AF-900000']).toBe('data/probes/cases/AF-900000.json');
    expect(github.files.get('data/index.json')!.text).toBe(realBefore);
    assertClosed(calls);
  });

  it('does not overwrite a case file that already exists', async () => {
    const { github, writer } = tracked();
    await writer.ensureIndex();
    const original = '{"locked":true}\n';
    github.files.set('data/probes/cases/AF-900000.json', { sha: 'occupied', text: original });
    const hidden: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/data/probes/cases/AF-900000.json')) {
        return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) } as Response;
      }
      return github.transport(input, init);
    };
    const racing = new CalibrationProbeWriter('test-token', hidden);
    await expect(racing.insert({
      case_id: 'AF-900000',
      source: { kind: 'autofix_human_quote', source_case_key: 'probe-cal-009c-occupied' },
    })).rejects.toThrow('Case file already exists');
    expect(github.files.get('data/probes/cases/AF-900000.json')?.text).toBe(original);

    const moved = await recordProbeObservation(writer, quote('probe-cal-009c-002'));
    expect(moved.caseId).toBe('AF-900001');
    expect(github.files.get('data/probes/cases/AF-900000.json')?.text).toBe(original);
    expect(github.files.has('data/cases/AF-900001.json')).toBe(false);
    expect(github.files.has('data/index.json')).toBe(true);
  });

  it('rejects real paths, escapes, encodings, and AF-000001 before any request', () => {
    const refused = [
      'data/index.json',
      'data/cases/AF-000001.json',
      'data/cases/AF-900000.json',
      'data/photos/AF-900000/IMG-000001.json',
      'data/probes/cases/AF-000001.json',
      'data/probes/cases/AF-899999.json',
      'data/probes/../index.json',
      'data/probes/cases/../../data/index.json',
      'data/probes/./index.json',
      '/data/probes/index.json',
      'data/probes/%2e%2e/index.json',
      'data/probes/%2e%2e%2findex.json',
      'data/probes\\cases\\AF-900000.json',
      'data/probes/index.json?ref=main&path=../data/index.json',
      'data/probes/index.json?ref=dev',
    ];
    for (const path of refused) {
      expect(() => assertProbeContentsPath(path)).toThrow('Probe path is not allowed');
    }
    expect(assertProbeContentsPath('data/probes/index.json')).toBe('data/probes/index.json');
    expect(assertProbeContentsPath('data/probes/index.json?ref=main')).toBe('data/probes/index.json');
    expect(assertProbeContentsPath('data/probes/cases/AF-900000.json')).toBe('data/probes/cases/AF-900000.json');
    expect(() => nextProbeCaseId(['AF-000001'])).toThrow('Probe index contains a real case id');
  });

  it('refuses to store the real case id or the CAL-008 asset', async () => {
    const transport = jest.fn();
    const writer = new CalibrationProbeWriter('test-token', transport as unknown as typeof fetch);
    await expect(writer.insert({
      case_id: 'AF-000001',
      source: { kind: 'autofix_human_quote', source_case_key: 'probe-cal-009c-real' },
    })).rejects.toThrow('Probe case id is outside the reserved range');
    expect(transport).not.toHaveBeenCalled();
    const { github, calls, realBefore, writer: probe } = tracked();
    const foreign = quote();
    foreign.visual_observations = ['asset 27b61d9ab76b915baa754954bfb34ec8'];
    await expect(recordProbeObservation(probe, foreign)).rejects.toThrow(
      'Probe observation references a foreign archive',
    );
    expect(github.files.get('data/index.json')!.text).toBe(realBefore);
    expect(github.files.has(CALIBRATION_PROBE_INDEX_PATH)).toBe(false);
    expect(calls).toEqual([]);
    expect(readFileSync('src/calibration/calibration-github-writer.ts', 'utf8')).not.toContain(
      'pegazuz-calibration-probe',
    );
    expect(readFileSync('src/app.module.ts', 'utf8')).not.toContain('CalibrationModule');
    expect(() => new CalibrationGithubWriter(
      'test-token',
      transport as unknown as typeof fetch,
      'arturo2565-alt/pegazuz-calibration-probe',
    )).toThrow('Calibration GitHub repository is not allowed');
  });
});
