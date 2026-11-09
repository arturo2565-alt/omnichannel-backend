import { calibrationDiagnosticTarget } from './calibration-diagnose';
import {
  diagnoseCalibrationProbeWrite,
  type ProbeWriteReport,
} from './calibration-diagnose-probe-write';

/** Resultado del diagnóstico. No modifica el código de salida del proceso. */
export async function readCalibrationProbeWriteDiagnostic(
  env: NodeJS.ProcessEnv,
): Promise<ProbeWriteReport> {
  try {
    if (!calibrationDiagnosticTarget(env)) {
      return { service: 'github-probe-write', result: 'error', category: 'wrong_target' };
    }
    return await diagnoseCalibrationProbeWrite(env);
  } catch {
    return { service: 'github-probe-write', result: 'error', category: 'rejected' };
  }
}

/** Entrada compilada a dist. No usa ts-node ni abre la red fuera de staging. */
export async function writeCalibrationProbeWriteDiagnostic(): Promise<void> {
  const report = await readCalibrationProbeWriteDiagnostic(process.env);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.result !== 'ok') process.exitCode = 1;
}
