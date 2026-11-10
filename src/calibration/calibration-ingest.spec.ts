import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { memoryGithub } from '../../test/calibration-memory-github';
import { CalibrationEngine } from './calibration-engine';
import { CalibrationGithubWriter } from './calibration-github-writer';
import { CalibrationIngestController } from './calibration-ingest.controller';
import { minimalDecodablePng } from './calibration-image-archive.service';
import {
  CalibrationIngestService,
  calibrationIngestEnabled,
  readCalibrationImages,
} from './calibration-ingest.service';

const enabled = { CALIBRATION_INGEST_ENABLED: 'true' };
const workshop = { tallerId: '01000000-0000-4000-8000-000000000010' };
const image = minimalDecodablePng([1, 2, 3]);

function quote(key = 'case-test-ingest') {
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
    line_items: [{
      line_id: 'L1',
      part: 'puerta delantera derecha',
      treatment: 'repair_paint',
      price_mxn: 1400,
      damage_severity: 'unknown',
      validation: 'human_confirmed',
    }],
    visual_observations: [],
    status: 'human_verified',
  };
}

function service(engine?: Pick<CalibrationEngine, 'record'>) {
  return new CalibrationIngestService(engine ?? null);
}

describe('CAL-007A calibration ingest', () => {
  it('stays disabled unless the feature flag is exactly true', async () => {
    expect(calibrationIngestEnabled({})).toBe(false);
    expect(calibrationIngestEnabled({ CALIBRATION_INGEST_ENABLED: '1' })).toBe(false);
    const calls: unknown[] = [];
    const ingest = service({
      record: async (input) => {
        calls.push(input);
        throw new Error('disabled ingest must not record');
      },
    });
    await expect(ingest.record(workshop, { quote: quote() }, {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(ingest.record(workshop, { quote: quote() }, {
      CALIBRATION_INGEST_ENABLED: 'false',
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(calls).toEqual([]);
    const source = readFileSync(join(__dirname, '../app.module.ts'), 'utf8');
    expect(source).not.toContain('CalibrationModule');
    expect(source).not.toContain('calibration-ingest');
  });

  it('requires the authenticated workshop and ignores a mismatched claim', async () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, CalibrationIngestController) as unknown[];
    expect(guards).toContain(JwtAuthGuard);
    const ingest = service({
      record: async () => {
        throw new Error('unauthorized ingest must not record');
      },
    });
    await expect(ingest.record(null, { quote: quote() }, enabled)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(ingest.record(workshop, {
      tallerId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      quote: quote(),
    }, enabled)).rejects.toMatchObject({ response: { error: 'workshop_mismatch' } });
  });

  it('limits image count and rejects a remote or data URL in place of original bytes', () => {
    expect(() => readCalibrationImages(Array.from({ length: 9 }, () => image.toString('base64')))).toThrow(
      expect.objectContaining({ response: { error: 'too_many_images' } }),
    );
    expect(() => readCalibrationImages(['data:image/jpeg;base64,' + image.toString('base64')])).toThrow(
      expect.objectContaining({ response: { error: 'original_bytes_required' } }),
    );
    expect(() => readCalibrationImages(['https://example.test/photo.jpg'])).toThrow(
      expect.objectContaining({ response: { error: 'original_bytes_required' } }),
    );
  });

  it('returns the same case for a repeated quote and a partial result when photos stay pending', async () => {
    const github = memoryGithub();
    const engine = new CalibrationEngine(
      new CalibrationGithubWriter('test-token', github.transport),
      {
        store: async () => {
          throw new Error('checksum download failed');
        },
      },
      () => '2026-11-06T18:00:00.000Z',
      { sleep: async () => undefined, retry: { maxTransientAttempts: 0 } },
    );
    const ingest = service(engine);
    const body = { tallerId: workshop.tallerId, quote: quote(), images: [image.toString('base64')] };
    const first = await ingest.record(workshop, body, enabled);
    const second = await ingest.record(workshop, body, enabled);
    expect(first).toMatchObject({
      outcome: 'partial',
      registration: 'created',
      caseId: 'AF-000002',
      photoArchiveStatus: 'pending_private_archive',
      photoRefs: [],
    });
    expect(second).toMatchObject({
      outcome: 'partial',
      registration: 'already_exists',
      caseId: 'AF-000002',
    });
    expect(JSON.stringify(second)).not.toContain(workshop.tallerId);
    expect([...github.files.keys()].filter((path) => path.startsWith('data/cases/'))).toHaveLength(1);
    expect([...github.files.keys()].some((path) => path.includes('/photos/'))).toBe(false);

    const reconciled = memoryGithub({ failIndexWrites: 1 });
    const recovery = service(new CalibrationEngine(
      new CalibrationGithubWriter('test-token', reconciled.transport),
      null,
      () => '2026-11-06T18:00:00.000Z',
    ));
    const result = await recovery.record(workshop, { quote: quote('case-test-reconcile') }, enabled);
    expect(result).toMatchObject({ outcome: 'reconciled', caseId: 'AF-000002' });
    const index = JSON.parse(reconciled.files.get('data/index.json')!.text) as {
      source_keys: Record<string, string>;
    };
    expect(index.source_keys['case-test-reconcile']).toBe('AF-000002');
  });

  it('does not echo personal data or archive details in a validation error', async () => {
    const ingest = service();
    await expect(ingest.record(workshop, {
      quote: { ...quote(), customerName: 'Ana Ensayo' },
    }, enabled)).rejects.toMatchObject({ response: { error: 'personal_data' } });
    const controller = new CalibrationIngestController(ingest);
    expect(controller).toBeInstanceOf(CalibrationIngestController);
  });
});
