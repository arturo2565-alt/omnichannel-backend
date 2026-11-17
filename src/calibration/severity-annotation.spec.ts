import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { readCalibrationCase, listCalibrationSeverity, readCalibrationRepair } from './calibration-query';
import type { CalibrationArchive } from './calibration-query';
import {
  SEVERITY_LEVELS,
  SeverityError,
  SeverityGithub,
  assertSeverityWrite,
  confirmSeverity,
  ingestSeverityAssessment,
  recordDeclaredSeverity,
  type SeverityFiles,
} from './severity-annotation';
import { SeverityReviewController } from './severity-review.module';

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

class MemoryFiles implements SeverityFiles {
  readonly files = new Map<string, { content: string; sha: string }>();
  readonly writes: string[] = [];

  async read(path: string) {
    return this.files.get(path) ?? null;
  }

  async write(path: string, content: string, sha?: string) {
    assertSeverityWrite(path);
    const current = this.files.get(path);
    if (current && current.sha !== sha) throw new SeverityError('conflict');
    if (!current && sha) throw new SeverityError('conflict');
    const next = { content, sha: `git-${this.writes.length + 1}` };
    this.files.set(path, next);
    this.writes.push(path);
    return next.sha;
  }

  seed(path: string, content: string) {
    this.files.set(path, { content, sha: `seed-${path}` });
  }
}

function archiveOf(files: MemoryFiles): CalibrationArchive {
  return {
    async read(path: string) {
      return files.files.get(path)?.content ?? null;
    },
    async photo() {
      throw new Error('no photo');
    },
  };
}

function visualCase(id: string, lines: Array<Record<string, unknown>>, price = 3600) {
  return JSON.stringify({
    schema_version: '1.0.0',
    case_id: id,
    line_items: lines.map((line, index) => ({
      line_id: line.line_id ?? `L${index + 1}`,
      part: line.part,
      treatment: line.treatment ?? 'repair_paint',
      price_mxn: line.price_mxn ?? price,
      damage_severity: 'unknown',
      validation: 'human_confirmed',
    })),
    photo_refs: ['IMG-000001'],
    photo_archive_status: 'archived_private',
    status: 'human_verified',
  });
}

function repairQuote(id: string) {
  return JSON.stringify({
    schema_version: '1.0.0',
    quote_id: id,
    evidence: 'text_only',
    photo_status: 'not_provided',
    lines: [
      { line_id: 'L01', part: 'Puerta', role: 'part', labor: null, prices: { quoted: { amount_mxn: 4500, validation: 'human_confirmed' } } },
      { line_id: 'L02', part: 'Pintura', role: 'labor', labor: 'paint', prices: { quoted: { amount_mxn: 800, validation: 'human_confirmed' } } },
    ],
    quoted_total_mxn: 5300,
    status: 'human_verified',
  });
}

