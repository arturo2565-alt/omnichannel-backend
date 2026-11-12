import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CalibrationValidationError } from './calibration-case';
import {
  assessPhotoManifest,
  confirmArchiveChecksum,
  CalibrationEngine,
  retryDelayMs,
} from './calibration-engine';
import {
  CalibrationConflictError,
  CalibrationGithubWriter,
  CalibrationWriteError,
  classifyGithubFailure,
} from './calibration-github-writer';
import { minimalDecodablePng, validateCalibrationImage } from './calibration-image-archive.service';
import { memoryGithub } from '../../test/calibration-memory-github';

function quote(key = 'case-test-000010', price = 1250) {
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

const image = minimalDecodablePng();

function verifiedStore() {
  const calls: Buffer[] = [];
  return {
    calls,
    store: async ({ bytes }: { caseId: string; bytes: Buffer }) => {
      calls.push(bytes);
      const sha256 = validateCalibrationImage(bytes).sha256;
      return { sha256, verified: confirmArchiveChecksum(sha256, sha256) };
    },
  };
}

function engineFor(
  github = memoryGithub(),
  photos?: ReturnType<typeof verifiedStore>,
  options?: ConstructorParameters<typeof CalibrationEngine>[3],
) {
  return {
    github,
    photos,
    engine: new CalibrationEngine(
      new CalibrationGithubWriter('test-token', github.transport),
      photos ?? null,
      () => '2026-11-06T18:00:00.000Z',
      options,
    ),
  };
}

function storedCase(github: ReturnType<typeof memoryGithub>, caseId: string) {
  const file = github.files.get(`data/cases/${caseId}.json`);
  if (!file) throw new Error(`missing ${caseId}`);
  return JSON.parse(file.text) as Record<string, unknown>;
}

describe('CAL-006 calibration engine', () => {
  it('records a valid human quote without inventing unknown identity', async () => {
    const { engine, github } = engineFor();
    const result = await engine.record(quote());
    expect(result.status).toBe('created');
    expect(result.caseId).toBe('AF-000002');
    expect(result.photoArchiveStatus).toBe('not_provided');
    const saved = storedCase(github, 'AF-000002');
    expect(saved.vehicle).toMatchObject({
      make: 'Mazda',
      make_evidence: 'visual_inference',
      model: null,
      model_evidence: 'unknown',
      year: null,
      year_evidence: 'unknown',
    });
    expect(saved).not.toHaveProperty('customerName');
  });

  it('rejects an incomplete quote before writing', async () => {
    const { engine, github } = engineFor();
    await expect(engine.record({ status: 'human_verified' })).rejects.toMatchObject({
      code: 'incomplete',
    } satisfies Partial<CalibrationValidationError>);
    expect(github.files.has('data/cases/AF-000002.json')).toBe(false);
  });

  it('rejects a missing, zero, or unconfirmed price', async () => {
    const { engine } = engineFor();
    const missing = quote();
    missing.line_items[0]!.price_mxn = null as unknown as number;
    await expect(engine.record(missing)).rejects.toMatchObject({ code: 'unauthorized_price' });
    const zero = quote();
    zero.line_items[0]!.price_mxn = 0;
    await expect(engine.record(zero)).rejects.toMatchObject({ code: 'unauthorized_price' });
    const pending = quote();
    pending.line_items[0]!.validation = 'pending_review' as 'human_confirmed';
    await expect(engine.record(pending)).rejects.toMatchObject({ code: 'unauthorized_price' });
  });

  it('keeps a visual identification with unknown model and year', async () => {
    const { engine, github } = engineFor();
    await engine.record(quote('case-test-visual-01'));
    const saved = storedCase(github, 'AF-000002');
    expect(saved.vehicle).toMatchObject({
      make_evidence: 'visual_inference',
      model: null,
      year: null,
    });
  });

  it('does not create a second case for the same source key', async () => {
    const { engine, github } = engineFor();
    const first = await engine.record(quote('case-test-dup-01'));
    const second = await engine.record(quote('case-test-dup-01'));
    expect(first.caseId).toBe('AF-000002');
    expect(second).toMatchObject({ status: 'already_exists', caseId: 'AF-000002' });
    expect([...github.files.keys()].filter((path) => path.startsWith('data/cases/'))).toEqual([
      'data/cases/AF-000002.json',
    ]);
    await expect(engine.record(quote('case-test-dup-01', 9999))).rejects.toBeInstanceOf(
      CalibrationConflictError,
    );
  });

  it('allocates distinct ids for two concurrent quotes', async () => {
    const { engine } = engineFor();
    const [left, right] = await Promise.all([
      engine.record(quote('case-test-concurrent-a')),
      engine.record(quote('case-test-concurrent-b', 800)),
    ]);
    expect(new Set([left.caseId, right.caseId])).toEqual(new Set(['AF-000002', 'AF-000003']));
    expect(left.status).toBe('created');
    expect(right.status).toBe('created');
  });

  it('does not persist when GitHub fails', async () => {
    const photos = verifiedStore();
    const { engine } = engineFor(memoryGithub({ failAll: true }), photos);
    await expect(engine.record(quote(), [image])).rejects.toThrow('github unavailable');
    expect(photos.calls).toHaveLength(0);
  });

  it('keeps the quote pending when Cloudinary fails', async () => {
    const github = memoryGithub();
    const engine = new CalibrationEngine(
      new CalibrationGithubWriter('test-token', github.transport),
      { store: async () => { throw new Error('cloudinary unavailable'); } },
    );
    const result = await engine.record(quote('case-test-photo-fail'), [image]);
    expect(result.photoArchiveStatus).toBe('pending_private_archive');
    expect(result.photoRefs).toEqual([]);
    expect(storedCase(github, result.caseId).photo_archive_status).toBe('pending_private_archive');
  });

  it('does not archive a photo whose checksum was not confirmed', async () => {
    const github = memoryGithub();
    const engine = new CalibrationEngine(
      new CalibrationGithubWriter('test-token', github.transport),
      {
        store: async ({ bytes }) => ({
          sha256: validateCalibrationImage(bytes).sha256,
          verified: confirmArchiveChecksum(validateCalibrationImage(bytes).sha256, null),
        }),
      },
    );
    const result = await engine.record(quote('case-test-unverified'), [image]);
    expect(result.photoArchiveStatus).toBe('pending_private_archive');
    expect([...github.files.keys()].some((path) => path.includes('/photos/'))).toBe(false);
  });

  it('stores one manifest for a duplicated photograph', async () => {
    const photos = verifiedStore();
    const { engine, github } = engineFor(memoryGithub(), photos);
    const result = await engine.record(quote('case-test-same-photo'), [image, Buffer.from(image)]);
    expect(photos.calls).toHaveLength(1);
    expect(result.photoArchiveStatus).toBe('archived_private');
    expect(result.photoRefs).toEqual(['IMG-000001']);
    const manifest = github.files.get(`data/photos/${result.caseId}/IMG-000001.json`);
    expect(JSON.parse(manifest!.text).content_sha256).toBe(validateCalibrationImage(image).sha256);
    expect(JSON.parse(manifest!.text).storage_status).toBe('verified');
  });

  it('recovers a case whose index write was partial', async () => {
    const { engine, github } = engineFor(memoryGithub({ failIndexWrites: 1 }));
    const result = await engine.record(quote('case-test-partial'));
    expect(result.status).toBe('reconciled');
    expect(result.caseId).toBe('AF-000002');
    const index = JSON.parse(github.files.get('data/index.json')!.text) as {
      source_keys: Record<string, string>;
    };
    expect(index.source_keys['case-test-partial']).toBe('AF-000002');
  });

  it('matches the pinned private case and photo contracts', () => {
    const caseSchema = JSON.parse(
      readFileSync(join(process.cwd(), 'calibration/schema.json'), 'utf8'),
    ) as { properties: Record<string, { properties?: Record<string, unknown>; enum?: string[] }> };
    const photoSchema = JSON.parse(
      readFileSync(join(process.cwd(), 'calibration/photo-v1.schema.json'), 'utf8'),
    ) as { required: string[]; properties: Record<string, { pattern?: string; enum?: string[] }> };
    expect(caseSchema.properties.vehicle?.properties).toHaveProperty('make_evidence');
    expect(caseSchema.properties.vehicle?.properties).toHaveProperty('model_evidence');
    expect(caseSchema.properties.vehicle?.properties).toHaveProperty('year_evidence');
    expect(caseSchema.properties.visual_observations).toBeDefined();
    expect(caseSchema.properties.photo_archive_status?.enum).toContain('archived_private');
    expect(photoSchema.required).toEqual(
      expect.arrayContaining(['content_sha256', 'storage_status', 'photo_id', 'case_id']),
    );
    expect(photoSchema.properties.content_sha256?.pattern).toBe('^[a-f0-9]{64}$');
    expect(photoSchema.properties.storage_status?.enum).toContain('verified');
  });

  it('classifies GitHub 422 validation separately from a real file collision', () => {
    expect(classifyGithubFailure(422, 'Invalid request.\n\n"sha" wasn\'t supplied.')).toBe('occupied');
    expect(classifyGithubFailure(422, 'Validation Failed')).toBe('validation');
    expect(classifyGithubFailure(403, 'Resource not accessible by integration')).toBe('forbidden');
    expect(classifyGithubFailure(429, 'API rate limit exceeded')).toBe('rate_limit');
    expect(retryDelayMs(0, { baseDelayMs: 100, jitterRatio: 0.5 }, () => 0)).toBe(100);
    expect(retryDelayMs(0, { baseDelayMs: 100, jitterRatio: 0.5 }, () => 1)).toBe(150);
    expect(retryDelayMs(2, { baseDelayMs: 100, jitterRatio: 0 }, () => 0)).toBe(400);
  });

  it('does not allocate another id when GitHub returns 422 for validation', async () => {
    const github = memoryGithub({ rejectCaseCreate: 'validation' });
    const { engine } = engineFor(github);
    await expect(engine.record(quote('case-test-invalid'))).rejects.toMatchObject({
      kind: 'validation',
      status: 422,
    } satisfies Partial<CalibrationWriteError>);
    expect(github.files.has('data/cases/AF-000002.json')).toBe(false);
    expect(github.files.has('data/cases/AF-000003.json')).toBe(false);
  });

  it('allocates another id only when the case file is already occupied', async () => {
    const github = memoryGithub();
    const original = '{"locked":true}\n';
    github.files.set('data/cases/AF-000002.json', { sha: 'occupied', text: original });
    const { engine } = engineFor(github);
    const result = await engine.record(quote('case-test-occupied'));
    expect(result.caseId).toBe('AF-000003');
    expect(github.files.get('data/cases/AF-000002.json')?.text).toBe(original);
  });

  it('does not allocate another id when GitHub returns 403', async () => {
    const github = memoryGithub({ rejectCaseCreate: 'forbidden' });
    const { engine } = engineFor(github);
    await expect(engine.record(quote('case-test-forbidden'))).rejects.toMatchObject({
      kind: 'forbidden',
      status: 403,
    });
    expect([...github.files.keys()].some((path) => path.startsWith('data/cases/'))).toBe(false);
  });

  it('retries HTTP 429 against the same case id', async () => {
    const github = memoryGithub({ rateLimitCaseCreates: 1 });
    const waits: number[] = [];
    const { engine } = engineFor(github, undefined, {
      sleep: async (ms) => { waits.push(ms); },
      random: () => 0,
      retry: { baseDelayMs: 10, jitterRatio: 0.5 },
    });
    const result = await engine.record(quote('case-test-rate'));
    expect(result.caseId).toBe('AF-000002');
    expect(waits).toEqual([10]);
    expect(github.files.has('data/cases/AF-000003.json')).toBe(false);
  });

  it('stops after the configured number of real collisions', async () => {
    const github = memoryGithub();
    github.files.set('data/cases/AF-000002.json', { sha: 'occupied', text: '{"locked":true}\n' });
    const { engine } = engineFor(github, undefined, { retry: { maxAllocationAttempts: 1 } });
    await expect(engine.record(quote('case-test-cap'))).rejects.toThrow(
      'Concurrent case allocation was not resolved',
    );
    expect(github.files.has('data/cases/AF-000003.json')).toBe(false);
    expect(github.files.get('data/cases/AF-000002.json')?.text).toBe('{"locked":true}\n');
  });

  it('retries the same quote without writing a second case', async () => {
    const { engine, github } = engineFor();
    const first = await engine.record(quote('case-test-retry'));
    const second = await engine.record(quote('case-test-retry'));
    expect(second).toMatchObject({ status: 'already_exists', caseId: first.caseId });
    expect([...github.files.keys()].filter((path) => path.startsWith('data/cases/'))).toHaveLength(1);
  });

  it('keeps the case pending when linking fails after the manifest is stored', async () => {
    const photos = verifiedStore();
    const github = memoryGithub({ failArchivedUpdates: 1 });
    const { engine } = engineFor(github, photos, { retry: { maxTransientAttempts: 0 } });
    const first = await engine.record(quote('case-test-photo-crash'), [image]);
    expect(first.photoArchiveStatus).toBe('pending_private_archive');
    expect(first.photoRefs).toEqual([]);
    expect(first.orphanPhotoRefs).toEqual(['IMG-000001']);
    expect(storedCase(github, first.caseId).photo_archive_status).toBe('pending_private_archive');
    const second = await engine.record(quote('case-test-photo-crash'), [image]);
    expect(second.photoArchiveStatus).toBe('archived_private');
    expect(second.photoRefs).toEqual(['IMG-000001']);
    expect(photos.calls).toHaveLength(1);
    expect(storedCase(github, first.caseId).photo_refs).toEqual(['IMG-000001']);
  });

  it('links a proven orphan manifest and leaves an unproven file untouched', async () => {
    const { engine, github } = engineFor();
    const created = await engine.record(quote('case-test-recover'));
    const checksum = 'ab'.repeat(32);
    const proven = {
      schema_version: '1.0.0',
      photo_id: 'IMG-000001',
      case_id: created.caseId,
      storage_status: 'verified',
      content_sha256: checksum,
    };
    const foreign = {
      schema_version: '1.0.0',
      photo_id: 'IMG-000009',
      case_id: 'AF-999999',
      storage_status: 'verified',
      content_sha256: checksum,
    };
    github.files.set(`data/photos/${created.caseId}/IMG-000001.json`, {
      sha: 'manifest-proven',
      text: JSON.stringify(proven),
    });
    github.files.set(`data/photos/${created.caseId}/IMG-000009.json`, {
      sha: 'manifest-foreign',
      text: JSON.stringify(foreign),
    });
    expect(assessPhotoManifest({
      caseExists: false,
      referenced: false,
      pathCaseId: created.caseId,
      pathPhotoId: 'IMG-000001',
      manifest: proven,
    })).toBe('unproven');
    const partial = await engine.recoverOrphanManifests(created.caseId, [
      'IMG-000001',
      'IMG-000009',
    ], [
      { photoId: 'IMG-000001', sha256: checksum },
      { photoId: 'IMG-000002', sha256: checksum },
    ]);
    expect(partial.linked).toEqual([]);
    expect(partial.unproven).toEqual(['IMG-000009']);
    expect(partial.photoArchiveStatus).not.toBe('archived_private');
    expect(storedCase(github, created.caseId).photo_archive_status).not.toBe('archived_private');
    expect(storedCase(github, created.caseId).photo_refs ?? []).toEqual([]);
    expect(github.files.get(`data/photos/${created.caseId}/IMG-000009.json`)?.text).toBe(
      JSON.stringify(foreign),
    );
    const recovered = await engine.recoverOrphanManifests(created.caseId, [
      'IMG-000001',
      'IMG-000009',
    ], [
      { photoId: 'IMG-000001', sha256: checksum },
    ]);
    expect(recovered.linked).toEqual(['IMG-000001']);
    expect(recovered.photoArchiveStatus).toBe('archived_private');
    expect(github.files.get(`data/photos/${created.caseId}/IMG-000009.json`)?.text).toBe(
      JSON.stringify(foreign),
    );
    expect(storedCase(github, created.caseId).photo_refs).toEqual(['IMG-000001']);
  });

  it('stores a private asset id only when the checksum and the id are safe', async () => {
    const github = memoryGithub();
    const engine = new CalibrationEngine(
      new CalibrationGithubWriter('test-token', github.transport),
      {
        store: async ({ bytes }) => ({
          sha256: validateCalibrationImage(bytes).sha256,
          verified: true,
          assetPublicId: 'pegazuz_calibration/AF-000002/0123456789abcdef0123456789abcdef',
          assetVersion: 4,
        }),
      },
    );
    const saved = await engine.record(quote('case-test-asset'), [image]);
    const manifest = JSON.parse(
      github.files.get(`data/photos/${saved.caseId}/IMG-000001.json`)!.text,
    ) as Record<string, unknown>;
    expect(manifest.asset_public_id).toBe(
      'pegazuz_calibration/AF-000002/0123456789abcdef0123456789abcdef',
    );
    expect(manifest.asset_version).toBe(4);
    expect(JSON.stringify(manifest)).not.toContain('https://');

    const rejected = memoryGithub();
    const blocked = new CalibrationEngine(
      new CalibrationGithubWriter('test-token', rejected.transport),
      {
        store: async ({ bytes }) => ({
          sha256: validateCalibrationImage(bytes).sha256,
          verified: true,
          assetPublicId: 'https://res.cloudinary.com/demo/image/upload/private.jpg',
          assetVersion: 4,
        }),
      },
    );
    const pending = await blocked.record(quote('case-test-public-url'), [image]);
    expect(pending.photoArchiveStatus).toBe('pending_private_archive');
    expect([...rejected.files.keys()].some((path) => path.includes('/photos/'))).toBe(false);
  });
});
