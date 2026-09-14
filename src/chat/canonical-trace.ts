/**
 * Trazas de diagnóstico canónico (smoke live).
 * Observabilidad únicamente: no cambia treatment, pricing ni persistencia.
 */
import type {
  CanonicalPeritajeV1,
  CanonicalQuoteV1,
  DamageItem,
  QuoteLine,
  VehicleIdentity,
} from '../domain/peritaje-v1';
import { getLlmAuditContext } from './llm-audit-context';
import type { DetectedDamageItem } from './entities/chat.entity';
import type { QuoteFlowDecision } from '../domain/peritaje-v1/quote-flow-mode';
import {
  getPegazuzContext,
  hasPegazuzContext,
  mergePegazuzContext,
  patchTurnSummary,
  runWithPegazuzContext,
  type PegazuzContext,
} from '../observability/pegazuz-context';
import {
  isDebugDetailEnabled,
  shouldEmitLegacyTraceJson,
} from '../observability/pegazuz-log-level';
import { pegLogger } from '../observability/pegazuz-logger';
import { sanitizeTracePayload } from '../observability/sanitize-log';

export {
  redactEvidenceRefForTrace,
  sanitizeTracePayload,
} from '../observability/sanitize-log';

type ClientMessageTraceInput = {
  flow: string;
  fallbackUsed: boolean;
  shownWarnings: readonly string[];
};

export const PEG_CANONICAL_TRACE_PREFIX = '[PEG_CANONICAL_TRACE]';
export const PEG_CANONICAL_TRACE_ENV = 'PEG_CANONICAL_TRACE';

