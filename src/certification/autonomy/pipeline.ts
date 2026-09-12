import type { DetectedDamageItem } from '../../chat/entities/chat.entity';
import { buildCanonicalQuoteV1 } from '../../chat/canonical-quote-engine';
import {
  canonicalQuoteFromInstantResolution,
  commercialBundleFromExpress,
  commercialLinesFromExtras,
  mergeCommercialLinesIntoQuote,
} from '../../chat/canonical-commercial-quote';
import { composeModernClientQuoteMessage } from '../../chat/canonical-quote-narrative';
import { canonicalPhysicalPanelKey } from '../../chat/piece-treatment';
import {
  composeAggregateClientQuoteMessage,
  quotesMixVehicles,
} from '../../domain/peritaje-v1/aggregate-quote';
import {
  createQuoteLineId,
  finalizeCanonicalQuote,
  mergeLockedTreatments,
  parseStructuredTreatment,
  peritajeFromLegacyAnalysis,
  type QuoteLine,
  type TreatmentDecision,
} from '../../domain/peritaje-v1';
import {
  extractMonetaryAmounts,
  isChargeableQuoteLine,
  renderCanonicalQuoteFinancialBlock,
  resolveModernPanelFallbackText,
  resolveQuoteFlowMode,
  QUOTE_FLOW_MODE,
  validateFinalClientQuoteMessage,
} from '../../domain/peritaje-v1';
import { autonomyMockSnap } from './pricing-snap';
import type { AutonomyCertificationCase, CaseActual } from './types';

