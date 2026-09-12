/**
 * Canonical Quote Engine (Fase 5).
 *
 * CanonicalPeritajeV1 + pricing context → CanonicalQuoteV1
 * Reutiliza quoteRowsFromDamageInventory / BPC / montaje / mercado ya resuelto.
 * No reimplementa fórmulas. No usa narrativa.
 */
import { Logger } from '@nestjs/common';
import type { CatalogPricingRules } from '../catalog/catalog-pricing-rules';
import { resolveIntegralPriceForVehicleProfile } from '../catalog/vehicle-integral-pricing';
import type { VehiclePricingProfile } from '../catalog/vehicle-pricing-profile';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import {
  canAttemptCanonicalFinancialFlow,
  compareCanonicalVsLegacyFinance,
  finalizeCanonicalQuote,
  isCanonicalFinancialAuthority,
  validateCanonicalQuoteFinancial,
  type FinancialDifference,
} from '../domain/peritaje-v1/quote-engine';
import {
  createQuoteLineId,
  type CanonicalPeritajeV1,
  type CanonicalQuoteV1,
  type DamageItem,
  type InvariantViolation,
  type QuoteLine,
  type QuoteServiceType,
} from '../domain/peritaje-v1';
import type { DraftQuote, DraftQuoteLine, QuoteSendSnapshot } from './autofix-config';
import {
  FLOW_EVENTS,
  QUOTE_FLOW_MODE,
  logFlowEvent,
  resolveQuoteFlowMode,
} from '../domain/peritaje-v1/quote-flow-mode';
import type { CommercialItemV1 } from '../domain/peritaje-v1';
import {
  buildCanonicalQuoteFromPricedSources,
  mergeCommercialLinesIntoQuote,
} from './canonical-commercial-quote';
import { createVehicleId } from '../domain/peritaje-v1';
import {
  buildDraftQuoteLineFromQuoteRow,
  quoteLineMarketProjection,
  quoteRowsFromDamageInventory,
  type QuoteRowInput,
} from './draft-quote-inventory-pricing';
import type { DetectedDamageItem } from './entities/chat.entity';
import {
  canonicalPhysicalPanelKey,
  deriveStableVehicleId,
  ensureDamageIdentity,
} from './piece-treatment';
import { isBanioPinturaCompletoVisionInventory } from './vision-bpc-inventory';
import {
  lookupBanioCatalogBase,
  normalizeBanioProductCode,
  type BanioProductCode,
} from '../catalog/banio-service-identity';

const logger = new Logger('CanonicalQuoteEngine');

export type ManualPriceOverride = {
  quoteLineId?: string;
  damageItemId?: string;
  serviceType?: string;
  amount: number;
};

export type CanonicalQuoteEngineInput = {
  peritaje: CanonicalPeritajeV1;
  pricedInventory: readonly DetectedDamageItem[];
  snap: MatrixPricingSnapshot;
  vehicleProfile?: VehiclePricingProfile | null;
  pricingRules?: CatalogPricingRules | null;
  quoteId?: string;
  generatedAt?: string;
  manualOverrides?: readonly ManualPriceOverride[];
  frozenByQuoteLineId?: ReadonlyMap<string, number>;
};

export type CanonicalQuoteEngineOk = {
  ok: true;
  quote: CanonicalQuoteV1;
  rows: QuoteRowInput[];
};

export type CanonicalQuoteEngineErr = {
  ok: false;
  violations: InvariantViolation[];
};

export type CanonicalQuoteEngineResult =
  | CanonicalQuoteEngineOk
  | CanonicalQuoteEngineErr;

