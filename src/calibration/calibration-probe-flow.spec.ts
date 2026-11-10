import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAL010_CLOUDINARY_PREFIX,
  type CloudinaryGateway,
  type CloudinaryReceipt,
} from './calibration-cloudinary-archive';
import { CalibrationEngine } from './calibration-engine';
import { CalibrationProbeWriter } from './calibration-probe';
import {
  CAL010_PROTECTED_CASE_ID,
  CAL010_SOURCE_KEY,
  createCal010PhotoArchive,
  recordCal010Observation,
  syntheticCal010Image,
} from './calibration-probe-flow';
import { memoryGithub } from '../../test/calibration-memory-github';

const image = syntheticCal010Image();
const sha256 = createHash('sha256').update(image).digest('hex');

function response(status: number, value: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => value } as Response;
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
  return {
    realIndex: github.files.get('data/index.json')!.text,
    protectedCase,
  };
}

function gateway(options?: {
  failUploads?: number;
  failAfter?: number;
  wrongPublicId?: boolean;
}): CloudinaryGateway & { uploads: string[] } {
  const uploads: string[] = [];
  let failures = options?.failUploads ?? 0;
  let succeeded = 0;
  return {
    uploads,
    async uploadAuthenticated({ publicId, bytes }) {
      if (options?.failAfter != null && succeeded >= options.failAfter) {
        throw new Error('asset already stored');
      }
      if (failures > 0) {
        failures -= 1;
        throw new Error('asset already stored');
      }
      uploads.push(publicId);
      const receipt: CloudinaryReceipt = {
        assetId: 'asset-cal010',
        publicId: options?.wrongPublicId ? 'pegazuz_calibration/cal008-probe/AF-008008/other' : publicId,
        version: 11,
        bytes: bytes.length,
        format: 'png',
        type: 'authenticated',
        resourceType: 'image',
      };
      succeeded += 1;
      return receipt;
    },
    async downloadAuthenticated({ publicId }) {
      if (!publicId.startsWith(`${CAL010_CLOUDINARY_PREFIX}/`)) {
        throw new Error('foreign photo prefix');
      }
      return Buffer.from(image);
    },
  };
}

function harness(github = memoryGithub()) {
  const baseline = seed(github);
  const calls: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    if (method === 'PUT' && (url.includes('/AF-900000') || url.includes('/contents/data/index.json') || url.includes('/contents/data/cases/'))) {
      throw new Error('protected path was written');
    }
    return github.transport(input, init);
  };
  return {
    github,
    calls,
    baseline,
    writer: new CalibrationProbeWriter('test-token', transport),
    photos: createCal010PhotoArchive(gateway()),
  };
}

