import type { CaseCompareResult, CertificationReport } from './types';

export function buildCertificationReport(
  results: readonly CaseCompareResult[],
): CertificationReport {
  const scored = results.filter((r) => !r.productDecision);
  const failed = scored.filter((r) => !r.passed);

  const treatmentOk = scored.filter((r) => !r.failures.includes('WRONG_TREATMENT')).length;
  const linesOk = scored.filter((r) => !r.failures.includes('WRONG_QUOTE_LINE') && !r.failures.includes('MISSING_MONTAJE_PINTURA')).length;
  const totalsOk = scored.filter((r) => !r.failures.includes('WRONG_TOTAL')).length;
  const warnOk = scored.filter((r) => !r.failures.includes('MISSING_REQUIRED_WARNING')).length;
  const partialOk = scored.filter((r) => !r.failures.includes('PARTIAL_PRESENTED_AS_COMPLETE')).length;
  const narrativeOk = scored.filter((r) => !r.failures.includes('INVENTED_MONEY')).length;
  const vehicleOk = scored.filter((r) => !r.failures.includes('CROSS_VEHICLE_MIX')).length;
  const pieceOk = scored.filter((r) => !r.failures.includes('WRONG_EVIDENCE_ASSOCIATION')).length;

  const pct = (n: number) =>
    scored.length ? Math.round((n / scored.length) * 1000) / 10 : 100;

  return {
    casesTotal: results.length,
    casesPassed: results.filter((r) => r.passed).length,
    casesFailed: failed.length,
    vehicleIdentityAccuracy: pct(vehicleOk),
    pieceDetectionAccuracy: pct(pieceOk),
    treatmentAccuracy: pct(treatmentOk),
    quoteLineAccuracy: pct(linesOk),
    financialExactMatchRate: pct(totalsOk),
    warningRecall: pct(warnOk),
    partialQuoteCorrectness: pct(partialOk),
    narrativeFinancialIntegrityRate: pct(narrativeOk),
    unsafeLegacyFallbackCount: results.filter((r) =>
      r.failures.includes('UNSAFE_LEGACY_FALLBACK'),
    ).length,
    crossVehicleCollisions: results.filter((r) =>
      r.failures.includes('CROSS_VEHICLE_MIX'),
    ).length,
    inventedMonetaryAmounts: results.filter((r) =>
      r.failures.includes('INVENTED_MONEY'),
    ).length,
    knownProductDecisions: [
      ...new Set(results.map((r) => r.productDecision).filter(Boolean) as string[]),
    ],
    failures: failed.map((r) => ({ caseId: r.caseId, failures: r.failures })),
  };
}

export function formatCertificationReport(report: CertificationReport): string {
  const bpcc = report.knownProductDecisions.includes(
    'PRODUCT_DECISION_REQUIRED_BPCC',
  )
    ? 'pending'
    : 'resolved';
  const failList = report.failures.length
    ? report.failures
        .map((f) => `  - ${f.caseId}: ${f.failures.join(', ')}`)
        .join('\n')
    : '  (none)';

  return [
    'AUTONOMY CERTIFICATION',
    '',
    'Overall:',
    `${report.casesPassed} / ${report.casesTotal} passed`,
    '',
    'Technical:',
    `Vehicle identity: ${report.vehicleIdentityAccuracy}%`,
    `Piece identity: ${report.pieceDetectionAccuracy}%`,
    `Treatment: ${report.treatmentAccuracy}%`,
    '',
    'Financial:',
    `Quote lines: ${report.quoteLineAccuracy}%`,
    `Exact totals: ${report.financialExactMatchRate}%`,
    `Partial quote correctness: ${report.partialQuoteCorrectness}%`,
    '',
    'Narrative:',
    `Financial integrity: ${report.narrativeFinancialIntegrityRate}%`,
    `Warning recall: ${report.warningRecall}%`,
    '',
    'Safety:',
    `Modern→legacy fallbacks: ${report.unsafeLegacyFallbackCount}`,
    `Cross-vehicle collisions: ${report.crossVehicleCollisions}`,
    `Invented monetary amounts: ${report.inventedMonetaryAmounts}`,
    '',
    'Known product decisions:',
    `* BPCC: ${bpcc}`,
    '',
    'Failures:',
    failList,
  ].join('\n');
}
