import { createHash, generateKeyPairSync } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedUser, JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { minimalDecodablePng } from './calibration-image-archive.service';
import { listCalibrationEvidence, readCalibrationEvidence } from './calibration-query';
import { evidencePublicId } from './evidence-cloudinary';
import {
  EvidenceLinkError,
  assertEvidenceWrite,
  commitOwnerReview,
  linkEvidence,
  sha256,
  type EvidenceFiles,
  type EvidencePhotoReceipt,
} from './evidence-link';
import {
  EVIDENCE_PREVIEW_TTL_MS,
  EvidencePreviewVault,
  EvidenceReviewDesk,
  EvidenceReviewError,
  evidenceWriteGrantAllowed,
  type EvidenceReviewDependencies,
} from './evidence-review';
import { EvidenceReviewController } from './evidence-review.module';

async function holdReviewedCopy(
  controller: EvidenceReviewController,
  subjectId: string,
  image: Buffer,
  origin: Buffer,
): Promise<{ previewId: string; sha256: string }> {
  const noted = await controller.hold(owner, {
    subjectId,
    role: 'origin',
    imageBase64: origin.toString('base64'),
  }) as { provenanceId: string };
  return await controller.hold(owner, {
    subjectId,
    role: 'copy',
    provenanceId: noted.provenanceId,
    imageBase64: image.toString('base64'),
  }) as { previewId: string; sha256: string };
}

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

class MemoryFiles implements EvidenceFiles {
  readonly files = new Map<string, { content: string; sha: string }>();
  readonly writes: string[] = [];

  async read(path: string) {
    return this.files.get(path) ?? null;
  }

  async write(path: string, content: string, sha?: string) {
    assertEvidenceWrite(path);
    if (content.includes('https://') || content.includes('http://')) throw new EvidenceLinkError('rejected');
    const current = this.files.get(path);
    if (current && current.sha !== sha) throw new EvidenceLinkError('conflict');
    if (!current && sha) throw new EvidenceLinkError('conflict');
    const next = { content, sha: `git-${this.writes.length + 1}` };
    this.files.set(path, next);
    this.writes.push(path);
    return next.sha;
  }

  seed(path: string, content: string) {
    this.files.set(path, { content, sha: `seed-${path}` });
  }
}

class MemoryPhotos {
  readonly calls: string[] = [];

  async store(input: { subjectId: string; evidenceId: string; bytes: Buffer }): Promise<EvidencePhotoReceipt> {
    this.calls.push(input.evidenceId);
    const digest = sha256(input.bytes);
    return { sha256: digest, verified: true, assetPublicId: evidencePublicId(input.subjectId, input.evidenceId, digest), assetVersion: 3 };
  }
}

function quote(id: string) {
  return JSON.stringify({ quote_id: id, prices: { quoted: { amount_mxn: 32000, validation: 'human_confirmed' } } });
}

function deskFor(files: MemoryFiles, env: NodeJS.ProcessEnv = openEnv, extra: EvidenceReviewDependencies = {}) {
  return new EvidenceReviewDesk({ files, env, ...extra });
}