describe('CAL-010 probe observation with a private photo', () => {
  it('stores one verified manifest and reads the case back without touching protected records', async () => {
    const { github, calls, baseline, writer } = harness();
    const cloud = gateway();
    const photos = createCal010PhotoArchive(cloud);
    const created = await recordCal010Observation(writer, photos);
    expect(created).toMatchObject({
      status: 'created',
      caseId: 'AF-900001',
      photoArchiveStatus: 'archived_private',
      photoRefs: ['IMG-000001'],
      orphanPhotoRefs: [],
    });
    const stored = await writer.readCase('AF-900001');
    const manifest = await writer.readPhotoManifest('AF-900001', 'IMG-000001');
    expect(stored).toMatchObject({
      case_id: 'AF-900001',
      photo_refs: ['IMG-000001'],
      photo_archive_status: 'archived_private',
    });
    expect(manifest).toMatchObject({
      storage_status: 'verified',
      content_sha256: sha256,
      case_id: 'AF-900001',
      photo_id: 'IMG-000001',
      asset_public_id: `${CAL010_CLOUDINARY_PREFIX}/AF-900001/${sha256.slice(0, 32)}`,
      delivery_type: 'authenticated',
    });
    expect(cloud.uploads).toEqual([`${CAL010_CLOUDINARY_PREFIX}/AF-900001/${sha256.slice(0, 32)}`]);
    const repeated = await recordCal010Observation(writer, photos);
    expect(repeated).toMatchObject({
      status: 'already_exists',
      caseId: 'AF-900001',
      photoArchiveStatus: 'archived_private',
      photoRefs: ['IMG-000001'],
    });
    expect(cloud.uploads).toHaveLength(1);
    expect(github.files.get('data/probes/cases/AF-900000.json')!.text).toBe(baseline.protectedCase);
    expect(github.files.get('data/index.json')!.text).toBe(baseline.realIndex);
    expect(github.files.has('data/cases/AF-900001.json')).toBe(false);
    expect(JSON.stringify([...github.files.values()])).not.toContain('27b61d9ab76b915baa754954bfb34ec8');
    expect(JSON.stringify([...github.files.values()])).not.toContain('cal008-probe');
    expect(calls.some((call) => call.startsWith('PUT ') && call.includes('AF-900000'))).toBe(false);
  });

  it('keeps the case pending when the manifest write fails and links it on the next attempt', async () => {
    const github = memoryGithub();
    const baseline = seed(github);
    let manifestFailures = 1;
    const transport: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'PUT' && url.includes('/data/probes/photos/') && manifestFailures > 0) {
        manifestFailures -= 1;
        return response(500, { message: 'unavailable' });
      }
      return github.transport(input, init);
    };
    const writer = new CalibrationProbeWriter('test-token', transport);
    const cloud = gateway({ failAfter: 1 });
    const photos = createCal010PhotoArchive(cloud);
    const pending = await recordCal010Observation(writer, photos, { maxTransientAttempts: 0 });
    expect(pending).toMatchObject({
      status: 'created',
      caseId: 'AF-900001',
      photoArchiveStatus: 'pending_private_archive',
      photoRefs: [],
      orphanPhotoRefs: [],
    });
    expect(github.files.has('data/probes/photos/AF-900001/IMG-000001.json')).toBe(false);
    const linked = await recordCal010Observation(writer, photos);
    expect(linked).toMatchObject({
      status: 'already_exists',
      caseId: 'AF-900001',
      photoArchiveStatus: 'archived_private',
      photoRefs: ['IMG-000001'],
    });
    expect(cloud.uploads).toHaveLength(1);
    expect(github.files.get('data/probes/cases/AF-900000.json')!.text).toBe(baseline.protectedCase);
    expect(github.files.get('data/index.json')!.text).toBe(baseline.realIndex);
  });

  it('recovers an orphan manifest and a Cloudinary asset that already exists', async () => {
    const { github, writer } = harness();
    const cloud = gateway();
    const photos = createCal010PhotoArchive(cloud);
    let caseUpdates = 0;
    const original = writer.updateVerifiedPhotos.bind(writer);
    writer.updateVerifiedPhotos = async (input) => {
      caseUpdates += 1;
      if (caseUpdates === 1) throw new Error('case update failed');
      return original(input);
    };
    const pending = await recordCal010Observation(writer, photos, { maxTransientAttempts: 0 });
    expect(pending.orphanPhotoRefs).toEqual(['IMG-000001']);
    expect(pending.photoRefs).toEqual([]);
    const engine = new CalibrationEngine(writer, photos, () => '2026-11-08T18:00:00.000Z', {
      sleep: async () => undefined,
      random: () => 0,
      retry: { maxTransientAttempts: 0 },
    });
    const recovered = await engine.recoverOrphanManifests('AF-900001', ['IMG-000001']);
    expect(recovered).toMatchObject({ linked: ['IMG-000001'], photoArchiveStatus: 'archived_private' });
    expect((await writer.readCase('AF-900001'))?.photo_refs).toEqual(['IMG-000001']);

    const retryCloud = gateway({ failUploads: 1 });
    const archived = await createCal010PhotoArchive(retryCloud).store({ caseId: 'AF-900001', bytes: image });
    expect(archived).toMatchObject({
      verified: true,
      sha256,
      assetPublicId: `${CAL010_CLOUDINARY_PREFIX}/AF-900001/${sha256.slice(0, 32)}`,
    });
    expect(retryCloud.uploads).toEqual([]);
    expect(github.files.get('data/index.json')).toBeTruthy();
  });

  it('does not verify a foreign prefix, the protected case, or a real case id', async () => {
    const archive = createCal010PhotoArchive(gateway({ wrongPublicId: true }));
    await expect(archive.store({ caseId: 'AF-900001', bytes: image })).resolves.toMatchObject({
      verified: false,
      assetPublicId: null,
    });
    const blocked = createCal010PhotoArchive(gateway());
    await expect(blocked.store({ caseId: 'AF-900000', bytes: image })).resolves.toMatchObject({ verified: false });
    await expect(blocked.store({ caseId: 'AF-000001', bytes: image })).resolves.toMatchObject({ verified: false });
    expect(readFileSync(join(__dirname, '../app.module.ts'), 'utf8')).not.toContain('CalibrationModule');
    expect(sha256).not.toBe('c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77');
  });
});