function damageToPricedItem(
  damage: DamageItem,
  priced: DetectedDamageItem | undefined,
): DetectedDamageItem {
  const base: DetectedDamageItem = {
    pieza: priced?.pieza || damage.pieceCode,
    severidad: priced?.severidad || damage.severity,
    descripcionTecnica: damage.descriptionTechnical,
    urls_origen:
      damage.evidence.map((e) => e.url).filter(Boolean).length > 0
        ? damage.evidence.map((e) => e.url).filter(Boolean)
        : [...(priced?.urls_origen ?? [])],
    tratamiento: damage.treatment,
    treatmentSource: damage.treatmentSource,
    treatmentReason: damage.treatmentReason,
    vehicleId: damage.vehicleId,
    damageItemId: damage.damageItemId,
    ...(damage.possibleReplacement ? { posibleReemplazoRefaccion: true } : {}),
    ...(damage.possibleHiddenDamage
      ? { possibleHiddenDamage: damage.possibleHiddenDamage }
      : {}),
  };
  if (!priced) return ensureDamageIdentity(base);
  return ensureDamageIdentity({
    ...priced,
    ...base,
    precioMx: priced.precioMx,
    detallesRefaccion: priced.detallesRefaccion,
    priceSource: priced.priceSource,
    pricingStatus: priced.pricingStatus,
    pricingType: priced.pricingType,
    precioMinEstimado: priced.precioMinEstimado,
    precioMaxEstimado: priced.precioMaxEstimado,
    precioCentral: priced.precioCentral,
    cantidadMuestras: priced.cantidadMuestras,
    cantidadDominios: priced.cantidadDominios,
  });
}

function mergeInventoryForEngine(
  peritaje: CanonicalPeritajeV1,
  pricedInventory: readonly DetectedDamageItem[],
): DetectedDamageItem[] {
  const identified = pricedInventory.map((raw) => ensureDamageIdentity(raw));
  const byId = new Map<string, DetectedDamageItem>();
  for (const it of identified) {
    if (it.damageItemId) byId.set(it.damageItemId, it);
  }
  return peritaje.damages.map((d) => {
    const byIdentity = byId.get(d.damageItemId);
    const panelMatches = identified.filter(
      (it) => canonicalPhysicalPanelKey(it.pieza) === d.physicalPanelKey,
    );
    const byVehicle = panelMatches.find(
      (it) => deriveStableVehicleId(it) === d.vehicleId,
    );
    return damageToPricedItem(d, byIdentity ?? byVehicle ?? panelMatches[0]);
  });
}

function buildBpcQuoteRows(
  inventory: readonly DetectedDamageItem[],
  snap: MatrixPricingSnapshot,
  vehicleProfile?: VehiclePricingProfile | null,
  pricingRules?: CatalogPricingRules | null,
): QuoteRowInput[] {
  const bpc = ensureDamageIdentity(inventory[0]!);
  const code: BanioProductCode =
    normalizeBanioProductCode(bpc.pieza) ?? 'BPE';
  const lookup = lookupBanioCatalogBase(snap, code);
  const integral =
    lookup.status === 'READY'
      ? resolveIntegralPriceForVehicleProfile(
          snap,
          lookup.catalogName,
          vehicleProfile,
          pricingRules,
        )
      : null;
  const unit = integral && integral.unitPrice > 0 ? integral.unitPrice : 0;
  const unconfigured = lookup.status === 'UNCONFIGURED' || unit <= 0;
  const serviceType: QuoteServiceType = 'REPARACION_PINTURA';
  return [
    {
      pieza: bpc.pieza,
      severidad: String(vehicleProfile?.sizeTier ?? bpc.severidad ?? 'Mediano'),
      precioMx: Math.max(0, Math.round(unit)),
      tratamiento: 'REPARAR',
      serviceType,
      physicalPanelKey: bpc.pieza,
      billable: unit > 0 && !unconfigured,
      priceSource: unconfigured ? 'UNCONFIGURED' : 'AUTOFIX_CATALOG',
      ...(unconfigured
        ? { pricingStatus: 'INSUFFICIENT_MARKET_SAMPLE' as const }
        : {}),
      damageItemId: bpc.damageItemId,
      vehicleId: bpc.vehicleId,
      quoteLineId: bpc.damageItemId
        ? createQuoteLineId({
            damageItemId: bpc.damageItemId,
            serviceType,
          })
        : undefined,
      description: `${lookup.catalogName} (${code})`,
      descripcionServicio: `${lookup.catalogName} (${code})`,
    },
  ];
}