export const CANONICAL_TRACE_EVENTS = {
  VISION_INPUT: 'VISION_INPUT',
  VISION_EVIDENCE_RAW: 'VISION_EVIDENCE_RAW',
  EVIDENCE_RECOVERED_SINGLE_INPUT: 'EVIDENCE_RECOVERED_SINGLE_INPUT',
  EVIDENCE_MISSING_FROM_VISION: 'EVIDENCE_MISSING_FROM_VISION',
  VEHICLE_IDENTITY: 'VEHICLE_IDENTITY',
  DAMAGE_ITEM: 'DAMAGE_ITEM',
  DAMAGE_MERGE: 'DAMAGE_MERGE',
  TREATMENT_RESOLUTION: 'TREATMENT_RESOLUTION',
  CANONICAL_PERITAJE: 'CANONICAL_PERITAJE',
  REFACCION_MARKET: 'REFACCION_MARKET',
  REFACCION_MARKET_SEARCH_STARTED: 'REFACCION_MARKET_SEARCH_STARTED',
  REFACCION_MARKET_ESTIMATE_READY: 'REFACCION_MARKET_ESTIMATE_READY',
  REFACCION_MARKET_INSUFFICIENT: 'REFACCION_MARKET_INSUFFICIENT',
  REFACCION_MARKET_COMPATIBILITY_REJECTED:
    'REFACCION_MARKET_COMPATIBILITY_REJECTED',
  REFACCION_MARKET_AUDIT: 'REFACCION_MARKET_AUDIT',
  MARKET_LOOKUP_EXECUTED: 'MARKET_LOOKUP_EXECUTED',
  MARKET_CACHE_REUSED: 'MARKET_CACHE_REUSED',
  REFACCION_SEARCH_STARTED: 'REFACCION_SEARCH_STARTED',
  REFACCION_QUERIES_GENERATED: 'REFACCION_QUERIES_GENERATED',
  REFACCION_CACHE_DECISION: 'REFACCION_CACHE_DECISION',
  REFACCION_PROVIDER_REQUEST: 'REFACCION_PROVIDER_REQUEST',
  REFACCION_PROVIDER_RESPONSE: 'REFACCION_PROVIDER_RESPONSE',
  REFACCION_RAW_SAMPLE: 'REFACCION_RAW_SAMPLE',
  REFACCION_SAMPLE_EVALUATED: 'REFACCION_SAMPLE_EVALUATED',
  REFACCION_SEARCH_FUNNEL: 'REFACCION_SEARCH_FUNNEL',
  REFACCION_PART_TYPE_SELECTION: 'REFACCION_PART_TYPE_SELECTION',
  REFACCION_ACCEPTED_SAMPLE: 'REFACCION_ACCEPTED_SAMPLE',
  REFACCION_PRICING_DECISION: 'REFACCION_PRICING_DECISION',
  REFACCION_SEARCH_FINISHED: 'REFACCION_SEARCH_FINISHED',
  PART_DISCOVERY_STARTED: 'PART_DISCOVERY_STARTED',
  PART_NUMBER_DISCOVERED: 'PART_NUMBER_DISCOVERED',
  SHOPPING_LOOKUP_STARTED: 'SHOPPING_LOOKUP_STARTED',
  SHOPPING_LOOKUP_RESULT: 'SHOPPING_LOOKUP_RESULT',
  PART_NUMBER_PIVOT_STARTED: 'PART_NUMBER_PIVOT_STARTED',
  PART_NUMBER_PIVOT_RESULT: 'PART_NUMBER_PIVOT_RESULT',
  VARIANT_CLUSTER_CREATED: 'VARIANT_CLUSTER_CREATED',
  CROSS_QUERY_DEDUPE: 'CROSS_QUERY_DEDUPE',
  MARKET_SAMPLE_SELECTED: 'MARKET_SAMPLE_SELECTED',
  REPLACEMENT_INSTALLATION_RESOLUTION: 'REPLACEMENT_INSTALLATION_RESOLUTION',
  QUOTE_LINE: 'QUOTE_LINE',
  CANONICAL_QUOTE: 'CANONICAL_QUOTE',
  QUOTE_FLOW_MODE: 'QUOTE_FLOW_MODE',
  FINAL_CLIENT_MESSAGE_SUMMARY: 'FINAL_CLIENT_MESSAGE_SUMMARY',
  CLIENT_MESSAGE_MODE_RESOLVED: 'CLIENT_MESSAGE_MODE_RESOLVED',
  QUOTE_DELTA_COMPUTED: 'QUOTE_DELTA_COMPUTED',
  CLIENT_MESSAGE_RENDERED: 'CLIENT_MESSAGE_RENDERED',
  CLIENT_MESSAGE_POST_FILTER_INTERVENTION:
    'CLIENT_MESSAGE_POST_FILTER_INTERVENTION',
  VEHICLE_IDENTITY_CORRECTED: 'VEHICLE_IDENTITY_CORRECTED',
  MARKET_INVALIDATED_BY_VEHICLE_CORRECTION:
    'MARKET_INVALIDATED_BY_VEHICLE_CORRECTION',
  CANONICAL_IDENTITY_STAMPED: 'CANONICAL_IDENTITY_STAMPED',
  CANONICAL_IDENTITY_PROJECTION_MISMATCH:
    'CANONICAL_IDENTITY_PROJECTION_MISMATCH',
  PRICING_ELIGIBILITY: 'PRICING_ELIGIBILITY',
  PERSIST_DAMAGE_RESOLUTION: 'PERSIST_DAMAGE_RESOLUTION',
  MISSING_CANONICAL_DAMAGE_ID: 'MISSING_CANONICAL_DAMAGE_ID',
  PENDING_REQUIREMENT_CREATED: 'PENDING_REQUIREMENT_CREATED',
  VEHICLE_IDENTITY_CONFIRMED: 'VEHICLE_IDENTITY_CONFIRMED',
  PENDING_REQUIREMENT_RESOLVED: 'PENDING_REQUIREMENT_RESOLVED',
  QUOTE_RESUME_STARTED: 'QUOTE_RESUME_STARTED',
  REFACCION_REPRICE_STARTED: 'REFACCION_REPRICE_STARTED',
  REFACCION_REPRICE_RESULT: 'REFACCION_REPRICE_RESULT',
  CANONICAL_QUOTE_RESUMED: 'CANONICAL_QUOTE_RESUMED',
  VISION_BATCH_VEHICLE_IDENTITY: 'VISION_BATCH_VEHICLE_IDENTITY',
  CANONICAL_VEHICLE_REUSE: 'CANONICAL_VEHICLE_REUSE',
  VEHICLE_IDENTITY_CONFIRMATION_REQUIRED:
    'VEHICLE_IDENTITY_CONFIRMATION_REQUIRED',
  SINGLE_VEHICLE_IDENTITY_MISMATCH: 'SINGLE_VEHICLE_IDENTITY_MISMATCH',
} as const;

