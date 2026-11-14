import { crc32 } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { minimalDecodablePng } from './calibration-image-archive.service';
import { evidencePublicId } from './evidence-cloudinary';
import {
  EvidenceGithub,
  EvidenceLinkError,
  assertEvidenceTransport,
  assertEvidenceWrite,
  attestHumanReview,
  linkEvidence,
  sha256,
  type EvidenceFiles,
  type EvidencePhotoReceipt,
  type EvidenceRequest,
} from './evidence-link';

class MemoryFiles implements EvidenceFiles {
  readonly files = new Map<string, { content: string; sha: string }>();
  readonly writes: string[] = [];
  failVerifiedIndex = false;
  failManifest = false;

  async read(path: string) {
    return this.files.get(path) ?? null;
  }

  async write(path: string, content: string, sha?: string) {
    assertEvidenceWrite(path);
    if (content.includes('https://') || content.includes('http://')) throw new EvidenceLinkError('rejected');
    const current = this.files.get(path);
    if (current && current.sha !== sha) throw new EvidenceLinkError('conflict');
    if (!current && sha) throw new EvidenceLinkError('conflict');
    if (this.failVerifiedIndex && path.endsWith('/CQ-000011/index.json') && content.includes('"verified"')) {
      this.failVerifiedIndex = false;
      throw new Error('index interrupted');
    }
    if (this.failManifest && path.includes('/manifests/') && content.includes('"storage_status": "verified"')) {
      this.failManifest = false;
      throw new Error('manifest interrupted');
    }
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
  readonly calls: Array<{ subjectId: string; evidenceId: string }> = [];
  verified = true;

  async store(input: { subjectId: string; evidenceId: string; bytes: Buffer }): Promise<EvidencePhotoReceipt> {
    this.calls.push({ subjectId: input.subjectId, evidenceId: input.evidenceId });
    const digest = sha256(input.bytes);
    if (!this.verified) return { sha256: digest, verified: false, assetPublicId: null, assetVersion: null, failure: 'download_failed' };
    return {
      sha256: digest,
      verified: true,
      assetPublicId: evidencePublicId(input.subjectId, input.evidenceId, digest),
      assetVersion: 4,
    };
  }
}

function quoteFile(id: string, amount: number) {
  return JSON.stringify({ quote_id: id, prices: { quoted: { amount_mxn: amount, validation: 'human_confirmed' } } });
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, sum]);
}

function pngWithAuthor(): Buffer {
  const clean = minimalDecodablePng();
  return Buffer.concat([
    clean.subarray(0, clean.length - 12),
    pngChunk('tEXt', Buffer.from('Author\0person', 'latin1')),
    clean.subarray(clean.length - 12),
  ]);
}

