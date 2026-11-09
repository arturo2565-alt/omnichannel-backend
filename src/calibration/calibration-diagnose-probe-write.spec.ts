import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CALIBRATION_DIAGNOSTIC_ENVIRONMENT_ID,
  CALIBRATION_DIAGNOSTIC_PROJECT_ID,
  CALIBRATION_DIAGNOSTIC_SERVICE_ID,
} from './calibration-diagnose';
import { readCalibrationProbeWriteDiagnostic } from './calibration-diagnose-probe-write-main';
import {
  CALIBRATION_PROBE_CERTIFICATION_KEY,
  assertProbeWriteRequest,
  calibrationProbeCertificationQuote,
  diagnoseCalibrationProbeWrite,
} from './calibration-diagnose-probe-write';
import { memoryGithub } from '../../test/calibration-memory-github';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function response(status: number, value: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => value } as Response;
}

function stagingEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
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
    ...overrides,
  };
}

function tokenPayload(overrides: Record<string, unknown> = {}) {
  return {
    token: 'ghs_installation_token_one',
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    permissions: { contents: 'write', metadata: 'read' },
    repository_selection: 'selected',
    ...overrides,
  };
}

function routed(github = memoryGithub(), mutate?: (input: RequestInfo | URL, init: RequestInit | undefined) => Response | null) {
  const calls: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const early = mutate?.(input, init);
    if (early) return early;
    if (method === 'POST' && url.includes('/access_tokens')) return response(201, tokenPayload());
    if (method === 'GET' && url.includes('/installation/repositories')) {
      return response(200, {
        total_count: 1,
        repositories: [{ full_name: 'arturo2565-alt/pegazuz-calibration-data' }],
      });
    }
    return github.transport(input, init);
  };
  return { github, calls, transport };
}

function putsOutsideProbe(calls: string[]) {
  return calls.filter((call) => {
    const method = call.slice(0, call.indexOf(' '));
    if (method !== 'PUT') return false;
    return !call.includes('/contents/data/probes/');
  });
}