export type CanonicalTraceEvent =
  (typeof CANONICAL_TRACE_EVENTS)[keyof typeof CANONICAL_TRACE_EVENTS];

export type CanonicalTraceContext = PegazuzContext;

const MARKET_OWNED_EVENTS = new Set<string>([
  CANONICAL_TRACE_EVENTS.REFACCION_MARKET,
  CANONICAL_TRACE_EVENTS.REFACCION_MARKET_SEARCH_STARTED,
  CANONICAL_TRACE_EVENTS.REFACCION_MARKET_ESTIMATE_READY,
  CANONICAL_TRACE_EVENTS.REFACCION_MARKET_INSUFFICIENT,
  CANONICAL_TRACE_EVENTS.REFACCION_MARKET_COMPATIBILITY_REJECTED,
  CANONICAL_TRACE_EVENTS.REFACCION_MARKET_AUDIT,
  CANONICAL_TRACE_EVENTS.MARKET_LOOKUP_EXECUTED,
  CANONICAL_TRACE_EVENTS.MARKET_CACHE_REUSED,
  CANONICAL_TRACE_EVENTS.REFACCION_SEARCH_STARTED,
  CANONICAL_TRACE_EVENTS.REFACCION_QUERIES_GENERATED,
  CANONICAL_TRACE_EVENTS.REFACCION_CACHE_DECISION,
  CANONICAL_TRACE_EVENTS.REFACCION_PROVIDER_REQUEST,
  CANONICAL_TRACE_EVENTS.REFACCION_PROVIDER_RESPONSE,
  CANONICAL_TRACE_EVENTS.REFACCION_RAW_SAMPLE,
  CANONICAL_TRACE_EVENTS.REFACCION_SAMPLE_EVALUATED,
  CANONICAL_TRACE_EVENTS.REFACCION_SEARCH_FUNNEL,
  CANONICAL_TRACE_EVENTS.REFACCION_PART_TYPE_SELECTION,
  CANONICAL_TRACE_EVENTS.REFACCION_ACCEPTED_SAMPLE,
  CANONICAL_TRACE_EVENTS.REFACCION_PRICING_DECISION,
  CANONICAL_TRACE_EVENTS.REFACCION_SEARCH_FINISHED,
  CANONICAL_TRACE_EVENTS.PART_DISCOVERY_STARTED,
  CANONICAL_TRACE_EVENTS.PART_NUMBER_DISCOVERED,
  CANONICAL_TRACE_EVENTS.SHOPPING_LOOKUP_STARTED,
  CANONICAL_TRACE_EVENTS.SHOPPING_LOOKUP_RESULT,
  CANONICAL_TRACE_EVENTS.PART_NUMBER_PIVOT_STARTED,
  CANONICAL_TRACE_EVENTS.PART_NUMBER_PIVOT_RESULT,
  CANONICAL_TRACE_EVENTS.VARIANT_CLUSTER_CREATED,
  CANONICAL_TRACE_EVENTS.CROSS_QUERY_DEDUPE,
  CANONICAL_TRACE_EVENTS.MARKET_SAMPLE_SELECTED,
]);

