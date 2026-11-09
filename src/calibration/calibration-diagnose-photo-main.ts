import { calibrationDiagnosticTarget } from './calibration-diagnose';
import { diagnoseCalibrationPhoto, type CalibrationPhotoReport } from './calibration-diagnose-photo';

/** Resultado del diagnóstico. No modifica el código de salida del proceso. */
export async function readCalibrationPhotoDiagnostic(
  env: NodeJS.ProcessEnv,
): Promise<CalibrationPhotoReport> {
  try {
    if (!calibrationDiagnosticTarget(env)) {
      return { service: 'cloudinary-photo', result: 'error', category: 'wrong_target', deleted: false };
    }
    return await diagnoseCalibrationPhoto(env);
  } catch {
    return { service: 'cloudinary-photo', result: 'error', category: 'rejected', deleted: false };
  }
}

/** Entrada compilada a dist. No usa ts-node ni abre la red fuera de staging. */
export async function writeCalibrationPhotoDiagnostic(): Promise<void> {
  const report = await readCalibrationPhotoDiagnostic(process.env);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.result !== 'ok') process.exitCode = 1;
}
