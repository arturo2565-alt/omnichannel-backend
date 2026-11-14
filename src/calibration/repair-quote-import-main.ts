import {
  importRepairQuoteFile,
  type RepairImportReport,
} from './repair-quote-import';

/** Lee el archivo local y no modifica el código de salida del proceso. */
export async function readRepairImport(
  env: NodeJS.ProcessEnv,
  filePath: string | undefined,
): Promise<RepairImportReport> {
  if (!filePath)
    return {
      service: 'repair-quote-import',
      result: 'error',
      category: 'incomplete',
    };
  return importRepairQuoteFile(env, filePath);
}

/** Entrada compilada a dist. No abre un endpoint. */
export async function writeRepairImport(
  filePath = process.argv[2],
): Promise<void> {
  const report = await readRepairImport(process.env, filePath);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.result !== 'ok') process.exitCode = 1;
}