export function isPegCanonicalTraceEnabled(): boolean {
  const raw = String(process.env[PEG_CANONICAL_TRACE_ENV] ?? '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

function withAuditIds(patch: CanonicalTraceContext): CanonicalTraceContext {
  const audit = getLlmAuditContext();
  return {
    ...patch,
    conversationId:
      patch.conversationId ??
      (audit?.conversationId ? String(audit.conversationId) : undefined),
    caseId: patch.caseId ?? (audit?.caseId ? String(audit.caseId) : undefined),
  };
}

export function getCanonicalTraceContext(): CanonicalTraceContext | undefined {
  return getPegazuzContext();
}

export function hasCanonicalTraceContext(): boolean {
  return hasPegazuzContext();
}

export function runWithCanonicalTraceContext<T>(
  ctx: CanonicalTraceContext,
  fn: () => T,
): T {
  return runWithPegazuzContext(withAuditIds(ctx), fn);
}

export function mergeCanonicalTraceContext(
  patch: CanonicalTraceContext,
): void {
  mergePegazuzContext(withAuditIds(patch));
}

function correlationFrom(
  extra?: CanonicalTraceContext,
): CanonicalTraceContext {
  const store = getPegazuzContext();
  const audit = getLlmAuditContext();
  return {
    conversationId:
      extra?.conversationId ??
      store?.conversationId ??
      (audit?.conversationId ? String(audit.conversationId) : undefined),
    turnId: extra?.turnId ?? store?.turnId,
    quoteId: extra?.quoteId ?? store?.quoteId ?? store?.draftQuoteId,
    draftQuoteId: extra?.draftQuoteId ?? store?.draftQuoteId,
    peritajeId: extra?.peritajeId ?? store?.peritajeId,
    visionRunId: extra?.visionRunId ?? store?.visionRunId,
    searchRunId: extra?.searchRunId ?? store?.searchRunId,
    caseId:
      extra?.caseId ??
      store?.caseId ??
      (audit?.caseId ? String(audit.caseId) : undefined),
    vehicleId: extra?.vehicleId ?? store?.vehicleId,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function vehicleLabelOf(payload: Record<string, unknown>): string | undefined {
  const display = String(payload.displayLabel ?? '').trim();
  if (display) return display;
  const make = String(payload.make ?? '').trim();
  const model = String(payload.model ?? '').trim();
  const year = String(payload.year ?? '').trim();
  const label = [make, model, year].filter(Boolean).join(' ');
  return label || undefined;
}

function emitCanonicalCompact(
  event: string,
  payload: Record<string, unknown>,
): void {
  if (event === CANONICAL_TRACE_EVENTS.VISION_INPUT) {
    pegLogger.debug('VISION', {
      phase: 'START',
      input: payload.inputImageCount,
      items: payload.itemCount,
    });
    return;
  }
  if (event === CANONICAL_TRACE_EVENTS.VEHICLE_IDENTITY) {
    const vehicle = vehicleLabelOf(payload);
    const confirmed =
      payload.confirmedByUser === true
        ? true
        : payload.confirmedByUser === false
          ? false
          : undefined;
    pegLogger.info('VEHICLE', { vehicle, confirmed });
    if (vehicle) {
      patchTurnSummary({ vehicle, vehicleConfirmed: confirmed });
    }
    return;
  }
  if (event === CANONICAL_TRACE_EVENTS.VEHICLE_IDENTITY_CORRECTED) {
    const before = asRecord(payload.before);
    const after = asRecord(payload.after);
    const yearBefore = String(before.year ?? '').trim();
    const yearAfter = String(after.year ?? '').trim();
    const vehicle =
      vehicleLabelOf(after) || vehicleLabelOf(before) || undefined;
    pegLogger.info('VEHICLE', {
      vehicle,
      year:
        yearBefore && yearAfter && yearBefore !== yearAfter
          ? `${yearBefore}→${yearAfter}`
          : yearAfter || yearBefore || undefined,
    });
    if (vehicle) patchTurnSummary({ vehicle });
    return;
  }
  if (event === CANONICAL_TRACE_EVENTS.CANONICAL_PERITAJE) {
    if (getCanonicalTraceContext()?.treatmentLogged) return;
    mergeCanonicalTraceContext({ treatmentLogged: true });
    const damages = Array.isArray(payload.damages) ? payload.damages : [];
    const counts = { reparar: 0, sustituir: 0, pendiente: 0, incierto: 0 };
    for (const row of damages) {
      const treatment = String(
        asRecord(row).treatment ?? '',
      ).toUpperCase();
      if (treatment.includes('REPAR')) counts.reparar += 1;
      else if (treatment.includes('SUST')) counts.sustituir += 1;
      else if (treatment.includes('PEND')) counts.pendiente += 1;
      else counts.incierto += 1;
    }
    pegLogger.info('TREATMENT', counts);
    return;
  }
  if (event === CANONICAL_TRACE_EVENTS.CANONICAL_QUOTE) {
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    const billable = lines.filter((row) => asRecord(row).billable === true)
      .length;
    const pending =
      lines.length > 0
        ? lines.length - billable
        : Math.max(0, Number(payload.lineCount ?? 0) - billable);
    const total = asNumber(payload.total) ?? asNumber(payload.subtotal) ?? 0;
    pegLogger.info('QUOTE', {
      q: payload.quoteId,
      total,
      partial: payload.isPartial,
      billable,
      pending,
    });
    patchTurnSummary({
      quoteTotal: total,
      partial:
        typeof payload.isPartial === 'boolean' ? payload.isPartial : undefined,
    });
    mergeCanonicalTraceContext({
      quoteId:
        typeof payload.quoteId === 'string' ? payload.quoteId : undefined,
    });
    return;
  }
  if (event === CANONICAL_TRACE_EVENTS.CLIENT_MESSAGE_RENDERED) {
    const ux = {
      mode: typeof payload.mode === 'string' ? payload.mode : undefined,
      delta: Number(payload.deltaCount ?? (payload.deltaRendered ? 1 : 0)),
      greet: payload.greetingRendered === true,
      technical: payload.technicalExplanationRendered === true,
      warnings: Number(payload.warningsRenderedCount ?? 0),
      cta: typeof payload.ctaType === 'string' ? payload.ctaType : undefined,
    };
    patchTurnSummary({
      mode: ux.mode,
      ux,
    });
    if (getCanonicalTraceContext()?.turnId) {
      pegLogger.debug('UX', ux);
      return;
    }
    pegLogger.info('UX', ux);
  }
}

const CANONICAL_INFO_EVENTS = new Set<string>([
  CANONICAL_TRACE_EVENTS.VISION_INPUT,
  CANONICAL_TRACE_EVENTS.VEHICLE_IDENTITY,
  CANONICAL_TRACE_EVENTS.VEHICLE_IDENTITY_CORRECTED,
  CANONICAL_TRACE_EVENTS.CANONICAL_PERITAJE,
  CANONICAL_TRACE_EVENTS.CANONICAL_QUOTE,
  CANONICAL_TRACE_EVENTS.CLIENT_MESSAGE_RENDERED,
]);

export function pegCanonicalTrace(
  event: string,
  payload: Record<string, unknown> = {},
  extraCtx?: CanonicalTraceContext,
): void {
  if (MARKET_OWNED_EVENTS.has(event)) return;
  if (extraCtx) mergeCanonicalTraceContext(extraCtx);
  if (CANONICAL_INFO_EVENTS.has(event)) {
    emitCanonicalCompact(event, payload);
  } else if (isDebugDetailEnabled()) {
    pegLogger.debug('CANONICAL', { event, ...payload });
  }
  if (!shouldEmitLegacyTraceJson() || !isPegCanonicalTraceEnabled()) return;
  const pieceHint =
    event === CANONICAL_TRACE_EVENTS.DAMAGE_ITEM &&
    typeof payload.pieceCode === 'string' &&
    payload.pieceCode.trim()
      ? ` ${payload.pieceCode.trim()}`
      : '';
  const body = sanitizeTracePayload({
    ...correlationFrom(extraCtx),
    ...payload,
  });
  console.log(
    `${PEG_CANONICAL_TRACE_PREFIX} ${event}${pieceHint} ${JSON.stringify(body)}`,
  );
}

export function summarizeVehicleIdentity(
  vehicle: VehicleIdentity,
): Record<string, unknown> {
  return {
    vehicleId: vehicle.vehicleId,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    version: vehicle.version,
    generation: vehicle.generation,
    displayLabel: vehicle.displayLabel,
    confidence: vehicle.confidence,
    source: vehicle.source,
    confirmedByUser: vehicle.confirmedByUser,
  };
}

export function summarizeDamageItem(damage: DamageItem): Record<string, unknown> {
  return {
    damageItemId: damage.damageItemId,
    vehicleId: damage.vehicleId,
    pieceCode: damage.pieceCode,
    pieceLabel: damage.pieceLabel,
    physicalPanelKey: damage.physicalPanelKey,
    ...(damage.pieceCode === 'MOLDURA' ||
    String(damage.physicalPanelKey ?? '').startsWith('MOLDURA') ||
    damage.pieceCode === 'Moldura'
      ? {
          moldingPosition: damage.moldingPosition ?? 'UNKNOWN',
          finishType: damage.finishType ?? 'UNKNOWN',
        }
      : {}),
    severity: damage.severity,
    treatment: damage.treatment,
    treatmentSource: damage.treatmentSource,
    treatmentReason: damage.treatmentReason,
    possibleReplacement: damage.possibleReplacement,
    damageEvidenceStatus: damage.damageEvidenceStatus ?? null,
    possibleHiddenDamageDetected: damage.possibleHiddenDamage?.detected ?? false,
    evidenceCount: damage.evidence?.length ?? 0,
    evidenceIds: (damage.evidence ?? []).map((ev) => ev.evidenceId),
  };
}

export function summarizeTreatmentResolution(
  damage: DamageItem,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    damageItemId: damage.damageItemId,
    pieceCode: damage.pieceCode,
    incomingTreatment: damage.treatment,
    resolvedTreatment: damage.treatment,
    treatmentSource: damage.treatmentSource,
    treatmentReason: damage.treatmentReason,
    locked: Boolean(damage.treatmentSource),
    possibleReplacement: damage.possibleReplacement,
  };
  if (damage.treatmentReason === 'conflicting_structured_treatments') {
    return {
      ...base,
      resolvedTreatment: damage.treatment,
      reason: damage.treatmentReason,
    };
  }
  return base;
}

export function summarizeCanonicalPeritaje(
  peritaje: CanonicalPeritajeV1,
): Record<string, unknown> {
  return {
    peritajeId: peritaje.peritajeId,
    vehicleCount: peritaje.vehicles.length,
    damageCount: peritaje.damages.length,
    viable: peritaje.viability?.viable ?? true,
    vehicles: peritaje.vehicles.map((v) => ({
      vehicleId: v.vehicleId,
      displayLabel: v.displayLabel,
      source: v.source,
      confirmedByUser: v.confirmedByUser,
    })),
    damages: peritaje.damages.map((d) => ({
      damageItemId: d.damageItemId,
      vehicleId: d.vehicleId,
      pieceCode: d.pieceCode,
      severity: d.severity,
      treatment: d.treatment,
      evidenceCount: d.evidence?.length ?? 0,
    })),
  };
}

export function summarizeQuoteLine(
  line: QuoteLine,
  peritaje?: CanonicalPeritajeV1 | null,
): Record<string, unknown> {
  const damage = peritaje?.damages.find(
    (d) => d.damageItemId === line.damageItemId,
  );
  return {
    quoteLineId: line.quoteLineId,
    damageItemId: line.damageItemId,
    vehicleId: line.vehicleId,
    pieceCode: damage?.pieceCode,
    pieceLabel: damage?.pieceLabel,
    serviceType: line.serviceType,
    billable: line.billable,
    amount: line.amount,
    pricingSource: line.pricingSource,
    pricingStatus: line.pricingStatus,
    priceRange: line.priceRange
      ? {
          min: line.priceRange.min,
          max: line.priceRange.max,
          central: line.priceRange.central,
        }
      : undefined,
  };
}

export function summarizeCanonicalQuote(
  quote: CanonicalQuoteV1,
): Record<string, unknown> {
  return {
    quoteId: quote.quoteId,
    peritajeId: quote.peritajeId,
    lineCount: quote.lines.length,
    subtotal: quote.subtotal,
    total: quote.total,
    isPartial: quote.isPartial,
    warnings: (quote.warnings ?? []).slice(0, 12),
    lines: quote.lines.map((line) => ({
      quoteLineId: line.quoteLineId,
      damageItemId: line.damageItemId,
      serviceType: line.serviceType,
      billable: line.billable,
      amount: line.amount,
      pricingSource: line.pricingSource,
      pricingStatus: line.pricingStatus,
    })),
  };
}

export function traceVisionInput(payload: {
  inputImageCount: number;
  itemCount?: number;
}): void {
  const store = getCanonicalTraceContext();
  if (store?.visionInputLogged) return;
  mergeCanonicalTraceContext({ visionInputLogged: true });
  pegCanonicalTrace(CANONICAL_TRACE_EVENTS.VISION_INPUT, {
    inputImageCount: payload.inputImageCount,
    itemCount: payload.itemCount,
  });
}

export function traceVisionEvidenceRecovery(input: {
  itemsBefore: readonly DetectedDamageItem[];
  itemsAfter: readonly DetectedDamageItem[];
  inputImageCount: number;
  recoveredPieceCodes: readonly string[];
  missingPieceCodes: readonly string[];
}): void {
  if (!isPegCanonicalTraceEnabled()) return;
  traceVisionInput({
    inputImageCount: input.inputImageCount,
    itemCount: input.itemsBefore.length,
  });
  for (const it of input.itemsBefore) {
    pegCanonicalTrace(CANONICAL_TRACE_EVENTS.VISION_EVIDENCE_RAW, {
      pieceCode: it.pieza,
      inputImageCount: input.inputImageCount,
      urlsOrigenCount: Array.isArray(it.urls_origen) ? it.urls_origen.length : 0,
    });
  }
  for (const it of input.itemsAfter) {
    if (!input.recoveredPieceCodes.includes(it.pieza)) continue;
    pegCanonicalTrace(CANONICAL_TRACE_EVENTS.EVIDENCE_RECOVERED_SINGLE_INPUT, {
      pieceCode: it.pieza,
      damageItemId: it.damageItemId,
      evidenceCountAfter: Array.isArray(it.urls_origen)
        ? it.urls_origen.length
        : 0,
    });
  }
  for (const pieceCode of input.missingPieceCodes) {
    pegCanonicalTrace(CANONICAL_TRACE_EVENTS.EVIDENCE_MISSING_FROM_VISION, {
      pieceCode,
      inputImageCount: input.inputImageCount,
    });
  }
}

export function traceCanonicalPeritajeBuilt(
  peritaje: CanonicalPeritajeV1 | null | undefined,
  opts?: { merged?: boolean; priorDamageCount?: number },
): void {
  if (!peritaje) return;
  mergeCanonicalTraceContext({
    peritajeId: peritaje.peritajeId,
    conversationId: peritaje.conversationId,
    vehicleId: peritaje.vehicles[0]?.vehicleId,
  });
  for (const vehicle of peritaje.vehicles) {
    pegCanonicalTrace(
      CANONICAL_TRACE_EVENTS.VEHICLE_IDENTITY,
      summarizeVehicleIdentity(vehicle),
    );
  }
  for (const damage of peritaje.damages) {
    pegCanonicalTrace(
      CANONICAL_TRACE_EVENTS.DAMAGE_ITEM,
      summarizeDamageItem(damage),
    );
    pegCanonicalTrace(
      CANONICAL_TRACE_EVENTS.TREATMENT_RESOLUTION,
      summarizeTreatmentResolution(damage),
    );
  }
  if (opts?.merged) {
    pegCanonicalTrace(CANONICAL_TRACE_EVENTS.DAMAGE_MERGE, {
      priorDamageCount: opts.priorDamageCount,
      damageCount: peritaje.damages.length,
      pieceCodes: peritaje.damages.map((d) => d.pieceCode),
    });
  }
  pegCanonicalTrace(
    CANONICAL_TRACE_EVENTS.CANONICAL_PERITAJE,
    summarizeCanonicalPeritaje(peritaje),
  );
}

export function traceDamageMerge(payload: {
  priorCount: number;
  incomingCount: number;
  mergedCount: number;
  previousPiezas?: readonly string[];
  newPiezas?: readonly string[];
}): void {
  pegCanonicalTrace(CANONICAL_TRACE_EVENTS.DAMAGE_MERGE, {
    priorCount: payload.priorCount,
    incomingCount: payload.incomingCount,
    mergedCount: payload.mergedCount,
    previousPiezas: payload.previousPiezas,
    newPiezas: payload.newPiezas,
  });
}

export function traceQuoteFlowMode(flow: QuoteFlowDecision): void {
  const store = getCanonicalTraceContext();
  if (store?.quoteFlowModeLogged) return;
  mergeCanonicalTraceContext({ quoteFlowModeLogged: true });
  pegCanonicalTrace(CANONICAL_TRACE_EVENTS.QUOTE_FLOW_MODE, {
    mode: flow.mode,
    reason: flow.reason,
  });
}

export function traceCanonicalQuoteBuilt(
  quote: CanonicalQuoteV1 | null | undefined,
  peritaje?: CanonicalPeritajeV1 | null,
): void {
  if (!quote) return;
  mergeCanonicalTraceContext({
    peritajeId: quote.peritajeId,
    quoteId: quote.quoteId,
    vehicleId: quote.lines[0]?.vehicleId,
  });
  if (isDebugDetailEnabled() || isPegCanonicalTraceEnabled()) {
    for (const line of quote.lines) {
      pegCanonicalTrace(
        CANONICAL_TRACE_EVENTS.QUOTE_LINE,
        summarizeQuoteLine(line, peritaje),
      );
    }
  }
  pegCanonicalTrace(
    CANONICAL_TRACE_EVENTS.CANONICAL_QUOTE,
    summarizeCanonicalQuote(quote),
  );
}

function asString(value: unknown): string | undefined {
  const s = String(value ?? '').trim();
  return s || undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Market events are owned by PegazuzLogger / market-search-trace. */
export function traceRefaccionMarketEvent(
  _event: string,
  _payload: Record<string, unknown> = {},
): void {}

export function tracePendingQuoteLifecycle(
  event:
    | typeof CANONICAL_TRACE_EVENTS.PENDING_REQUIREMENT_CREATED
    | typeof CANONICAL_TRACE_EVENTS.VEHICLE_IDENTITY_CONFIRMED
    | typeof CANONICAL_TRACE_EVENTS.PENDING_REQUIREMENT_RESOLVED
    | typeof CANONICAL_TRACE_EVENTS.QUOTE_RESUME_STARTED
    | typeof CANONICAL_TRACE_EVENTS.REFACCION_REPRICE_STARTED
    | typeof CANONICAL_TRACE_EVENTS.REFACCION_REPRICE_RESULT
    | typeof CANONICAL_TRACE_EVENTS.CANONICAL_QUOTE_RESUMED,
  payload: {
    conversationId?: string;
    quoteId?: string;
    vehicleId?: string;
    damageItemId?: string;
    requiredFields?: readonly string[];
    missingFields?: readonly string[];
    confirmationFields?: readonly string[];
    pricingStatus?: string;
  } = {},
): void {
  pegCanonicalTrace(event, {
    conversationId: asString(payload.conversationId),
    quoteId: asString(payload.quoteId),
    vehicleId: asString(payload.vehicleId),
    damageItemId: asString(payload.damageItemId),
    requiredFields: payload.requiredFields
      ? [...payload.requiredFields]
      : undefined,
    missingFields: payload.missingFields
      ? [...payload.missingFields]
      : undefined,
    confirmationFields: payload.confirmationFields
      ? [...payload.confirmationFields]
      : undefined,
    pricingStatus: asString(payload.pricingStatus),
  });
}

export function traceFinalClientMessageSummary(input: {
  composed: ClientMessageTraceInput;
  canonicalQuote: CanonicalQuoteV1;
  financialIntegrityValid: boolean;
}): void {
  pegCanonicalTrace(CANONICAL_TRACE_EVENTS.FINAL_CLIENT_MESSAGE_SUMMARY, {
    narrativeFlow: input.composed.flow,
    canonicalTotal: input.canonicalQuote.total,
    isPartial: input.canonicalQuote.isPartial,
    financialIntegrityValid: input.financialIntegrityValid,
    deterministicFallbackUsed: input.composed.fallbackUsed,
    warningsShownCount: input.composed.shownWarnings.length,
  });
}
