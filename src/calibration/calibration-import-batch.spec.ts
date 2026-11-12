import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import {
  CalibrationCloudinaryArchive,
  type CloudinaryGateway,
} from './calibration-cloudinary-archive';
import {
  CALIBRATION_DIAGNOSTIC_ENVIRONMENT_ID,
  CALIBRATION_DIAGNOSTIC_PROJECT_ID,
  CALIBRATION_DIAGNOSTIC_SERVICE_ID,
} from './calibration-diagnose';
import {
  importCalibrationBatch,
  type BatchReport,
} from './calibration-import-batch';
import { readCalibrationBatch } from './calibration-import-batch-main';
import {
  validateCalibrationImage,
  minimalDecodablePng,
} from './calibration-image-archive.service';
import { memoryGithub } from '../../test/calibration-memory-github';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const FROZEN: Record<string, string> = {
  'data/cases/AF-000001.json':
    '{"case_id":"AF-000001","photo_refs":[],"photo_archive_status":"pending_private_archive"}\n',
  'data/cases/AF-000002.json':
    '{"case_id":"AF-000002","photo_refs":["IMG-000001","IMG-000002","IMG-000003"],"photo_archive_status":"archived_private"}\n',
  'data/photos/AF-000002/IMG-000001.json':
    '{"photo_id":"IMG-000001","storage_status":"verified"}\n',
  'data/photos/AF-000002/IMG-000002.json':
    '{"photo_id":"IMG-000002","storage_status":"verified"}\n',
  'data/photos/AF-000002/IMG-000003.json':
    '{"photo_id":"IMG-000003","storage_status":"verified"}\n',
  'data/probes/index.json': '{"archive":"probe"}\n',
  'data/probes/cases/AF-900000.json': '{"case_id":"AF-900000"}\n',
};

function response(status: number, value: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(value),
  } as Response;
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

function quote(key: string, price = 4100) {
  return {
    source_case_key: key,
    quoted_at: '2026-11-11T17:30:00.000Z',
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
        part: 'fascia delantera',
        treatment: 'repair_paint',
        price_mxn: price,
        damage_severity: 'unknown',
        validation: 'human_confirmed',
      },
    ],
    visual_observations: [],
  };
}

function keyFor(index: number): string {
  return `autofix-2026-11-11-${String(index + 1).padStart(2, '0')}`;
}

function writeExpediente(
  root: string,
  folder: string,
  body: object,
  images: readonly string[],
  files: Record<string, Buffer>,
) {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files))
    writeFileSync(join(dir, name), bytes);
  writeFileSync(join(dir, 'caso.json'), JSON.stringify({ ...body, images }));
}

function seed(github: ReturnType<typeof memoryGithub>) {
  for (const [path, text] of Object.entries(FROZEN))
    github.files.set(path, { sha: `frozen-${path}`, text });
  github.files.set('data/index.json', {
    sha: 'index-0',
    text: JSON.stringify({
      schema_version: '1.0.0',
      cases: {
        'AF-000001': 'data/cases/AF-000001.json',
        'AF-000002': 'data/cases/AF-000002.json',
      },
      source_keys: {
        'seed-case-000001': 'AF-000001',
        'autofix-2026-11-10-002': 'AF-000002',
      },
    }),
  });
}

function routed(
  github = memoryGithub(),
  mutate?: (method: string, url: string) => Response | null,
) {
  seed(github);
  const calls: string[] = [];
  const transport: typeof fetch = (input, init) => {
    const url = String(input);
    const method = readMethod(init);
    calls.push(`${method} ${url}`);
    const early = mutate?.(method, url);
    if (early) return early;
    if (method === 'POST' && url.includes('/access_tokens'))
      return response(201, tokenPayload());
    if (method === 'GET' && url.includes('/installation/repositories')) {
      return response(200, {
        total_count: 1,
        repositories: [
          { full_name: 'arturo2565-alt/pegazuz-calibration-data' },
        ],
      });
    }
    return github.transport(input, init);
  };
  return { github, calls, transport };
}