function collapseByPhysicalPiece(
  items: DetectedDamageItem[],
): DetectedDamageItem[] {
  const map = new Map<string, DetectedDamageItem>();
  for (const it of items) {
    const vehicle = String(it.vehicleId || it.vehiculoDetectado || '').trim();
    const panel = canonicalPhysicalPanelKey(it.pieza) || it.pieza;
    const key = `${vehicle}::${panel}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...it, urls_origen: [...(it.urls_origen ?? [])] });
      continue;
    }
    const merged = mergeLockedTreatments(
      parseStructuredTreatment(prev.tratamiento),
      parseStructuredTreatment(it.tratamiento),
    );
    map.set(key, {
      ...prev,
      urls_origen: [
        ...new Set([...(prev.urls_origen ?? []), ...(it.urls_origen ?? [])]),
      ],
      descripcionTecnica: it.descripcionTecnica || prev.descripcionTecnica,
      tratamiento: merged.treatment,
      treatmentSource: merged.source,
      treatmentReason: merged.reason,
    });
  }
  return [...map.values()];
}

function applyPriorLocks(
  items: DetectedDamageItem[],
  prior?: AutonomyCertificationCase['input']['priorTreatments'],
): DetectedDamageItem[] {
  if (!prior?.length) return items;
  return items.map((it) => {
    const key = canonicalPhysicalPanelKey(it.pieza) || it.pieza;
    const existing = prior.find(
      (p) =>
        (canonicalPhysicalPanelKey(p.pieza) || p.pieza) === key &&
        (!p.vehicleLabel ||
          !it.vehiculoDetectado ||
          p.vehicleLabel === it.vehiculoDetectado),
    );
    if (!existing) return it;
    const incoming = parseStructuredTreatment(it.tratamiento);
    const merged = mergeLockedTreatments(existing.treatment, incoming);
    return {
      ...it,
      tratamiento: merged.treatment,
      treatmentSource: merged.source,
      treatmentReason: merged.reason,
    };
  });
}

function emptyActual(partial: Partial<CaseActual> = {}): CaseActual {
  return {
    treatments: [],
    serviceTypes: [],
    quoteLines: [],
    total: 0,
    isPartial: false,
    warnings: [],
    finalMessage: '',
    financialBlock: '',
    quoteFlowMode: 'CANONICAL',
    damageItemIds: [],
    vehicleIds: [],
    inventedMoney: false,
    unsafeLegacyFallback: false,
    usedLocalFinance: false,
    narrativeOk: true,
    ...partial,
  };
}

function actualFromQuote(
  quote: {
    total: number;
    isPartial: boolean;
    warnings: string[];
    lines: Array<{
      serviceType: string;
      billable: boolean;
      amount: number;
      vehicleId: string;
      damageItemId: string;
      pricingSource?: string;
      pricingStatus?: string;
    }>;
  },
  extras: Partial<CaseActual>,
): CaseActual {
  return emptyActual({
    serviceTypes: quote.lines.map((l) => l.serviceType as CaseActual['serviceTypes'][number]),
    quoteLines: quote.lines.map((l) => ({
      serviceType: l.serviceType as CaseActual['quoteLines'][number]['serviceType'],
      billable: l.billable,
      amount: l.amount,
      vehicleId: l.vehicleId,
      damageItemId: l.damageItemId,
      pricingSource: l.pricingSource,
      pricingStatus: l.pricingStatus,
    })),
    total: quote.total,
    isPartial: quote.isPartial,
    warnings: quote.warnings,
    vehicleIds: [...new Set(quote.lines.map((l) => l.vehicleId))],
    damageItemIds: [...new Set(quote.lines.map((l) => l.damageItemId))],
    ...extras,
  });
}

export async function runDeterministicAutonomyCase(
  certCase: AutonomyCertificationCase,
): Promise<CaseActual> {
  const snap = autonomyMockSnap();

  if (certCase.input.simulateFrontendFallback) {
    const fb = resolveModernPanelFallbackText({
      quoteFlowMode: 'CANONICAL',
      hasCanonicalQuote: true,
      persistedFinalMessage: '',
    });
    return emptyActual({
      usedLocalFinance: fb.usedLocalFinance,
      unsafeLegacyFallback: fb.usedLocalFinance,
      quoteFlowMode: 'CANONICAL',
    });
  }

  if (certCase.input.simulateDowngrade) {
    const decision = resolveQuoteFlowMode({
      lockedMode: QUOTE_FLOW_MODE.CANONICAL,
    });
    return emptyActual({
      quoteFlowMode: decision.mode,
      unsafeLegacyFallback:
        decision.mode === QUOTE_FLOW_MODE.LEGACY && !decision.blockedDowngrade,
    });
  }

  if (certCase.kind === 'multi_vehicle' && certCase.input.express && certCase.input.secondVehicleExpress) {
    const a = commercialBundleFromExpress(certCase.input.express, 'cert-a');
    const b = commercialBundleFromExpress(
      certCase.input.secondVehicleExpress,
      'cert-b',
    );
    const composed = composeAggregateClientQuoteMessage({
      quotes: [
        {
          quote: a.quote,
          vehicleLabel: certCase.input.express.vehicleDisplayLabel || 'A',
        },
        {
          quote: b.quote,
          vehicleLabel:
            certCase.input.secondVehicleExpress.vehicleDisplayLabel || 'B',
        },
      ],
      contactName: 'Cliente',
    });
    const mixed = quotesMixVehicles([a.quote, b.quote]);
    return actualFromQuote(
      {
        ...a.quote,
        total: composed.aggregate.combinedTotal,
        isPartial: composed.aggregate.isPartial,
        lines: [...a.quote.lines, ...b.quote.lines],
        warnings: [...a.quote.warnings, ...b.quote.warnings],
      },
      {
        treatments: [],
        finalMessage: composed.finalMessage,
        financialBlock: composed.financialBlock,
        vehicleIds: composed.aggregate.vehicleIds,
        unsafeLegacyFallback: mixed,
      },
    );
  }

  if (certCase.input.forcedQuoteLines?.length) {
    const lines: QuoteLine[] = certCase.input.forcedQuoteLines.map((row, idx) => ({
      quoteLineId: createQuoteLineId({
        damageItemId: `dmg_forced_${idx}`,
        serviceType: row.serviceType,
      }),
      damageItemId: `dmg_forced_${idx}`,
      vehicleId: row.vehicleId || 'veh_forced',
      serviceType: row.serviceType,
      description: row.description || row.serviceType,
      billable: row.billable,
      amount: row.amount,
      confidence: 'MEDIUM',
      ...(row.pricingSource
        ? { pricingSource: row.pricingSource as QuoteLine['pricingSource'] }
        : {}),
      ...(row.pricingStatus
        ? { pricingStatus: row.pricingStatus as QuoteLine['pricingStatus'] }
        : {}),
    }));
    const quote = finalizeCanonicalQuote({
      lines,
      peritajeId: 'per_forced',
      quoteId: `quo_forced_${certCase.caseId}`,
    });
    return finalizeNarrative(certCase, quote, []);
  }

  if (certCase.kind === 'express' || certCase.kind === 'commercial' || certCase.kind === 'product_decision') {
    const express = certCase.input.express ?? {
      lines: [],
      extras: certCase.input.extraLines,
      vehicleDisplayLabel: certCase.input.vehicleContext,
    };
    let quote = commercialBundleFromExpress(express, 'cert-express').quote;
    if (certCase.input.extraLines?.length && certCase.kind === 'commercial') {
      const vehicleId = quote.lines[0]?.vehicleId || 'veh_unknown';
      const extras = commercialLinesFromExtras(
        certCase.input.extraLines,
        vehicleId,
        'express',
      );
      quote = mergeCommercialLinesIntoQuote(quote, extras.lines);
    }
    return finalizeNarrative(certCase, quote, []);
  }

  if (certCase.kind === 'panel_manual') {
    const quote = canonicalQuoteFromInstantResolution({
      lines: [{ label: 'Fascia', amount: certCase.input.manualAmount ?? 0 }],
    });
    quote.lines[0]!.pricingSource = 'MANUAL';
    return finalizeNarrative(certCase, quote, []);
  }

  const rawItems = collapseByPhysicalPiece(
    applyPriorLocks(
      (certCase.input.visionItems ?? []).map((it) => ({
        ...it,
        vehiculoDetectado:
          it.vehiculoDetectado || certCase.input.vehicleContext,
      })),
      certCase.input.priorTreatments,
    ),
  );
  const peritaje = peritajeFromLegacyAnalysis({
    analysis: {
      inventory: rawItems,
      vehiculoDetectado: certCase.input.vehicleContext,
    },
    conversationId: `cert-${certCase.caseId}`,
    canonicalizePanel: (raw) => canonicalPhysicalPanelKey(raw) || raw,
  });

  if (certCase.input.simulateRebuildFailure) {
    return emptyActual({
      treatments: peritaje.damages.map((d) => d.treatment),
      quoteFlowMode: 'BLOCKED',
      unsafeLegacyFallback: false,
    });
  }

  const priced: DetectedDamageItem[] = peritaje.damages.map((d) => {
    const src =
      rawItems.find(
        (it) =>
          (canonicalPhysicalPanelKey(it.pieza) || it.pieza) === d.physicalPanelKey &&
          (!it.vehicleId || it.vehicleId === d.vehicleId),
      ) ?? rawItems[0];
    return {
      pieza: d.pieceCode,
      severidad: d.severity,
      descripcionTecnica: d.descriptionTechnical,
      urls_origen: d.evidence.map((e) => e.url),
      tratamiento: d.treatment,
      treatmentSource: d.treatmentSource,
      treatmentReason: d.treatmentReason,
      vehicleId: d.vehicleId,
      damageItemId: d.damageItemId,
      vehiculoDetectado: certCase.input.vehicleContext,
      ...(d.possibleHiddenDamage
        ? { possibleHiddenDamage: d.possibleHiddenDamage }
        : {}),
      ...(src?.precioMx != null ? { precioMx: src.precioMx } : {}),
      ...(src?.pricingStatus ? { pricingStatus: src.pricingStatus } : {}),
      ...(src?.priceSource ? { priceSource: src.priceSource } : {}),
    };
  });

  const built = buildCanonicalQuoteV1({
    peritaje,
    pricedInventory: priced,
    snap,
    quoteId: `quo_cert_${certCase.caseId}`,
    generatedAt: '2026-09-11T00:00:00.000Z',
    ...(certCase.input.manualAmount != null
      ? {
          manualOverrides: [
            { amount: certCase.input.manualAmount, serviceType: 'REPARACION_PINTURA' },
          ],
        }
      : {}),
  });

  if (!built.ok) {
    return emptyActual({
      treatments: peritaje.damages.map((d) => d.treatment),
      quoteFlowMode: 'BLOCKED',
      unsafeLegacyFallback: false,
    });
  }

  let quote = built.quote;
  if (certCase.input.extraLines?.length) {
    const extras = commercialLinesFromExtras(
      certCase.input.extraLines,
      quote.lines[0]?.vehicleId || peritaje.vehicles[0]?.vehicleId || 'veh_unknown',
      'express',
    );
    quote = mergeCommercialLinesIntoQuote(quote, extras.lines);
  }

  return finalizeNarrative(
    certCase,
    quote,
    peritaje.damages.map((d) => d.treatment),
    peritaje,
  );
}

async function finalizeNarrative(
  certCase: AutonomyCertificationCase,
  quote: Parameters<typeof composeModernClientQuoteMessage>[0]['canonicalQuote'],
  treatments: TreatmentDecision[],
  peritaje?: Parameters<typeof composeModernClientQuoteMessage>[0]['peritaje'],
): Promise<CaseActual> {
  const financial = renderCanonicalQuoteFinancialBlock(quote, peritaje);
  const openai = certCase.input.simulateOpenaiFailure
    ? ({
        chat: {
          completions: {
            create: async () => {
              throw new Error('openai_unavailable');
            },
          },
        },
      } as never)
    : undefined;

  let composed: Awaited<ReturnType<typeof composeModernClientQuoteMessage>>;
  try {
    composed = await composeModernClientQuoteMessage({
      canonicalQuote: quote,
      peritaje,
      contactName: 'Cliente',
      hasActiveAppointment: false,
      ...(certCase.input.injectedLlmParts
        ? { llmParts: certCase.input.injectedLlmParts }
        : openai
          ? {
              openai,
              chatAppointmentSystemPrompt: 'asesor',
            }
          : {}),
    });
  } catch {
    return actualFromQuote(quote, {
      treatments,
      financialBlock: financial.text,
      inventedMoney: false,
      narrativeOk: true,
      unsafeLegacyFallback: false,
      quoteFlowMode: 'BLOCKED',
    });
  }

  const validation = validateFinalClientQuoteMessage({
    canonicalQuote: quote,
    renderedFinancialBlock: composed.financialBlock,
    finalMessage: composed.finalMessage,
    warningsBlock: composed.warningsBlock,
    peritaje,
  });
  const allowedAmounts = new Set<number>([
    quote.total,
    ...quote.lines
      .filter((l) => isChargeableQuoteLine(l))
      .map((l) => Math.round(l.amount)),
  ]);
  const remainder = composed.finalMessage.replace(composed.financialBlock, '');
  const extraMoney = extractMonetaryAmounts(remainder).some(
    (hit) => hit.amount != null && !allowedAmounts.has(Math.round(hit.amount)),
  );
  void validation.ok;

  return actualFromQuote(quote, {
    treatments,
    finalMessage: composed.finalMessage,
    financialBlock: composed.financialBlock || financial.text,
    inventedMoney: extraMoney,
    narrativeOk: validation.ok && !extraMoney,
    unsafeLegacyFallback: false,
    quoteFlowMode: 'CANONICAL',
  });
}
