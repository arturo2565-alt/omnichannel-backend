import {
  calibrationDiagnosticTarget,
  diagnoseCalibrationGithub,
} from '../src/calibration/calibration-diagnose';

async function main(): Promise<void> {
  const report = calibrationDiagnosticTarget(process.env)
    ? await diagnoseCalibrationGithub(process.env)
    : { service: 'github' as const, result: 'error' as const, category: 'wrong_target' as const };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.result !== 'ok') process.exitCode = 1;
}

main().catch(() => {
  process.stdout.write('{"service":"github","result":"error","category":"rejected"}\n');
  process.exitCode = 1;
});
