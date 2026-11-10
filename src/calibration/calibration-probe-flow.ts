import { CAL010_CLOUDINARY_PREFIX, CalibrationCloudinaryArchive } from './calibration-cloudinary-archive';
import { minimalDecodablePng } from './calibration-image-archive.service';
import { CalibrationEngine, type CalibrationPhotoStore, type CalibrationRecordResult } from './calibration-engine';
import { CalibrationConflictError } from './calibration-github-writer';
import { CalibrationProbeWriter, type ProbeIndex } from './calibration-probe';

/** The certified CAL-009D case. This flow must not rewrite it. */
export const CAL010_PROTECTED_CASE_ID = 'AF-900000';
export const CAL010_PROTECTED_SOURCE_KEY = 'probe-cal-009d-001';
export const CAL010_SOURCE_KEY = 'probe-cal-010-001';

const CLOCK = '2026-11-08T18:00:00.000Z';

/** A 1×1 opaque PNG. It is not the CAL-008 image and carries no personal data or EXIF. */
export function syntheticCal010Image(): Buffer {
  return minimalDecodablePng([16, 32, 48]);
}

export function cal010Quote() {
  return {
    source: {
      kind: 'autofix_human_quote',
      source_case_key: CAL010_SOURCE_KEY,
      quoted_at: null,
    },
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
        price_mxn: 1250,
        damage_severity: 'unknown',
        validation: 'human_confirmed',
      },
    ],
    visual_observations: ['Deformación visible en el arco de la salpicadera.'],
    status: 'human_verified',
  };
}

export function createCal010PhotoArchive(gateway: ConstructorParameters<typeof CalibrationCloudinaryArchive>[0]): CalibrationCloudinaryArchive {
  return new CalibrationCloudinaryArchive(gateway, CAL010_CLOUDINARY_PREFIX);
}

/**
 * Records one synthetic observation through the existing engine.
 * GitHub stays under data/probes/. Photographs stay under the CAL-010 prefix.
 * AF-900000 is a precondition, not a file this function updates.
 */
export async function recordCal010Observation(
  writer: CalibrationProbeWriter,
  photos: CalibrationPhotoStore,
  options?: { maxTransientAttempts?: number },
): Promise<CalibrationRecordResult> {
  assertCal010Floor(await writer.readIndex());
  const engine = new CalibrationEngine(writer, photos, () => CLOCK, {
    sleep: async () => undefined,
    random: () => 0,
    retry: { maxTransientAttempts: options?.maxTransientAttempts ?? 3 },
  });
  const result = await engine.record(cal010Quote(), [syntheticCal010Image()]);
  if (result.caseId === CAL010_PROTECTED_CASE_ID) {
    throw new CalibrationConflictError('Probe observation reused the protected case');
  }
  return result;
}

/** Links one already verified manifest. It does not upload and does not delete. */
export async function recoverCal010Manifest(
  writer: CalibrationProbeWriter,
  photos: CalibrationPhotoStore,
  caseId: string,
): Promise<CalibrationRecordResult['photoArchiveStatus']> {
  if (caseId === CAL010_PROTECTED_CASE_ID || !/^AF-9\d{5}$/.test(caseId)) {
    throw new CalibrationConflictError('Probe observation reused the protected case');
  }
  const engine = new CalibrationEngine(writer, photos, () => CLOCK, {
    sleep: async () => undefined,
    random: () => 0,
    retry: { maxTransientAttempts: 0 },
  });
  const recovered = await engine.recoverOrphanManifests(caseId, ['IMG-000001']);
  return recovered.photoArchiveStatus;
}

export function assertCal010Floor(index: ProbeIndex): void {
  if (index.archive !== 'probe') {
    throw new CalibrationConflictError('Probe index can reach the real case range');
  }
  if (index.cases[CAL010_PROTECTED_CASE_ID] !== `data/probes/cases/${CAL010_PROTECTED_CASE_ID}.json`) {
    throw new CalibrationConflictError('Protected probe case is missing');
  }
  if (index.source_keys[CAL010_PROTECTED_SOURCE_KEY] !== CAL010_PROTECTED_CASE_ID) {
    throw new CalibrationConflictError('Protected probe case is missing');
  }
  if (index.source_keys[CAL010_SOURCE_KEY] === CAL010_PROTECTED_CASE_ID) {
    throw new CalibrationConflictError('Probe observation reused the protected case');
  }
}
