import type {
  AutonomyCertificationCase,
  CaseActual,
  CaseCompareResult,
  CaseFailureCode,
} from './types';

export function compareAutonomyCase(
  certCase: AutonomyCertificationCase,
  actual: CaseActual,
): CaseCompareResult {
  const failures: CaseFailureCode[] = [];
  const exp = certCase.expected;

  if (exp.treatments?.length) {
    const a = [...actual.treatments].sort().join('|');
    const e = [...exp.treatments].sort().join('|');
    if (a !== e) failures.push('WRONG_TREATMENT');
  }

  if (exp.quoteLines?.length) {
    const actualTypes = actual.quoteLines.map((l) => l.serviceType).sort();
    const expectedTypes = exp.quoteLines.map((l) => l.serviceType).sort();
    if (actualTypes.join('|') !== expectedTypes.join('|')) {
      failures.push('WRONG_QUOTE_LINE');
      if (
        expectedTypes.includes('MONTAJE_PINTURA') &&
        !actualTypes.includes('MONTAJE_PINTURA')
      ) {
        failures.push('MISSING_MONTAJE_PINTURA');
      }
    }
    for (const want of exp.quoteLines) {
      const hit = actual.quoteLines.find((l) => l.serviceType === want.serviceType);
      if (!hit) continue;
      if (want.billable != null && hit.billable !== want.billable) {
        failures.push('WRONG_QUOTE_LINE');
      }
      if (want.pricingSource && hit.pricingSource !== want.pricingSource) {
        failures.push('WRONG_PRICING_SOURCE');
      }
      if (want.pricingStatus && hit.pricingStatus !== want.pricingStatus) {
        failures.push('WRONG_QUOTE_LINE');
      }
    }
  }

  if (exp.forbiddenServiceTypes?.some((t) => actual.serviceTypes.includes(t))) {
    failures.push('WRONG_QUOTE_LINE');
  }

  if (exp.total != null && actual.total !== exp.total) {
    failures.push('WRONG_TOTAL');
  }

  if (exp.isPartial != null && actual.isPartial !== exp.isPartial) {
    failures.push('PARTIAL_PRESENTED_AS_COMPLETE');
  }
  if (
    actual.isPartial &&
    /inversi[oó]n total estimada/i.test(actual.finalMessage) &&
    !/parcial|incompleta/i.test(actual.finalMessage)
  ) {
    failures.push('PARTIAL_PRESENTED_AS_COMPLETE');
  }

  if (exp.requiredWarnings?.length) {
    const missing = exp.requiredWarnings.filter(
      (w) => !actual.warnings.includes(w),
    );
    if (missing.length) failures.push('MISSING_REQUIRED_WARNING');
  }

  if (exp.sameDamageItemId && new Set(actual.damageItemIds).size > 1) {
    failures.push('WRONG_EVIDENCE_ASSOCIATION');
  }

  if (exp.distinctVehicleIds && actual.vehicleIds.length < 2) {
    failures.push('CROSS_VEHICLE_MIX');
  }
  if (new Set(actual.quoteLines.map((l) => l.vehicleId)).size > 1) {
    const byVehicle = new Map<string, string[]>();
    for (const line of actual.quoteLines) {
      const list = byVehicle.get(line.vehicleId) ?? [];
      list.push(line.damageItemId);
      byVehicle.set(line.vehicleId, list);
    }
  }
  if (
    actual.quoteLines.length > 1 &&
    new Set(actual.quoteLines.map((l) => l.vehicleId)).size > 1 &&
    certCase.kind !== 'multi_vehicle' &&
    !exp.distinctVehicleIds
  ) {
    failures.push('CROSS_VEHICLE_MIX');
  }

  if (exp.pricingSource && !actual.quoteLines.some((l) => l.pricingSource === exp.pricingSource)) {
    failures.push('WRONG_PRICING_SOURCE');
  }

  if (exp.quoteFlowMode && actual.quoteFlowMode !== exp.quoteFlowMode) {
    if (actual.quoteFlowMode === 'LEGACY') failures.push('UNSAFE_LEGACY_FALLBACK');
  }

  if (exp.noInventedMoney !== false && actual.inventedMoney) {
    failures.push('INVENTED_MONEY');
  }
  if (exp.noUnsafeLegacyFallback !== false && actual.unsafeLegacyFallback) {
    failures.push('UNSAFE_LEGACY_FALLBACK');
  }
  if (exp.usedLocalFinance === false && actual.usedLocalFinance) {
    failures.push('FRONTEND_FINANCIAL_FALLBACK');
  }

  if (exp.shouldRequestMoreEvidence && !actual.treatments.includes('PENDIENTE') && !actual.treatments.includes('INCIERTO')) {
    failures.push('WRONG_TREATMENT');
  }

  const unique = [...new Set(failures)];
  const productDecision = certCase.productDecisionRequired;
  const passed = productDecision ? true : unique.length === 0;

  return {
    caseId: certCase.caseId,
    passed,
    productDecision,
    failures: unique,
    trace: formatTrace(certCase, actual, unique),
  };
}

function formatTrace(
  certCase: AutonomyCertificationCase,
  actual: CaseActual,
  failures: CaseFailureCode[],
): string {
  const exp = certCase.expected;
  return [
    `Case: ${certCase.caseId}`,
    '',
    'Expected:',
    exp.treatments ? `treatment=${exp.treatments.join(',')}` : null,
    exp.quoteLines
      ? `services=[${exp.quoteLines.map((l) => l.serviceType).join(', ')}]`
      : null,
    exp.total != null ? `total=${exp.total}` : null,
    exp.isPartial != null ? `isPartial=${exp.isPartial}` : null,
    '',
    'Actual:',
    `treatment=${actual.treatments.join(',') || '—'}`,
    `services=[${actual.serviceTypes.join(', ')}]`,
    `total=${actual.total}`,
    `isPartial=${actual.isPartial}`,
    `warnings=${actual.warnings.join(',') || '—'}`,
    `quoteFlowMode=${actual.quoteFlowMode}`,
    '',
    failures.length
      ? `Failure:\n${failures.join('\n')}`
      : certCase.productDecisionRequired
        ? `PRODUCT_DECISION_REQUIRED: ${certCase.productDecisionRequired}`
        : 'PASS',
  ]
    .filter((line) => line !== null)
    .join('\n');
}