describe('CAL-009D GitHub probe write diagnostic', () => {
  it('refuses routes outside data/probes and a real index write', () => {
    expect(() => assertProbeWriteRequest(
      'PUT',
      'https://api.github.com/repos/arturo2565-alt/pegazuz-calibration-data/contents/data/index.json',
    )).toThrow('Calibration probe write refused a request');
    expect(() => assertProbeWriteRequest(
      'GET',
      'https://api.github.com/repos/arturo2565-alt/pegazuz-calibration-data/contents/data/cases/AF-000001.json?ref=main',
    )).toThrow('Calibration probe write refused a request');
    expect(() => assertProbeWriteRequest(
      'PUT',
      'https://api.github.com/repos/arturo2565-alt/pegazuz-calibration-data/contents/data/probes/../index.json',
    )).toThrow('Calibration probe write refused a request');
    expect(() => assertProbeWriteRequest(
      'GET',
      'https://api.github.com/repos/arturo2565-alt/pegazuz-calibration-data/contents/data/index.json?ref=main',
    )).not.toThrow();
    const quote = JSON.stringify(calibrationProbeCertificationQuote());
    expect(quote).toContain(CALIBRATION_PROBE_CERTIFICATION_KEY);
    expect(quote).not.toContain('27b61d9ab76b915baa754954bfb34ec8');
    expect(quote).not.toContain('photo');
  });

  it('creates AF-900000, reads it back, and stays idempotent', async () => {
    const { github, calls, transport } = routed();
    const realBefore = github.files.get('data/index.json')!.text;
    const created = await diagnoseCalibrationProbeWrite(stagingEnv(), transport);
    expect(created).toMatchObject({
      result: 'ok',
      status: 'created',
      caseId: 'AF-900000',
      sourceKey: CALIBRATION_PROBE_CERTIFICATION_KEY,
      contentMatch: true,
      photoArchiveStatus: 'not_provided',
      photoCount: 0,
      probeCaseCount: 1,
      realCaseCountBefore: 1,
      realCaseCountAfter: 1,
      realIndexUnchanged: true,
    });
    const repeated = await diagnoseCalibrationProbeWrite(stagingEnv(), transport);
    expect(repeated).toMatchObject({
      result: 'ok',
      status: 'already_exists',
      caseId: 'AF-900000',
      probeCaseCount: 1,
      realCaseCountBefore: 1,
      realCaseCountAfter: 1,
      realIndexUnchanged: true,
    });
    expect(github.files.has('data/probes/cases/AF-900001.json')).toBe(false);
    expect(github.files.get('data/index.json')!.text).toBe(realBefore);
    expect(putsOutsideProbe(calls)).toEqual([]);
    expect(JSON.stringify(created)).not.toContain('ghs_');
    expect(JSON.stringify(created)).not.toContain('BEGIN');
  });

  it('rejects a different observation and an unknown probe index without writing over them', async () => {
    const first = routed();
    await diagnoseCalibrationProbeWrite(stagingEnv(), first.transport);
    const stored = first.github.files.get('data/probes/cases/AF-900000.json')!;
    const body = JSON.parse(stored.text) as { line_items: Array<{ price_mxn: number }> };
    body.line_items[0].price_mxn = 1400;
    first.github.files.set('data/probes/cases/AF-900000.json', { sha: stored.sha, text: JSON.stringify(body) });
    const conflict = await diagnoseCalibrationProbeWrite(stagingEnv(), first.transport);
    expect(conflict).toMatchObject({
      result: 'error',
      category: 'conflict',
      realCaseCountBefore: 1,
      realCaseCountAfter: 1,
      realIndexUnchanged: true,
    });
    expect(first.github.files.has('data/probes/cases/AF-900001.json')).toBe(false);

    const unknown = routed();
    const text = JSON.stringify({ schema_version: '1.0.0', archive: 'probe', extra: true, cases: {}, source_keys: {} });
    unknown.github.files.set('data/probes/index.json', { sha: 'probe-unknown', text });
    const refused = await diagnoseCalibrationProbeWrite(stagingEnv(), unknown.transport);
    expect(refused.category).toBe('invalid_index');
    expect(unknown.github.files.get('data/probes/index.json')!.text).toBe(text);
    expect(unknown.calls.some((call) => call.startsWith('PUT '))).toBe(false);
  });

  it('keeps an existing reserved case and reconciles one index SHA conflict', async () => {
    const existing = routed();
    const original = '{"locked":true}\n';
    existing.github.files.set('data/probes/index.json', {
      sha: 'probe-index',
      text: JSON.stringify({
        schema_version: '1.0.0',
        archive: 'probe',
        cases: { 'AF-900000': 'data/probes/cases/AF-900000.json' },
        source_keys: { 'probe-other-key': 'AF-900000' },
      }),
    });
    existing.github.files.set('data/probes/cases/AF-900000.json', { sha: 'occupied', text: original });
    const moved = await diagnoseCalibrationProbeWrite(stagingEnv(), existing.transport);
    expect(moved).toMatchObject({ result: 'ok', status: 'created', caseId: 'AF-900001', probeCaseCount: 2 });
    expect(existing.github.files.get('data/probes/cases/AF-900000.json')?.text).toBe(original);

    const partial = routed(memoryGithub({ failIndexWrites: 1 }));
    const recovered = await diagnoseCalibrationProbeWrite(stagingEnv(), partial.transport);
    expect(recovered).toMatchObject({
      result: 'ok',
      status: 'reconciled',
      caseId: 'AF-900000',
      probeCaseCount: 1,
      realIndexUnchanged: true,
    });
    expect(partial.github.files.has('data/probes/cases/AF-900001.json')).toBe(false);
  });

  it('stops after an index validation failure and refuses flags or a wider grant', async () => {
    const broken = routed(memoryGithub(), (_input, init) => {
      const method = init?.method ?? 'GET';
      if (method !== 'PUT') return null;
      const body = JSON.parse(String(init?.body ?? '{}')) as { sha?: string };
      if (!body.sha) return null;
      return response(422, { message: 'Validation Failed' });
    });
    const partial = await diagnoseCalibrationProbeWrite(stagingEnv(), broken.transport);
    expect(partial).toMatchObject({
      result: 'error',
      category: 'partial',
      realCaseCountBefore: 1,
      realCaseCountAfter: 1,
      realIndexUnchanged: true,
    });
    expect(JSON.parse(broken.github.files.get('data/probes/index.json')!.text).source_keys).toEqual({});
    const indexPuts = broken.calls.filter((call) => call.startsWith('PUT ') && call.includes('/data/probes/index.json'));
    expect(indexPuts).toHaveLength(2);

    const idle = jest.fn();
    await expect(diagnoseCalibrationProbeWrite(stagingEnv({
      CALIBRATION_INGEST_ENABLED: 'true',
    }), idle)).resolves.toMatchObject({ category: 'flags' });
    await expect(diagnoseCalibrationProbeWrite(stagingEnv({
      DB_SYNCHRONIZE: 'true',
    }), idle)).resolves.toMatchObject({ category: 'flags' });
    expect(idle).not.toHaveBeenCalled();

    const wide = routed(memoryGithub(), (input) => {
      if (String(input).includes('/access_tokens')) {
        return response(201, tokenPayload({ repository_selection: 'all' }));
      }
      return null;
    });
    const scoped = await diagnoseCalibrationProbeWrite(stagingEnv(), wide.transport);
    expect(scoped.category).toBe('scope');
    expect(wide.calls.some((call) => call.startsWith('PUT '))).toBe(false);
  });

  it('keeps the command out of the app and exits non-zero outside staging', async () => {
    const exitCodeBefore = process.exitCode;
    await expect(readCalibrationProbeWriteDiagnostic({})).resolves.toEqual({
      service: 'github-probe-write',
      result: 'error',
      category: 'wrong_target',
    });
    expect(process.exitCode).toBe(exitCodeBefore);
    const main = readFileSync(join(__dirname, 'calibration-diagnose-probe-write-main.ts'), 'utf8');
    const reader = main.slice(0, main.indexOf('export async function writeCalibrationProbeWriteDiagnostic'));
    expect(reader).not.toContain('process.exitCode');
    expect(main).toContain('process.exitCode = 1');
    const source = readFileSync(join(__dirname, 'calibration-diagnose-probe-write.ts'), 'utf8');
    expect(source).not.toContain('new CalibrationGithubWriter');
    expect(source).not.toContain('@Controller');
    expect(readFileSync(join(__dirname, 'calibration-diagnose-github-write.ts'), 'utf8')).not.toContain('ts-node');
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['diagnose:calibration-github-write']).toBe(
      'node dist/calibration/calibration-diagnose-github-write.js',
    );
    expect(readFileSync(join(__dirname, '../app.module.ts'), 'utf8')).not.toContain('CalibrationModule');

    const child = await runWriteCli();
    expect(child.code).toBe(1);
    expect(child.stdout).toContain('"category":"wrong_target"');
    expect(child.stdout).not.toContain('https://');
    expect(child.stdout).not.toContain('ghs_');
    expect(process.exitCode).toBe(exitCodeBefore);
  }, 20_000);
});

function runWriteCli(): Promise<{ code: number | null; stdout: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('RAILWAY_') || key.startsWith('CALIBRATION_') || key.startsWith('CLOUDINARY_')) {
      delete env[key];
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      require.resolve('ts-node/dist/bin.js'),
      '--skip-project',
      '--transpile-only',
      '--compiler-options',
      JSON.stringify({
        module: 'commonjs',
        moduleResolution: 'node',
        esModuleInterop: true,
        target: 'ES2023',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      }),
      join(__dirname, 'calibration-diagnose-github-write.ts'),
    ], { cwd: join(__dirname, '../..'), env });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}