function applyOverridesAndFreezes(
  rows: QuoteRowInput[],
  manual?: readonly ManualPriceOverride[],
  frozen?: ReadonlyMap<string, number>,
): QuoteRowInput[] {
  return rows.map((row) => {
    const qid = String(row.quoteLineId ?? '').trim();
    if (qid && frozen?.has(qid)) {
      const amount = Math.max(0, Math.round(frozen.get(qid) ?? 0));
      return {
        ...row,
        precioMx: amount,
        billable: row.serviceType === 'PENDIENTE' || row.serviceType === 'ADVERTENCIA'
          ? false
          : amount > 0 && row.pricingStatus !== 'INSUFFICIENT_MARKET_SAMPLE',
      };
    }
    const manualHit = (manual ?? []).find((m) => {
      if (m.quoteLineId && qid && m.quoteLineId === qid) return true;
      if (
        m.damageItemId &&
        m.serviceType &&
        m.damageItemId === row.damageItemId &&
        m.serviceType === row.serviceType
      ) {
        return true;
      }
      return false;
    });
    if (!manualHit) return row;
    const amount = Math.max(0, Math.round(Number(manualHit.amount) || 0));
    return {
      ...row,
      precioMx: amount,
      billable:
        row.serviceType === 'PENDIENTE' || row.serviceType === 'ADVERTENCIA'
          ? false
          : amount > 0,
      priceSource: 'MANUAL',
      pricingStatus: 'OK',
    };
  });
}

function rowToQuoteLine(row: QuoteRowInput): QuoteLine {
  const amount = Math.max(0, Math.round(Number(row.precioMx) || 0));
  const serviceType = (row.serviceType ||
    'REPARACION_PINTURA') as QuoteServiceType;
  const insufficient =
    row.pricingStatus === 'INSUFFICIENT_MARKET_SAMPLE' ||
    row.priceSource === 'INSUFFICIENT_MARKET_SAMPLE';
  const nonChargeableType =
    serviceType === 'PENDIENTE' || serviceType === 'ADVERTENCIA';
  const billable =
    row.billable === true && amount > 0 && !insufficient && !nonChargeableType;
  return {
    quoteLineId:
      String(row.quoteLineId ?? '').trim() ||
      createQuoteLineId({
        damageItemId: String(row.damageItemId ?? 'dmg_unknown'),
        serviceType,
      }),
    damageItemId: String(row.damageItemId ?? '').trim() || 'dmg_unknown',
    vehicleId: String(row.vehicleId ?? '').trim() || 'veh_unknown',
    serviceType,
    description: String(row.description ?? row.descripcionServicio ?? '').trim(),
    billable,
    amount,
    confidence: 'MEDIUM',
    ...(row.priceSource
      ? { pricingSource: row.priceSource as QuoteLine['pricingSource'] }
      : {}),
    ...(row.pricingStatus
      ? { pricingStatus: row.pricingStatus as QuoteLine['pricingStatus'] }
      : {}),
    ...(row.pricingType
      ? { pricingType: row.pricingType as QuoteLine['pricingType'] }
      : {}),
    ...quoteLineMarketProjection(row),
  };
}

