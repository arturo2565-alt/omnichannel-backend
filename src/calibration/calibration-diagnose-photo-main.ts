import { calibrationDiagnosticTarget } from './calibration-diagnose';
import { diagnoseCalibrationPhoto, type CalibrationPhotoReport } from './calibration-diagnose-photo';

/** Entrada compilada a dist. No usa ts-node ni abre la red fuera de staging. */
export async function writeCalibrationPhotoDiagnostic(): Promise<void> {
  try {
    if (!calibrationDiagnosticTarget(process.env)) {
      write({ service: 'cloudinary-photo', result: 'error', category: 'wrong_target', deleted: false });
      return;
    }
    write(await diagnoseCalibrationPhoto(process.env));
  } catch {
    write({ service: 'cloudinary-photo', result: 'error', category: 'rejected', deleted: false });
  }
}

function write(report: CalibrationPhotoReport): void {
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.result !== 'ok') process.exitCode = 1;
}
