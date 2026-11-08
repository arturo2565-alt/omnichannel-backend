import {
  calibrationDiagnosticTarget,
  diagnoseCalibrationCloudinary,
  diagnoseCalibrationGithub,
  type CalibrationDiagnosticReport,
} from './calibration-diagnose';

/** Entrada compilada a dist. No usa ts-node ni abre la red fuera de staging. */
export async function writeCalibrationDiagnostic(service: 'github' | 'cloudinary'): Promise<void> {
  try {
    const report = await readDiagnostic(service);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.result !== 'ok') process.exitCode = 1;
  } catch {
    process.stdout.write(`${JSON.stringify({ service, result: 'error', category: 'rejected' })}\n`);
    process.exitCode = 1;
  }
}

async function readDiagnostic(service: 'github' | 'cloudinary'): Promise<CalibrationDiagnosticReport> {
  if (!calibrationDiagnosticTarget(process.env)) {
    return { service, result: 'error', category: 'wrong_target' };
  }
  return service === 'github'
    ? diagnoseCalibrationGithub(process.env)
    : diagnoseCalibrationCloudinary(process.env);
}
