import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import {
  CalibrationQueryError,
  calibrationPathAllowed,
  calibrationPhotoManifestPath,
  calibrationQueryAccess,
  listCalibrationCases,
  listCalibrationOpportunities,
  listCalibrationRepairs,
  readCalibrationCase,
  readCalibrationPhoto,
  readCalibrationQuote,
  readCalibrationRepair,
  readCalibrationSummary,
  type CalibrationArchive,
  type PhotoLocator,
} from './calibration-query';
import {
  CalibrationQueryGithub,
  fetchPrivatePhoto,
  mintCalibrationReadToken,
} from './calibration-query-source';
import { CalibrationQueryController, CalibrationQueryService } from './calibration-query.module';

const owner: AuthenticatedUser = {
  userId: 'user-1',
  email: 'dueno@ensayo.test',
  tallerId: '01000000-0000-4000-8000-000000000010',
  role: 'owner',
};

const openEnv: NodeJS.ProcessEnv = {
  PEGAZUZ_ENV: 'staging',
  CALIBRATION_READ_ENABLED: 'true',
  CALIBRATION_INGEST_ENABLED: 'false',
  CALIBRATION_READ_ACTORS: 'dueno@ensayo.test',
  RAILWAY_ENVIRONMENT_NAME: 'staging',
  RAILWAY_SERVICE_NAME: 'pegazuz-backend-staging',
};

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function archive(files: Record<string, string>, photos = new Map<string, Buffer>()): CalibrationArchive & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async read(path: string) {
      calls.push(`GET ${path}`);
      if (!calibrationPathAllowed(path)) throw new Error(`blocked ${path}`);
      return files[path] ?? null;
    },
    async photo(locator: PhotoLocator) {
      calls.push(`PHOTO ${locator.publicId}`);
      const bytes = photos.get(locator.sha256);
      if (!bytes) throw new Error('missing photo');
      return bytes;
    },
  };
}

function visualCase(id: string, patch: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema_version: '1.0.0',
    case_id: id,
    source: { kind: 'autofix_human_quote', source_case_key: 'fuente-privada-no-visible', quoted_at: null },
    vehicle: {
      make: 'Muestra',
      make_evidence: 'customer_provided',
      model: 'Sedán',
      model_evidence: 'customer_provided',
      year: 2018,
      year_evidence: 'customer_provided',
      variant: null,
      variant_evidence: 'unknown',
    },
    line_items: [{
      line_id: 'L1',
      part: 'Cofre',
      treatment: 'repair_paint',
      price_mxn: 1900,
      damage_severity: 'minor',
      validation: 'human_confirmed',
    }],
    visual_observations: ['Observación de taller'],
    status: 'human_verified',
    photo_refs: [],
    photo_archive_status: 'not_provided',
    ...patch,
  });
}

