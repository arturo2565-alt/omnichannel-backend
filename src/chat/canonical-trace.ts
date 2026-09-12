/**
 * Trazas de diagnóstico canónico (smoke live).
 * Observabilidad únicamente: no cambia treatment, pricing ni persistencia.
 */
import { AsyncLocalStorage } from 'async_hooks';
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
  QUOTE_LINE: 'QUOTE_LINE',
  CANONICAL_QUOTE: 'CANONICAL_QUOTE',
  QUOTE_FLOW_MODE: 'QUOTE_FLOW_MODE',
  FINAL_CLIENT_MESSAGE_SUMMARY: 'FINAL_CLIENT_MESSAGE_SUMMARY',
  CANONICAL_IDENTITY_STAMPED: 'CANONICAL_IDENTITY_STAMPED',
  PERSIST_DAMAGE_RESOLUTION: 'PERSIST_DAMAGE_RESOLUTION',
  MISSING_CANONICAL_DAMAGE_ID: 'MISSING_CANONICAL_DAMAGE_ID',
} as const;

export type CanonicalTraceEvent =
  (typeof CANONICAL_TRACE_EVENTS)[keyof typeof CANONICAL_TRACE_EVENTS];

export type CanonicalTraceContext = {
  conversationId?: string;
  draftQuoteId?: string;
  peritajeId?: string;
  visionRunId?: string;
  caseId?: string;
  vehicleId?: string;
  quoteFlowModeLogged?: boolean;
  visionInputLogged?: boolean;
};

const als = new AsyncLocalStorage<CanonicalTraceContext>();

const SENSITIVE_KEY =
  /^(phone|telefono|tel|mobile|whatsapp|waid|waId|fullName|nombre|nombreCompleto|customerName|contactName|displayName|jwt|authorization|token|apiKey|apikey|api_key|cookie|password|secret|prompt|systemPrompt|conversationTurns|messages|history|rawHits|samples|pages)$/i;

export function isPegCanonicalTraceEnabled(): boolean {
  const raw = String(process.env[PEG_CANONICAL_TRACE_ENV] ?? '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

export function getCanonicalTraceContext(): CanonicalTraceContext | undefined {
  return als.getStore();
}

export function hasCanonicalTraceContext(): boolean {
  return als.getStore() != null;
}

export function runWithCanonicalTraceContext<T>(
  ctx: CanonicalTraceContext,
  fn: () => T,
): T {
  const parent = als.getStore();
  return als.run(mergeTraceContext(parent, ctx), fn);
}

export function mergeCanonicalTraceContext(
  patch: CanonicalTraceContext,
): void {
  const store = als.getStore();
  if (!store) return;
  Object.assign(store, mergeTraceContext(store, patch));
}

function mergeTraceContext(
  parent: CanonicalTraceContext | undefined,
  next: CanonicalTraceContext,
): CanonicalTraceContext {
  const audit = getLlmAuditContext();
  return {
    ...parent,
    ...compactIds({
      conversationId: next.conversationId ?? parent?.conversationId,
      draftQuoteId: next.draftQuoteId ?? parent?.draftQuoteId,
      peritajeId: next.peritajeId ?? parent?.peritajeId,
      visionRunId: next.visionRunId ?? parent?.visionRunId,
      caseId: next.caseId ?? parent?.caseId ?? audit?.caseId ?? undefined,
      vehicleId: next.vehicleId ?? parent?.vehicleId,
    }),
    quoteFlowModeLogged:
      next.quoteFlowModeLogged ?? parent?.quoteFlowModeLogged,
    visionInputLogged: next.visionInputLogged ?? parent?.visionInputLogged,
  };
}

function compactIds(
  ids: CanonicalTraceContext,
): CanonicalTraceContext {
  const out: CanonicalTraceContext = {};
  for (const key of [
    'conversationId',
    'draftQuoteId',
    'peritajeId',
    'visionRunId',
    'caseId',
    'vehicleId',
  ] as const) {
    const value = String(ids[key] ?? '').trim();
    if (value) out[key] = value;
  }
  return out;
}

function correlationFrom(
  extra?: CanonicalTraceContext,
): CanonicalTraceContext {
  const store = als.getStore();
  const audit = getLlmAuditContext();
  return compactIds({
    conversationId: extra?.conversationId ?? store?.conversationId,
    draftQuoteId: extra?.draftQuoteId ?? store?.draftQuoteId,
    peritajeId: extra?.peritajeId ?? store?.peritajeId,
    visionRunId: extra?.visionRunId ?? store?.visionRunId,
    caseId: extra?.caseId ?? store?.caseId ?? audit?.caseId ?? undefined,
    vehicleId: extra?.vehicleId ?? store?.vehicleId,
  });
}

/** Hostname + último segmento; nunca URL firmada completa. */
export function redactEvidenceRefForTrace(url: string): string {
  const s = String(url ?? '').trim();
  if (!s) return '';
  if (/^data:image\//i.test(s)) return '[data-url]';
  try {
    const u = new URL(s);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    const tail = last.length > 16 ? `…${last.slice(-12)}` : last;
    return tail ? `${u.hostname}/${tail}` : u.hostname;
  } catch {
    return '[redacted-url]';
  }
}

function looksLikeUrl(value: string): boolean {
  return (
    /^https?:\/\//i.test(value) ||
    /^data:image\//i.test(value) ||
    /X-Amz-|Signature=|X-Goog-Signature|token=/i.test(value)
  );
}

function looksLikeJwt(value: string): boolean {
  return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value);
}

function looksLikePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return (
    /^\+?\d[\d\s-]{9,}$/.test(value.trim()) &&
    digits.length >= 10 &&
    digits.length <= 15
  );
}

export function sanitizeTracePayload(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (value == null) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (looksLikeJwt(value) || looksLikePhone(value)) return '[redacted]';
    if (looksLikeUrl(value)) return redactEvidenceRefForTrace(value);
    if (value.length > 240) return `${value.slice(0, 120)}…`;
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => sanitizeTracePayload(item, depth + 1));
  }
  if (typeof value !== 'object') return String(value);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (/url/i.test(key) && typeof child === 'string') {
      out[key] = redactEvidenceRefForTrace(child);
      continue;
    }
    out[key] = sanitizeTracePayload(child, depth + 1);
  }
  return out;
}