/** Única función que construye la verdad financiera moderna. */
export function buildCanonicalQuoteV1(
  input: CanonicalQuoteEngineInput,
): CanonicalQuoteEngineResult {
  if (!canAttemptCanonicalFinancialFlow(input.peritaje)) {
    return {
      ok: false,
      violations: [
        {
          code: 'peritaje_not_ready',
          message: 'CanonicalPeritajeV1 inválido; no se intenta autoridad financiera',
        },
      ],
    };
  }

  const inventory = mergeInventoryForEngine(
    input.peritaje,
    input.pricedInventory,
  );
  const rows = applyOverridesAndFreezes(
    isBanioPinturaCompletoVisionInventory(inventory)
      ? buildBpcQuoteRows(
          inventory,
          input.snap,
          input.vehicleProfile,
          input.pricingRules,
        )
      : quoteRowsFromDamageInventory(
          inventory,
          input.snap,
          input.vehicleProfile,
          input.pricingRules,
        ),
    input.manualOverrides,
    input.frozenByQuoteLineId,
  );

  if (input.peritaje.damages.length > 0 && rows.length === 0) {
    return {
      ok: false,
      violations: [
        {
          code: 'empty_quote_for_damages',
          message: 'El peritaje tiene daños pero no se emitió ninguna QuoteLine',
        },
      ],
    };
  }

  const quote = finalizeCanonicalQuote({
    lines: rows.map(rowToQuoteLine),
    peritajeId: input.peritaje.peritajeId,
    quoteId: input.quoteId,
    generatedAt: input.generatedAt,
    peritaje: input.peritaje,
  });

  const violations = validateCanonicalQuoteFinancial(quote, input.peritaje);
  if (violations.length) {
    return { ok: false, violations };
  }
  return { ok: true, quote, rows };
}

/** Proyección: no recalcula dinero. */
export function projectCanonicalQuoteToDraftLines(
  quote: CanonicalQuoteV1,
  snap: MatrixPricingSnapshot,
  rows?: readonly QuoteRowInput[],
): DraftQuoteLine[] {
  return quote.lines.map((line, idx) => {
    const row = rows?.find((r) => r.quoteLineId === line.quoteLineId) ?? {
      pieza: line.serviceType === 'REFACCION' ? `REFACCION:${line.damageItemId}` : line.damageItemId,
      severidad: 'N/A',
      precioMx: line.amount,
      serviceType: line.serviceType,
      damageItemId: line.damageItemId,
      quoteLineId: line.quoteLineId,
      vehicleId: line.vehicleId,
      billable: line.billable,
      description: line.description,
      priceSource: line.pricingSource,
      pricingStatus: line.pricingStatus,
      pricingType: line.pricingType,
    };
    const drafted = buildDraftQuoteLineFromQuoteRow(
      { ...row, precioMx: line.amount, billable: line.billable },
      idx,
      snap,
    );
    return {
      ...drafted,
      unitPrice: line.amount,
      subtotal: line.amount,
      billable: line.billable,
      serviceType: line.serviceType,
      damageItemId: line.damageItemId,
      quoteLineId: line.quoteLineId,
      vehicleId: line.vehicleId,
      priceSource: line.pricingSource,
      pricingStatus: line.pricingStatus,
      description: line.description || drafted.description,
    };
  });
}

export function projectCanonicalQuoteOntoDraft(
  prior: DraftQuote,
  quote: CanonicalQuoteV1,
  snap: MatrixPricingSnapshot,
  rows?: readonly QuoteRowInput[],
): DraftQuote {
  return {
    ...prior,
    lines: projectCanonicalQuoteToDraftLines(quote, snap, rows),
    subtotal: quote.total,
    total: quote.total,
    pricingIncomplete: quote.isPartial,
    generatedAt: prior.generatedAt || quote.generatedAt,
  };
}

export function frozenAmountsFromSnapshot(
  snapshot?: QuoteSendSnapshot | null,
): Map<string, number> | undefined {
  const amounts = snapshot?.canonicalFreeze?.amounts;
  if (!amounts?.length) return undefined;
  return new Map(
    amounts.map((a) => [a.quoteLineId, Math.max(0, Math.round(a.amount))]),
  );
}

export function buildCanonicalFreeze(quote: CanonicalQuoteV1): NonNullable<
  QuoteSendSnapshot['canonicalFreeze']
> {
  return {
    schemaVersion: quote.schemaVersion,
    quoteId: quote.quoteId,
    quoteLineIds: quote.lines.map((l) => l.quoteLineId),
    amounts: quote.lines.map((l) => ({
      quoteLineId: l.quoteLineId,
      amount: l.amount,
      serviceType: l.serviceType,
      damageItemId: l.damageItemId,
    })),
    subtotal: quote.subtotal,
    total: quote.total,
    isPartial: quote.isPartial,
    warnings: [...quote.warnings],
    generatedAt: quote.generatedAt,
  };
}

