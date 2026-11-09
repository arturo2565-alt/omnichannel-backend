import { calibrationDiagnosticTarget } from './calibration-diagnose';
import {
  diagnoseCalibrationIntegrated,
  type IntegratedReport,
} from './calibration-diagnose-integrated';

/** Resultado del diagnóstico. No modifica el código de salida del proceso. */
export async function readCalibrationIntegratedDiagnostic(
  env: NodeJS.ProcessEnv,
): Promise<IntegratedReport> {
  try {
    if (!calibrationDiagnosticTarget(env)) {
      return { service: 'calibration-integrated', result: 'error', category: 'wrong_target' };
    }
    return await diagnoseCalibrationIntegrated(env);
  } catch {
    return { service: 'calibration-integrated', result: 'error', category: 'rejected' };
  }
}

/** Entrada compilada a dist. No usa ts-node ni abre la red fuera de staging. */
export async function writeCalibrationIntegratedDiagnostic(): Promise<void> {
  const report = await readCalibrationIntegratedDiagnostic(process.env);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.result !== 'ok') process.exitCode = 1;
}