describe('consulta de calibración', () => {
  const image = Buffer.from('fotografia-de-ensayo');
  const digest = sha(image);
  const photo = {
    schema_version: '1.0.0',
    photo_id: 'IMG-000001',
    case_id: 'AF-000101',
    storage_provider: 'cloudinary',
    storage_status: 'verified',
    asset_public_id: `pegazuz_calibration/AF-000101/${digest.slice(0, 32)}`,
    asset_version: 7,
    delivery_type: 'authenticated',
    content_sha256: digest,
    mime_type: 'image/jpeg',
    size_bytes: image.length,
    source_kind: 'manual_import',
  };

  function files(): Record<string, string> {
    return {
      'data/index.json': JSON.stringify({
        schema_version: '1.0.0',
        cases: { 'AF-000101': 'fuente-a', 'AF-000102': 'fuente-b' },
        source_keys: { 'fuente-a': 'AF-000101', 'fuente-b': 'AF-000102' },
      }),
      'data/cases/AF-000101.json': visualCase('AF-000101', {
        photo_refs: ['IMG-000001'],
        photo_archive_status: 'archived_private',
        visual_observations: ['Observación de taller', 'cliente@correo.test'],
      }),
      'data/cases/AF-000102.json': visualCase('AF-000102', {
        vehicle: {
          make: null,
          make_evidence: 'unknown',
          model: 'Hatch',
          model_evidence: 'customer_provided',
          year: null,
          year_evidence: 'unknown',
          variant: null,
          variant_evidence: 'unknown',
        },
        photo_archive_status: 'pending_private_archive',
      }),
      'data/photos/AF-000101/IMG-000001.json': JSON.stringify(photo),
      'data/commercial/index.json': JSON.stringify({
        schema_version: '1.0.0',
        archive: 'commercial',
        opportunities: {
          'oportunidad-muestra': {
            root_quote_id: 'CQ-100201',
            head_quote_id: 'CQ-100202',
            quote_ids: ['CQ-100201', 'CQ-100202'],
          },
        },
        source_keys: { 'fuente-comercial': 'CQ-100202' },
      }),
      'data/commercial/quotes/CQ-100201.json': JSON.stringify(quote('CQ-100201', 1, null)),
      'data/commercial/quotes/CQ-100202.json': JSON.stringify(quote('CQ-100202', 2, 'CQ-100201', 26500)),
    };
  }

  it('oculta la consulta fuera de staging y exige owner autorizado', () => {
    expect(calibrationQueryAccess({ ...openEnv, CALIBRATION_READ_ENABLED: 'false' }, owner)).toBe('hidden');
    expect(calibrationQueryAccess({ ...openEnv, PEGAZUZ_ENV: 'production' }, owner)).toBe('hidden');
    expect(calibrationQueryAccess({ ...openEnv, CALIBRATION_INGEST_ENABLED: 'true' }, owner)).toBe('hidden');
    expect(calibrationQueryAccess({ ...openEnv, RAILWAY_SERVICE_NAME: 'omnichannel-backend' }, owner)).toBe('hidden');
    expect(calibrationQueryAccess(openEnv, { ...owner, role: 'admin' })).toBe('forbidden');
    expect(calibrationQueryAccess(openEnv, { ...owner, role: 'agent' })).toBe('forbidden');
    expect(calibrationQueryAccess(openEnv, { ...owner, email: 'otro@ensayo.test' })).toBe('forbidden');
    expect(calibrationQueryAccess(openEnv, { ...owner, email: 'dueno@ensayo.test.evil' })).toBe('forbidden');
    expect(calibrationQueryAccess(openEnv, { ...owner, email: 'xdueno@ensayo.test' })).toBe('forbidden');
    expect(calibrationQueryAccess(openEnv, { ...owner, email: 'dueno@ensayo.tes' })).toBe('forbidden');
    expect(calibrationQueryAccess(openEnv, { ...owner, email: 'DUENO@Ensayo.Test' })).toBe('open');
    expect(calibrationQueryAccess(openEnv, undefined)).toBe('forbidden');
    expect(calibrationQueryAccess({ ...openEnv, CALIBRATION_READ_ACTORS: '  Dueno@Ensayo.Test , otro@ensayo.test ' }, owner)).toBe('open');
    expect(calibrationQueryAccess({ ...openEnv, CALIBRATION_READ_ACTORS: '*@ensayo.test' }, owner)).toBe('forbidden');
    expect(calibrationQueryAccess({ ...openEnv, CALIBRATION_READ_ACTORS: 'dueno@ensayo' }, owner)).toBe('forbidden');
    expect(calibrationQueryAccess({ ...openEnv, CALIBRATION_READ_ACTORS: '' }, owner)).toBe('forbidden');
    expect(calibrationQueryAccess(openEnv, owner)).toBe('open');
  });

  it('no lee el archivo ni descarga fotografías sin permiso', async () => {
    const calls: string[] = [];
    const archive: CalibrationArchive = {
      read: async () => {
        calls.push('read');
        return null;
      },
      photo: async () => {
        calls.push('photo');
        return Buffer.from('x');
      },
    };
    const controller = new CalibrationQueryController(new CalibrationQueryService(archive));
    const previous = snapshotEnv();
    try {
      Object.assign(process.env, openEnv);
      await expect(controller.photo({ ...owner, role: 'agent' }, 'AF-000101', 'IMG-000001')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.photo(undefined as unknown as AuthenticatedUser, 'AF-000101', 'IMG-000001')).rejects.toBeInstanceOf(ForbiddenException);
      Object.assign(process.env, { CALIBRATION_READ_ENABLED: 'false' });
      await expect(controller.summary(owner)).rejects.toBeInstanceOf(NotFoundException);
      expect(calls).toEqual([]);
    } finally {
      restoreEnv(previous);
    }
  });

  it('resume expedientes, fotografías y oportunidades sin claves de origen', async () => {
    const store = archive(files(), new Map([[digest, image]]));
    const summary = await readCalibrationSummary(store);
    expect(summary).toMatchObject({
      visual: { caseCount: 2, archivedCount: 1, pendingCount: 1, photoCount: 1 },
      commercial: { opportunityCount: 1, quoteCount: 2 },
      repairs: { opportunityCount: 0, quoteCount: 0, truncated: false },
    });
    expect(JSON.stringify(summary)).not.toContain('fuente-a');
    expect(store.calls.some((call) => call.startsWith('PHOTO'))).toBe(false);
  });

  it('lista, filtra y pagina expedientes, y conserva un caso sin fotografías', async () => {
    const store = archive(files(), new Map([[digest, image]]));
    const pending = await listCalibrationCases(store, { archive: 'pending_private_archive' });
    expect(pending.items.map((item) => item.id)).toEqual(['AF-000102']);
    expect(pending.items[0]).toMatchObject({ archiveStatus: 'pending_private_archive', integrity: 'incomplete', photoCount: 0 });
    const page = await listCalibrationCases(store, { limit: '1' });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('AF-000101');
    const next = await listCalibrationCases(store, { limit: '1', cursor: 'AF-000101' });
    expect(next.items.map((item) => item.id)).toEqual(['AF-000102']);
    await expect(listCalibrationCases(store, { limit: '0' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(listCalibrationCases(store, { q: 'x'.repeat(81) })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('muestra piezas y omite el identificador privado de la fotografía', async () => {
    const store = archive(files(), new Map([[digest, image]]));
    const detail = await readCalibrationCase(store, 'AF-000101');
    expect(detail.lines).toEqual([
      expect.objectContaining({ part: 'Cofre', treatment: 'repair_paint', priceMxn: 1900 }),
    ]);
    expect(detail.observations).toEqual(['Observación de taller']);
    expect(detail.integrity).toBe('incomplete');
    expect(detail.photos).toEqual([
      expect.objectContaining({ id: 'IMG-000001', status: 'verified', verified: true }),
    ]);
    const body = JSON.stringify(detail);
    expect(body).not.toContain('asset_public_id');
    expect(body).not.toContain('pegazuz_calibration');
    expect(body).not.toContain('fuente-privada');
    expect(body).not.toContain('cliente@correo.test');
    await expect(readCalibrationCase(store, 'AF-1')).rejects.toBeInstanceOf(CalibrationQueryError);
  });

  it('entrega bytes verificados y rechaza una fotografía ajena o alterada', async () => {
    const store = archive(files(), new Map([[digest, image]]));
    const served = await readCalibrationPhoto(store, 'AF-000101', 'IMG-000001');
    expect(served.mime).toBe('image/jpeg');
    expect(served.bytes.equals(image)).toBe(true);
    expect(JSON.stringify({ mime: served.mime, bytes: served.bytes.length })).not.toContain('http');
    const tampered = archive(files(), new Map([[digest, Buffer.from('otro-archivo')]]));
    await expect(readCalibrationPhoto(tampered, 'AF-000101', 'IMG-000001')).rejects.toMatchObject({ code: 'unavailable' });
    const foreign = archive({
      ...files(),
      'data/photos/AF-000101/IMG-000001.json': JSON.stringify({
        ...photo,
        asset_public_id: 'pegazuz_calibration/cal010-probe/AF-900001/abc',
      }),
    }, new Map([[digest, image]]));
    await expect(readCalibrationPhoto(foreign, 'AF-000101', 'IMG-000001')).rejects.toMatchObject({ code: 'missing' });
    expect(foreign.calls.some((call) => call.startsWith('PHOTO'))).toBe(false);
  });

  it('resuelve los manifiestos en la carpeta del expediente', async () => {
    expect(calibrationPhotoManifestPath('AF-000002', 'IMG-000001')).toBe('data/photos/AF-000002/IMG-000001.json');
    expect(calibrationPhotoManifestPath('AF-000002', 'IMG-000002')).toBe('data/photos/AF-000002/IMG-000002.json');
    expect(calibrationPhotoManifestPath('AF-000002', 'IMG-000003')).toBe('data/photos/AF-000002/IMG-000003.json');
    expect(calibrationPhotoManifestPath('AF-000003', 'IMG-000001')).toBe('data/photos/AF-000003/IMG-000001.json');
    expect(calibrationPhotoManifestPath('AF-900001', 'IMG-000001')).toBeNull();
    expect(calibrationPhotoManifestPath('AF-12', 'IMG-000001')).toBeNull();
    expect(calibrationPhotoManifestPath('AF-000002/../AF-000003', 'IMG-000001')).toBeNull();
    expect(calibrationPhotoManifestPath('AF-000002%2f..', 'IMG-000001')).toBeNull();
    expect(calibrationPhotoManifestPath('AF-000002', '..\\IMG-000001')).toBeNull();
    expect(calibrationPathAllowed('data/photos/IMG-000001.json')).toBe(false);
    expect(calibrationPathAllowed('data/photos/AF-900001/IMG-000001.json')).toBe(false);
    expect(calibrationPathAllowed('data/photos/AF-000002/../../data/probes/index.json')).toBe(false);
    expect(calibrationPathAllowed('data/probes/photos/AF-900001/IMG-000001.json')).toBe(false);
    expect(calibrationPathAllowed('data/repairs/index.json')).toBe(true);
    expect(calibrationPathAllowed('data/repairs/quotes/RQ-000001.json')).toBe(true);
    expect(calibrationPathAllowed('data/repairs/quotes/CQ-000001.json')).toBe(false);
    expect(calibrationPathAllowed('data/repairs/quotes/../index.json')).toBe(false);
    expect(calibrationPathAllowed('data/repairs/quotes/RQ-000001.json/../../data/index.json')).toBe(false);

    const mazdaFirst = Buffer.from('ensayo-mazda-1');
    const mazdaSecond = Buffer.from('ensayo-mazda-2');
    const mazdaThird = Buffer.from('ensayo-mazda-3');
    const golf = Buffer.from('ensayo-golf-1');
    const digests = {
      mazdaFirst: sha(mazdaFirst),
      mazdaSecond: sha(mazdaSecond),
      mazdaThird: sha(mazdaThird),
      golf: sha(golf),
    };
    const manifest = (caseId: string, photoId: string, digest: string, bytes: number) => JSON.stringify({
      photo_id: photoId,
      case_id: caseId,
      storage_provider: 'cloudinary',
      storage_status: 'verified',
      asset_public_id: `pegazuz_calibration/${caseId}/${digest.slice(0, 32)}`,
      asset_version: 3,
      delivery_type: 'authenticated',
      content_sha256: digest,
      mime_type: 'image/jpeg',
      size_bytes: bytes,
    });
    const stored: Record<string, string> = {
      'data/index.json': JSON.stringify({
        cases: { 'AF-000001': 'inicial', 'AF-000002': 'mazda', 'AF-000003': 'golf' },
      }),
      'data/cases/AF-000001.json': visualCase('AF-000001', {
        photo_refs: [],
        photo_archive_status: 'pending_private_archive',
        visual_observations: [],
        line_items: [],
      }),
      'data/cases/AF-000002.json': visualCase('AF-000002', {
        vehicle: {
          make: 'Mazda',
          make_evidence: 'customer_provided',
          model: null,
          model_evidence: 'unknown',
          year: null,
          year_evidence: 'unknown',
          variant: null,
          variant_evidence: 'unknown',
        },
        line_items: [{
          line_id: 'L1',
          part: 'Costado',
          treatment: 'repair_paint',
          price_mxn: 5300,
          damage_severity: 'moderate',
          validation: 'human_confirmed',
        }],
        photo_refs: ['IMG-000001', 'IMG-000002', 'IMG-000003'],
        photo_archive_status: 'archived_private',
        visual_observations: [],
      }),
      'data/cases/AF-000003.json': visualCase('AF-000003', {
        vehicle: {
          make: 'Volkswagen',
          make_evidence: 'customer_provided',
          model: 'Golf MK2',
          model_evidence: 'customer_provided',
          year: null,
          year_evidence: 'unknown',
          variant: null,
          variant_evidence: 'unknown',
        },
        line_items: [{
          line_id: 'L1',
          part: 'Carrocería',
          treatment: 'paint',
          price_mxn: 10500,
          damage_severity: 'moderate',
          validation: 'human_confirmed',
        }],
        photo_refs: ['IMG-000001'],
        photo_archive_status: 'archived_private',
        visual_observations: [],
      }),
      'data/photos/AF-000002/IMG-000001.json': manifest('AF-000002', 'IMG-000001', digests.mazdaFirst, mazdaFirst.length),
      'data/photos/AF-000002/IMG-000002.json': manifest('AF-000002', 'IMG-000002', digests.mazdaSecond, mazdaSecond.length),
      'data/photos/AF-000002/IMG-000003.json': manifest('AF-000002', 'IMG-000003', digests.mazdaThird, mazdaThird.length),
      'data/photos/AF-000003/IMG-000001.json': manifest('AF-000003', 'IMG-000001', digests.golf, golf.length),
    };
    const bytes = new Map<string, Buffer>([
      [digests.mazdaFirst, mazdaFirst],
      [digests.mazdaSecond, mazdaSecond],
      [digests.mazdaThird, mazdaThird],
      [digests.golf, golf],
    ]);
    const store = archive(stored, bytes);
    const mazda = await readCalibrationCase(store, 'AF-000002');
    expect(mazda.photos.map((item) => item.id)).toEqual(['IMG-000001', 'IMG-000002', 'IMG-000003']);
    expect(mazda.photos.every((item) => item.verified)).toBe(true);
    expect(mazda.quotedTotalMxn).toBe(5300);
    const golfCase = await readCalibrationCase(store, 'AF-000003');
    expect(golfCase.photoCount).toBe(1);
    expect(golfCase.quotedTotalMxn).toBe(10500);
    const empty = await readCalibrationCase(store, 'AF-000001');
    expect(empty.photoCount).toBe(0);
    expect(empty.photos).toEqual([]);
    const sharedMazda = await readCalibrationPhoto(store, 'AF-000002', 'IMG-000001');
    const sharedGolf = await readCalibrationPhoto(store, 'AF-000003', 'IMG-000001');
    expect(sharedMazda.bytes.equals(mazdaFirst)).toBe(true);
    expect(sharedGolf.bytes.equals(golf)).toBe(true);

    await expect(readCalibrationPhoto(store, 'AF-000001', 'IMG-000001')).rejects.toMatchObject({ code: 'missing' });
    await expect(readCalibrationPhoto(store, 'AF-900001', 'IMG-000001')).rejects.toMatchObject({ code: 'invalid' });
    await expect(readCalibrationPhoto(store, 'AF-000002/../AF-000003', 'IMG-000001')).rejects.toMatchObject({ code: 'invalid' });
    await expect(readCalibrationPhoto(store, 'AF-%00002', 'IMG-000001')).rejects.toMatchObject({ code: 'invalid' });

    const absent = archive({
      ...stored,
      'data/cases/AF-000002.json': visualCase('AF-000002', {
        photo_refs: ['IMG-000002'],
        photo_archive_status: 'archived_private',
        visual_observations: [],
      }),
    }, bytes);
    await expect(readCalibrationPhoto(absent, 'AF-000002', 'IMG-000001')).rejects.toMatchObject({ code: 'missing' });
    expect(absent.calls.some((call) => call.includes('data/photos/AF-000002/IMG-000001.json'))).toBe(false);

    const foreignCase = archive({
      ...stored,
      'data/photos/AF-000002/IMG-000001.json': manifest('AF-000003', 'IMG-000001', digests.golf, golf.length),
    }, bytes);
    await expect(readCalibrationPhoto(foreignCase, 'AF-000002', 'IMG-000001')).rejects.toMatchObject({ code: 'missing' });
    expect(foreignCase.calls.some((call) => call.startsWith('PHOTO'))).toBe(false);

    const wrongHash = archive(stored, new Map([[digests.mazdaFirst, Buffer.from('bytes-distintos')]]));
    await expect(readCalibrationPhoto(wrongHash, 'AF-000002', 'IMG-000001')).rejects.toMatchObject({ code: 'unavailable' });

    expect(store.calls.every((call) => call.startsWith('GET ') || call.startsWith('PHOTO '))).toBe(true);
    expect(store.calls.some((call) => call.includes('data/probes') || call.includes('PUT '))).toBe(false);
    expect(store.calls).toEqual(expect.arrayContaining([
      'GET data/photos/AF-000002/IMG-000001.json',
      'GET data/photos/AF-000002/IMG-000002.json',
      'GET data/photos/AF-000002/IMG-000003.json',
      'GET data/photos/AF-000003/IMG-000001.json',
    ]));
    const query = readFileSync(join(__dirname, 'calibration-query.ts'), 'utf8');
    expect(query).toContain('data/photos/${caseId}/${photoId}.json');
    expect(query).not.toContain('data/photos/${photoId}.json');
  });

  it('lista oportunidades y conserva el historial comercial sin fotografías', async () => {
    const store = archive(files());
    const listed = await listCalibrationOpportunities(store, { service: 'bath_with_bodywork', q: 'cr-v' });
    expect(listed.items).toEqual([
      expect.objectContaining({
        headQuoteId: 'CQ-100202',
        revisionCount: 2,
        service: 'bath_with_bodywork',
        quotedMxn: 34000,
        integrity: 'complete',
      }),
    ]);
    const detail = await readCalibrationQuote(store, 'CQ-100202');
    expect(detail.revisions.map((item) => item.id)).toEqual(['CQ-100201', 'CQ-100202']);
    expect(detail.revisions[0]).toMatchObject({ contractedValidation: 'not_provided', collectedValidation: 'not_provided' });
    expect(detail.revisions[1]).toMatchObject({ contractedMxn: 26500, quotedMxn: 34000 });
    expect(JSON.stringify(detail)).not.toContain('fuente-comercial');
    expect(await listCalibrationOpportunities(archive({}), {})).toMatchObject({ items: [] });
    await expect(readCalibrationQuote(store, 'CQ-999999')).rejects.toMatchObject({ code: 'missing' });
  });

  it('el lector remoto solo hace GET sobre rutas permitidas y pide contents:read', async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const github = new CalibrationQueryGithub(async () => 'ghs_reader', async (input, init) => {
      calls.push({ url: String(input), method: String(init?.method) });
      return new Response(JSON.stringify({ content: Buffer.from('{"ok":true}').toString('base64') }), { status: 200 });
    });
    expect(await github.read('data/index.json')).toContain('ok');
    expect(calls).toEqual([{ url: expect.stringContaining('/contents/data/index.json?ref=main'), method: 'GET' }]);
    await expect(github.read('data/probes/index.json')).rejects.toThrow('not readable');
    expect(calls).toHaveLength(1);

    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const tokenCalls: { method: string; body: string }[] = [];
    const token = await mintCalibrationReadToken({
      CALIBRATION_GITHUB_APP_ID: '123',
      CALIBRATION_GITHUB_INSTALLATION_ID: '456',
      CALIBRATION_GITHUB_APP_PRIVATE_KEY: pem,
      CALIBRATION_GITHUB_REPOSITORY: 'arturo2565-alt/pegazuz-calibration-data',
    }, async (input, init) => {
      tokenCalls.push({ method: String(init?.method), body: String(init?.body) });
      return new Response(JSON.stringify(readTokenBody()), { status: 201 });
    });
    expect(token).toBe('ghs_readtoken');
    expect(tokenCalls[0]?.method).toBe('POST');
    expect(JSON.parse(tokenCalls[0]?.body ?? '{}')).toMatchObject({
      repositories: ['pegazuz-calibration-data'],
      permissions: { contents: 'read' },
    });
    const rejected = [
      { token: 'ghs_writetoken', permissions: { contents: 'write' } },
      { ...readTokenBody(), permissions: { contents: 'read', metadata: 'read', actions: 'read' } },
      { ...readTokenBody(), repositories: [{ name: 'otro-repo', full_name: 'arturo2565-alt/otro-repo' }] },
      { ...readTokenBody(), expires_at: '2000-01-01T00:00:00.000Z' },
    ];
    for (const body of rejected) {
      await expect(mintCalibrationReadToken({
        CALIBRATION_GITHUB_APP_ID: '123',
        CALIBRATION_GITHUB_INSTALLATION_ID: '456',
        CALIBRATION_GITHUB_APP_PRIVATE_KEY: pem,
      }, async () => new Response(JSON.stringify(body), { status: 201 }))).rejects.toThrow('could not be read');
    }
  });

  it('no devuelve la URL firmada de Cloudinary', async () => {
    const signed = 'https://res.cloudinary.com/example/image/authenticated/s--short--/v7/photo.jpg';
    const bytes = await fetchPrivatePhoto({
      publicId: `pegazuz_calibration/AF-000101/${digest.slice(0, 32)}`,
      version: 7,
      format: 'jpg',
      sha256: digest,
    }, async (input) => {
      expect(String(input)).toBe(signed);
      return new Response(image, { status: 200 });
    }, () => signed);
    expect(bytes.equals(image)).toBe(true);
    expect(JSON.stringify({ bytes: bytes.length })).not.toContain('cloudinary');
    await expect(fetchPrivatePhoto({
      publicId: 'pegazuz_calibration/AF-000101/abc',
      version: 7,
      format: 'jpg',
      sha256: digest,
    }, async () => new Response(image), () => 'https://example.test/private.jpg')).rejects.toThrow('could not be read');
  });

  it('lista reparaciones textuales, pagina y conserva el historial sin fotografías', async () => {
    const store = archive({
      'data/repairs/index.json': JSON.stringify({
        schema_version: '1.0.0',
        archive: 'repairs',
        opportunities: {
          'fuente-rq-secreta': {
            root_quote_id: 'RQ-100001',
            head_quote_id: 'RQ-100001',
            quote_ids: ['RQ-100001'],
          },
          'oportunidad-fascia': {
            root_quote_id: 'RQ-100002',
            head_quote_id: 'RQ-100003',
            quote_ids: ['RQ-100002', 'RQ-100003'],
          },
        },
        source_keys: { 'fuente-rq-secreta': 'RQ-100001' },
      }),
      'data/repairs/quotes/RQ-100001.json': JSON.stringify(repairQuote('RQ-100001', 1, null, 'Aveo', 2026)),
      'data/repairs/quotes/RQ-100002.json': JSON.stringify(repairQuote('RQ-100002', 1, null, 'Sedán', 2019)),
      'data/repairs/quotes/RQ-100003.json': JSON.stringify(repairQuote('RQ-100003', 2, 'RQ-100002', 'Sedán', 2019, 2900)),
      'data/cases/AF-000101.json': visualCase('AF-000101'),
      'data/commercial/quotes/CQ-100201.json': JSON.stringify(quote('CQ-100201', 1, null)),
    });
    const listed = await listCalibrationRepairs(store, { q: 'aveo' });
    expect(listed.items).toEqual([
      expect.objectContaining({
        headQuoteId: 'RQ-100001',
        revisionCount: 1,
        integrity: 'complete',
        model: 'Aveo',
        year: 2026,
        quotedMxn: 6300,
        evidence: 'text_only',
        photoStatus: 'not_provided',
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain('fuente-rq-secreta');
    const page = await listCalibrationRepairs(store, { limit: '1' });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('RQ-100001');
    const detail = await readCalibrationRepair(store, 'RQ-100003');
    expect(detail.revisions.map((item) => item.id)).toEqual(['RQ-100002', 'RQ-100003']);
    expect(detail.headQuoteId).toBe('RQ-100003');
    expect(detail.integrity).toBe('complete');
    const active = detail.revisions[1];
    expect(active.lines.map((line) => [line.part, line.role, line.quotedMxn])).toEqual([
      ['fascia delantera', 'part', 2900],
      ['fascia delantera', 'labor', 3400],
    ]);
    expect(active.quotedTotalMxn).toBe(6300);
    expect(active.lines[0].contractedValidation).toBe('not_provided');
    expect(active.lines[1].contractedMxn).toBe(2900);
    expect(active.conditions).toEqual(['Tiempo estimado de 3 a 4 dias habiles.']);
    expect(store.calls.some((call) => call.startsWith('PHOTO') || call.includes('data/cases') || call.includes('data/commercial'))).toBe(false);
    expect(JSON.stringify(detail)).not.toContain('fuente-rq-secreta');
    await expect(readCalibrationRepair(store, 'CQ-100201')).rejects.toMatchObject({ code: 'invalid' });
    await expect(readCalibrationRepair(store, 'RQ-100099')).rejects.toMatchObject({ code: 'missing' });
  });

  it('no lee reparaciones sin autorización de owner', async () => {
    const store = archive({
      'data/repairs/index.json': JSON.stringify({ opportunities: {}, source_keys: {} }),
    });
    const controller = new CalibrationQueryController(new CalibrationQueryService(store));
    const previous = snapshotEnv();
    try {
      Object.assign(process.env, openEnv);
      await expect(controller.repairs({ ...owner, role: 'agent' }, {})).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.repair({ ...owner, role: 'admin' }, 'RQ-100001')).rejects.toBeInstanceOf(ForbiddenException);
      Object.assign(process.env, { CALIBRATION_READ_ENABLED: 'false' });
      await expect(controller.repairs(owner, {})).rejects.toBeInstanceOf(NotFoundException);
      expect(store.calls).toEqual([]);
    } finally {
      restoreEnv(previous);
    }
  });

  it('no abre escritura ni monta el módulo de ingesta', () => {
    const controller = readFileSync(join(__dirname, 'calibration-query.module.ts'), 'utf8');
    const app = readFileSync(join(__dirname, '../app.module.ts'), 'utf8');
    const source = readFileSync(join(__dirname, 'calibration-query-source.ts'), 'utf8');
    expect(controller).not.toMatch(/@(Post|Put|Patch|Delete)\(/);
    expect(controller).toContain("@Get('summary')");
    expect(controller).toContain("@Get('repairs')");
    expect(controller).toContain("@Get('repairs/:quoteId')");
    expect(controller).not.toContain('repair-quote-import');
    expect(app).toContain('CalibrationQueryModule');
    expect(app).not.toContain('CalibrationModule');
    expect(app).not.toContain('CalibrationIngestController');
    expect(source).not.toContain("method: 'PUT'");
    expect(source).not.toContain("method: 'PATCH'");
    expect(source).not.toContain("method: 'DELETE'");
    expect(source).toContain("permissions: { contents: 'read' }");
    expect(source).toContain('expiresAtMs - RENEW_BEFORE_MS');
    const strategy = readFileSync(join(__dirname, '../auth/strategies/jwt.strategy.ts'), 'utf8');
    const auth = readFileSync(join(__dirname, '../auth/auth.service.ts'), 'utf8');
    expect(strategy).toContain('ExtractJwt.fromAuthHeaderAsBearerToken()');
    expect(strategy).not.toContain('req.body');
    expect(auth).toContain('email: user.email');
    expect(auth).toContain('role: user.role');
    expect(controller).toContain("@Header('Cache-Control', 'private, no-store')");
    expect(controller).toContain('@UseGuards(JwtAuthGuard)');
    expect(controller).toContain('@CurrentUser() user: AuthenticatedUser');
  });
});

function readTokenBody() {
  return {
    token: 'ghs_readtoken',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: { contents: 'read', metadata: 'read' },
    repository_selection: 'selected',
    repositories: [{
      name: 'pegazuz-calibration-data',
      full_name: 'arturo2565-alt/pegazuz-calibration-data',
      private: true,
    }],
  };
}

function snapshotEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function restoreEnv(previous: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) delete process.env[key];
  }
  Object.assign(process.env, previous);
}

function repairQuote(
  id: string,
  revision: number,
  prior: string | null,
  model: string,
  year: number,
  contractedLabor: number | null = null,
) {
  const laborContracted = contractedLabor == null
    ? { amount_mxn: null, validation: 'not_provided' }
    : { amount_mxn: contractedLabor, validation: 'human_confirmed' };
  return {
    schema_version: '1.0.0',
    quote_id: id,
    revision,
    recorded_at: '2026-11-14T03:25:39.889Z',
    evidence: 'text_only',
    photo_status: 'not_provided',
    source: {
      kind: 'autofix_human_repair_quote',
      source_case_key: 'fuente-rq-secreta',
      opportunity_key: 'fuente-rq-secreta',
      prior_quote_id: prior,
      quoted_at: null,
    },
    vehicle: {
      make: null,
      make_evidence: 'unknown',
      model,
      model_evidence: 'customer_provided',
      year,
      year_evidence: 'customer_provided',
      variant: null,
      variant_evidence: 'unknown',
    },
    lines: [
      {
        line_id: 'L01',
        part: 'fascia delantera',
        role: 'part',
        labor: null,
        prices: {
          quoted: { amount_mxn: 2900, validation: 'human_confirmed' },
          contracted: { amount_mxn: null, validation: 'not_provided' },
          collected: { amount_mxn: null, validation: 'not_provided' },
        },
      },
      {
        line_id: 'L02',
        part: 'fascia delantera',
        role: 'labor',
        labor: 'mount_and_paint',
        prices: {
          quoted: { amount_mxn: 3400, validation: 'human_confirmed' },
          contracted: laborContracted,
          collected: { amount_mxn: null, validation: 'not_provided' },
        },
      },
    ],
    quoted_total_mxn: 6300,
    conditions: ['Tiempo estimado de 3 a 4 dias habiles.'],
    status: 'human_verified',
  };
}

function quote(id: string, revision: number, prior: string | null, contracted: number | null = null) {
  return {
    schema_version: '1.0.0',
    quote_id: id,
    revision,
    recorded_at: '2026-11-13T20:00:00.000Z',
    source: {
      kind: 'autofix_human_commercial_quote',
      source_case_key: `fuente-${id}`,
      opportunity_key: 'oportunidad-muestra',
      prior_quote_id: prior,
      quoted_at: null,
    },
    vehicle: {
      make: 'Honda',
      make_evidence: 'customer_provided',
      model: 'CR-V',
      model_evidence: 'customer_provided',
      year: 2010,
      year_evidence: 'customer_provided',
      variant: null,
      variant_evidence: 'unknown',
    },
    service: 'bath_with_bodywork',
    colors: {
      current: null,
      current_evidence: 'unknown',
      requested: null,
      requested_evidence: 'unknown',
    },
    work_scope: ['bodywork'],
    prices: {
      quoted: { amount_mxn: 34000, validation: 'human_confirmed' },
      contracted: contracted == null
        ? { amount_mxn: null, validation: 'not_provided' }
        : { amount_mxn: contracted, validation: 'human_confirmed' },
      collected: { amount_mxn: null, validation: 'not_provided' },
    },
    status: 'human_verified',
  };
}