export function logFinancialDifferences(
  diffs: FinancialDifference[],
  ctx: { conversationId?: string; peritajeId?: string },
): void {
  if (!diffs.length) return;
  logger.log(
    JSON.stringify({
      compare: 'canonical_vs_legacy_finance',
      conversationId: ctx.conversationId,
      peritajeId: ctx.peritajeId,
      differenceCount: diffs.length,
      differences: diffs.map((d) => ({
        type: d.type,
        quoteLineId: d.quoteLineId,
        serviceType: d.serviceType,
        canonical: d.canonical,
        legacy: d.legacy,
      })),
    }),
  );
}

export function logLegacyTotalFallback(ctx: {
  conversationId?: string;
  reason: string;
}): void {
  logger.warn(
    JSON.stringify({
      divergence: 'LEGACY_TOTAL_FALLBACK_USED',
      conversationId: ctx.conversationId,
      reason: ctx.reason,
    }),
  );
}

export function logCanonicalBuildFailed(ctx: {
  conversationId?: string;
  codes: string[];
}): void {
  logger.warn(
    JSON.stringify({
      divergence: 'CANONICAL_QUOTE_BUILD_FAILED',
      conversationId: ctx.conversationId,
      violationCodes: ctx.codes,
    }),
  );
}

export type AuthoritativeFinance =
  | {
      mode: 'canonical';
      quote: CanonicalQuoteV1;
      draft: DraftQuote;
      estimateAmount: number;
      rows: QuoteRowInput[];
    }
  | {
      mode: 'canonical_blocked';
      draft: DraftQuote;
      estimateAmount: number;
    }
  | {
      mode: 'legacy';
      draft: DraftQuote;
      estimateAmount: number;
    };

