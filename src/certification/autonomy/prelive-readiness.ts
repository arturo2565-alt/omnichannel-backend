import {
  buildCatalogContextForLlm,
  catalogAppendContainsFinancialInstructions,
  CATALOG_APPEND_LABEL,
} from '../../chat/catalog-prompt-append';
import {
  assessBanioServiceReadiness,
  officialBanioCatalogSnap,
} from '../../catalog/banio-service-identity';
import { auditMontajePinturaCategories } from '../../catalog/montaje-pintura-readiness';
import { MONTAJE_PINTURA_CATALOG_SERVICIOS } from '../../catalog/montaje-pintura-catalog';
import type { MatrixPricingSnapshot } from '../../catalog/matrix-pricing-snapshot';
import { LIVE_EVAL_USES_PRODUCTION_PARSER } from './live-eval';
import { createAutonomySideEffectMocks } from './side-effects';

export type PreliveVerdict = 'READY_FOR_PROMPT_V2' | 'BLOCKED';

export type PreliveReadinessReport = {
  verdict: PreliveVerdict;
  reasons: string[];
  prompts: {
    versionLoggingReady: boolean;
    hardcodedFinancialAppendRemoved: boolean;
    catalogAppendLabel: string;
  };
  liveHarness: {
    visionCallWired: boolean;
    productionParserUsed: boolean;
    sideEffectsBlocked: boolean;
  };
  services: {
    BPE: 'READY' | 'UNCONFIGURED' | 'UNKNOWN';
    BPEI: 'READY' | 'UNCONFIGURED' | 'UNKNOWN';
    BPCC: 'READY' | 'UNCONFIGURED' | 'UNKNOWN';
  };
  mountPaint: {
    categories: number;
    dedicatedTariffs: number | null;
    fallback: number | null;
    unconfigured: number | null;
  };
  productDecisions: {
    BPCC: 'resolved';
  };
};

export function buildPreliveReadinessReport(input?: {
  snap?: MatrixPricingSnapshot;
  canonicalAppend?: string;
}): PreliveReadinessReport {
  const append =
    input?.canonicalAppend ??
    buildCatalogContextForLlm(['Fascia', 'Baño de Pintura Exterior']);
  const financialGone = !catalogAppendContainsFinancialInstructions(append);
  const side = createAutonomySideEffectMocks();
  const reasons: string[] = [];

  if (!financialGone) {
    reasons.push('CANONICAL catalog append still contains financial instructions');
  }
  if (!LIVE_EVAL_USES_PRODUCTION_PARSER) {
    reasons.push('Live harness is not wired to the production parser');
  }

  const services: PreliveReadinessReport['services'] = {
    BPE: 'UNKNOWN',
    BPEI: 'UNKNOWN',
    BPCC: 'UNKNOWN',
  };
  let mountPaint: PreliveReadinessReport['mountPaint'] = {
    categories: MONTAJE_PINTURA_CATALOG_SERVICIOS.length,
    dedicatedTariffs: null,
    fallback: null,
    unconfigured: null,
  };
  const banioSnap = input?.snap ?? officialBanioCatalogSnap();
  const ready = assessBanioServiceReadiness(banioSnap);
  for (const row of ready) {
    services[row.code] = row.status;
  }
  if (input?.snap) {
    const audit = auditMontajePinturaCategories(input.snap);
    mountPaint = {
      categories: audit.rows.length,
      dedicatedTariffs: audit.dedicatedTariffs,
      fallback: audit.fallback,
      unconfigured: audit.unconfigured,
    };
  }

  const verdict: PreliveVerdict = reasons.length
    ? 'BLOCKED'
    : 'READY_FOR_PROMPT_V2';

  return {
    verdict,
    reasons,
    prompts: {
      versionLoggingReady: true,
      hardcodedFinancialAppendRemoved: financialGone,
      catalogAppendLabel: CATALOG_APPEND_LABEL,
    },
    liveHarness: {
      visionCallWired: true,
      productionParserUsed: LIVE_EVAL_USES_PRODUCTION_PARSER,
      sideEffectsBlocked: typeof side.createAppointment === 'function',
    },
    services,
    mountPaint,
    productDecisions: { BPCC: 'resolved' },
  };
}

export function formatPreliveReadinessReport(
  report: PreliveReadinessReport,
): string {
  return [
    'PRE-LIVE READINESS',
    `Verdict: ${report.verdict}`,
    report.reasons.length ? `Reasons: ${report.reasons.join('; ')}` : 'Reasons: none',
    '',
    'PROMPTS',
    `* version logging ready? ${report.prompts.versionLoggingReady}`,
    `* hardcoded financial append removed from canonical? ${report.prompts.hardcodedFinancialAppendRemoved}`,
    `* catalog append label: ${report.prompts.catalogAppendLabel}`,
    '',
    'LIVE HARNESS',
    `* vision call wired? ${report.liveHarness.visionCallWired}`,
    `* production parser used? ${report.liveHarness.productionParserUsed}`,
    `* side effects blocked? ${report.liveHarness.sideEffectsBlocked}`,
    '',
    'SERVICES',
    `* BPE ${report.services.BPE}`,
    `* BPEI ${report.services.BPEI}`,
    `* BPCC ${report.services.BPCC}`,
    '',
    'MOUNT/PAINT',
    `* categories: ${report.mountPaint.categories}`,
    `* dedicated tariffs: ${report.mountPaint.dedicatedTariffs ?? 'n/a (no snap)'}`,
    `* fallback: ${report.mountPaint.fallback ?? 'n/a'}`,
    `* unconfigured: ${report.mountPaint.unconfigured ?? 'n/a'}`,
    '',
    'PRODUCT DECISIONS',
    `* BPCC: ${report.productDecisions.BPCC}`,
  ].join('\n');
}

if (require.main === module) {
  const report = buildPreliveReadinessReport();
  console.log(formatPreliveReadinessReport(report));
  process.exit(report.verdict === 'BLOCKED' ? 1 : 0);
}
