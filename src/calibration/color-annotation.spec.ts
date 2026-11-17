import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { readCalibrationCase, readCalibrationQuote, readCalibrationRepair } from './calibration-query';
import type { CalibrationArchive } from './calibration-query';
import {
  ColorError,
  ColorGithub,
  assertColorWrite,
  confirmVehicleColor,
  importColorReading,
  type ColorFiles,
  type ColorReading,
} from './color-annotation';
import { ColorReviewController } from './color-review.module';
import { applyColorImport, interpretColorStatement } from './color-import';

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

class MemoryFiles implements ColorFiles {
  readonly files = new Map<string, { content: string; sha: string }>();
  readonly writes: string[] = [];

  async read(path: string) {
    return this.files.get(path) ?? null;
  }

  async write(path: string, content: string, sha?: string) {
    assertColorWrite(path);
    const current = this.files.get(path);
    if (current && current.sha !== sha) throw new ColorError('conflict');
    if (!current && sha) throw new ColorError('conflict');
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

function visualCase(id: string, price = 3600) {
  return JSON.stringify({
    schema_version: '1.0.0',
    case_id: id,
    vehicle: { make: 'Mazda', model: '3', year: 2015 },
    line_items: [{ line_id: 'L1', part: 'Puerta', treatment: 'repair_paint', price_mxn: price, damage_severity: 'unknown', validation: 'human_confirmed' }],
    photo_archive_status: 'archived_private',
    status: 'human_verified',
  });
}

function declared(color: string, extra: Partial<ColorReading> = {}): ColorReading {
  return {
    exteriorColor: color,
    exteriorProvenance: 'human_declaration',
    requestedColor: null,
    requestedProvenance: null,
    finish: null,
    finishProvenance: null,
    paintCode: null,
    paintCodeProvenance: null,
    originalColor: null,
    originalProvenance: null,
    ...extra,
  };
}

describe('color color-v1', () => {
  it('conserva el color declarado, el inferido y el desconocido sin validarlos', async () => {
    const files = new MemoryFiles();
    const body = visualCase('AF-000010');
    files.seed('data/cases/AF-000010.json', body);
    const declaredNote = await importColorReading(files, 'AF-000010', declared('rojo'));
    expect(declaredNote.status).toBe('recorded');
    expect(await importColorReading(files, 'AF-000010', declared('rojo'))).toMatchObject({
      status: 'already_recorded',
      annotationId: declaredNote.annotationId,
    });
    const inferred = await importColorReading(files, 'AF-000010', {
      ...declared('blanco'),
      exteriorProvenance: 'visual_inference',
    });
    expect(inferred.status).toBe('retained');
    const detail = await readCalibrationCase(archiveOf(files), 'AF-000010');
    expect(detail.colorAnnotation).toMatchObject({
      exteriorColor: 'rojo',
      exteriorProvenance: 'human_declaration',
      requestedColor: null,
      status: 'proposed',
      contractVersion: 'color-v1',
      finish: null,
      paintCode: null,
    });
    expect(detail.colorAnnotation?.status).not.toBe('validated');
    expect(detail.lines[0].priceMxn).toBe(3600);
    expect(files.files.get('data/cases/AF-000010.json')?.content).toBe(body);
    const unknownFiles = new MemoryFiles();
    unknownFiles.seed('data/cases/AF-000011.json', visualCase('AF-000011', 1900));
    const unknown = interpretColorStatement('el color quedó sin precisar');
    expect(unknown).toMatchObject({ exteriorColor: null, exteriorProvenance: 'unknown', requestedColor: null });
    const saved = await applyColorImport(unknownFiles, 'AF-000011', unknown!);
    expect(saved.clarification).toBe(true);
    const hidden = await readCalibrationCase(archiveOf(unknownFiles), 'AF-000011');
    expect(hidden.colorAnnotation).toMatchObject({ status: 'unknown', exteriorProvenance: 'unknown', exteriorColor: null });
    expect(hidden.quotedTotalMxn).toBe(1900);
    expect(unknownFiles.files.get('data/cases/AF-000011.json')?.content).toBe(visualCase('AF-000011', 1900));
  });

  it('separa el color actual del solicitado y no inventa acabado ni código', async () => {
    expect(interpretColorStatement('Volkswagen Jetta blanco')).toMatchObject({
      exteriorColor: 'blanco',
      exteriorProvenance: 'human_declaration',
      requestedColor: null,
      finish: null,
      paintCode: null,
    });
    expect(interpretColorStatement('Mazda 3 2015 rojo')).toMatchObject({
      exteriorColor: 'rojo',
      exteriorProvenance: 'human_declaration',
      requestedColor: null,
      originalColor: null,
    });
    expect(interpretColorStatement('Mazda 3 rojo')).toMatchObject({ exteriorColor: 'rojo', requestedColor: null, originalColor: null });
    expect(interpretColorStatement('Mercedes-Benz negro')).toMatchObject({ exteriorColor: 'negro', requestedColor: null });
    expect(interpretColorStatement('Baño de pintura en plata')).toMatchObject({
      exteriorColor: null,
      exteriorProvenance: 'unknown',
      requestedColor: 'plata',
      requestedProvenance: 'human_declaration',
      originalColor: null,
    });
    expect(interpretColorStatement('Baño de pintura en color plata')).toMatchObject({
      exteriorColor: null,
      requestedColor: 'plata',
      requestedProvenance: 'human_declaration',
      finish: null,
      paintCode: null,
    });
    expect(interpretColorStatement('Color original blanco. Mazda 3 rojo.')).toMatchObject({
      originalColor: 'blanco',
      originalProvenance: 'human_declaration',
      exteriorColor: 'rojo',
      requestedColor: null,
    });
    expect(interpretColorStatement('Cambio de blanco a negro')).toMatchObject({
      exteriorColor: 'blanco',
      requestedColor: 'negro',
      exteriorProvenance: 'human_declaration',
      requestedProvenance: 'human_declaration',
    });
    expect(interpretColorStatement('Baño de pintura en color plata, acabado perlado, código LY9B')).toMatchObject({
      exteriorColor: null,
      requestedColor: 'plata',
      finish: 'perlado',
      finishProvenance: 'human_declaration',
      paintCode: 'LY9B',
      paintCodeProvenance: 'human_declaration',
    });
    expect(interpretColorStatement('El vehiculo se observa de color blanco.')).toMatchObject({
      exteriorColor: 'blanco',
      exteriorProvenance: 'visual_inference',
      requestedColor: null,
      finish: null,
      paintCode: null,
    });
    expect(interpretColorStatement('rojo o azul')).toMatchObject({ exteriorColor: null, exteriorProvenance: 'unknown' });
    expect(interpretColorStatement('Tiempo estimado de tres dias.')).toBeNull();
    const files = new MemoryFiles();
    const body = visualCase('AF-000012', 4700);
    files.seed('data/cases/AF-000012.json', body);
    await importColorReading(files, 'AF-000012', interpretColorStatement('Cambio de blanco a negro')!);
    const detail = await readCalibrationCase(archiveOf(files), 'AF-000012');
    expect(detail.colorAnnotation).toMatchObject({
      exteriorColor: 'blanco',
      requestedColor: 'negro',
      finish: null,
      paintCode: null,
      status: 'proposed',
    });
    expect(detail.quotedTotalMxn).toBe(4700);
    expect(files.files.get('data/cases/AF-000012.json')?.content).toBe(body);
  });

  it('la corrección del propietario no reescribe el expediente ni acepta el rol del cliente', async () => {
    const files = new MemoryFiles();
    const body = visualCase('AF-000020', 8500);
    files.seed('data/cases/AF-000020.json', body);
    const proposed = await importColorReading(files, 'AF-000020', declared('rojo'));
    const corrected = await confirmVehicleColor(files, openEnv, owner, {
      subjectId: 'AF-000020',
      exteriorColor: 'azul',
      colorReviewed: true,
    });
    expect(corrected.status).toBe('validated');
    const detail = await readCalibrationCase(archiveOf(files), 'AF-000020');
    expect(detail.colorAnnotation).toMatchObject({
      exteriorColor: 'azul',
      exteriorProvenance: 'authenticated_owner',
      status: 'validated',
      requestedColor: null,
    });
    expect(detail.colorAnnotation?.history.some((item) => item.annotationId === proposed.annotationId && item.exteriorProvenance === 'human_declaration')).toBe(true);
    expect(detail.lines[0].priceMxn).toBe(8500);
    expect(files.files.get('data/cases/AF-000020.json')?.content).toBe(body);
    await expect(confirmVehicleColor(files, openEnv, owner, {
      subjectId: 'AF-000020',
      exteriorColor: 'verde',
      colorReviewed: true,
      operatorRole: 'owner',
    } as never)).rejects.toMatchObject({ code: 'rejected' });
    const previous = { ...process.env };
    try {
      Object.assign(process.env, openEnv);
      const controller = new ColorReviewController(files);
      await expect(controller.confirm({ ...owner, role: 'agent' }, {
        subjectId: 'AF-000020',
        exteriorColor: 'verde',
        colorReviewed: true,
      })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(controller.confirm(undefined as unknown as AuthenticatedUser, {
        subjectId: 'AF-000020',
        exteriorColor: 'verde',
        colorReviewed: true,
      })).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(controller.confirm(owner, {
        subjectId: 'AF-000020',
        exteriorColor: 'verde',
        colorReviewed: true,
        operatorRole: 'owner',
      })).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.confirm(owner, {
        subjectId: 'AF-000020',
        exteriorColor: 'verde',
        colorReviewed: true,
        validated: true,
      })).rejects.toBeInstanceOf(BadRequestException);
      Object.assign(process.env, { RAILWAY_ENVIRONMENT_NAME: 'production' });
      await expect(controller.confirm(owner, {
        subjectId: 'AF-000020',
        exteriorColor: 'verde',
        colorReviewed: true,
      })).rejects.toBeInstanceOf(NotFoundException);
      expect(files.files.get('data/cases/AF-000020.json')?.content).toBe(body);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
    }
  });

  it('no deja que los importadores confirmen el color ni escribe el expediente', async () => {
    const calls: string[] = [];
    const github = new ColorGithub(async (url, init) => {
      calls.push(`${init?.method} ${String(url)}`);
      if (init?.method === 'GET') return new Response('', { status: 404 });
      return new Response(JSON.stringify({ commit: { sha: 'abc123' } }), { status: 201 });
    }, async () => 'Bearer ghs_ensayo');
    await expect(github.write('data/cases/AF-000004.json', '{}\n')).rejects.toBeInstanceOf(ColorError);
    await expect(github.write('data/annotations/color/visual/AF-000004/CL-000001.json', '{}\n')).resolves.toBe('abc123');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/contents/data/annotations/color/');
    const offenders: string[] = [];
    for (const name of readdirSync(__dirname)) {
      if (!name.endsWith('.ts') || name.endsWith('.spec.ts')) continue;
      if (!name.includes('import')) continue;
      const source = readFileSync(join(__dirname, name), 'utf8');
      if (source.includes('confirmVehicleColor') || source.includes('operatorRole') || source.includes('authenticated_owner')) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
    const historical = new MemoryFiles();
    const protectedBody = '{"case_id":"AF-000001","quoted_total_mxn":100}\n';
    historical.seed('data/cases/AF-000001.json', protectedBody);
    const skipped = await applyColorImport(historical, 'AF-000001', declared('negro'));
    expect(skipped.status).toBe('rejected');
    expect(historical.writes).toEqual([]);
    expect(historical.files.get('data/cases/AF-000001.json')?.content).toBe(protectedBody);
  });

  it('muestra el color de RQ y CQ sin alterar el precio del documento', async () => {
    const files = new MemoryFiles();
    const repair = JSON.stringify({
      quote_id: 'RQ-000044',
      lines: [{ line_id: 'L01', part: 'Puerta', role: 'labor', labor: 'paint', prices: { quoted: { amount_mxn: 800, validation: 'human_confirmed' } } }],
      quoted_total_mxn: 800,
    });
    const commercial = JSON.stringify({
      quote_id: 'CQ-000044',
      prices: { quoted: { amount_mxn: 28000, validation: 'human_confirmed' } },
    });
    files.seed('data/repairs/quotes/RQ-000044.json', repair);
    files.seed('data/repairs/index.json', JSON.stringify({ opportunities: { llave: { quote_ids: ['RQ-000044'] } } }));
    files.seed('data/commercial/quotes/CQ-000044.json', commercial);
    files.seed('data/commercial/index.json', JSON.stringify({ opportunities: { llave: { quote_ids: ['CQ-000044'] } } }));
    await importColorReading(files, 'RQ-000044', declared('rojo'));
    await importColorReading(files, 'CQ-000044', {
      ...declared(null as unknown as string),
      exteriorColor: null,
      exteriorProvenance: 'unknown',
      requestedColor: 'negro',
      requestedProvenance: 'human_declaration',
    });
    const repairDetail = await readCalibrationRepair(archiveOf(files), 'RQ-000044');
    expect(repairDetail.revisions[0].colorAnnotation).toMatchObject({ exteriorColor: 'rojo', requestedColor: null });
    const quoteDetail = await readCalibrationQuote(archiveOf(files), 'CQ-000044');
    expect(quoteDetail.revisions[0].colorAnnotation).toMatchObject({
      exteriorColor: null,
      requestedColor: 'negro',
      status: 'proposed',
    });
    expect(files.files.get('data/repairs/quotes/RQ-000044.json')?.content).toBe(repair);
    expect(files.files.get('data/commercial/quotes/CQ-000044.json')?.content).toBe(commercial);
  });
});