export function resolveAuthoritativeDraftFinance(input: {
  peritaje?: CanonicalPeritajeV1 | null;
  pricedInventory: readonly DetectedDamageItem[];
  snap: MatrixPricingSnapshot;
  vehicleProfile?: VehiclePricingProfile | null;
  pricingRules?: CatalogPricingRules | null;
  priorDraft: DraftQuote;
  legacyDraft: DraftQuote;
  legacyEstimate: number;
  conversationId?: string;
  quoteId?: string;
  manualOverrides?: readonly ManualPriceOverride[];
  sentSnapshot?: QuoteSendSnapshot | null;
  commercialEntries?: readonly CommercialItemV1[] | null;
  commercialExtraLines?: readonly QuoteLine[] | null;
  pricedRows?: readonly QuoteRowInput[];
  fromExpress?: boolean;
  preferCanonical?: boolean;
  existingQuote?: CanonicalQuoteV1 | null;
}): AuthoritativeFinance {
  const flow = resolveQuoteFlowMode({
    lockedMode: input.priorDraft.quoteFlowMode,
    canonicalQuote: input.existingQuote ?? null,
    canonicalPeritaje: input.peritaje,
    commercialEntries: input.commercialEntries,
    fromExpress: input.fromExpress,
    preferCanonical: input.preferCanonical,
  });

  const stampDraft = (draft: DraftQuote, quote?: CanonicalQuoteV1): DraftQuote => ({
    ...draft,
    quoteFlowMode: flow.mode,
    ...(input.commercialEntries?.length
      ? { commercialEntries: [...input.commercialEntries] }
      : {}),
    ...(quote
      ? { subtotal: quote.total, total: quote.total, pricingIncomplete: quote.isPartial }
      : {}),
  });

  if (flow.mode === QUOTE_FLOW_MODE.LEGACY) {
    logLegacyTotalFallback({
      conversationId: input.conversationId,
      reason: flow.reason,
    });
    return {
      mode: 'legacy',
      draft: stampDraft(input.legacyDraft),
      estimateAmount: input.legacyEstimate,
    };
  }

  const extraLines = [...(input.commercialExtraLines ?? [])];
  const vehicleId =
    input.vehicleProfile?.vehicleLabel
      ? createVehicleId({ displayLabel: input.vehicleProfile.vehicleLabel })
      : 'veh_unknown';

  const finishCanonical = (
    quote: CanonicalQuoteV1,
    rows: QuoteRowInput[],
  ): AuthoritativeFinance => {
    const merged = extraLines.length
      ? mergeCommercialLinesIntoQuote(quote, extraLines)
      : quote;
    const draft = stampDraft(
      projectCanonicalQuoteOntoDraft(
        input.legacyDraft,
        merged,
        input.snap,
        rows,
      ),
      merged,
    );
    return {
      mode: 'canonical',
      quote: merged,
      rows,
      draft,
      estimateAmount: merged.total,
    };
  };

  if (canAttemptCanonicalFinancialFlow(input.peritaje)) {
    const built = buildCanonicalQuoteV1({
      peritaje: input.peritaje,
      pricedInventory: input.pricedInventory,
      snap: input.snap,
      vehicleProfile: input.vehicleProfile,
      pricingRules: input.pricingRules,
      quoteId: input.quoteId,
      generatedAt: input.legacyDraft.generatedAt,
      manualOverrides: input.manualOverrides,
      frozenByQuoteLineId: frozenAmountsFromSnapshot(input.sentSnapshot),
    });

    if (!built.ok) {
      if (input.existingQuote && flow.mode === QUOTE_FLOW_MODE.CANONICAL) {
        logFlowEvent(FLOW_EVENTS.MODERN_FLOW_LEGACY_DOWNGRADE, {
          conversationId: input.conversationId,
          blocked: true,
          reason: 'build_failed_keep_prior',
        });
        return finishCanonical(input.existingQuote, [
          ...(input.pricedRows ?? []),
        ]);
      }
      logCanonicalBuildFailed({
        conversationId: input.conversationId,
        codes: built.violations.map((v) => v.code),
      });
      return {
        mode: 'canonical_blocked',
        draft: stampDraft({
          ...input.priorDraft,
          pricingIncomplete: true,
        }),
        estimateAmount: Math.max(
          0,
          Math.round(Number(input.priorDraft.total) || 0),
        ),
      };
    }

    const diffs = compareCanonicalVsLegacyFinance({
      canonical: built.quote,
      legacy: {
        total: input.legacyEstimate,
        subtotal: input.legacyDraft.subtotal,
        isPartial: input.legacyDraft.pricingIncomplete,
        lines: input.legacyDraft.lines.map((l) => ({
          quoteLineId: l.quoteLineId,
          serviceType: l.serviceType,
          billable: l.billable,
          amount: l.subtotal,
        })),
      },
    });
    logFinancialDifferences(diffs, {
      conversationId: input.conversationId,
      peritajeId: input.peritaje.peritajeId,
    });
    return finishCanonical(built.quote, built.rows);
  }

  if ((input.pricedRows?.length ?? 0) > 0 || extraLines.length > 0) {
    const quote = buildCanonicalQuoteFromPricedSources({
      conversationId: input.conversationId,
      quoteId: input.quoteId,
      vehicleId,
      rows: input.pricedRows ?? [],
      extraLines,
      peritajeId: input.existingQuote?.peritajeId,
    });
    return finishCanonical(quote, [...(input.pricedRows ?? [])]);
  }

  if (input.existingQuote) {
    logFlowEvent(FLOW_EVENTS.MODERN_FLOW_LEGACY_DOWNGRADE, {
      conversationId: input.conversationId,
      blocked: true,
      reason: 'keep_existing_canonical_quote',
    });
    return finishCanonical(input.existingQuote, []);
  }

  logFlowEvent(FLOW_EVENTS.CANONICAL_MODE_AMBIGUOUS, {
    conversationId: input.conversationId,
    reason: flow.reason,
  });
  return {
    mode: 'canonical_blocked',
    draft: stampDraft({
      ...input.priorDraft,
      pricingIncomplete: true,
    }),
    estimateAmount: Math.max(0, Math.round(Number(input.priorDraft.total) || 0)),
  };
}

export { canAttemptCanonicalFinancialFlow, isCanonicalFinancialAuthority };
export { compareCanonicalVsLegacyFinance };