describe('severidad severity-v1', () => {
  it('registra los cinco niveles, desconocida y piezas distintas sin validar una propuesta', async () => {
    const files = new MemoryFiles();
    const body = visualCase('AF-000010', [
      { line_id: 'L1', part: 'Cofre' },
      { line_id: 'L2', part: 'Salpicadera', treatment: 'paint' },
      { line_id: 'L3', part: 'Tapa', treatment: 'replace' },
      { line_id: 'L4', part: 'Costado', treatment: 'replace_paint' },
      { line_id: 'L5', part: 'Fascia', treatment: 'other' },
      { line_id: 'L6', part: 'Espejo', treatment: 'uncertain' },
    ]);
    files.seed('data/cases/AF-000010.json', body);
    for (const [index, level] of SEVERITY_LEVELS.entries()) {
      const saved = await ingestSeverityAssessment(files, {
        subjectId: 'AF-000010',
        lineId: `L${index + 1}`,
        assessment: 'visual_inference',
        level,
      });
      expect(saved.status).toBe('recorded');
      expect(await ingestSeverityAssessment(files, {
        subjectId: 'AF-000010',
        lineId: `L${index + 1}`,
        assessment: 'visual_inference',
        level,
      })).toMatchObject({ status: 'already_recorded', annotationId: saved.annotationId });
    }
    await ingestSeverityAssessment(files, {
      subjectId: 'AF-000010',
      lineId: 'L6',
      assessment: 'insufficient_evidence',
    });
    const listed = await listCalibrationSeverity(archiveOf(files), {});
    expect(listed.items.map((item) => item.level)).toEqual([...SEVERITY_LEVELS, null]);
    expect(listed.items.every((item) => item.status !== 'validated')).toBe(true);
    expect(listed.items.find((item) => item.lineId === 'L6')).toMatchObject({ status: 'unknown', provenance: 'insufficient_evidence' });
    expect(listed.items.find((item) => item.lineId === 'L1')?.evidenceKind).toBe('photographs');
    expect(files.files.get('data/cases/AF-000010.json')?.content).toBe(body);
    const written = files.writes.map((path) => files.files.get(path)?.content ?? '').join('\n');
    expect(written).not.toContain('validated');
    expect(written).not.toContain('operator_role');
    expect(written).not.toContain('@');
  });

  it('deja AF-000004 como propuesta no validada y no cambia sus $3,600', async () => {
    const files = new MemoryFiles();
    const body = visualCase('AF-000004', [{ line_id: 'L1', part: 'Puerta delantera derecha', treatment: 'repair_paint', price_mxn: 3600 }], 3600);
    files.seed('data/cases/AF-000004.json', body);
    const saved = await ingestSeverityAssessment(files, {
      subjectId: 'AF-000004',
      lineId: 'L1',
      assessment: 'visual_inference',
      level: 'medio_leve',
    });
    expect(saved.status).toBe('recorded');
    const detail = await readCalibrationCase(archiveOf(files), 'AF-000004');
    expect(detail.quotedTotalMxn).toBe(3600);
    expect(detail.lines[0]).toMatchObject({
      part: 'Puerta delantera derecha',
      treatment: 'repair_paint',
      priceMxn: 3600,
      severityAnnotation: {
        level: 'medio_leve',
        status: 'proposed',
        provenance: 'visual_inference',
        inferenceMethod: 'visual_assessment',
        scaleVersion: 'severity-v1',
        evidenceKind: 'photographs',
      },
    });
    expect(JSON.stringify(detail)).not.toContain('actor_key');
    expect(JSON.stringify(detail)).not.toContain('validated');
    expect(files.files.get('data/cases/AF-000004.json')?.content).toBe(body);
    const filtered = await listCalibrationSeverity(archiveOf(files), {
      part: 'puerta delantera',
      treatment: 'repair_paint',
      severity: 'medio_leve',
      validation: 'proposed',
      evidence: 'photographs',
    });
    expect(filtered.items.map((item) => item.subjectId)).toEqual(['AF-000004']);
  });

  it('valida solo con el propietario, conserva el historial y rechaza una validación fabricada', async () => {
    const files = new MemoryFiles();
    const body = visualCase('AF-000004', [{ line_id: 'L1', part: 'Puerta delantera derecha', price_mxn: 3600 }], 3600);
    files.seed('data/cases/AF-000004.json', body);
    await ingestSeverityAssessment(files, {
      subjectId: 'AF-000004',
      lineId: 'L1',
      assessment: 'visual_inference',
      level: 'medio_leve',
    });
    await expect(ingestSeverityAssessment(files, {
      subjectId: 'AF-000004',
      lineId: 'L1',
      assessment: 'visual_inference',
      level: 'medio_leve',
      validated: true,
    } as never)).rejects.toMatchObject({ code: 'rejected' });
    await expect(confirmSeverity(files, openEnv, owner, {
      subjectId: 'AF-000004',
      lineId: 'L1',
      level: 'medio',
      lineReviewed: true,
      operatorRole: 'owner',
    } as never)).rejects.toMatchObject({ code: 'rejected' });
    const confirmed = await confirmSeverity(files, openEnv, owner, {
      subjectId: 'AF-000004',
      lineId: 'L1',
      level: 'medio',
      lineReviewed: true,
    });
    expect(confirmed.status).toBe('validated');
    expect(await confirmSeverity(files, openEnv, owner, {
      subjectId: 'AF-000004',
      lineId: 'L1',
      level: 'medio',
      lineReviewed: true,
    })).toMatchObject({ status: 'already_validated', annotationId: confirmed.annotationId });
    const corrected = await confirmSeverity(files, openEnv, owner, {
      subjectId: 'AF-000004',
      lineId: 'L1',
      level: 'fuerte',
      lineReviewed: true,
    });
    expect(corrected.status).toBe('validated');
    expect(corrected.annotationId).not.toBe(confirmed.annotationId);
    await expect(ingestSeverityAssessment(files, {
      subjectId: 'AF-000004',
      lineId: 'L1',
      assessment: 'visual_inference',
      level: 'leve',
    })).resolves.toMatchObject({ status: 'retained' });
    const detail = await readCalibrationCase(archiveOf(files), 'AF-000004');
    expect(detail.lines[0].severityAnnotation).toMatchObject({
      level: 'fuerte',
      status: 'validated',
      provenance: 'authenticated_owner',
    });
    expect(detail.lines[0].severityAnnotation?.history.map((item) => item.level)).toEqual(['medio_leve', 'medio']);
    expect(detail.lines[0].severityAnnotation?.history[0].status).toBe('proposed');
    expect(detail.quotedTotalMxn).toBe(3600);
    expect(files.files.get('data/cases/AF-000004.json')?.content).toBe(body);
    expect(files.files.has('data/annotations/severity/visual/AF-000004/SV-000001.json')).toBe(true);
    expect(files.files.has('data/annotations/severity/visual/AF-000004/SV-000003.json')).toBe(true);
  });

  it('anota una reparación sin fotografías y rechaza pintura integral y mano de obra', async () => {
    const files = new MemoryFiles();
    const repair = repairQuote('RQ-000021');
    const commercial = JSON.stringify({ quote_id: 'CQ-000006', prices: { quoted: { amount_mxn: 32000 } } });
    files.seed('data/repairs/quotes/RQ-000021.json', repair);
    files.seed('data/repairs/index.json', JSON.stringify({ opportunities: { puerta: { quote_ids: ['RQ-000021'] } } }));
    files.seed('data/commercial/quotes/CQ-000006.json', commercial);
    const saved = await ingestSeverityAssessment(files, {
      subjectId: 'RQ-000021',
      lineId: 'L01',
      assessment: 'visual_inference',
      level: 'medio',
    });
    expect(saved.status).toBe('recorded');
    const detail = await readCalibrationRepair(archiveOf(files), 'RQ-000021');
    const line = detail.revisions[0].lines.find((item) => item.lineId === 'L01');
    expect(line?.severityAnnotation).toMatchObject({
      status: 'proposed',
      provenance: 'visual_inference',
      inferenceMethod: 'visual_assessment',
      level: 'medio',
      evidenceKind: 'text_only',
      zoneId: 'rq:puerta',
    });
    expect(line?.severityAnnotation?.status).not.toBe('validated');
    expect(detail.revisions[0].quotedTotalMxn).toBe(5300);
    expect(files.files.get('data/repairs/quotes/RQ-000021.json')?.content).toBe(repair);
    await expect(ingestSeverityAssessment(files, {
      subjectId: 'RQ-000021',
      lineId: 'L02',
      assessment: 'visual_inference',
      level: 'leve',
    })).rejects.toMatchObject({ code: 'rejected' });
    await expect(ingestSeverityAssessment(files, {
      subjectId: 'CQ-000006',
      lineId: 'L1',
      assessment: 'visual_inference',
      level: 'medio',
    })).rejects.toMatchObject({ code: 'invalid' });
    expect(files.writes.some((path) => path.includes('CQ-000006') || path.startsWith('data/commercial/'))).toBe(false);
    expect(files.files.get('data/commercial/quotes/CQ-000006.json')?.content).toBe(commercial);
  });

  it('clasifica la zona dañada y no deja que la inferencia se presente como declaración', async () => {
    const files = new MemoryFiles();
    const repairOnly = JSON.stringify({
      schema_version: '1.0.0',
      quote_id: 'RQ-000031',
      revision: 1,
      evidence: 'text_only',
      photo_status: 'not_provided',
      lines: [{
        line_id: 'L01',
        part: 'Puerta delantera derecha',
        role: 'labor',
        labor: 'repair',
        prices: { quoted: { amount_mxn: 3600, validation: 'human_confirmed' } },
      }],
      quoted_total_mxn: 3600,
      status: 'human_verified',
    });
    const replaced = JSON.stringify({
      schema_version: '1.0.0',
      quote_id: 'RQ-000032',
      revision: 1,
      evidence: 'text_only',
      photo_status: 'not_provided',
      lines: [
        { line_id: 'L01', part: 'Fascia delantera', role: 'part', labor: null, prices: { quoted: { amount_mxn: 2900, validation: 'human_confirmed' } } },
        { line_id: 'L02', part: 'Fascia delantera', role: 'labor', labor: 'mount_and_paint', prices: { quoted: { amount_mxn: 3400, validation: 'human_confirmed' } } },
      ],
      quoted_total_mxn: 6300,
      status: 'human_verified',
    });
    const generic = JSON.stringify({
      schema_version: '1.0.0',
      quote_id: 'RQ-000033',
      revision: 1,
      evidence: 'text_only',
      photo_status: 'not_provided',
      lines: [{
        line_id: 'L01',
        part: 'Pintura',
        role: 'labor',
        labor: 'paint',
        prices: { quoted: { amount_mxn: 800, validation: 'human_confirmed' } },
      }],
      quoted_total_mxn: 800,
      status: 'human_verified',
    });
    files.seed('data/repairs/quotes/RQ-000031.json', repairOnly);
    files.seed('data/repairs/quotes/RQ-000032.json', replaced);
    files.seed('data/repairs/quotes/RQ-000033.json', generic);
    files.seed('data/repairs/index.json', JSON.stringify({
      opportunities: {
        puerta: { quote_ids: ['RQ-000031'] },
        fascia: { quote_ids: ['RQ-000032'] },
        generica: { quote_ids: ['RQ-000033'] },
      },
    }));
    await expect(ingestSeverityAssessment(files, {
      subjectId: 'RQ-000031',
      lineId: 'L01',
      assessment: 'human_declaration',
      level: 'medio',
    } as never)).rejects.toMatchObject({ code: 'rejected' });
    const proposed = await ingestSeverityAssessment(files, {
      subjectId: 'RQ-000031',
      lineId: 'L01',
      assessment: 'visual_inference',
      level: 'medio_leve',
    });
    expect(proposed.status).toBe('recorded');
    const declared = await recordDeclaredSeverity(files, {
      subjectId: 'RQ-000031',
      lineId: 'L01',
      level: 'medio',
    });
    expect(declared.status).toBe('recorded');
    await expect(ingestSeverityAssessment(files, {
      subjectId: 'RQ-000031',
      lineId: 'L01',
      assessment: 'visual_inference',
      level: 'fuerte',
    })).resolves.toMatchObject({ status: 'retained', annotationId: declared.annotationId });
    const repairDetail = await readCalibrationRepair(archiveOf(files), 'RQ-000031');
    expect(repairDetail.revisions[0].lines[0]).toMatchObject({
      severityZone: 'rq:puerta delantera derecha',
      severityAnchor: true,
      severityAnnotation: {
        status: 'proposed',
        provenance: 'human_declaration',
        inferenceMethod: null,
        treatment: 'repair',
        level: 'medio',
      },
    });
    expect(repairDetail.revisions[0].quotedTotalMxn).toBe(3600);
    expect(files.files.get('data/repairs/quotes/RQ-000031.json')?.content).toBe(repairOnly);
    const mounted = await ingestSeverityAssessment(files, {
      subjectId: 'RQ-000032',
      lineId: 'L02',
      assessment: 'visual_inference',
      level: 'medio_fuerte',
    });
    expect(await ingestSeverityAssessment(files, {
      subjectId: 'RQ-000032',
      lineId: 'L01',
      assessment: 'visual_inference',
      level: 'medio_fuerte',
    })).toMatchObject({ status: 'already_recorded', annotationId: mounted.annotationId });
    const replacedDetail = await readCalibrationRepair(archiveOf(files), 'RQ-000032');
    const shared = replacedDetail.revisions[0].lines.map((line) => line.severityAnnotation?.annotationId);
    expect(shared).toEqual([mounted.annotationId, mounted.annotationId]);
    expect(replacedDetail.revisions[0].lines[0].severityAnchor).toBe(true);
    expect(replacedDetail.revisions[0].lines[1].severityAnchor).toBe(false);
    expect(replacedDetail.revisions[0].lines[0].severityAnnotation).toMatchObject({ treatment: 'replace_paint', status: 'proposed' });
    expect(replacedDetail.revisions[0].quotedTotalMxn).toBe(6300);
    expect(files.files.get('data/repairs/quotes/RQ-000032.json')?.content).toBe(replaced);
    const beforeGeneric = files.writes.length;
    await expect(ingestSeverityAssessment(files, {
      subjectId: 'RQ-000033',
      lineId: 'L01',
      assessment: 'visual_inference',
      level: 'leve',
    })).rejects.toMatchObject({ code: 'rejected' });
    expect(files.writes).toHaveLength(beforeGeneric);
    const untouched = await readCalibrationRepair(archiveOf(files), 'RQ-000033');
    expect(untouched.revisions[0].lines[0].severityZone).toBeNull();
    expect(untouched.revisions[0].lines[0].severityAnnotation).toBeNull();
    expect(untouched.revisions[0].quotedTotalMxn).toBe(800);
    expect(files.files.get('data/repairs/quotes/RQ-000033.json')?.content).toBe(generic);
  });

  it('oculta una validación fabricada en el índice y conserva el precio', async () => {
    const files = new MemoryFiles();
    const body = visualCase('AF-000004', [{ line_id: 'L1', part: 'Puerta delantera derecha', price_mxn: 3600 }], 3600);
    files.seed('data/cases/AF-000004.json', body);
    files.seed('data/annotations/severity/visual/AF-000004/index.json', JSON.stringify({
      schema_version: '1.0.0',
      subject_id: 'AF-000004',
      items: [{
        annotation_id: 'SV-000001',
        line_id: 'L1',
        level: 'fuerte',
        status: 'validated',
        provenance: 'visual_inference',
        scale_version: 'severity-v1',
        authorization: null,
        actor_key: null,
        part: 'Puerta delantera derecha',
        treatment: 'repair_paint',
        evidence_kind: 'photographs',
        current: true,
        supersedes: null,
      }],
    }));
    const detail = await readCalibrationCase(archiveOf(files), 'AF-000004');
    expect(detail.lines[0].severityAnnotation).toBeNull();
    expect(detail.quotedTotalMxn).toBe(3600);
    expect(files.files.get('data/cases/AF-000004.json')?.content).toBe(body);
    const disguised = visualCase('AF-000011', [{ line_id: 'L1', part: 'Cofre', price_mxn: 1900 }], 1900);
    files.seed('data/cases/AF-000011.json', disguised);
    files.seed('data/annotations/severity/visual/AF-000011/index.json', JSON.stringify({
      schema_version: '1.0.0',
      subject_id: 'AF-000011',
      items: [{
        annotation_id: 'SV-000001',
        line_id: 'L1',
        zone_id: 'af:L1',
        level: 'leve',
        status: 'proposed',
        provenance: 'human_declaration',
        inference_method: 'visual_assessment',
        scale_version: 'severity-v1',
        authorization: null,
        actor_key: null,
        part: 'Cofre',
        treatment: 'repair_paint',
        evidence_kind: 'photographs',
        current: true,
        supersedes: null,
      }],
    }));
    const hidden = await readCalibrationCase(archiveOf(files), 'AF-000011');
    expect(hidden.lines[0].severityAnnotation).toBeNull();
    expect(hidden.quotedTotalMxn).toBe(1900);
    expect(files.files.get('data/cases/AF-000011.json')?.content).toBe(disguised);
  });

  it('bloquea agent, admin, sesión ausente y producción antes de escribir', async () => {
    const files = new MemoryFiles();
    files.seed('data/cases/AF-000004.json', visualCase('AF-000004', [{ part: 'Puerta delantera derecha', price_mxn: 3600 }]));
    const previous = { ...process.env };
    try {
      Object.assign(process.env, openEnv);
      const controller = new SeverityReviewController(files);
      const body = { subjectId: 'AF-000004', lineId: 'L1', level: 'medio_leve', lineReviewed: true };
      await expect(controller.confirm({ ...owner, role: 'agent' }, body)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.confirm({ ...owner, role: 'admin' }, body)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.confirm({ ...owner, email: 'otro@ensayo.test' }, body)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.confirm(undefined as unknown as AuthenticatedUser, body)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(controller.confirm(owner, { ...body, operatorRole: 'owner' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.confirm(owner, { ...body, lineReviewed: false })).rejects.toBeInstanceOf(BadRequestException);
      Object.assign(process.env, { RAILWAY_ENVIRONMENT_NAME: 'production' });
      await expect(controller.confirm(owner, body)).rejects.toBeInstanceOf(NotFoundException);
      expect(files.writes).toEqual([]);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
    }
  });

  it('no deja que los importadores confirmen la severidad ni escribe el expediente', async () => {
    const calls: string[] = [];
    const github = new SeverityGithub(async (url, init) => {
      calls.push(`${init?.method} ${String(url)}`);
      if (init?.method === 'GET') return new Response('', { status: 404 });
      return new Response(JSON.stringify({ commit: { sha: 'abc123' } }), { status: 201 });
    }, async () => 'Bearer ghs_ensayo');
    await expect(github.write('data/cases/AF-000004.json', '{}\n')).rejects.toBeInstanceOf(SeverityError);
    await expect(github.write('data/annotations/severity/visual/AF-000004/SV-000001.json', '{}\n')).resolves.toBe('abc123');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/contents/data/annotations/severity/');
    const offenders: string[] = [];
    for (const name of readdirSync(__dirname)) {
      if (!name.endsWith('.ts') || name.endsWith('.spec.ts')) continue;
      if (!name.includes('import')) continue;
      const source = readFileSync(join(__dirname, name), 'utf8');
      if (source.includes('confirmSeverity') || source.includes('ingestSeverityAssessment') || source.includes('recordDeclaredSeverity') || source.includes('operatorRole') || source.includes('authenticated_owner')) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
