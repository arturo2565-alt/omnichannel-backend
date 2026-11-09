import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAL010_CLOUDINARY_PREFIX,
  type CloudinaryGateway,
  type CloudinaryReceipt,
} from './calibration-cloudinary-archive';
import {
  CALIBRATION_DIAGNOSTIC_ENVIRONMENT_ID,
  CALIBRATION_DIAGNOSTIC_PROJECT_ID,
  CALIBRATION_DIAGNOSTIC_SERVICE_ID,
} from './calibration-diagnose';
import {
  assertIntegratedCloudinaryRequest,
  diagnoseCalibrationIntegrated,
} from './calibration-diagnose-integrated';
import { readCalibrationIntegratedDiagnostic } from './calibration-diagnose-integrated-main';
import { assertProbeWriteRequest } from './calibration-diagnose-probe-write';
import { CalibrationProbeWriter } from './calibration-probe';
import {
  CAL010_SOURCE_KEY,
  createCal010PhotoArchive,
  recordCal010Observation,
  syntheticCal010Image,
} from './calibration-probe-flow';
import { memoryGithub } from '../../test/calibration-memory-github';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const image = syntheticCal010Image();
const imageSha = createHash('sha256').update(image).digest('hex');

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
    CLOUDINARY_CLOUD_NAME: 'pegazuz-staging',
    CLOUDINARY_API_KEY: '123456789012345',
    CLOUDINARY_API_SECRET: 'staging-secret',
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

function floorIndex() {
  return `${JSON.stringify({
    schema_version: '1.0.0',
    archive: 'probe',
    cases: { 'AF-900000': 'data/probes/cases/AF-900000.json' },
    source_keys: { 'probe-cal-009d-001': 'AF-900000' },
  }, null, 2)}\n`;
}

function seed(github: ReturnType<typeof memoryGithub>) {
  const protectedCase = '{"case_id":"AF-900000","locked":true}\n';
  github.files.set('data/probes/index.json', { sha: 'probe-floor', text: floorIndex() });
  github.files.set('data/probes/cases/AF-900000.json', { sha: 'case-900000', text: protectedCase });
  return { protectedCase, realIndex: github.files.get('data/index.json')!.text };
}

function gateway(options?: {
  failUploads?: number;
  failAfter?: number;
  wrongPublicId?: boolean;
  download?: Buffer;
}): CloudinaryGateway & { uploads: string[] } {
  const uploads: string[] = [];
  let failures = options?.failUploads ?? 0;
  let succeeded = 0;
  return {
    uploads,
    async uploadAuthenticated({ publicId, bytes }) {
      if (options?.failAfter != null && succeeded >= options.failAfter) throw new Error('asset already stored');
      if (failures > 0) {
        failures -= 1;
        throw new Error('asset already stored');
      }
      uploads.push(publicId);
      succeeded += 1;
      const receipt: CloudinaryReceipt = {
        assetId: 'asset-cal010',
        publicId: options?.wrongPublicId ? 'pegazuz_calibration/cal008-probe/AF-008008/other' : publicId,
        version: 11,
        bytes: bytes.length,
        format: 'jpg',
        type: 'authenticated',
        resourceType: 'image',
      };
      return receipt;
    },
    async downloadAuthenticated({ publicId }) {
      if (!publicId.startsWith(`${CAL010_CLOUDINARY_PREFIX}/`)) throw new Error('foreign photo prefix');
      return options?.download ?? Buffer.from(image);
    },
  };
}

