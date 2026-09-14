import type {
  ConversationUxCheckId,
  ConversationUxCompareResult,
  ConversationUxReport,
} from './types';
import { CONVERSATION_UX_CHECK_TITLES } from './types';

export function buildConversationUxReport(
  results: readonly ConversationUxCompareResult[],
  extras?: {
    greetingDuplicates?: number;
    fullQuoteUnexpectedRenders?: number;
    technicalRepeatViolations?: number;
  },
): ConversationUxReport {
  const failed = results.filter((r) => !r.passed);
  return {
    casesTotal: results.length,
    casesPassed: results.filter((r) => r.passed).length,
    casesFailed: failed.length,
    greetingDuplicates: extras?.greetingDuplicates ?? 0,
    fullQuoteUnexpectedRenders:
      extras?.fullQuoteUnexpectedRenders ??
      failed.filter((r) => r.failures.includes('FULL_QUOTE_UNEXPECTED')).length,
    technicalRepeatViolations:
      extras?.technicalRepeatViolations ??
      failed.filter((r) => r.failures.includes('TECHNICAL_REPEAT')).length,
    internalLabelsExposed: results.filter((r) => r.actual.humanLabelLeak).length,
    inventedAmounts: results.reduce((n, r) => n + r.actual.inventedAmounts, 0),
    postFilterInterventions: results.reduce(
      (n, r) => n + r.actual.postFilterInterventions,
      0,
    ),
    failures: failed.map((r) => ({
      checkId: r.checkId,
      failures: r.failures,
    })),
  };
}

export function formatConversationUxReport(
  report: ConversationUxReport,
  results: readonly ConversationUxCompareResult[],
): string {
  const lines = results.map((r) => {
    const pad = CONVERSATION_UX_CHECK_TITLES[r.checkId as ConversationUxCheckId];
    const dots = '.'.repeat(Math.max(2, 34 - pad.length));
    return `${pad} ${dots} ${r.passed ? 'PASS' : `FAIL (${r.failures.join(', ')})`}`;
  });
  return [
    'CONVERSATION UX CERTIFICATION',
    '',
    ...lines,
    '',
    `${report.casesPassed} / ${report.casesTotal} passed`,
    '',
    `greetingDuplicates=${report.greetingDuplicates}`,
    `fullQuoteUnexpectedRenders=${report.fullQuoteUnexpectedRenders}`,
    `technicalRepeatViolations=${report.technicalRepeatViolations}`,
    `internalLabelsExposed=${report.internalLabelsExposed}`,
    `inventedAmounts=${report.inventedAmounts}`,
    `postFilterInterventions=${report.postFilterInterventions}`,
  ].join('\n');
}