async function streamBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('revisión autenticada del propietario', () => {
  const received = '11'.repeat(32);
  const otherReceived = '22'.repeat(32);

  it('exige la sesión del propietario, la vista de esos bytes y una confirmación explícita', async () => {
    const files = new MemoryFiles();
    const quoteBody = quote('CQ-000021');
    files.seed('data/commercial/quotes/CQ-000021.json', quoteBody);
    const original = minimalDecodablePng([1, 2, 3]);
    const bytes = Buffer.from(original);
    const photos = new MemoryPhotos();
    const desk = deskFor(files, openEnv, { photos });
    const preview = await desk.hold(owner, { subjectId: 'CQ-000021', receivedSha256: received, bytes });
    bytes[10] ^= 0xff;
    const seen = await desk.read(owner, preview.previewId);
    expect(seen.bytes.equals(original)).toBe(true);
    expect(seen.mime).toBe('image/png');
    expect(seen.sha256).toBe(preview.sha256);
    expect(sha256(original)).toBe(preview.sha256);

    const review = await desk.confirm(owner, preview.previewId, {
      subjectId: 'CQ-000021',
      sha256: preview.sha256,
      visibleIdentifiersReviewed: true,
    });
    expect(review).toMatchObject({
      status: 'attested',
      archive: 'linked',
      reviewId: 'RV-000001',
      evidenceId: 'EV-000001',
      sha256: preview.sha256,
    });
    expect(photos.calls).toEqual(['EV-000001']);
    expect(files.writes.filter((path) => path.includes('/reviews/RV-'))).toHaveLength(1);
    expect(files.writes.some((path) => path.includes('/manifests/EV-000001.json'))).toBe(true);

    const document = files.files.get('data/evidence/commercial/CQ-000021/reviews/RV-000001.json')?.content ?? '';
    const actorKey = createHash('sha256').update(`calibration-owner\0${owner.userId}`).digest('hex');
    expect(document).toContain('"authorization": "authenticated_owner"');
    expect(document).toContain(`"actor_key": "${actorKey}"`);
    expect(document).toContain('"visible_identifiers_reviewed": true');
    expect(document).toContain(`"received_sha256": "${received}"`);
    expect(document).toContain(`"reviewed_sha256": "${preview.sha256}"`);
    expect(document).not.toContain('operator_role');
    expect(document).not.toContain(owner.email);
    expect(document).not.toContain('@');
    expect(files.writes.every((path) => path.startsWith('data/evidence/'))).toBe(true);
    expect(files.writes.some((path) => path.includes('/reviews/'))).toBe(true);
    expect(files.writes.some((path) => path.includes('/manifests/'))).toBe(true);
    expect(files.writes.some((path) => path.includes('/links/'))).toBe(true);
    expect(files.writes.join('\n')).not.toContain('CQ-000006');
    expect(files.writes.some((path) => path.startsWith('data/cases/') || path.startsWith('data/photos/'))).toBe(false);
    expect(files.files.get('data/commercial/quotes/CQ-000021.json')?.content).toBe(quoteBody);

    const changed = minimalDecodablePng([9, 9, 9]);
    const laterPhotos = new MemoryPhotos();
    await expect(linkEvidence(files, laterPhotos, {
      subjectId: 'CQ-000021',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes: changed,
    })).rejects.toMatchObject({ code: 'conflict' });
    expect(laterPhotos.calls).toEqual([]);
    const linked = await linkEvidence(files, laterPhotos, {
      subjectId: 'CQ-000021',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes: original,
    });
    expect(linked).toMatchObject({ status: 'already_linked', evidenceId: 'EV-000001' });
    await expect(linkEvidence(files, laterPhotos, {
      subjectId: 'CQ-000021',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes: changed,
    })).rejects.toMatchObject({ code: 'conflict' });
    expect(photos.calls).toEqual(['EV-000001']);
    expect(laterPhotos.calls).toEqual([]);
  });

  it('no reutiliza la aprobación para otro hash, otra cotización u otra fotografía', async () => {
    const files = new MemoryFiles();
    files.seed('data/commercial/quotes/CQ-000021.json', quote('CQ-000021'));
    files.seed('data/commercial/quotes/CQ-000022.json', quote('CQ-000022'));
    files.seed('data/evidence/commercial/CQ-000021/index.json', `${JSON.stringify({
      schema_version: '1.0.0',
      subject_kind: 'commercial_quote',
      subject_id: 'CQ-000021',
      items: [{
        evidence_id: 'EV-000001',
        link_id: 'LN-000001',
        state: 'privacy_pending',
        received_sha256: 'aa'.repeat(32),
        content_sha256: null,
        provenance: null,
      }],
      link_ids: ['LN-000001'],
    })}\n`);
    const first = minimalDecodablePng([4, 4, 4]);
    const second = minimalDecodablePng([5, 5, 5]);
    const storedPhotos = new MemoryPhotos();
    const desk = deskFor(files, openEnv, { photos: storedPhotos });
    const preview = await desk.hold(owner, { subjectId: 'CQ-000021', receivedSha256: received, bytes: first });
    await desk.read(owner, preview.previewId);
    await expect(desk.confirm(owner, preview.previewId, {
      subjectId: 'CQ-000021',
      sha256: sha256(second),
      visibleIdentifiersReviewed: true,
    })).rejects.toMatchObject({ code: 'conflict' });
    await expect(desk.confirm(owner, preview.previewId, {
      subjectId: 'CQ-000022',
      sha256: preview.sha256,
      visibleIdentifiersReviewed: true,
    })).rejects.toMatchObject({ code: 'conflict' });
    expect(files.writes).toEqual([]);

    const review = await desk.confirm(owner, preview.previewId, {
      subjectId: 'CQ-000021',
      sha256: preview.sha256,
      visibleIdentifiersReviewed: true,
    });
    expect(review).toMatchObject({ evidenceId: 'EV-000002', archive: 'linked' });
    expect(storedPhotos.calls).toEqual(['EV-000002']);
    const photos = new MemoryPhotos();
    await expect(linkEvidence(files, photos, {
      subjectId: 'CQ-000022',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes: first,
    })).rejects.toMatchObject({ code: 'review_required' });
    await expect(linkEvidence(files, photos, {
      subjectId: 'CQ-000021',
      approval: 'anonymized_copy',
      receivedSha256: otherReceived,
      bytes: second,
    })).rejects.toMatchObject({ code: 'review_required' });
    const linked = await linkEvidence(files, photos, {
      subjectId: 'CQ-000021',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes: first,
    });
    expect(linked).toMatchObject({ status: 'already_linked', evidenceId: 'EV-000002' });
    expect(photos.calls).toEqual([]);
    expect(storedPhotos.calls).toEqual(['EV-000002']);
    expect(files.files.has('data/evidence/commercial/CQ-000022/reviews/index.json')).toBe(false);
  });

  it('no archiva si la revisión visual no ocurrió y caduca la copia temporal', async () => {
    const files = new MemoryFiles();
    files.seed('data/commercial/quotes/CQ-000021.json', quote('CQ-000021'));
    const bytes = minimalDecodablePng([6, 6, 6]);
    let now = Date.parse('2026-11-14T18:00:00.000Z');
    const vault = new EvidencePreviewVault(() => now);
    const desk = deskFor(files, openEnv, { vault });
    const preview = await desk.hold(owner, { subjectId: 'CQ-000021', receivedSha256: received, bytes });
    expect(preview.expiresAt).toBe(new Date(now + EVIDENCE_PREVIEW_TTL_MS).toISOString());
    await expect(desk.confirm(owner, preview.previewId, {
      subjectId: 'CQ-000021',
      sha256: preview.sha256,
      visibleIdentifiersReviewed: true,
    })).rejects.toMatchObject({ code: 'incomplete' });
    await desk.read(owner, preview.previewId);
    await expect(desk.confirm(owner, preview.previewId, {
      subjectId: 'CQ-000021',
      sha256: preview.sha256,
      visibleIdentifiersReviewed: false,
    })).rejects.toMatchObject({ code: 'incomplete' });
    expect(files.writes).toEqual([]);

    const other = deskFor(files, {
      ...openEnv,
      CALIBRATION_READ_ACTORS: 'dueno@ensayo.test,otro@ensayo.test',
    }, { vault });
    const secondOwner: AuthenticatedUser = { ...owner, userId: 'user-2', email: 'otro@ensayo.test' };
    await expect(other.read(secondOwner, preview.previewId)).rejects.toMatchObject({ code: 'missing' });
    const later = await desk.hold(owner, { subjectId: 'CQ-000021', receivedSha256: otherReceived, bytes: minimalDecodablePng([6, 6, 7]) });
    now += EVIDENCE_PREVIEW_TTL_MS + 1;
    await expect(desk.confirm(owner, later.previewId, {
      subjectId: 'CQ-000021',
      sha256: later.sha256,
      visibleIdentifiersReviewed: true,
    })).rejects.toMatchObject({ code: 'expired' });
    await expect(desk.read(owner, preview.previewId)).rejects.toMatchObject({ code: 'expired' });
    await expect(desk.confirm(owner, preview.previewId, {
      subjectId: 'CQ-000021',
      sha256: preview.sha256,
      visibleIdentifiersReviewed: true,
    })).rejects.toMatchObject({ code: 'missing' });
    expect(files.writes).toEqual([]);
  });

  it('rechaza agent, admin, correo ajeno, JWT ausente o inválido y un rol escrito a mano', async () => {
    const files = new MemoryFiles();
    files.seed('data/commercial/quotes/CQ-000021.json', quote('CQ-000021'));
    const bytes = minimalDecodablePng([7, 7, 7]);
    const previous = { ...process.env };
    try {
      Object.assign(process.env, openEnv);
      const desk = new EvidenceReviewDesk({ files, env: process.env });
      const controller = new EvidenceReviewController(desk);
      await expect(controller.hold({ ...owner, role: 'agent' }, {
        subjectId: 'CQ-000021',
        receivedSha256: received,
        imageBase64: bytes.toString('base64'),
      })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.hold({ ...owner, role: 'admin' }, {
        subjectId: 'CQ-000021',
        receivedSha256: received,
        imageBase64: bytes.toString('base64'),
      })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.hold({ ...owner, email: 'otro@ensayo.test' }, {
        subjectId: 'CQ-000021',
        receivedSha256: received,
        imageBase64: bytes.toString('base64'),
      })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.hold(undefined as unknown as AuthenticatedUser, {
        subjectId: 'CQ-000021',
        receivedSha256: received,
        imageBase64: bytes.toString('base64'),
      })).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(controller.hold(owner, {
        subjectId: 'CQ-000021',
        receivedSha256: received,
        imageBase64: bytes.toString('base64'),
        operatorRole: 'owner',
      })).rejects.toBeInstanceOf(BadRequestException);
      expect(files.writes).toEqual([]);

      const validate = JwtStrategy.prototype.validate as (payload: Partial<JwtPayload>) => AuthenticatedUser;
      expect(() => validate.call({}, { role: 'owner', email: owner.email })).toThrow(UnauthorizedException);
      expect(() => validate.call({}, { sub: '', tallerId: owner.tallerId, email: owner.email, role: 'owner' })).toThrow(UnauthorizedException);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
    }
  });

  it('no deja que el vínculo ni un objeto fabricado creen la revisión', async () => {
    const files = new MemoryFiles();
    const quoteBody = quote('CQ-000021');
    files.seed('data/commercial/quotes/CQ-000021.json', quoteBody);
    const bytes = minimalDecodablePng([8, 8, 8]);
    const photos = new MemoryPhotos();
    await expect(linkEvidence(files, photos, {
      subjectId: 'CQ-000021',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes,
      humanReviewed: true,
      operatorRole: 'owner',
      visibleIdentifiersReviewed: true,
    } as never)).rejects.toMatchObject({ code: 'rejected' });
    await expect(commitOwnerReview(files, {
      operatorRole: 'owner',
      subjectId: 'CQ-000021',
      receivedSha256: received,
      reviewedSha256: sha256(bytes),
      confirmation: 'human_reviewed',
    } as never)).rejects.toMatchObject({ code: 'rejected' });
    expect(files.writes).toEqual([]);
    expect(photos.calls).toEqual([]);
    expect(files.files.get('data/commercial/quotes/CQ-000021.json')?.content).toBe(quoteBody);
  });

  it('oculta la revisión en producción y no abre una carga pública', async () => {
    const files = new MemoryFiles();
    files.seed('data/commercial/quotes/CQ-000021.json', quote('CQ-000021'));
    const bytes = minimalDecodablePng();
    const previous = { ...process.env };
    try {
      Object.assign(process.env, openEnv, { RAILWAY_ENVIRONMENT_NAME: 'production' });
      const controller = new EvidenceReviewController(new EvidenceReviewDesk({ files, env: process.env }));
      await expect(controller.hold(owner, {
        subjectId: 'CQ-000021',
        receivedSha256: received,
        imageBase64: bytes.toString('base64'),
      })).rejects.toBeInstanceOf(NotFoundException);
      Object.assign(process.env, { CALIBRATION_INGEST_ENABLED: 'true', RAILWAY_ENVIRONMENT_NAME: 'staging' });
      await expect(controller.hold(owner, {
        subjectId: 'CQ-000021',
        receivedSha256: received,
        imageBase64: bytes.toString('base64'),
      })).rejects.toBeInstanceOf(NotFoundException);
      Object.assign(process.env, { CALIBRATION_INGEST_ENABLED: 'false', RAILWAY_SERVICE_NAME: 'omnichannel-backend' });
      await expect(controller.hold(owner, {
        subjectId: 'CQ-000021',
        receivedSha256: received,
        imageBase64: bytes.toString('base64'),
      })).rejects.toBeInstanceOf(NotFoundException);
      expect(files.writes).toEqual([]);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
    }

    const moduleSource = readFileSync(join(__dirname, 'evidence-review.module.ts'), 'utf8');
    const querySource = readFileSync(join(__dirname, 'calibration-query.module.ts'), 'utf8');
    const app = readFileSync(join(__dirname, '../app.module.ts'), 'utf8');
    const strategy = readFileSync(join(__dirname, '../auth/strategies/jwt.strategy.ts'), 'utf8');
    expect(moduleSource).toContain('@UseGuards(JwtAuthGuard)');
    expect(moduleSource).toContain("@Post('evidence-previews')");
    expect(moduleSource).toContain("@Get('evidence-previews/:previewId')");
    expect(moduleSource).toContain("@Post('evidence-previews/:previewId/confirm')");
    expect(moduleSource).toContain("@Post('evidence-previews/:previewId/cancel')");
    expect(moduleSource).toContain("@Header('Cache-Control', 'private, no-store')");
    expect(moduleSource).not.toContain('@Public');
    expect(moduleSource).not.toMatch(/@(Put|Patch|Delete)\(/);
    expect(querySource).not.toMatch(/@(Post|Put|Patch|Delete)\(/);
    expect(app).toContain('EvidenceReviewModule');
    expect(app).not.toContain('evidence-link');
    expect(app).not.toContain('CalibrationIngestController');
    expect(strategy).toContain('ExtractJwt.fromAuthHeaderAsBearerToken()');
    expect(strategy).toContain('ignoreExpiration: false');
    expect(strategy).not.toContain('req.body');
  });

  it('sirve la copia temporal solo a quien la cargó y rechaza un permiso de escritura ampliado', async () => {
    const files = new MemoryFiles();
    files.seed('data/commercial/quotes/CQ-000021.json', quote('CQ-000021'));
    const bytes = minimalDecodablePng([2, 2, 2]);
    const previous = { ...process.env };
    try {
      Object.assign(process.env, openEnv);
      const desk = new EvidenceReviewDesk({ files, env: process.env });
      const controller = new EvidenceReviewController(desk);
      const created = await controller.hold(owner, {
        subjectId: 'CQ-000021',
        role: 'copy',
        imageBase64: bytes.toString('base64'),
      }) as { previewId: string };
      const image = await controller.read(owner, created.previewId);
      expect(await streamBytes(image.getStream())).toEqual(bytes);
      await expect(controller.read({ ...owner, userId: 'user-2' }, created.previewId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(controller.hold(owner, {
        subjectId: 'CQ-000021',
        role: 'copy',
        imageBase64: 'x'.repeat(7_000_001),
      })).rejects.toBeInstanceOf(BadRequestException);
      await expect(desk.hold(owner, {
        subjectId: 'CQ-000021',
        receivedSha256: received,
        bytes: Buffer.alloc(5 * 1024 * 1024 + 1),
      })).rejects.toBeInstanceOf(EvidenceReviewError);
      expect(files.writes).toEqual([]);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
    }

    expect(evidenceWriteGrantAllowed(null)).toBe(false);
    expect(evidenceWriteGrantAllowed({ permissions: { contents: 'read' }, repositorySelection: 'selected' })).toBe(false);
    expect(evidenceWriteGrantAllowed({ permissions: { contents: 'write', metadata: 'write' }, repositorySelection: 'selected' })).toBe(false);
    expect(evidenceWriteGrantAllowed({ permissions: { contents: 'write' }, repositorySelection: 'all' })).toBe(false);
    expect(evidenceWriteGrantAllowed({ permissions: { contents: 'write', metadata: 'read' }, repositorySelection: 'selected' })).toBe(true);

    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const calls: string[] = [];
    const remote = new EvidenceReviewDesk({
      env: {
        ...openEnv,
        CALIBRATION_GITHUB_APP_ID: '123',
        CALIBRATION_GITHUB_INSTALLATION_ID: '456',
        CALIBRATION_GITHUB_APP_PRIVATE_KEY: pem,
        CALIBRATION_GITHUB_REPOSITORY: 'arturo2565-alt/pegazuz-calibration-data',
      },
      transport: async (input, init) => {
        calls.push(`${init?.method ?? ''} ${String(input)}`);
        const body = JSON.parse(String(init?.body ?? '{}')) as { permissions?: unknown; repositories?: unknown };
        expect(body.permissions).toEqual({ contents: 'write' });
        expect(body.repositories).toEqual(['pegazuz-calibration-data']);
        return new Response(JSON.stringify({
          token: `ghs_${'a'.repeat(24)}`,
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          permissions: { contents: 'write', pull_requests: 'write' },
          repository_selection: 'selected',
        }), { status: 201 });
      },
    });
    await expect(remote.hold(owner, {
      subjectId: 'CQ-000021',
      receivedSha256: received,
      bytes: minimalDecodablePng(),
    })).rejects.toMatchObject({ code: 'unavailable' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/access_tokens');
    expect(calls.join('\n')).not.toContain('/contents/');

    const blocked = new EvidenceReviewDesk({
      env: {
        ...openEnv,
        CALIBRATION_GITHUB_APP_ID: '123',
        CALIBRATION_GITHUB_INSTALLATION_ID: '456',
        CALIBRATION_GITHUB_APP_PRIVATE_KEY: 'unused',
        CALIBRATION_GITHUB_REPOSITORY: 'otro/repo',
      },
      transport: async () => {
        throw new Error('network');
      },
    });
    await expect(blocked.hold(owner, {
      subjectId: 'CQ-000021',
      receivedSha256: received,
      bytes: minimalDecodablePng(),
    })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('mantiene la emisión de la prueba fuera del ingestor', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(__dirname)) {
      if (!name.endsWith('.ts') || name.endsWith('.spec.ts')) continue;
      const source = readFileSync(join(__dirname, name), 'utf8');
      const proof = source.includes('issueOwnerReviewProof') || source.includes('commitOwnerReview');
      const allowed = name === 'evidence-link.ts' || name === 'evidence-review.ts';
      if (proof && !allowed) offenders.push(name);
      if (source.includes('attestHumanReview')) offenders.push(name);
      if (name.startsWith('calibration-import') || name.includes('quote-import')) {
        if (source.includes('EvidenceReviewDesk') || source.includes('operatorRole')) offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('recorre carga, bytes exactos, archivo, galería y reintento sin duplicar ni tocar el precio', async () => {
    const files = new MemoryFiles();
    const quoteBody = quote('RQ-000031');
    files.seed('data/repairs/quotes/RQ-000031.json', quoteBody);
    const original = minimalDecodablePng([3, 1, 4]);
    const blobs = new Map<string, Buffer>();
    let rejectUpload = true;
    const photos: MemoryPhotos = Object.assign(new MemoryPhotos(), {
      async store(input: { subjectId: string; evidenceId: string; bytes: Buffer }) {
        this.calls.push(input.evidenceId);
        const digest = sha256(input.bytes);
        if (rejectUpload) {
          return { sha256: digest, verified: false, assetPublicId: null, assetVersion: null, failure: 'upload_rejected' as const };
        }
        const assetPublicId = evidencePublicId(input.subjectId, input.evidenceId, digest);
        blobs.set(digest, Buffer.from(input.bytes));
        return { sha256: digest, verified: true, assetPublicId, assetVersion: 4 };
      },
    });
    const vault = new EvidencePreviewVault();
    const desk = deskFor(files, openEnv, { photos, vault });
    const controller = new EvidenceReviewController(desk);
    const previous = { ...process.env };
    Object.assign(process.env, openEnv);
    try {
    const originPhoto = minimalDecodablePng([9, 1, 7]);
    const preview = await holdReviewedCopy(controller, 'RQ-000031', original, originPhoto);
    const seen = await controller.read(owner, preview.previewId);
    expect(await streamBytes(seen.getStream())).toEqual(original);
    const pending = await controller.confirm(owner, preview.previewId, {
      subjectId: 'RQ-000031',
      sha256: preview.sha256,
      visibleIdentifiersReviewed: true,
    });
    expect(pending).toMatchObject({ status: 'attested', archive: 'link_pending', failure: 'upload_rejected' });
    const archive = {
      async read(path: string) {
        return files.files.get(path)?.content ?? null;
      },
      async photo(locator: { sha256: string }) {
        const bytes = blobs.get(locator.sha256);
        if (!bytes) throw new Error('missing photo');
        return bytes;
      },
    };
    expect(await listCalibrationEvidence(archive, 'RQ-000031')).toMatchObject({
      items: [{ id: 'EV-000001', state: 'link_pending' }],
    });
    await expect(readCalibrationEvidence(archive, 'RQ-000031', 'EV-000001')).rejects.toMatchObject({ code: 'missing' });
    expect(files.files.get('data/repairs/quotes/RQ-000031.json')?.content).toBe(quoteBody);

    rejectUpload = false;
    const archived = await controller.confirm(owner, preview.previewId, {
      subjectId: 'RQ-000031',
      sha256: preview.sha256,
      visibleIdentifiersReviewed: true,
    });
    expect(archived).toMatchObject({ status: 'already_attested', archive: 'linked', evidenceId: 'EV-000001' });
    const listed = await listCalibrationEvidence(archive, 'RQ-000031');
    expect(listed.items).toEqual([{ id: 'EV-000001', state: 'verified', provenance: 'anonymized_copy' }]);
    const photo = await readCalibrationEvidence(archive, 'RQ-000031', 'EV-000001');
    expect(photo.bytes.equals(original)).toBe(true);
    expect(sha256(photo.bytes)).toBe(preview.sha256);
    expect(files.files.get('data/repairs/quotes/RQ-000031.json')?.content).toBe(quoteBody);
    expect(files.writes.join('\n')).not.toContain('CQ-000006');
    expect(new Set(photos.calls)).toEqual(new Set(['EV-000001']));

    const restarted = new EvidenceReviewController(deskFor(files, openEnv, { photos, vault: new EvidencePreviewVault() }));
    await expect(restarted.read(owner, preview.previewId)).rejects.toBeInstanceOf(NotFoundException);
    const again = await holdReviewedCopy(restarted, 'RQ-000031', original, originPhoto);
    await restarted.read(owner, again.previewId);
    const repeated = await restarted.confirm(owner, again.previewId, {
      subjectId: 'RQ-000031',
      sha256: again.sha256,
      visibleIdentifiersReviewed: true,
    });
    expect(repeated).toMatchObject({ status: 'already_attested', archive: 'already_linked', evidenceId: 'EV-000001' });
    expect(photos.calls.filter((id) => id === 'EV-000001').length).toBe(2);
    expect((await listCalibrationEvidence(archive, 'RQ-000031')).items).toHaveLength(1);

    await expect(controller.confirm({ ...owner, role: 'agent' }, preview.previewId, {
      subjectId: 'RQ-000031',
      sha256: preview.sha256,
      visibleIdentifiersReviewed: true,
    })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.confirm(undefined as unknown as AuthenticatedUser, preview.previewId, {
      subjectId: 'RQ-000031',
      sha256: preview.sha256,
      visibleIdentifiersReviewed: true,
    })).rejects.toBeInstanceOf(UnauthorizedException);

    const other = minimalDecodablePng([8, 8, 1]);
    const conflictPreview = await holdReviewedCopy(controller, 'RQ-000031', other, originPhoto);
    await controller.read(owner, conflictPreview.previewId);
    await expect(controller.confirm(owner, conflictPreview.previewId, {
      subjectId: 'RQ-000031',
      sha256: conflictPreview.sha256,
      visibleIdentifiersReviewed: true,
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(files.files.get('data/repairs/quotes/RQ-000031.json')?.content).toBe(quoteBody);

    const fresh = new MemoryFiles();
    fresh.seed('data/commercial/quotes/CQ-000031.json', quote('CQ-000031'));
    const freshDesk = deskFor(fresh, openEnv, { photos: new MemoryPhotos() });
    const held = await freshDesk.hold(owner, {
      subjectId: 'CQ-000031',
      receivedSha256: otherReceived,
      bytes: minimalDecodablePng([2, 2, 8]),
    });
    expect(await freshDesk.cancel(owner, held.previewId)).toEqual({ status: 'cleared' });
    await expect(freshDesk.read(owner, held.previewId)).rejects.toMatchObject({ code: 'missing' });
    expect(fresh.writes).toEqual([]);
    expect(fresh.files.get('data/commercial/quotes/CQ-000031.json')?.content).toContain('32000');

    const guardedQuote = quote('CQ-000032');
    const guarded = new MemoryFiles();
    guarded.seed('data/commercial/quotes/CQ-000032.json', guardedQuote);
    const originalWrite = guarded.write.bind(guarded);
    let failedManifest = false;
    guarded.write = async (path, content, sha) => {
      if (!failedManifest && path.includes('/manifests/')) {
        failedManifest = true;
        throw new Error('github unavailable');
      }
      return originalWrite(path, content, sha);
    };
    const guardedPhotos = new MemoryPhotos();
    const guardedDesk = new EvidenceReviewController(deskFor(guarded, openEnv, { photos: guardedPhotos }));
    const guardedBytes = minimalDecodablePng([4, 2, 1]);
    const guardedPreview = await guardedDesk.hold(owner, {
      subjectId: 'CQ-000032',
      role: 'copy',
      imageBase64: guardedBytes.toString('base64'),
    }) as { previewId: string; sha256: string };
    await guardedDesk.read(owner, guardedPreview.previewId);
    await expect(guardedDesk.confirm(owner, guardedPreview.previewId, {
      subjectId: 'CQ-000032',
      sha256: guardedPreview.sha256,
      visibleIdentifiersReviewed: true,
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(guarded.files.get('data/commercial/quotes/CQ-000032.json')?.content).toBe(guardedQuote);
    const recovered = await guardedDesk.confirm(owner, guardedPreview.previewId, {
      subjectId: 'CQ-000032',
      sha256: guardedPreview.sha256,
      visibleIdentifiersReviewed: true,
    });
    expect(recovered).toMatchObject({ archive: 'linked', evidenceId: 'EV-000001' });
    expect(guardedPhotos.calls).toEqual(['EV-000001']);
    expect(guarded.files.get('data/commercial/quotes/CQ-000032.json')?.content).toBe(guardedQuote);
    const unavailable = guarded.files.get('data/evidence/commercial/CQ-000032/manifests/EV-000001.json')?.content ?? '';
    expect(unavailable).toContain('"origin_provenance": "unavailable"');
    expect(unavailable).toContain('"received_sha256": null');
    const privateCopy = await readCalibrationEvidence({
      async read(path: string) {
        return guarded.files.get(path)?.content ?? null;
      },
      async photo() {
        return guardedBytes;
      },
    }, 'CQ-000032', 'EV-000001');
    expect(privateCopy.bytes.equals(guardedBytes)).toBe(true);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
    }
  });

  it('calcula el SHA-256 en el servidor y deja la procedencia ausente como estado explícito', async () => {
    const files = new MemoryFiles();
    const quoteBody = quote('CQ-000041');
    files.seed('data/commercial/quotes/CQ-000041.json', quoteBody);
    const blobs = new Map<string, Buffer>();
    const photos: MemoryPhotos = Object.assign(new MemoryPhotos(), {
      async store(input: { subjectId: string; evidenceId: string; bytes: Buffer }) {
        this.calls.push(input.evidenceId);
        const digest = sha256(input.bytes);
        blobs.set(digest, Buffer.from(input.bytes));
        return { sha256: digest, verified: true, assetPublicId: evidencePublicId(input.subjectId, input.evidenceId, digest), assetVersion: 3 };
      },
    });
    const controller = new EvidenceReviewController(deskFor(files, openEnv, { photos }));
    const previous = { ...process.env };
    Object.assign(process.env, openEnv);
    try {
      const copy = minimalDecodablePng([4, 4, 4]);
      const origin = minimalDecodablePng([5, 5, 5]);
      await expect(controller.hold(owner, {
        subjectId: 'CQ-000041',
        role: 'copy',
        receivedSha256: received,
        imageBase64: copy.toString('base64'),
      })).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.hold(owner, {
        subjectId: 'CQ-000041',
        role: 'owner',
        imageBase64: copy.toString('base64'),
      })).rejects.toBeInstanceOf(BadRequestException);
      const noted = await controller.hold(owner, {
        subjectId: 'CQ-000041',
        role: 'origin',
        imageBase64: origin.toString('base64'),
      }) as { provenanceId: string; sha256: string };
      expect(noted.sha256).toBe(sha256(origin));
      expect(files.writes).toEqual([]);
      await expect(controller.confirm(owner, noted.provenanceId, {
        subjectId: 'CQ-000041',
        sha256: noted.sha256,
        visibleIdentifiersReviewed: true,
      })).rejects.toBeInstanceOf(NotFoundException);
      const distinct = controller.hold(owner, {
        subjectId: 'CQ-000041',
        role: 'copy',
        provenanceId: noted.provenanceId,
        imageBase64: origin.toString('base64'),
      });
      await expect(distinct).rejects.toBeInstanceOf(BadRequestException);
      await expect(distinct).rejects.toMatchObject({ response: { code: 'distinct_copy' } });
      const preview = await controller.hold(owner, {
        subjectId: 'CQ-000041',
        role: 'copy',
        provenanceId: noted.provenanceId,
        imageBase64: copy.toString('base64'),
      }) as { previewId: string; sha256: string; originProvenance: string };
      expect(preview.originProvenance).toBe('received');
      const seen = await controller.read(owner, preview.previewId);
      expect(await streamBytes(seen.getStream())).toEqual(copy);
      const archived = await controller.confirm(owner, preview.previewId, {
        subjectId: 'CQ-000041',
        sha256: preview.sha256,
        visibleIdentifiersReviewed: true,
      });
      expect(archived).toMatchObject({ archive: 'linked', evidenceId: 'EV-000001' });
      const manifest = files.files.get('data/evidence/commercial/CQ-000041/manifests/EV-000001.json')?.content ?? '';
      expect(manifest).toContain(`"received_sha256": "${sha256(origin)}"`);
      expect(manifest).toContain('"origin_provenance": "received"');
      expect(manifest).not.toContain(`"content_sha256": "${sha256(origin)}"`);
      const archive = {
        async read(path: string) {
          return files.files.get(path)?.content ?? null;
        },
        async photo(locator: { sha256: string }) {
          const bytes = blobs.get(locator.sha256);
          if (!bytes) throw new Error('missing photo');
          return bytes;
        },
      };
      const photo = await readCalibrationEvidence(archive, 'CQ-000041', 'EV-000001');
      expect(photo.bytes.equals(copy)).toBe(true);
      expect(sha256(photo.bytes)).toBe(preview.sha256);

      const secondBytes = minimalDecodablePng([6, 6, 6]);
      const second = await controller.hold(owner, {
        subjectId: 'CQ-000041',
        role: 'copy',
        imageBase64: secondBytes.toString('base64'),
      }) as { previewId: string; sha256: string; originProvenance: string };
      expect(second.originProvenance).toBe('unavailable');
      await controller.read(owner, second.previewId);
      const linked = await controller.confirm(owner, second.previewId, {
        subjectId: 'CQ-000041',
        sha256: second.sha256,
        visibleIdentifiersReviewed: true,
      });
      expect(linked).toMatchObject({ archive: 'linked', evidenceId: 'EV-000002' });
      const absent = files.files.get('data/evidence/commercial/CQ-000041/manifests/EV-000002.json')?.content ?? '';
      expect(absent).toContain('"origin_provenance": "unavailable"');
      expect(absent).toContain('"received_sha256": null');
      const repeated = await controller.hold(owner, {
        subjectId: 'CQ-000041',
        role: 'copy',
        imageBase64: secondBytes.toString('base64'),
      }) as { previewId: string; sha256: string };
      await controller.read(owner, repeated.previewId);
      await expect(controller.confirm(owner, repeated.previewId, {
        subjectId: 'CQ-000041',
        sha256: repeated.sha256,
        visibleIdentifiersReviewed: true,
      })).resolves.toMatchObject({ archive: 'already_linked', evidenceId: 'EV-000002' });
      const downgraded = await controller.hold(owner, {
        subjectId: 'CQ-000041',
        role: 'copy',
        imageBase64: copy.toString('base64'),
      }) as { previewId: string; sha256: string };
      await controller.read(owner, downgraded.previewId);
      await expect(controller.confirm(owner, downgraded.previewId, {
        subjectId: 'CQ-000041',
        sha256: downgraded.sha256,
        visibleIdentifiersReviewed: true,
      })).rejects.toBeInstanceOf(BadRequestException);
      expect(photos.calls).toEqual(['EV-000001', 'EV-000002']);
      expect(files.files.get('data/commercial/quotes/CQ-000041.json')?.content).toBe(quoteBody);
      expect(files.writes.join('\n')).not.toContain('CQ-000006');
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
    }
  });
});
