import { calibrationDiagnosticTarget } from './calibration-diagnose';
import { importCalibrationCase, readCalibrationImportDocument, type ImportReport } from './calibration-import';

/** Lee el archivo local y no modifica el código de salida del proceso. */
export async function readCalibrationImport(env: NodeJS.ProcessEnv, filePath: string | undefined): Promise<ImportReport> {
  try {
    if (!calibrationDiagnosticTarget(env)) {
      return { service: 'calibration-import', result: 'error', category: 'wrong_target' };
    }
    if (!filePath) return { service: 'calibration-import', result: 'error', category: 'incomplete' };
    return await importCalibrationCase(env, readCalibrationImportDocument(filePath));
  } catch {
    return { service: 'calibration-import', result: 'error', category: 'invalid' };
  }
}

/** Entrada compilada a dist. No usa ts-node ni abre un endpoint. */
export async function writeCalibrationImport(filePath = process.argv[2]): Promise<void> {
  const report = await readCalibrationImport(process.env, filePath);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.result !== 'ok') process.exitCode = 1;
}
