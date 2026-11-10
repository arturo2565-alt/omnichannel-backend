import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { CalibrationCloudinaryArchive, type CloudinaryGateway } from './calibration-cloudinary-archive';
import {
  CALIBRATION_DIAGNOSTIC_ENVIRONMENT_ID,
  CALIBRATION_DIAGNOSTIC_PROJECT_ID,
  CALIBRATION_DIAGNOSTIC_SERVICE_ID,
} from './calibration-diagnose';
import { CalibrationValidationError } from './calibration-case';
import {
  assertRealImportRequest,
  importCalibrationCase,
  loadCalibrationImportFile,
  prepareCalibrationImport,
  readCalibrationImportDocument,
} from './calibration-import';
import { readCalibrationImport } from './calibration-import-main';
import { minimalDecodablePng } from './calibration-image-archive.service';
import { memoryGithub } from '../../test/calibration-memory-github';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const first = minimalDecodablePng([16, 32, 48]);
const second = minimalDecodablePng([1, 2, 3]);
const PROTECTED = '{"case_id":"AF-000001","photo_refs":[],"photo_archive_status":"pending_private_archive"}\n';

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

function tokenPayload() {
  return {
    token: 'ghs_installation_token_one',
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    permissions: { contents: 'write', metadata: 'read' },
    repository_selection: 'selected',
  };
}

