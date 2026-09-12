import { AUTONOMY_GOLDEN_CASES } from './golden-cases';
import { runDeterministicAutonomyCase } from './pipeline';
import { compareAutonomyCase } from './compare';
import { buildCertificationReport, formatCertificationReport } from './report';
import { createAutonomySideEffectMocks } from './side-effects';
import type { CaseCompareResult } from './types';

describe('Autonomy certification — LEVEL 1 deterministic pipeline', () => {
  it('cubre combinaciones distintas (no variantes triviales)', () => {
    expect(AUTONOMY_GOLDEN_CASES.length).toBeGreaterThanOrEqual(20);
    const cats = new Set(AUTONOMY_GOLDEN_CASES.map((c) => c.category));
    expect(cats.size).toBeGreaterThanOrEqual(20);
  });

  it('certifica el flujo completo y reporta métricas', async () => {
    const side = createAutonomySideEffectMocks();
    expect(side.calls).toEqual([]);

    const results: CaseCompareResult[] = [];
    for (const certCase of AUTONOMY_GOLDEN_CASES) {
      const actual = await runDeterministicAutonomyCase(certCase);
      const compared = compareAutonomyCase(certCase, actual);
      if (!compared.passed && !compared.productDecision) {
        // Traza corta y observable; no chain-of-thought.
        // eslint-disable-next-line no-console
        console.log(compared.trace);
      }
      results.push(compared);
    }

    const report = buildCertificationReport(results);
    // eslint-disable-next-line no-console
    console.log(`\n${formatCertificationReport(report)}\n`);

    expect(report.financialExactMatchRate).toBe(100);
    expect(report.narrativeFinancialIntegrityRate).toBe(100);
    expect(report.unsafeLegacyFallbackCount).toBe(0);
    expect(report.inventedMonetaryAmounts).toBe(0);
    expect(report.casesFailed).toBe(0);
    expect(report.knownProductDecisions).not.toContain(
      'PRODUCT_DECISION_REQUIRED_BPCC',
    );
  });
});
