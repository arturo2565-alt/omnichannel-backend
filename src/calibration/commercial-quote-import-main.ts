import { importCommercialQuoteFile, type CommercialImportReport } from './commercial-quote-import';

/** Lee el archivo local y no modifica el código de salida del proceso. */
export async function readCommercialImport(
  env: NodeJS.ProcessEnv,
  filePath: string | undefined,
): Promise<CommercialImportReport> {
  if (!filePath) return { service: 'commercial-quote-import', result: 'error', category: 'incomplete' };
  return importCommercialQuoteFile(env, filePath);
}

/** Entrada compilada a dist. No abre un endpoint. */
export async function writeCommercialImport(filePath = process.argv[2]): Promise<void> {
  const report = await readCommercialImport(process.env, filePath);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.result !== 'ok') process.exitCode = 1;
}