function quote(price = 1250, key = 'autofix-sim-0001') {
  return {
    source_case_key: key,
    quoted_at: null,
    human_verified: true as const,
    vehicle: {
      make: 'Mazda',
      make_evidence: 'customer_provided',
      model: '3',
      model_evidence: 'customer_provided',
      year: 2019,
      year_evidence: 'customer_provided',
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
    visual_observations: [],
    images: [first, second],
  };
}

function seed(github: ReturnType<typeof memoryGithub>) {
  github.files.set('data/cases/AF-000001.json', { sha: 'case-000001', text: PROTECTED });
}

function archive() {
  const stored = new Map<string, Buffer>();
  const uploads: string[] = [];
  let failures = 0;
  const gateway: CloudinaryGateway = {
    async uploadAuthenticated({ publicId, bytes }) {
      if (failures > 0) {
        failures -= 1;
        throw new Error('provider rejected the asset');
      }
      stored.set(publicId, Buffer.from(bytes));
      uploads.push(publicId);
      return {
        assetId: 'asset-import',
        publicId,
        version: 21,
        bytes: bytes.length,
        format: 'png',
        type: 'authenticated',
        resourceType: 'image',
      };
    },
    async downloadAuthenticated({ publicId }) {
      const bytes = stored.get(publicId);
      if (!bytes) throw new Error('missing asset');
      return bytes;
    },
  };
  return {
    uploads,
    photos: new CalibrationCloudinaryArchive(gateway),
    fail(count: number) {
      failures = count;
    },
  };
}

function routed(github = memoryGithub(), mutate?: (method: string, url: string) => Response | null) {
  seed(github);
  const calls: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const early = mutate?.(method, url);
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

describe('CAL-011A private human import', () => {
  it('keeps real writes on the authorized paths', () => {
    const prefix = 'https://api.github.com/repos/arturo2565-alt/pegazuz-calibration-data/contents/';
    expect(() => assertRealImportRequest('GET', `${prefix}data/index.json?ref=main`)).not.toThrow();
    expect(() => assertRealImportRequest('GET', `${prefix}data/cases/AF-000001.json?ref=main`)).not.toThrow();
    expect(() => assertRealImportRequest('PUT', `${prefix}data/index.json`)).not.toThrow();
    expect(() => assertRealImportRequest('PUT', `${prefix}data/cases/AF-000002.json`)).not.toThrow();
    expect(() => assertRealImportRequest('PUT', `${prefix}data/photos/AF-000002/IMG-000001.json`)).not.toThrow();
    expect(() => assertRealImportRequest('PUT', `${prefix}data/cases/AF-000001.json`)).toThrow('Calibration import refused a request');
    expect(() => assertRealImportRequest('PUT', `${prefix}data/probes/index.json`)).toThrow('Calibration import refused a request');
    expect(() => assertRealImportRequest('PUT', `${prefix}data/cases/AF-900001.json`)).toThrow('Calibration import refused a request');
    expect(() => assertRealImportRequest('PUT', `${prefix}data/photos/AF-900001/IMG-000001.json`)).toThrow('Calibration import refused a request');
  });

  it('records a verified quote and two original photographs', async () => {
    const route = routed();
    const photos = archive();
    const report = await importCalibrationCase(stagingEnv(), quote(), {
      transport: route.transport,
      photos: photos.photos,
      clock: () => '2026-11-10T18:00:00.000Z',
    });
    expect(report).toMatchObject({
      result: 'ok',
      status: 'created',
      caseId: 'AF-000002',
      sourceKey: 'autofix-sim-0001',
      photoRefs: ['IMG-000001', 'IMG-000002'],
      duplicateImages: 0,
      contentMatch: true,
      manifestMatch: true,
      photoArchiveStatus: 'archived_private',
      realCaseCountBefore: 1,
      realCaseCountAfter: 2,
      protectedCaseUnchanged: true,
    });
    expect(photos.uploads).toEqual([
      expect.stringMatching(/^pegazuz_calibration\/AF-000002\//),
      expect.stringMatching(/^pegazuz_calibration\/AF-000002\//),
    ]);
    expect(route.github.files.get('data/cases/AF-000001.json')?.text).toBe(PROTECTED);
    expect([...route.github.files.keys()].some((path) => path.startsWith('data/probes/'))).toBe(false);
  });

  it('repeats the same source key without another case or photograph', async () => {
    const route = routed();
    const photos = archive();
    const deps = { transport: route.transport, photos: photos.photos, clock: () => '2026-11-10T18:00:00.000Z' };
    await importCalibrationCase(stagingEnv(), quote(), deps);
    const repeated = await importCalibrationCase(stagingEnv(), { ...quote(), images: [first, second, first] }, deps);
    expect(repeated).toMatchObject({
      result: 'ok',
      status: 'already_exists',
      caseId: 'AF-000002',
      photoRefs: ['IMG-000001', 'IMG-000002'],
      duplicateImages: 1,
      realCaseCountAfter: 2,
      protectedCaseUnchanged: true,
    });
    expect(photos.uploads).toHaveLength(2);
    expect(route.github.files.has('data/cases/AF-000003.json')).toBe(false);
  });

  it('rejects an invalid quote and an invalid photograph before any write', async () => {
    const route = routed();
    const photos = archive();
    const invalidQuote = await importCalibrationCase(stagingEnv(), {
      ...quote(0),
    }, { transport: route.transport, photos: photos.photos });
    const invalidImage = await importCalibrationCase(stagingEnv(), {
      ...quote(),
      images: [Buffer.from([0xff, 0xd8, 0xff, 0x0a, 0x10, 0x01])],
    }, { transport: route.transport, photos: photos.photos });
    const personal = await importCalibrationCase(stagingEnv(), {
      ...quote(),
      line_items: [{ ...quote().line_items[0], part: 'cliente@example.com' }],
    }, { transport: route.transport, photos: photos.photos });
    expect(invalidQuote.category).toBe('invalid');
    expect(invalidImage.category).toBe('invalid');
    expect(personal.category).toBe('invalid');
    expect(route.calls).toHaveLength(0);
    expect(photos.uploads).toHaveLength(0);
    expect(route.github.files.has('data/cases/AF-000002.json')).toBe(false);
  });

  it('keeps the case after an upload failure and recovers it without a new id', async () => {
    const route = routed();
    const photos = archive();
    photos.fail(1);
    const deps = {
      transport: route.transport,
      photos: photos.photos,
      clock: () => '2026-11-10T18:00:00.000Z',
      maxTransientAttempts: 0,
    };
    const failed = await importCalibrationCase(stagingEnv(), quote(), deps);
    expect(failed).toMatchObject({
      result: 'error',
      category: 'partial',
      status: 'partial',
      caseId: 'AF-000002',
      storageFailure: 'upload_rejected',
      realCaseCountAfter: 2,
      protectedCaseUnchanged: true,
    });
    expect(route.github.files.has('data/photos/AF-000002/IMG-000001.json')).toBe(false);
    photos.fail(0);
    const recovered = await importCalibrationCase(stagingEnv(), quote(), deps);
    expect(recovered).toMatchObject({
      result: 'ok',
      status: 'already_exists',
      caseId: 'AF-000002',
      photoArchiveStatus: 'archived_private',
      realCaseCountAfter: 2,
    });
    expect(route.github.files.has('data/cases/AF-000003.json')).toBe(false);
  });

  it('keeps the case after a manifest failure and links it on the next run', async () => {
    const route = routed(memoryGithub(), (method, url) => {
      if (method === 'PUT' && url.includes('/contents/data/photos/')) return response(500, { message: 'unavailable' });
      return null;
    });
    const photos = archive();
    const failed = await importCalibrationCase(stagingEnv(), quote(), {
      transport: route.transport,
      photos: photos.photos,
      clock: () => '2026-11-10T18:00:00.000Z',
      maxTransientAttempts: 0,
    });
    expect(failed).toMatchObject({
      result: 'error',
      category: 'partial',
      caseId: 'AF-000002',
      protectedCaseUnchanged: true,
    });
    const open = routed(route.github);
    const recovered = await importCalibrationCase(stagingEnv(), quote(), {
      transport: open.transport,
      photos: photos.photos,
      clock: () => '2026-11-10T18:00:00.000Z',
    });
    expect(recovered).toMatchObject({
      result: 'ok',
      caseId: 'AF-000002',
      photoRefs: ['IMG-000001', 'IMG-000002'],
      realCaseCountAfter: 2,
      protectedCaseUnchanged: true,
    });
    expect(route.github.files.has('data/cases/AF-000003.json')).toBe(false);
    expect(route.github.files.get('data/cases/AF-000001.json')?.text).toBe(PROTECTED);
  });

  it('stops when the source key already records a different observation', async () => {
    const route = routed();
    const photos = archive();
    const deps = { transport: route.transport, photos: photos.photos, clock: () => '2026-11-10T18:00:00.000Z' };
    await importCalibrationCase(stagingEnv(), quote(), deps);
    const conflict = await importCalibrationCase(stagingEnv(), quote(1800), deps);
    const reserved = await importCalibrationCase(stagingEnv(), quote(1250, 'probe-cal-010-001'), deps);
    const protectedKey = await importCalibrationCase(stagingEnv(), quote(1250, 'seed-case-000001'), deps);
    expect(conflict).toMatchObject({ category: 'conflict', protectedCaseUnchanged: true });
    expect(reserved.category).toBe('conflict');
    expect(protectedKey).toMatchObject({ category: 'conflict', protectedCaseUnchanged: true });
    expect(photos.uploads).toHaveLength(2);
    expect(route.github.files.has('data/cases/AF-000003.json')).toBe(false);
    expect(route.calls.filter((call) => call.startsWith('PUT ') && call.includes('AF-000001'))).toHaveLength(0);
    expect(route.calls.some((call) => call.includes('data/probes') || call.includes('cal010-probe') || call.includes('cal008-probe'))).toBe(false);
  });

  it('reads photographs only from the import directory', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => {
      throw new Error('external write');
    });
    const root = mkdtempSync(join(tmpdir(), 'cal-011b-'));
    const outside = mkdtempSync(join(tmpdir(), 'cal-011b-outside-'));
    const marker = 'OUTSIDE-CANARY-PATH';
    try {
      writeFileSync(join(root, 'frente.png'), first);
      writeFileSync(join(outside, 'secret.png'), Buffer.from(marker));
      writeFileSync(join(root, 'caso.json'), JSON.stringify({ ...quote(), images: ['frente.png'] }));
      const loaded = loadCalibrationImportFile(join(root, 'caso.json'));
      expect(loaded.images).toHaveLength(1);
      expect(JSON.stringify(loaded.quote)).not.toContain(root);
      expect(JSON.stringify(loaded.quote)).not.toContain('frente.png');
      const route = routed();
      const stored = await importCalibrationCase(stagingEnv(), { ...quote(), images: loaded.images }, {
        transport: route.transport,
        photos: archive().photos,
        clock: () => '2026-11-10T18:00:00.000Z',
      });
      expect(stored).toMatchObject({ result: 'ok', caseId: 'AF-000002', protectedCaseUnchanged: true });
      expect(JSON.stringify(stored)).not.toContain(basename(root));
      for (const file of route.github.files.values()) {
        expect(file.text).not.toContain(basename(root));
        expect(file.text).not.toContain(marker);
        expect(file.text).not.toContain('/Users');
        expect(file.text).not.toContain('https://');
        expect(file.text).not.toContain('ghs_');
      }
      expect(route.calls.every((call) => call.includes('https://api.github.com/'))).toBe(true);

      writeFileSync(join(root, 'absolute.json'), JSON.stringify({ ...quote(), images: [join(outside, 'secret.png')] }));
      writeFileSync(join(root, 'parent.json'), JSON.stringify({ ...quote(), images: [`../${outside.split('/').pop()}/secret.png`] }));
      writeFileSync(join(root, 'missing.json'), JSON.stringify({ ...quote(), images: ['ausente.png'] }));
      writeFileSync(join(root, 'corrupt.json'), JSON.stringify({ ...quote(), images: ['roto.png'] }));
      writeFileSync(join(root, 'roto.png'), Buffer.from('not-an-image'));
      symlinkSync(join(outside, 'secret.png'), join(root, 'enlace.png'));
      writeFileSync(join(root, 'symlink.json'), JSON.stringify({ ...quote(), images: ['enlace.png'] }));
      mkdirSync(join(outside, 'album'));
      symlinkSync(join(outside, 'album'), join(root, 'album'));
      writeFileSync(join(root, 'linked-dir.json'), JSON.stringify({ ...quote(), images: ['album/secret.png'] }));
      symlinkSync(join(root, 'caso.json'), join(root, 'caso-enlace.json'));

      for (const file of ['absolute.json', 'parent.json', 'symlink.json', 'linked-dir.json', 'caso-enlace.json']) {
        let message = '';
        try {
          readCalibrationImportDocument(join(root, file));
        } catch (err) {
          message = err instanceof Error ? err.message : '';
        }
        expect(message).toContain('must stay inside');
        expect(message).not.toContain(marker);
        expect(message).not.toContain(outside);
        expect(message).not.toContain(root);
      }
      expect(() => readCalibrationImportDocument(join(root, 'missing.json'))).toThrow('missing or unreadable');
      expect(() => loadCalibrationImportFile(join(root, 'corrupt.json'))).toThrow('Unsupported calibration image content');
      const hidden = await readCalibrationImport(stagingEnv(), join(root, 'absolute.json'));
      expect(JSON.stringify(hidden)).toBe('{"service":"calibration-import","result":"error","category":"invalid"}');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rejects personal data before any write and keeps it out of the report', async () => {
    const route = routed();
    const phone = await importCalibrationCase(stagingEnv(), {
      ...quote(),
      line_items: [{ ...quote().line_items[0], part: '5512345678' }],
    }, { transport: route.transport, photos: archive().photos });
    const vin = () => prepareCalibrationImport(quote(1250, '1HGCM82633A004352'));
    const plate = () => prepareCalibrationImport({
      ...quote(),
      visual_observations: ['ABC-123-D'],
    });
    const named = () => prepareCalibrationImport({ ...quote(), vehicle: { ...quote().vehicle, nombre: 'Ana' } });
    expect(phone.category).toBe('invalid');
    expect(JSON.stringify(phone)).not.toContain('5512345678');
    expect(vin).toThrow(CalibrationValidationError);
    expect(plate).toThrow(CalibrationValidationError);
    expect(named).toThrow(CalibrationValidationError);
    expect(route.calls).toHaveLength(0);
    expect(route.github.files.has('data/cases/AF-000002.json')).toBe(false);
  });

  it('reads a local file and stays outside the public ingest', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'cal-011a-'));
    writeFileSync(join(folder, 'frente.png'), first);
    writeFileSync(join(folder, 'caso.json'), JSON.stringify({
      ...quote(),
      images: ['frente.png'],
    }));
    const loaded = loadCalibrationImportFile(join(folder, 'caso.json'));
    expect(loaded.quote.vehicle.make).toBe('Mazda');
    expect(loaded.quote.vehicle.year).toBe(2019);
    expect(loaded.images).toHaveLength(1);
    const blocked = await importCalibrationCase(stagingEnv({ CALIBRATION_INGEST_ENABLED: 'true' }), quote());
    expect(blocked.category).toBe('flags');
    const source = readFileSync(join(__dirname, 'calibration-import.ts'), 'utf8');
    expect(source).toContain('new CalibrationGithubWriter');
    expect(source).toContain('new CalibrationCloudinaryArchive');
    expect(source).not.toContain('CalibrationProbeWriter');
    expect(source).not.toContain('createCal010PhotoArchive');
    expect(source).not.toContain('@Controller');
    expect(readFileSync(join(__dirname, '../app.module.ts'), 'utf8')).not.toContain('CalibrationModule');
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['import:calibration-case']).toBe('node dist/calibration/calibration-import-run.js');
  });

  it('reports the wrong target without changing the Jest exit code', async () => {
    const exitCodeBefore = process.exitCode;
    const report = await readCalibrationImport({}, undefined);
    expect(report).toEqual({ service: 'calibration-import', result: 'error', category: 'wrong_target' });
    expect(process.exitCode).toBe(exitCodeBefore);
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
    if (key.startsWith('RAILWAY_') || key.startsWith('CALIBRATION_') || key.startsWith('CLOUDINARY_')) delete env[key];
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
      join(__dirname, 'calibration-import-run.ts'),
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