export function pegCanonicalTrace(
  event: string,
  payload: Record<string, unknown> = {},
  extraCtx?: CanonicalTraceContext,
): void {
  if (!isPegCanonicalTraceEnabled()) return;
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
    severity: damage.severity,
    treatment: damage.treatment,
    treatmentSource: damage.treatmentSource,
    treatmentReason: damage.treatmentReason,
    possibleReplacement: damage.possibleReplacement,
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
  const store = als.getStore();
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
  if (!peritaje || !isPegCanonicalTraceEnabled()) return;
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
  const store = als.getStore();
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
  if (!quote || !isPegCanonicalTraceEnabled()) return;
  mergeCanonicalTraceContext({
    peritajeId: quote.peritajeId,
    vehicleId: quote.lines[0]?.vehicleId,
  });
  for (const line of quote.lines) {
    pegCanonicalTrace(
      CANONICAL_TRACE_EVENTS.QUOTE_LINE,
      summarizeQuoteLine(line, peritaje),
    );
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

export function traceRefaccionMarketEvent(
  event: string,
  payload: Record<string, unknown> = {},
): void {
  if (!isPegCanonicalTraceEnabled()) return;
  const pieceCode = asString(payload.pieceCode) ?? asString(payload.pieza);
  const vehicle = {
    make: asString(payload.marca) ?? asString((payload.vehicle as { make?: unknown } | undefined)?.make),
    model:
      asString(payload.modelo) ??
      asString((payload.vehicle as { model?: unknown } | undefined)?.model),
    year:
      asString(payload.anio) ??
      asString((payload.vehicle as { year?: unknown } | undefined)?.year),
  };
  if (event === CANONICAL_TRACE_EVENTS.REFACCION_MARKET_SEARCH_STARTED) {
    pegCanonicalTrace(event, {
      damageItemId: asString(payload.damageItemId),
      pieceCode,
      vehicle,
      preferredPartTypes: payload.preferredPartTypes,
    });
    return;
  }
  if (event === CANONICAL_TRACE_EVENTS.REFACCION_MARKET_ESTIMATE_READY) {
    const range =
      payload.priceRange && typeof payload.priceRange === 'object'
        ? payload.priceRange
        : {
            min: asNumber(payload.precioMinEstimado),
            max: asNumber(payload.precioMaxEstimado),
            central: asNumber(payload.precioCentral) ?? asNumber(payload.amount),
          };
    pegCanonicalTrace(event, {
      damageItemId: asString(payload.damageItemId),
      pieceCode,
      pricingSource:
        asString(payload.pricingSource) ?? asString(payload.priceSource),
      pricingStatus: asString(payload.pricingStatus),
      sampleCount: asNumber(payload.sampleCount) ?? asNumber(payload.cantidadMuestras),
      compatibleSampleCount:
        asNumber(payload.compatibleSampleCount) ??
        asNumber(payload.sampleCount) ??
        asNumber(payload.cantidadMuestras),
      selectedPartType:
        asString(payload.selectedPartType) ?? asString(payload.partTypeGroup),
      priceRange: range,
      amount: asNumber(payload.amount) ?? asNumber(payload.precioCentral),
      confidence: asString(payload.confidence),
    });
    return;
  }
  pegCanonicalTrace(event, {
    damageItemId: asString(payload.damageItemId),
    pieceCode,
    vehicle,
    sampleCount: asNumber(payload.sampleCount) ?? asNumber(payload.cantidadMuestras),
    confirmed: payload.confirmed,
    rawHits: undefined,
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