function counting(cloud: ReturnType<typeof gateway>) {
  const archive = createCal010PhotoArchive(cloud);
  let calls = 0;
  return {
    calls: () => calls,
    store: async (input: { caseId: string; bytes: Buffer }) => {
      calls += 1;
      return archive.store(input);
    },
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
  return calls.filter((call) => call.startsWith('PUT ') && !call.includes('/contents/data/probes/'));
}

describe('CAL-010.1 integrated calibration diagnostic', () => {
  it('rejects GitHub and Cloudinary routes outside the probe', () => {
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
      'PUT',
      'https://api.github.com/repos/arturo2565-alt/pegazuz-calibration-data/contents/data/probes/photos/AF-900001/IMG-000001.json',
    )).not.toThrow();
    expect(() => assertIntegratedCloudinaryRequest(
      'https://res.cloudinary.com/pegazuz/image/upload/pegazuz_calibration/cal008-probe/AF-008008/x',
    )).toThrow('Calibration probe write refused a request');
    expect(() => assertIntegratedCloudinaryRequest('https://api.github.com/repos/arturo2565-alt/pegazuz-calibration-data')).toThrow();
    expect(() => assertIntegratedCloudinaryRequest(
      `https://res.cloudinary.com/pegazuz/${CAL010_CLOUDINARY_PREFIX}/AF-900001/${imageSha.slice(0, 32)}`,
    )).not.toThrow();
  });

  it('creates one observation and a second run does not create another photo or case', async () => {
    const { github, calls, transport } = routed();
    const baseline = seed(github);
    const cloud = gateway();
    const photos = counting(cloud);
    const created = await diagnoseCalibrationIntegrated(stagingEnv(), { transport, photos });
    expect(created).toMatchObject({
      service: 'calibration-integrated',
      result: 'ok',
      status: 'created',
      caseId: 'AF-900001',
      sourceKey: CAL010_SOURCE_KEY,
      photoRef: 'IMG-000001',
      contentMatch: true,
      manifestMatch: true,
      photoArchiveStatus: 'archived_private',
      probeCaseCount: 2,
      realCaseCountBefore: 1,
      realCaseCountAfter: 1,
      realIndexUnchanged: true,
      protectedCaseUnchanged: true,
    });
    const repeated = await diagnoseCalibrationIntegrated(stagingEnv(), { transport, photos });
    expect(repeated).toMatchObject({
      result: 'ok',
      status: 'already_exists',
      caseId: 'AF-900001',
      probeCaseCount: 2,
      realCaseCountBefore: 1,
      realCaseCountAfter: 1,
      realIndexUnchanged: true,
      protectedCaseUnchanged: true,
    });
    expect(photos.calls()).toBe(1);
    expect(cloud.uploads).toEqual([`${CAL010_CLOUDINARY_PREFIX}/AF-900001/${imageSha.slice(0, 32)}`]);
    expect(github.files.has('data/probes/cases/AF-900002.json')).toBe(false);
    expect(github.files.get('data/probes/cases/AF-900000.json')!.text).toBe(baseline.protectedCase);
    expect(github.files.get('data/index.json')!.text).toBe(baseline.realIndex);
    expect(putsOutsideProbe(calls)).toEqual([]);
    expect(calls.some((call) => call.includes('AF-000001'))).toBe(false);
    expect(JSON.stringify([created, repeated])).not.toContain('ghs_');
    expect(JSON.stringify([created, repeated])).not.toContain('https://');
    expect(JSON.stringify([created, repeated])).not.toContain('27b61d9ab76b915baa754954bfb34ec8');
    expect(JSON.stringify([...github.files.values()])).not.toContain('cal008-probe');
  });

  it('reports partial when Cloudinary confirms and the manifest write fails, then recovers once', async () => {
    const github = memoryGithub();
    seed(github);
    let manifestFailures = 1;
    const { calls, transport } = routed(github, (input, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'PUT' && String(input).includes('/data/probes/photos/') && manifestFailures > 0) {
        manifestFailures -= 1;
        return response(500, { message: 'unavailable' });
      }
      return null;
    });
    const cloud = gateway({ failAfter: 1 });
    const photos = counting(cloud);
    const pending = await diagnoseCalibrationIntegrated(stagingEnv(), { transport, photos });
    expect(pending).toMatchObject({
      result: 'error',
      category: 'partial',
      status: 'partial',
      caseId: 'AF-900001',
      realIndexUnchanged: true,
      protectedCaseUnchanged: true,
    });
    expect(github.files.has('data/probes/photos/AF-900001/IMG-000001.json')).toBe(false);
    expect(github.files.has('data/probes/cases/AF-900002.json')).toBe(false);
    const recovered = await diagnoseCalibrationIntegrated(stagingEnv(), { transport, photos });
    expect(recovered).toMatchObject({
      result: 'ok',
      status: 'already_exists',
      caseId: 'AF-900001',
      manifestMatch: true,
      probeCaseCount: 2,
    });
    expect(photos.calls()).toBe(2);
    expect(cloud.uploads).toHaveLength(1);
    expect(putsOutsideProbe(calls)).toEqual([]);
  });

  it('links a verified manifest that the case does not reference yet', async () => {
    const github = memoryGithub();
    seed(github);
    let blocked = true;
    const direct: typeof fetch = async (input, init) => {
      const method = init?.method ?? 'GET';
      if (blocked && method === 'PUT' && String(input).includes('/data/probes/cases/AF-900001.json')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { sha?: string };
        if (body.sha) return response(500, { message: 'unavailable' });
      }
      return github.transport(input, init);
    };
    const cloud = gateway();
    await recordCal010Observation(new CalibrationProbeWriter('test-token', direct), createCal010PhotoArchive(cloud), {
      maxTransientAttempts: 0,
    });
    expect(github.files.has('data/probes/photos/AF-900001/IMG-000001.json')).toBe(true);
    const stored = JSON.parse(github.files.get('data/probes/cases/AF-900001.json')!.text) as { photo_refs: string[] };
    expect(stored.photo_refs).toEqual([]);
    blocked = false;
    const { transport } = routed(github);
    const photos = counting(gateway());
    const linked = await diagnoseCalibrationIntegrated(stagingEnv(), { transport, photos });
    expect(linked).toMatchObject({
      result: 'ok',
      status: 'already_exists',
      caseId: 'AF-900001',
      photoRef: 'IMG-000001',
      contentMatch: true,
      manifestMatch: true,
      probeCaseCount: 2,
    });
    expect(photos.calls()).toBe(0);
    expect(cloud.uploads).toHaveLength(1);
  });

  it('accepts an existing photograph with the same SHA-256 and stops when the bytes differ', async () => {
    const same = routed();
    seed(same.github);
    const sameCloud = gateway({ failUploads: 1 });
    const samePhotos = counting(sameCloud);
    const created = await diagnoseCalibrationIntegrated(stagingEnv(), { transport: same.transport, photos: samePhotos });
    expect(created).toMatchObject({ result: 'ok', status: 'created', caseId: 'AF-900001', manifestMatch: true });
    expect(sameCloud.uploads).toEqual([]);
    expect(samePhotos.calls()).toBe(1);
    const again = await diagnoseCalibrationIntegrated(stagingEnv(), { transport: same.transport, photos: samePhotos });
    expect(again.status).toBe('already_exists');
    expect(samePhotos.calls()).toBe(1);

    const other = routed();
    seed(other.github);
    const otherCloud = gateway({ failUploads: 1, download: Buffer.from([0xff, 0xd8, 0xff, 0x0b]) });
    const otherPhotos = counting(otherCloud);
    const pending = await diagnoseCalibrationIntegrated(stagingEnv(), { transport: other.transport, photos: otherPhotos });
    expect(pending).toMatchObject({ result: 'error', category: 'partial', status: 'partial', caseId: 'AF-900001' });
    expect(other.github.files.has('data/probes/photos/AF-900001/IMG-000001.json')).toBe(false);
    expect(otherPhotos.calls()).toBe(1);
    expect(other.github.files.has('data/probes/cases/AF-900002.json')).toBe(false);
  });

  it('stops when an existing manifest or case has different content', async () => {
    const { github, transport } = routed();
    seed(github);
    const photos = counting(gateway());
    await diagnoseCalibrationIntegrated(stagingEnv(), { transport, photos });
    const manifestPath = 'data/probes/photos/AF-900001/IMG-000001.json';
    const manifestFile = github.files.get(manifestPath)!;
    const manifest = JSON.parse(manifestFile.text) as { content_sha256: string };
    manifest.content_sha256 = 'a'.repeat(64);
    github.files.set(manifestPath, { sha: manifestFile.sha, text: JSON.stringify(manifest) });
    const photoConflict = await diagnoseCalibrationIntegrated(stagingEnv(), { transport, photos });
    expect(photoConflict).toMatchObject({
      result: 'error',
      category: 'conflict',
      realIndexUnchanged: true,
      protectedCaseUnchanged: true,
    });
    expect(photos.calls()).toBe(1);
    expect(github.files.has('data/probes/cases/AF-900002.json')).toBe(false);

    const replaced = routed();
    seed(replaced.github);
    const replacedPhotos = counting(gateway());
    await diagnoseCalibrationIntegrated(stagingEnv(), { transport: replaced.transport, photos: replacedPhotos });
    const casePath = 'data/probes/cases/AF-900001.json';
    const caseFile = replaced.github.files.get(casePath)!;
    const body = JSON.parse(caseFile.text) as { line_items: Array<{ price_mxn: number }> };
    body.line_items[0].price_mxn = 1400;
    replaced.github.files.set(casePath, { sha: caseFile.sha, text: JSON.stringify(body) });
    const caseConflict = await diagnoseCalibrationIntegrated(stagingEnv(), {
      transport: replaced.transport,
      photos: replacedPhotos,
    });
    expect(caseConflict).toMatchObject({ result: 'error', category: 'conflict', realIndexUnchanged: true });
    expect(replacedPhotos.calls()).toBe(1);
    expect(replaced.github.files.has('data/probes/cases/AF-900002.json')).toBe(false);
  });

  it('stops on the wrong environment, a missing index, or an unexpected index', async () => {
    const idle = jest.fn();
    await expect(diagnoseCalibrationIntegrated({}, { transport: idle })).resolves.toMatchObject({ category: 'wrong_target' });
    await expect(diagnoseCalibrationIntegrated(stagingEnv({
      CALIBRATION_INGEST_ENABLED: 'true',
    }), { transport: idle })).resolves.toMatchObject({ category: 'flags' });
    await expect(diagnoseCalibrationIntegrated(stagingEnv({
      DB_SYNCHRONIZE: 'true',
    }), { transport: idle })).resolves.toMatchObject({ category: 'flags' });
    expect(idle).not.toHaveBeenCalled();

    const missing = routed();
    const missingPhotos = counting(gateway());
    const missingReport = await diagnoseCalibrationIntegrated(stagingEnv(), {
      transport: missing.transport,
      photos: missingPhotos,
    });
    expect(missingReport).toMatchObject({ result: 'error', category: 'invalid_index', realIndexUnchanged: true });
    expect(missing.calls.some((call) => call.startsWith('PUT '))).toBe(false);
    expect(missingPhotos.calls()).toBe(0);

    const unexpected = routed();
    const text = JSON.stringify({ schema_version: '1.0.0', archive: 'probe', extra: true, cases: {}, source_keys: {} });
    unexpected.github.files.set('data/probes/index.json', { sha: 'probe-unknown', text });
    const refused = await diagnoseCalibrationIntegrated(stagingEnv(), {
      transport: unexpected.transport,
      photos: counting(gateway()),
    });
    expect(refused.category).toBe('invalid_index');
    expect(unexpected.github.files.get('data/probes/index.json')!.text).toBe(text);
    expect(unexpected.calls.some((call) => call.startsWith('PUT '))).toBe(false);

    const wide = routed(memoryGithub(), (input) => {
      if (String(input).includes('/access_tokens')) return response(201, tokenPayload({ repository_selection: 'all' }));
      return null;
    });
    seed(wide.github);
    const scoped = await diagnoseCalibrationIntegrated(stagingEnv(), { transport: wide.transport, photos: counting(gateway()) });
    expect(scoped.category).toBe('scope');
    expect(wide.calls.some((call) => call.startsWith('PUT '))).toBe(false);
  });

  it('does not treat a lost response as proof that nothing was written', async () => {
    const github = memoryGithub();
    seed(github);
    let putFailed = false;
    const { transport } = routed(github, (input, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'PUT' && !putFailed) {
        putFailed = true;
        throw new Error('socket hang up');
      }
      if (putFailed && method === 'GET' && String(input).includes('/contents/data/index.json')) {
        throw new Error('socket hang up');
      }
      return null;
    });
    const photos = counting(gateway());
    const lost = await diagnoseCalibrationIntegrated(stagingEnv(), { transport, photos });
    expect(lost).toMatchObject({ result: 'error', category: 'partial' });
    expect(lost.realIndexUnchanged).not.toBe(true);
    expect(photos.calls()).toBe(0);
    expect(github.files.has('data/probes/cases/AF-900001.json')).toBe(false);
  });

  it('keeps the command out of the app and exits non-zero outside staging', async () => {
    const exitCodeBefore = process.exitCode;
    await expect(readCalibrationIntegratedDiagnostic({})).resolves.toEqual({
      service: 'calibration-integrated',
      result: 'error',
      category: 'wrong_target',
    });
    expect(process.exitCode).toBe(exitCodeBefore);
    const main = readFileSync(join(__dirname, 'calibration-diagnose-integrated-main.ts'), 'utf8');
    const reader = main.slice(0, main.indexOf('export async function writeCalibrationIntegratedDiagnostic'));
    expect(reader).not.toContain('process.exitCode');
    expect(main).toContain('process.exitCode = 1');
    const source = readFileSync(join(__dirname, 'calibration-diagnose-integrated.ts'), 'utf8');
    expect(source).not.toContain('new CalibrationGithubWriter');
    expect(source).not.toContain('new CalibrationCloudinaryArchive');
    expect(source).toContain('recordCal010Observation');
    expect(source).toContain('createCal010PhotoArchive');
    expect(source).not.toContain('@Controller');
    expect(readFileSync(join(__dirname, 'calibration-diagnose-integrated-run.ts'), 'utf8')).not.toContain('ts-node');
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['diagnose:calibration-integrated']).toBe(
      'node dist/calibration/calibration-diagnose-integrated-run.js',
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
      join(__dirname, 'calibration-diagnose-integrated-run.ts'),
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