function archive() {
  const stored = new Map<string, Buffer>();
  const uploads: string[] = [];
  let failures = 0;
  const gateway: CloudinaryGateway = {
    uploadAuthenticated({ publicId, bytes }) {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('provider rejected the asset'));
      }
      stored.set(publicId, Buffer.from(bytes));
      uploads.push(publicId);
      return Promise.resolve({
        assetId: 'asset-import',
        publicId,
        version: 21,
        bytes: bytes.length,
        format: 'png',
        type: 'authenticated',
        resourceType: 'image',
      });
    },
    downloadAuthenticated({ publicId }) {
      const bytes = stored.get(publicId);
      if (!bytes) return Promise.reject(new Error('missing asset'));
      return Promise.resolve(bytes);
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

function deps(route = routed(), photos = archive()) {
  return {
    github: route.github,
    calls: route.calls,
    photos,
    options: {
      transport: route.transport,
      photos: photos.photos,
      clock: () => '2026-11-11T18:00:00.000Z',
      maxTransientAttempts: 0,
    },
  };
}

function readMethod(init: unknown): string {
  if (!init || typeof init !== 'object' || !('method' in init)) return 'GET';
  return typeof init.method === 'string' ? init.method : 'GET';
}

function frozenUntouched(github: ReturnType<typeof memoryGithub>) {
  for (const [path, text] of Object.entries(FROZEN)) {
    expect(github.files.get(path)?.text).toBe(text);
  }
}

function forbiddenPuts(calls: readonly string[]): string[] {
  return calls.filter(
    (call) =>
      call.startsWith('PUT') &&
      /AF-000001|AF-000002|AF-000003|data\/probes|AF-900|cal008-probe|cal010-probe/.test(
        call,
      ),
  );
}

function withoutSecrets(report: BatchReport, secrets: readonly string[]) {
  const text = JSON.stringify(report);
  for (const secret of secrets) expect(text).not.toContain(secret);
  expect(text).not.toContain('fascia delantera');
  expect(text).not.toContain('https://');
  expect(text).not.toContain('ghs_');
  expect(text).not.toContain('/Users');
  expect(text).not.toContain('foto.png');
}

async function withRoot(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'cal-012-'));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('CAL-012 private batch import', () => {
  it('imports ten valid expedientes and leaves the historical cases unchanged', async () => {
    await withRoot(async (root) => {
      for (let index = 0; index < 10; index += 1) {
        const key = keyFor(index);
        writeExpediente(root, key, quote(key, 4200 + index), ['foto.png'], {
          'foto.png': minimalDecodablePng([index + 1, 20, 40]),
        });
      }
      const harness = deps(routed());
      const report = await importCalibrationBatch(stagingEnv(), root, {
        apply: true,
        ...harness.options,
      });
      expect(report).toMatchObject({
        service: 'calibration-import-batch',
        mode: 'apply',
        result: 'ok',
      });
      expect(report.items).toHaveLength(10);
      expect(report.counts).toEqual({ registrado: 10 });
      report.items.forEach((item, index) => {
        expect(item).toMatchObject({
          slot: index + 1,
          sourceKey: keyFor(index),
          disposition: 'registrado',
          labelEligible: true,
          caseId: `AF-${String(index + 4).padStart(6, '0')}`,
          photoRefs: ['IMG-000001'],
          contentMatch: true,
          manifestMatch: true,
          photoArchiveStatus: 'archived_private',
          protectedCaseUnchanged: true,
          duplicateImages: 0,
        });
      });
      expect(harness.photos.uploads).toHaveLength(10);
      expect(harness.github.files.has('data/cases/AF-000003.json')).toBe(false);
      expect(harness.github.files.has('data/cases/AF-000014.json')).toBe(false);
      frozenUntouched(harness.github);
      expect(forbiddenPuts(harness.calls)).toEqual([]);
      withoutSecrets(report, [basename(root)]);
    });
  });

  it('imports the valid expedientes when one quote needs correction', async () => {
    await withRoot(async (root) => {
      const email = 'cliente@example.com';
      for (let index = 0; index < 10; index += 1) {
        const key = keyFor(index);
        const body = quote(key, 4300 + index);
        if (index === 4) body.line_items[0].part = email;
        writeExpediente(root, key, body, ['foto.png'], {
          'foto.png': minimalDecodablePng([index + 11, 21, 41]),
        });
      }
      const harness = deps(routed());
      const report = await importCalibrationBatch(stagingEnv(), root, {
        apply: true,
        ...harness.options,
      });
      expect(report.result).toBe('error');
      expect(report.counts).toEqual({ registrado: 9, requiere_correccion: 1 });
      expect(report.items[4]).toMatchObject({
        slot: 5,
        sourceKey: keyFor(4),
        disposition: 'requiere_correccion',
        labelEligible: false,
        reason: 'invalid',
      });
      expect(report.items[4].caseId).toBeUndefined();
      const registered = report.items.filter(
        (item) => item.disposition === 'registrado',
      );
      expect(registered.map((item) => item.caseId)).toEqual([
        'AF-000004',
        'AF-000005',
        'AF-000006',
        'AF-000007',
        'AF-000008',
        'AF-000009',
        'AF-000010',
        'AF-000011',
        'AF-000012',
      ]);
      expect(registered.every((item) => item.labelEligible)).toBe(true);
      const index = JSON.parse(
        harness.github.files.get('data/index.json')?.text ?? '{}',
      ) as {
        source_keys: Record<string, string>;
      };
      expect(index.source_keys[keyFor(4)]).toBeUndefined();
      frozenUntouched(harness.github);
      withoutSecrets(report, [email, basename(root)]);
      for (const file of harness.github.files.values())
        expect(file.text).not.toContain(email);
    });
  });

  it('collapses duplicate photographs inside one expediente', async () => {
    await withRoot(async (root) => {
      const key = 'autofix-2026-11-11-31';
      const image = minimalDecodablePng([7, 8, 9]);
      writeExpediente(root, key, quote(key, 3100), ['foto.png', 'foto.png'], {
        'foto.png': image,
      });
      const harness = deps(routed());
      const report = await importCalibrationBatch(stagingEnv(), root, {
        apply: true,
        ...harness.options,
      });
      expect(report.result).toBe('ok');
      expect(report.items[0]).toMatchObject({
        sourceKey: key,
        disposition: 'registrado',
        labelEligible: true,
        duplicateImages: 1,
        caseId: 'AF-000004',
        photoRefs: ['IMG-000001'],
      });
      expect(harness.photos.uploads).toHaveLength(1);
      frozenUntouched(harness.github);
    });
  });

  it('keeps one expediente when the same key and content are repeated', async () => {
    await withRoot(async (root) => {
      const key = 'autofix-2026-11-11-32';
      const image = minimalDecodablePng([4, 5, 6]);
      writeExpediente(root, 'a-copy', quote(key, 3200), ['foto.png'], {
        'foto.png': image,
      });
      writeExpediente(root, 'b-copy', quote(key, 3200), ['foto.png'], {
        'foto.png': image,
      });
      const harness = deps(routed());
      const report = await importCalibrationBatch(stagingEnv(), root, {
        apply: true,
        ...harness.options,
      });
      expect(report.items.map((item) => item.disposition)).toEqual([
        'registrado',
        'duplicado_en_lote',
      ]);
      expect(report.items[0]).toMatchObject({
        sourceKey: key,
        caseId: 'AF-000004',
        labelEligible: true,
      });
      expect(report.items[1]).toMatchObject({
        sourceKey: key,
        labelEligible: false,
      });
      expect(report.items[1].caseId).toBeUndefined();
      expect(harness.photos.uploads).toHaveLength(1);
      expect(harness.github.files.has('data/cases/AF-000003.json')).toBe(false);
      expect(harness.github.files.has('data/cases/AF-000005.json')).toBe(false);
    });
  });

  it('does not import two expedientes that share a photograph', async () => {
    await withRoot(async (root) => {
      const shared = minimalDecodablePng([9, 9, 9]);
      const solo = minimalDecodablePng([8, 2, 2]);
      const sharedSha = validateCalibrationImage(shared).sha256.slice(0, 32);
      writeExpediente(
        root,
        'autofix-2026-11-11-41',
        quote('autofix-2026-11-11-41', 4101),
        ['foto.png'],
        { 'foto.png': shared },
      );
      writeExpediente(
        root,
        'autofix-2026-11-11-42',
        quote('autofix-2026-11-11-42', 4102),
        ['foto.png'],
        { 'foto.png': shared },
      );
      writeExpediente(
        root,
        'autofix-2026-11-11-43',
        quote('autofix-2026-11-11-43', 4103),
        ['foto.png'],
        { 'foto.png': solo },
      );
      writeExpediente(
        root,
        'autofix-sim-0041',
        quote('autofix-sim-0041', 4104),
        ['foto.png'],
        { 'foto.png': shared },
      );
      const harness = deps(routed());
      const prepared = await importCalibrationBatch(stagingEnv(), root, {
        apply: false,
      });
      expect(prepared.mode).toBe('prepare');
      expect(
        prepared.items.map((item) => [
          item.sourceKey,
          item.disposition,
          item.reason,
        ]),
      ).toEqual([
        ['autofix-2026-11-11-41', 'requiere_correccion', 'shared_photo'],
        ['autofix-2026-11-11-42', 'requiere_correccion', 'shared_photo'],
        ['autofix-2026-11-11-43', 'listo_para_importar', undefined],
        ['autofix-sim-0041', 'requiere_correccion', 'fixture_key'],
      ]);
      expect(prepared.items.every((item) => item.labelEligible === false)).toBe(
        true,
      );
      const report = await importCalibrationBatch(stagingEnv(), root, {
        apply: true,
        ...harness.options,
      });
      expect(report.items.map((item) => item.disposition)).toEqual([
        'requiere_correccion',
        'requiere_correccion',
        'registrado',
        'requiere_correccion',
      ]);
      expect(report.items[2]).toMatchObject({
        sourceKey: 'autofix-2026-11-11-43',
        caseId: 'AF-000004',
        labelEligible: true,
      });
      expect(harness.photos.uploads).toHaveLength(1);
      expect(harness.photos.uploads.some((id) => id.includes(sharedSha))).toBe(
        false,
      );
      const index = JSON.parse(
        harness.github.files.get('data/index.json')?.text ?? '{}',
      ) as {
        source_keys: Record<string, string>;
      };
      expect(index.source_keys['autofix-2026-11-11-41']).toBeUndefined();
      expect(index.source_keys['autofix-2026-11-11-42']).toBeUndefined();
      expect(index.source_keys['autofix-sim-0041']).toBeUndefined();
      frozenUntouched(harness.github);
    });
  });

  it('holds every copy when the same source key has different content', async () => {
    await withRoot(async (root) => {
      const key = 'autofix-2026-11-11-51';
      writeExpediente(root, 'left', quote(key, 5100), ['foto.png'], {
        'foto.png': minimalDecodablePng([1, 1, 1]),
      });
      writeExpediente(root, 'right', quote(key, 5200), ['foto.png'], {
        'foto.png': minimalDecodablePng([2, 2, 2]),
      });
      const calls: string[] = [];
      const transport: typeof fetch = (input) => {
        calls.push(String(input));
        return Promise.reject(new Error('network'));
      };
      const report = await importCalibrationBatch(stagingEnv(), root, {
        apply: true,
        transport,
      });
      expect(calls).toEqual([]);
      expect(report.items).toEqual([
        {
          slot: 1,
          sourceKey: key,
          disposition: 'requiere_correccion',
          labelEligible: false,
          reason: 'conflicting_key',
          duplicateImages: 0,
        },
        {
          slot: 2,
          sourceKey: key,
          disposition: 'requiere_correccion',
          labelEligible: false,
          reason: 'conflicting_key',
          duplicateImages: 0,
        },
      ]);
    });
  });

  it('repeats a complete batch without creating another case', async () => {
    await withRoot(async (root) => {
      for (let index = 0; index < 10; index += 1) {
        const key = keyFor(index);
        writeExpediente(root, key, quote(key, 6100 + index), ['foto.png'], {
          'foto.png': minimalDecodablePng([index + 30, 3, 3]),
        });
      }
      const harness = deps(routed());
      const first = await importCalibrationBatch(stagingEnv(), root, {
        apply: true,
        ...harness.options,
      });
      const uploads = harness.photos.uploads.length;
      const caseFiles = [...harness.github.files.keys()]
        .filter((path) => path.startsWith('data/cases/'))
        .sort();
      const second = await importCalibrationBatch(stagingEnv(), root, {
        apply: true,
        ...harness.options,
      });
      expect(first.counts).toEqual({ registrado: 10 });
      expect(second.result).toBe('ok');
      expect(second.counts).toEqual({ already_exists: 10 });
      second.items.forEach((item, index) => {
        expect(item).toMatchObject({
          sourceKey: keyFor(index),
          disposition: 'already_exists',
          labelEligible: true,
          caseId: first.items[index]?.caseId,
          contentMatch: true,
          manifestMatch: true,
          photoArchiveStatus: 'archived_private',
        });
      });
      expect(harness.photos.uploads).toHaveLength(uploads);
      expect(
        [...harness.github.files.keys()]
          .filter((path) => path.startsWith('data/cases/'))
          .sort(),
      ).toEqual(caseFiles);
      frozenUntouched(harness.github);
    });
  });

  it('recovers a partially archived expediente without changing its source key', async () => {
    await withRoot(async (root) => {
      const key = 'autofix-2026-11-11-71';
      writeExpediente(root, key, quote(key, 7100), ['foto.png'], {
        'foto.png': minimalDecodablePng([7, 1, 7]),
      });
      const harness = deps(routed());
      harness.photos.fail(1);
      const failed = await importCalibrationBatch(stagingEnv(), root, {
        apply: true,
        ...harness.options,
      });
      expect(failed.items[0]).toMatchObject({
        sourceKey: key,
        disposition: 'pending_private_archive',
        labelEligible: false,
        caseId: 'AF-000004',
        photoArchiveStatus: 'pending_private_archive',
        storageFailure: 'upload_rejected',
        protectedCaseUnchanged: true,
      });
      expect(harness.github.files.has('data/cases/AF-000003.json')).toBe(false);
      expect(harness.github.files.has('data/cases/AF-000005.json')).toBe(false);
      harness.photos.fail(0);
      const recovered = await importCalibrationBatch(stagingEnv(), root, {
        apply: true,
        ...harness.options,
      });
      expect(recovered.result).toBe('ok');
      expect(recovered.items[0]).toMatchObject({
        sourceKey: key,
        disposition: 'already_exists',
        labelEligible: true,
        caseId: 'AF-000004',
        photoRefs: ['IMG-000001'],
        contentMatch: true,
        manifestMatch: true,
        photoArchiveStatus: 'archived_private',
      });
      expect(harness.github.files.has('data/cases/AF-000005.json')).toBe(false);
      const stored = JSON.parse(
        harness.github.files.get('data/cases/AF-000004.json')?.text ?? '{}',
      ) as {
        source?: { source_case_key?: string };
      };
      expect(stored.source?.source_case_key).toBe(key);
      frozenUntouched(harness.github);
    });
  });

  it('rejects external paths, symbolic links, and unsafe batch locations', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => {
      throw new Error('network');
    });
    const marker = 'CANARY-OUTSIDE-5512345678';
    const root = mkdtempSync(join(tmpdir(), 'cal-012-paths-'));
    const outside = mkdtempSync(join(tmpdir(), 'cal-012-outside-'));
    const link = join(tmpdir(), `cal-012-link-${process.pid}`);
    const probes = mkdtempSync(join(tmpdir(), 'cal-012-data-'));
    try {
      writeFileSync(join(outside, 'secret.png'), Buffer.from(marker));
      mkdirSync(join(outside, 'album'));
      writeFileSync(join(outside, 'album', 'secret.png'), Buffer.from(marker));
      writeExpediente(
        root,
        '01-good',
        quote('autofix-2026-11-11-81', 8100),
        ['foto.png'],
        {
          'foto.png': minimalDecodablePng([8, 1, 1]),
        },
      );
      writeExpediente(
        root,
        '02-absolute',
        quote('autofix-2026-11-11-82', 8200),
        [join(outside, 'secret.png')],
        {},
      );
      writeExpediente(
        root,
        '03-parent',
        quote('autofix-2026-11-11-83', 8300),
        [`../${basename(outside)}/secret.png`],
        {},
      );
      writeExpediente(
        root,
        '04-image-link',
        quote('autofix-2026-11-11-84', 8400),
        ['enlace.png'],
        {},
      );
      symlinkSync(
        join(outside, 'secret.png'),
        join(root, '04-image-link', 'enlace.png'),
      );
      mkdirSync(join(root, '05-json-link'));
      symlinkSync(
        join(outside, 'secret.png'),
        join(root, '05-json-link', 'caso.json'),
      );
      symlinkSync(join(outside, 'album'), join(root, '06-dir-link'));
      let calls = 0;
      const transport: typeof fetch = () => {
        calls += 1;
        return Promise.reject(new Error('network'));
      };
      const report = await importCalibrationBatch(stagingEnv(), root, {
        apply: false,
        transport,
      });
      expect(calls).toBe(0);
      expect(
        report.items.map((item) => [item.slot, item.disposition, item.reason]),
      ).toEqual([
        [1, 'listo_para_importar', undefined],
        [2, 'requiere_correccion', 'unsafe_path'],
        [3, 'requiere_correccion', 'unsafe_path'],
        [4, 'requiere_correccion', 'unsafe_path'],
        [5, 'requiere_correccion', 'symlink'],
        [6, 'requiere_correccion', 'symlink'],
      ]);
      expect(report.items[0]).toMatchObject({
        sourceKey: 'autofix-2026-11-11-81',
        labelEligible: false,
      });
      expect(report.mode).toBe('prepare');
      withoutSecrets(report, [
        marker,
        root,
        outside,
        basename(root),
        basename(outside),
      ]);

      symlinkSync(root, link);
      const linked = await importCalibrationBatch(stagingEnv(), link, {
        apply: true,
      });
      expect(linked).toMatchObject({
        mode: 'apply',
        result: 'error',
        category: 'rejected',
        reason: 'symlink',
        items: [],
      });
      expect(JSON.stringify(linked)).not.toContain(marker);

      const crowded = mkdtempSync(join(tmpdir(), 'cal-012-eleven-'));
      try {
        for (let index = 0; index < 11; index += 1) {
          const dir = join(crowded, `exp-${String(index).padStart(2, '0')}`);
          mkdirSync(dir);
          writeFileSync(
            join(dir, 'caso.json'),
            JSON.stringify({ note: marker }),
          );
        }
        const limited = await importCalibrationBatch(stagingEnv(), crowded, {
          apply: true,
        });
        expect(limited).toMatchObject({
          result: 'error',
          category: 'rejected',
          reason: 'batch_limit',
          items: [],
        });
        expect(JSON.stringify(limited)).not.toContain(marker);
      } finally {
        rmSync(crowded, { recursive: true, force: true });
      }

      const probeDir = join(probes, 'data', 'probes');
      mkdirSync(probeDir, { recursive: true });
      writeFileSync(join(probeDir, 'caso.json'), marker);
      const probeBatch = await importCalibrationBatch(stagingEnv(), probeDir, {
        apply: false,
      });
      expect(probeBatch).toMatchObject({
        result: 'error',
        category: 'rejected',
        reason: 'probes',
        items: [],
      });
      expect(JSON.stringify(probeBatch)).not.toContain(marker);

      const repository = await importCalibrationBatch(
        stagingEnv(),
        join(__dirname, '..', '..'),
        { apply: true },
      );
      expect(repository).toMatchObject({
        mode: 'apply',
        result: 'error',
        category: 'rejected',
        reason: 'repository',
        items: [],
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      rmSync(link, { force: true });
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      rmSync(probes, { recursive: true, force: true });
    }
  });

  it('prepares a batch without network requests', async () => {
    await withRoot(async (root) => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => {
        throw new Error('network');
      });
      try {
        const key = 'autofix-2026-11-11-91';
        writeExpediente(
          root,
          'CANARY-FOLDER-NAME',
          quote(key, 9100),
          ['foto.png'],
          {
            'foto.png': minimalDecodablePng([9, 1, 9]),
          },
        );
        let calls = 0;
        const transport: typeof fetch = () => {
          calls += 1;
          return Promise.reject(new Error('network'));
        };
        const report = await importCalibrationBatch(stagingEnv(), root, {
          apply: false,
          transport,
        });
        expect(calls).toBe(0);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(report).toMatchObject({
          service: 'calibration-import-batch',
          mode: 'prepare',
          result: 'ok',
          items: [
            {
              slot: 1,
              sourceKey: key,
              disposition: 'listo_para_importar',
              labelEligible: false,
              duplicateImages: 0,
            },
          ],
          counts: { listo_para_importar: 1 },
        });
        expect(report.items[0].caseId).toBeUndefined();
        withoutSecrets(report, ['CANARY-FOLDER-NAME', basename(root)]);
        expect(JSON.stringify(report)).not.toContain('registrado');
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  it('prepares fifteen photographs without network and rejects thirty-one', async () => {
    await withRoot(async (root) => {
      const many = Array.from({ length: 15 }, (_item, index) => `f${index}.png`);
      const files = Object.fromEntries(many.map((name, index) => [
        name,
        minimalDecodablePng([index + 1, 3, 4]),
      ]));
      writeExpediente(root, 'quince', quote('autofix-2026-11-11-15', 1500), many, files);
      const tooMany = Array.from({ length: 31 }, (_item, index) => `g${index}.png`);
      writeExpediente(
        root,
        'treinta',
        quote('autofix-2026-11-11-31b', 3100),
        tooMany,
        { 'g0.png': minimalDecodablePng([1, 2, 3]) },
      );
      const calls: string[] = [];
      const transport: typeof fetch = (input) => {
        calls.push(String(input));
        return Promise.reject(new Error('network'));
      };
      const report = await importCalibrationBatch(stagingEnv(), root, {
        apply: false,
        transport,
      });
      expect(calls).toEqual([]);
      expect(report.items.map((item) => [item.disposition, item.reason])).toEqual([
        ['listo_para_importar', undefined],
        ['requiere_correccion', 'incomplete'],
      ]);
      expect(report.items[0].caseId).toBeUndefined();
    });
  });

  it('does not modify AF-000001, AF-000002, or the calibration probes', async () => {
    await withRoot(async (root) => {
      writeExpediente(
        root,
        'autofix-2026-11-10-002',
        quote('autofix-2026-11-10-002', 5300),
        ['foto.png'],
        {
          'foto.png': minimalDecodablePng([2, 2, 5]),
        },
      );
      writeExpediente(
        root,
        'autofix-2026-11-11-92',
        quote('autofix-2026-11-11-92', 9200),
        ['foto.png'],
        {
          'foto.png': minimalDecodablePng([9, 2, 2]),
        },
      );
      writeExpediente(
        root,
        'autofix-sim-0092',
        quote('autofix-sim-0092', 9201),
        ['foto.png'],
        {
          'foto.png': minimalDecodablePng([9, 2, 3]),
        },
      );
      writeExpediente(
        root,
        'probe-cal-012-001',
        quote('probe-cal-012-001', 9202),
        ['foto.png'],
        {
          'foto.png': minimalDecodablePng([9, 2, 4]),
        },
      );
      const harness = deps(routed());
      const report = await importCalibrationBatch(stagingEnv(), root, {
        apply: true,
        ...harness.options,
      });
      expect(
        report.items.map((item) => [
          item.sourceKey,
          item.disposition,
          item.reason,
          item.caseId,
        ]),
      ).toEqual([
        [
          'autofix-2026-11-10-002',
          'requiere_correccion',
          'conflict',
          undefined,
        ],
        ['autofix-2026-11-11-92', 'registrado', undefined, 'AF-000004'],
        ['autofix-sim-0092', 'requiere_correccion', 'fixture_key', undefined],
        ['probe-cal-012-001', 'requiere_correccion', 'probe_key', undefined],
      ]);
      expect(report.items[1].labelEligible).toBe(true);
      expect(harness.github.files.has('data/cases/AF-000003.json')).toBe(false);
      expect(harness.github.files.has('data/cases/AF-000005.json')).toBe(false);
      frozenUntouched(harness.github);
      expect(forbiddenPuts(harness.calls)).toEqual([]);
      expect(
        harness.photos.uploads.every((id) =>
          id.startsWith('pegazuz_calibration/AF-000004/'),
        ),
      ).toBe(true);
    });
  });

  it('stops the remaining expedientes after a permission failure', async () => {
    await withRoot(async (root) => {
      for (let index = 0; index < 3; index += 1) {
        const key = keyFor(index);
        writeExpediente(root, key, quote(key, 9300 + index), ['foto.png'], {
          'foto.png': minimalDecodablePng([index + 50, 9, 3]),
        });
      }
      let tokens = 0;
      const harness = deps(
        routed(memoryGithub(), (method, url) => {
          if (method === 'POST' && url.includes('/access_tokens')) {
            tokens += 1;
            if (tokens > 1) return response(403, { message: 'forbidden' });
          }
          return null;
        }),
      );
      const report = await importCalibrationBatch(stagingEnv(), root, {
        apply: true,
        ...harness.options,
      });
      expect(report).toMatchObject({ result: 'error', category: 'halted' });
      expect(
        report.items.map((item) => [
          item.disposition,
          item.reason,
          item.caseId,
        ]),
      ).toEqual([
        ['registrado', undefined, 'AF-000004'],
        ['detenido_por_seguridad', 'forbidden', undefined],
        ['detenido_por_seguridad', 'halted', undefined],
      ]);
      expect(report.items[0].labelEligible).toBe(true);
      expect(report.items[1].labelEligible).toBe(false);
      expect(report.items[1].sourceKey).toBe(keyFor(1));
      expect(report.items[2].sourceKey).toBe(keyFor(2));
      expect(harness.github.files.has('data/cases/AF-000003.json')).toBe(false);
      expect(harness.github.files.has('data/cases/AF-000005.json')).toBe(false);
      frozenUntouched(harness.github);
      withoutSecrets(report, []);
    });
  });

  it('stops before any network when the public ingest flag is not closed', async () => {
    await withRoot(async (root) => {
      for (const [index, key] of [
        'autofix-2026-11-11-94',
        'autofix-2026-11-11-95',
      ].entries()) {
        writeExpediente(root, key, quote(key, 9400 + index), ['foto.png'], {
          'foto.png': minimalDecodablePng([9, 4, index + 1]),
        });
      }
      let calls = 0;
      const transport: typeof fetch = () => {
        calls += 1;
        return Promise.reject(new Error('network'));
      };
      const report = await importCalibrationBatch(
        stagingEnv({ CALIBRATION_INGEST_ENABLED: 'true' }),
        root,
        { apply: true, transport },
      );
      expect(calls).toBe(0);
      expect(report).toMatchObject({
        mode: 'apply',
        result: 'error',
        category: 'halted',
      });
      expect(
        report.items.map((item) => [item.disposition, item.reason]),
      ).toEqual([
        ['detenido_por_seguridad', 'flags'],
        ['detenido_por_seguridad', 'halted'],
      ]);
      expect(
        report.items.every(
          (item) => item.labelEligible === false && item.caseId == null,
        ),
      ).toBe(true);
    });
  });

  it('keeps the command outside the public module', async () => {
    const source = readFileSync(
      join(__dirname, 'calibration-import-batch.ts'),
      'utf8',
    );
    const main = readFileSync(
      join(__dirname, 'calibration-import-batch-main.ts'),
      'utf8',
    );
    expect(source).not.toContain('@Controller');
    expect(source).not.toContain('CalibrationModule');
    expect(main).not.toContain('@Controller');
    expect(
      readFileSync(join(__dirname, '../app.module.ts'), 'utf8'),
    ).not.toContain('CalibrationModule');
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['import:calibration-batch']).toBe(
      'node dist/calibration/calibration-import-batch-run.js',
    );
    expect(pkg.scripts['import:calibration-case']).toBe(
      'node dist/calibration/calibration-import-run.js',
    );
    const missing = await readCalibrationBatch(stagingEnv(), []);
    expect(missing).toEqual({
      service: 'calibration-import-batch',
      mode: 'prepare',
      result: 'error',
      category: 'incomplete',
      items: [],
      counts: {},
    });
    const flagged = await readCalibrationBatch(stagingEnv(), ['--apply']);
    expect(flagged).toMatchObject({
      mode: 'apply',
      category: 'incomplete',
      items: [],
    });
    const unknown = await readCalibrationBatch(stagingEnv(), [
      '--publish',
      '/tmp/lote',
    ]);
    expect(unknown).toMatchObject({
      mode: 'prepare',
      category: 'invalid',
      items: [],
    });
  });

  it('prints a local report and does not change the Jest exit code', async () => {
    const exitCodeBefore = process.exitCode;
    const report = await readCalibrationBatch({}, ['--apply']);
    expect(report.category).toBe('incomplete');
    expect(process.exitCode).toBe(exitCodeBefore);
    const child = await runBatchCli();
    expect(child.code).toBe(1);
    expect(child.stdout).toContain('"category":"incomplete"');
    expect(child.stdout).not.toContain('https://');
    expect(child.stdout).not.toContain('ghs_');
    expect(process.exitCode).toBe(exitCodeBefore);
  }, 20_000);
});

function runBatchCli(): Promise<{ code: number | null; stdout: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('RAILWAY_') ||
      key.startsWith('CALIBRATION_') ||
      key.startsWith('CLOUDINARY_')
    )
      delete env[key];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
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
        join(__dirname, 'calibration-import-batch-run.ts'),
      ],
      { cwd: join(__dirname, '../..'), env },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}
