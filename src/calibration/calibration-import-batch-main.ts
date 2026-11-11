import {
  importCalibrationBatch,
  parseCalibrationBatchArgs,
  type BatchReport,
} from './calibration-import-batch';

/** Lee el lote local. No modifica el código de salida del proceso. */
export async function readCalibrationBatch(
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
): Promise<BatchReport> {
  const parsed = parseCalibrationBatchArgs(argv);
  if (parsed.failure) {
    return {
      service: 'calibration-import-batch',
      mode: parsed.apply ? 'apply' : 'prepare',
      result: 'error',
      category: parsed.failure.category,
      items: [],
      counts: {},
    };
  }
  return importCalibrationBatch(env, parsed.directory, { apply: parsed.apply });
}

/** Entrada compilada a dist. No usa ts-node ni abre un endpoint. */
export async function writeCalibrationBatch(
  argv: readonly string[] = commandArguments(process.argv),
): Promise<void> {
  const report = await readCalibrationBatch(process.env, argv);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.result !== 'ok') process.exitCode = 1;
}

function commandArguments(argv: readonly string[]): readonly string[] {
  const script = argv.findIndex(
    (arg) =>
      arg.endsWith('calibration-import-batch-run.js') ||
      arg.endsWith('calibration-import-batch-run.ts'),
  );
  return script >= 0 ? argv.slice(script + 1) : argv.slice(2);
}