describe('vínculo de evidencia para CQ y RQ', () => {
  const received = '11'.repeat(32);
  const otherReceived = '22'.repeat(32);

  it('registra una retención de privacidad sin bytes, sin revisión visual y sin tocar la cotización', async () => {
    const files = new MemoryFiles();
    const quote = quoteFile('CQ-000010', 32000);
    files.seed('data/commercial/quotes/CQ-000010.json', quote);
    const photos = new MemoryPhotos();
    const held = await linkEvidence(files, photos, {
      subjectId: 'CQ-000010',
      approval: 'privacy_hold',
      receivedSha256: received,
    });
    expect(held).toMatchObject({ status: 'privacy_pending', evidenceId: 'EV-000001' });
    expect(photos.calls).toEqual([]);
    expect(files.writes.filter((path) => path !== 'data/evidence/index.json').every((path) => path.startsWith('data/evidence/commercial/CQ-000010/'))).toBe(true);
    expect(files.writes).toContain('data/evidence/index.json');
    expect(files.files.get('data/commercial/quotes/CQ-000010.json')?.content).toBe(quote);
    const written = [...files.files.values()].map((file) => file.content).join('\n');
    expect(written).toContain('"disposition": "privacy_hold"');
    expect(written).not.toContain('visual_review');
    expect(written).not.toContain('human_reviewed');
    expect(written).not.toContain('https://');
    expect(written).not.toContain('@');

    const again = await linkEvidence(files, photos, {
      subjectId: 'CQ-000010',
      approval: 'privacy_hold',
      receivedSha256: received,
    });
    expect(again).toEqual({ status: 'already_recorded', evidenceId: 'EV-000001' });
    expect(files.writes).toHaveLength(3);
    await expect(linkEvidence(files, photos, {
      subjectId: 'CQ-000010',
      approval: 'privacy_hold',
      receivedSha256: otherReceived,
      bytes: minimalDecodablePng(),
    })).rejects.toMatchObject({ code: 'rejected' });
    await expect(linkEvidence(files, photos, {
      subjectId: 'CQ-000010',
      approval: 'visual_review' as EvidenceRequest['approval'],
      receivedSha256: otherReceived,
    })).rejects.toMatchObject({ code: 'rejected' });
  });

  it('archiva solo una copia anonimizada, rechaza el mismo SHA y recupera un índice parcial', async () => {
    const files = new MemoryFiles();
    const quote = quoteFile('CQ-000011', 18000);
    files.seed('data/commercial/quotes/CQ-000011.json', quote);
    const photos = new MemoryPhotos();
    const derivative = minimalDecodablePng();
    const alternate = minimalDecodablePng([9, 8, 7]);
    await expect(linkEvidence(files, photos, {
      subjectId: 'CQ-000011',
      approval: 'anonymized_copy',
      receivedSha256: sha256(derivative),
      bytes: derivative,
    })).rejects.toMatchObject({ code: 'rejected' });
    expect(photos.calls).toEqual([]);

    await expect(linkEvidence(files, photos, {
      subjectId: 'CQ-000011',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes: pngWithAuthor(),
    })).rejects.toMatchObject({ code: 'metadata' });
    expect(files.writes).toEqual([]);

    await expect(linkEvidence(files, photos, {
      subjectId: 'CQ-000011',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes: derivative,
    })).rejects.toMatchObject({ code: 'review_required' });
    expect(photos.calls).toEqual([]);
    expect(files.writes).toEqual([]);
    expect(files.files.get('data/commercial/quotes/CQ-000011.json')?.content).toBe(quote);

    await attestHumanReview(files, {
      subjectId: 'CQ-000011',
      receivedSha256: received,
      reviewedSha256: sha256(derivative),
      operatorRole: 'owner',
      confirmation: 'human_reviewed',
    });
    photos.verified = false;
    const pending = await linkEvidence(files, photos, {
      subjectId: 'CQ-000011',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes: derivative,
    });
    expect(pending.status).toBe('link_pending');
    const manifestPath = 'data/evidence/commercial/CQ-000011/manifests/EV-000001.json';
    expect(files.files.get(manifestPath)?.content).toContain('"storage_status": "pending"');
    expect(files.files.get('data/commercial/quotes/CQ-000011.json')?.content).toBe(quote);

    photos.verified = true;
    files.failVerifiedIndex = true;
    await expect(linkEvidence(files, photos, {
      subjectId: 'CQ-000011',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes: derivative,
    })).rejects.toThrow('index interrupted');
    expect(files.files.get(manifestPath)?.content).toContain('"storage_status": "verified"');
    expect(files.files.get(manifestPath)?.content).toContain('"reviewed_sha256"');
    expect(files.files.get(manifestPath)?.content).not.toContain('visual_review');
    expect(files.files.get('data/evidence/commercial/CQ-000011/index.json')?.content).toContain('"link_pending"');

    const linked = await linkEvidence(files, photos, {
      subjectId: 'CQ-000011',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes: derivative,
    });
    expect(linked).toMatchObject({ status: 'linked', evidenceId: 'EV-000001' });
    expect(photos.calls).toHaveLength(2);
    const archived = files.files.get(manifestPath)?.content ?? '';
    expect(archived).toContain(`"received_sha256": "${received}"`);
    expect(archived).toContain(`"content_sha256": "${sha256(derivative)}"`);
    expect(archived).toContain('"operator_role": "owner"');
    expect(archived).not.toContain('https://');

    const duplicate = await linkEvidence(files, photos, {
      subjectId: 'CQ-000011',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes: derivative,
    });
    expect(duplicate).toEqual({ status: 'already_linked', evidenceId: 'EV-000001' });
    expect(photos.calls).toHaveLength(2);
    await expect(linkEvidence(files, photos, {
      subjectId: 'CQ-000011',
      approval: 'anonymized_copy',
      receivedSha256: otherReceived,
      bytes: derivative,
    })).rejects.toMatchObject({ code: 'conflict' });
    await expect(linkEvidence(files, photos, {
      subjectId: 'CQ-000011',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes: alternate,
    })).rejects.toMatchObject({ code: 'conflict' });
    expect(photos.calls).toHaveLength(2);
    expect(files.files.get('data/commercial/quotes/CQ-000011.json')?.content).toBe(quote);
  });

  it('separa CQ, RQ y AF y no reutiliza el archivo de otra cotización', async () => {
    const files = new MemoryFiles();
    files.seed('data/commercial/quotes/CQ-000012.json', quoteFile('CQ-000012', 9000));
    files.seed('data/repairs/quotes/RQ-000012.json', quoteFile('RQ-000012', 4500));
    const photos = new MemoryPhotos();
    const derivative = minimalDecodablePng([4, 5, 6]);
    await attestHumanReview(files, {
      subjectId: 'CQ-000012',
      receivedSha256: received,
      reviewedSha256: sha256(derivative),
      operatorRole: 'owner',
      confirmation: 'human_reviewed',
    });
    await attestHumanReview(files, {
      subjectId: 'RQ-000012',
      receivedSha256: received,
      reviewedSha256: sha256(derivative),
      operatorRole: 'owner',
      confirmation: 'human_reviewed',
    });
    const commercial = await linkEvidence(files, photos, {
      subjectId: 'CQ-000012',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes: derivative,
    });
    const repair = await linkEvidence(files, photos, {
      subjectId: 'RQ-000012',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes: derivative,
    });
    expect(commercial.status).toBe('linked');
    expect(repair.status).toBe('linked');
    const commercialId = files.files.get('data/evidence/commercial/CQ-000012/manifests/EV-000001.json')?.content ?? '';
    const repairId = files.files.get('data/evidence/repairs/RQ-000012/manifests/EV-000001.json')?.content ?? '';
    expect(commercialId).toContain('pegazuz_calibration_evidence/CQ-000012/');
    expect(repairId).toContain('pegazuz_calibration_evidence/RQ-000012/');
    expect(commercialId).not.toContain('pegazuz_calibration/');
    expect(repairId).not.toContain(commercialId.match(/pegazuz_calibration_evidence\/CQ-000012\/EV-\d{6}\/[a-f0-9]{32}/)?.[0] ?? 'missing');
    expect(files.writes.some((path) => path.startsWith('data/cases/') || path.startsWith('data/photos/'))).toBe(false);
    await expect(linkEvidence(files, photos, {
      subjectId: 'AF-000012',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes: derivative,
    })).rejects.toMatchObject({ code: 'invalid' });
    await expect(files.write('data/cases/AF-000012.json', '{}\n')).rejects.toMatchObject({ code: 'rejected' });
    await expect(files.write('data/commercial/quotes/CQ-000012.json', '{}\n')).rejects.toMatchObject({ code: 'rejected' });
    await expect(files.write('data/repairs/quotes/RQ-000012.json', '{}\n')).rejects.toMatchObject({ code: 'rejected' });
    expect(assertEvidenceTransport(
      'https://api.github.com/repos/arturo2565-alt/pegazuz-calibration-data/contents/data/evidence/commercial/CQ-000012/index.json?ref=main',
      'GET',
    )).toBeUndefined();
    expect(() => assertEvidenceTransport(
      'https://api.github.com/repos/arturo2565-alt/pegazuz-calibration-data/contents/data/cases/AF-000012.json',
      'PUT',
    )).toThrow(EvidenceLinkError);
  });

  it('usa el adaptador solo con lectura de la cotización y escritura de evidencia', async () => {
    const calls: string[] = [];
    const github = new EvidenceGithub(async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      if (init?.method === 'GET') return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ commit: { sha: 'abc123' } }), { status: 201 });
    }, async () => 'Bearer token-de-ensayo');
    await expect(github.read('data/commercial/quotes/CQ-000012.json')).resolves.toBeNull();
    await expect(github.write('data/evidence/repairs/RQ-000012/index.json', '{}\n')).resolves.toBe('abc123');
    expect(calls[0]).toContain('https://api.github.com/repos/arturo2565-alt/pegazuz-calibration-data/contents/data/commercial/quotes/CQ-000012.json?ref=main');
    expect(calls[1]).toContain('/contents/data/evidence/repairs/RQ-000012/index.json');
    expect(calls.join('\n')).not.toContain('https://res.cloudinary.com');
    await expect(github.write('data/cases/AF-000001.json', '{}\n')).rejects.toMatchObject({ code: 'rejected' });
    await expect(github.write('data/evidence/repairs/RQ-000012/index.json', 'https://res.cloudinary.com/demo\n')).rejects.toMatchObject({ code: 'rejected' });
    expect(calls).toHaveLength(2);
  });

  it('no admite más de 30 fotografías en el mismo documento', async () => {
    const files = new MemoryFiles();
    files.seed('data/repairs/quotes/RQ-000030.json', quoteFile('RQ-000030', 1000));
    const items = Array.from({ length: 30 }, (_, index) => ({
      evidence_id: `EV-${String(index + 1).padStart(6, '0')}`,
      link_id: `LN-${String(index + 1).padStart(6, '0')}`,
      state: 'privacy_pending' as const,
      received_sha256: String(index + 1).padStart(64, 'a'),
      content_sha256: null,
      provenance: null,
    }));
    files.seed('data/evidence/repairs/RQ-000030/index.json', `${JSON.stringify({
      schema_version: '1.0.0',
      subject_kind: 'repair_quote',
      subject_id: 'RQ-000030',
      items,
      link_ids: items.map((item) => item.link_id),
    })}\n`);
    await expect(linkEvidence(files, new MemoryPhotos(), {
      subjectId: 'RQ-000030',
      approval: 'privacy_hold',
      receivedSha256: 'ff'.repeat(32),
    })).rejects.toMatchObject({ code: 'limit' });
    expect(files.writes).toEqual([]);
  });

  it('exige una revisión humana del SHA exacto y no deja que el vínculo la invente', async () => {
    const files = new MemoryFiles();
    const quote = quoteFile('RQ-000040', 12000);
    files.seed('data/repairs/quotes/RQ-000040.json', quote);
    const photos = new MemoryPhotos();
    const approved = minimalDecodablePng([3, 3, 3]);
    const changed = minimalDecodablePng([4, 4, 4]);
    await expect(linkEvidence(files, photos, {
      subjectId: 'RQ-000040',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes: approved,
      humanReviewed: true,
    } as EvidenceRequest)).rejects.toMatchObject({ code: 'rejected' });
    expect(files.writes).toEqual([]);
    expect(photos.calls).toEqual([]);

    const review = await attestHumanReview(files, {
      subjectId: 'RQ-000040',
      receivedSha256: received,
      reviewedSha256: sha256(approved),
      operatorRole: 'owner',
      confirmation: 'human_reviewed',
    });
    expect(review).toEqual({ status: 'attested', reviewId: 'RV-000001' });
    expect(await attestHumanReview(files, {
      subjectId: 'RQ-000040',
      receivedSha256: received,
      reviewedSha256: sha256(approved),
      operatorRole: 'owner',
      confirmation: 'human_reviewed',
    })).toEqual({ status: 'already_attested', reviewId: 'RV-000001' });
    await expect(attestHumanReview(files, {
      subjectId: 'RQ-000040',
      receivedSha256: received,
      reviewedSha256: sha256(approved),
      operatorRole: 'agent' as 'owner',
      confirmation: 'human_reviewed',
    })).rejects.toMatchObject({ code: 'rejected' });
    await expect(linkEvidence(files, photos, {
      subjectId: 'RQ-000040',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes: changed,
    })).rejects.toMatchObject({ code: 'review_required' });
    expect(photos.calls).toEqual([]);

    const linked = await linkEvidence(files, photos, {
      subjectId: 'RQ-000040',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes: approved,
    });
    expect(linked.status).toBe('linked');
    const manifest = files.files.get('data/evidence/repairs/RQ-000040/manifests/EV-000001.json')?.content ?? '';
    expect(manifest).toContain(`"reviewed_sha256": "${sha256(approved)}"`);
    expect(manifest).toContain('"human_review_id": "RV-000001"');
    expect(manifest).not.toContain('visual_review');
    expect(manifest).not.toContain('@');
    expect(manifest).not.toMatch(/rostro|placa|\bvin\b/i);
    expect(files.files.get('data/repairs/quotes/RQ-000040.json')?.content).toBe(quote);
    await expect(linkEvidence(files, photos, {
      subjectId: 'RQ-000040',
      approval: 'anonymized_copy',
      receivedSha256: received,
      bytes: changed,
    })).rejects.toMatchObject({ code: 'conflict' });
    expect(photos.calls).toHaveLength(1);

    files.failManifest = true;
    const second = minimalDecodablePng([8, 8, 8]);
    await attestHumanReview(files, {
      subjectId: 'RQ-000040',
      receivedSha256: otherReceived,
      reviewedSha256: sha256(second),
      operatorRole: 'owner',
      confirmation: 'human_reviewed',
    });
    await expect(linkEvidence(files, photos, {
      subjectId: 'RQ-000040',
      approval: 'anonymized_copy',
      receivedSha256: otherReceived,
      bytes: second,
    })).rejects.toThrow('manifest interrupted');
    const pendingManifest = files.files.get('data/evidence/repairs/RQ-000040/manifests/EV-000002.json')?.content ?? '';
    expect(pendingManifest).toContain('"storage_status": "pending"');
    const storedIndex = JSON.parse(files.files.get('data/evidence/repairs/RQ-000040/index.json')?.content ?? '{}') as {
      items: Array<{ received_sha256: string; state: string }>;
    };
    expect(storedIndex.items.find((item) => item.received_sha256 === otherReceived)?.state).toBe('link_pending');
  });

  it('no deja que los importadores declaren la revisión ni abran ingesta', () => {
    const names = [
      'commercial-quote-import.ts',
      'commercial-quote-import-run.ts',
      'repair-quote-import.ts',
      'repair-quote-import-run.ts',
      'calibration-import.ts',
      'calibration-import-run.ts',
      'calibration-import-batch.ts',
    ];
    for (const name of names) {
      const source = readFileSync(join(__dirname, name), 'utf8');
      expect(source).not.toContain('attestHumanReview');
      expect(source).not.toContain('linkEvidence');
      expect(source).not.toContain('human_reviewed');
    }
    const moduleSource = readFileSync(join(__dirname, 'calibration-query.module.ts'), 'utf8');
    const app = readFileSync(join(__dirname, '../app.module.ts'), 'utf8');
    expect(moduleSource).not.toMatch(/@(Post|Put|Patch|Delete)\(/);
    expect(app).not.toContain('evidence-link');
    expect(app).not.toContain('CalibrationIngestController');
  });
});
