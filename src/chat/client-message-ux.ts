/**
 * Conversation UX / Client Message Composer v2.
 * Presentación y continuidad conversacional. CanonicalQuote sigue siendo
 * la única autoridad financiera. No calcula precios ni reconstruye quotes.
 */
import { getClientPieceLabel } from '../catalog/panel-pieza-catalog';
import { isChargeableQuoteLine } from '../domain/peritaje-v1/quote-engine';
import { refaccionIdentityGaps } from '../domain/peritaje-v1/pending-quote-requirement';
import type {
  CanonicalPeritajeV1,
  CanonicalQuoteV1,
  DamageItem,
  QuoteLine,
  QuoteServiceType,
  TreatmentDecision,
} from '../domain/peritaje-v1';
import {
  PRESENTATION_HIDDEN_DAMAGE_COPY,
  REFACCION_AVAILABILITY_DISCLAIMER,
  buildControlledQuoteLineLabel,
  extractMonetaryAmounts,
  formatPartialQuoteFooter,
  formatQuoteMoney,
  formatQuoteMoneyRange,
  isPendingReviewDamage,
  renderCanonicalQuoteFinancialBlock,
  resolveQuoteLinePieceLabel,
  type ClientQuoteMessage,
} from '../domain/peritaje-v1/quote-narrative';
import type { QuoteSendSnapshot } from './autofix-config';
import { CANONICAL_TRACE_EVENTS, pegCanonicalTrace } from './canonical-trace';

export const CLIENT_MESSAGE_MODES = [
  'INITIAL_QUOTE',
  'QUOTE_RESUME',
  'QUOTE_UPDATE',
  'QUOTE_CORRECTION',
  'QUOTE_FULL_REFRESH',
  'APPOINTMENT_FOLLOWUP',
  'GENERAL_REPLY',
] as const;

export type ClientMessageMode = (typeof CLIENT_MESSAGE_MODES)[number];

export const CLIENT_MESSAGE_SOURCES = [
  'first_quote',
  'pending_requirement_resume',
  'vehicle_identity_correction',
  'cart_edit',
  'panel_refresh',
  'user_requested_full_quote',
  'appointment_turn',
  'general',
] as const;

export type ClientMessageSource = (typeof CLIENT_MESSAGE_SOURCES)[number];

export const CTA_TYPES = [
  'ASK_MISSING_VEHICLE_DATA',
  'OFFER_APPOINTMENT',
  'CONTINUE_APPOINTMENT',
  'NONE',
] as const;

export type CtaType = (typeof CTA_TYPES)[number];

export type TechnicalExplanationPolicy =
  | 'allowed'
  | 'omitted'
  | 'material_change_only';

export type QuoteDeltaUpdatedLine = {
  quoteLineId: string;
  before: QuoteLine | null;
  after: QuoteLine;
  changedFields: string[];
};

export type QuoteDelta = {
  addedLines: QuoteLine[];
  updatedLines: QuoteDeltaUpdatedLine[];
  removedLines: QuoteLine[];
  unchangedLineIds: string[];
  totalBefore: number | null;
  totalAfter: number;
  isPartialBefore: boolean | null;
  isPartialAfter: boolean;
  becameComplete: boolean;
  becamePartial: boolean;
};

export type ClientQuoteMessageContext = {
  mode: ClientMessageMode;
  shouldGreet: boolean;
  vehicleLabel: string;
  customerName: string;
  quote: CanonicalQuoteV1;
  quoteDelta: QuoteDelta;
  changedLines: QuoteLine[];
  warnings: string[];
  ctaType: CtaType;
  becameComplete: boolean;
  technicalExplanation: TechnicalExplanationPolicy;
  shouldShareLocation: boolean;
  missingVehicleFields: string[];
};

export type ResolveClientMessageModeInput = {
  quote: CanonicalQuoteV1;
  peritaje?: CanonicalPeritajeV1 | null;
  previousPeritaje?: CanonicalPeritajeV1 | null;
  previousSnapshot?: QuoteSendSnapshot | null;
  source?: ClientMessageSource;
  userText?: string;
  hasActiveAppointment?: boolean;
  appointmentCtaAlreadyOffered?: boolean;
  locationAlreadyShared?: boolean;
  contactName?: string;
};

export type ResolvedClientMessageUx = ClientQuoteMessageContext & {
  reason: string;
  presentation: 'FULL' | 'DELTA' | 'NONE';
  requiredQuoteLineIds: string[];
};

const FULL_QUOTE_REQUEST_RE =
  /cotizaci[oó]n completa|presupuesto completo|desglose completo|m[aá]ndame (?:la |el |toda (?:la |el )?)?(?:cotizaci[oó]n|desglose|presupuesto)|(?:reenv[ií]a|vuelve a (?:mandar|enviar)|otra vez).{0,40}cotizaci[oó]n|cotizaci[oó]n.{0,40}(?:otra vez|completa)|cu[aá]nto (?:ser[ií]a|sale|cuesta) todo|el total de todo/i;

const IDENTITY_CORRECTION_RE =
  /\b(?:perd[oó]n|correg(?:[ií]|ir)|me equivoqu|en realidad|no es(?: el)?)\b|\bes\s+(?:el\s+)?(?:19|20)\d{2}\b.+\bno\b|\bno\s+(?:es\s+)?(?:el\s+)?(?:19|20)\d{2}/i;

const APPOINTMENT_TURN_RE =
  /\b(?:ma[nñ]ana|hoy|pasado ma[nñ]ana|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b|\b(?:a las?|a la)\s+\d{1,2}(?:\s*:\s*\d{2})?\b|\b\d{1,2}\s*(?::\s*\d{2})?\s*(?:am|pm)\b|\bquiero\s+(?:agendar|cita|ir)\b/i;

const APPOINTMENT_ACCEPT_RE =
  /\b(?:s[ií](?:\s+\w+){0,6}\s+)?(?:quiero\s+)?(?:agendar|agenda(?:r|mos)?|cita)\b|\bvamos a agendar\b|\bdale(?:\s+\w+){0,3}\s+agend/i;

const APPOINTMENT_CTA_ALREADY_RE =
  /agendemos|qu[eé] d[ií]a te queda|valoraci[oó]n en taller|ingresar tu unidad/i;

const LOCATION_ALREADY_RE = /goo\.gl\/maps|maps\.google|📍/;

const FORBIDDEN_RESUME_GREETING_RE =
  /^\s*(?:hola[\s,]|👋)|hola\s+\w+|ya revisamos las (?:fotos|fotograf[ií]as)|ya analizamos las (?:fotos|fotograf[ií]as)/i;

const FORBIDDEN_RESUME_TECH_RE =
  /se (?:observa|aprecia)(?:\s+\w+){0,8}\s+(?:afectaci[oó]n|el da[nñ]o|da[nñ]o)|el da[nñ]o visible|ya revisamos las (?:fotos|fotograf[ií]as)/i;

const HIDDEN_DAMAGE_CLUSTER = new Set([
  'HIDDEN_DAMAGE',
  'POSSIBLE_SUBSTITUTION',
  'SUSPECTED_INVOLVEMENT',
]);

const CRITICAL_PENDING_WARNINGS = new Set([
  'AWAITING_VEHICLE_DATA',
  'REFACCION_PENDIENTE_DE_COTIZAR',
  'MONTAJE_TARIFA_NO_CONFIGURADA',
  'PENDING_TREATMENT',
  'NOT_ASSESSABLE',
  'MOLDURA_NO_PINTABLE_REQUIERE_REVISION',
  'MOLDURA_MONTAJE_PENDIENTE',
]);

const SERVICE_RENDER_ORDER: QuoteServiceType[] = [
  'REFACCION',
  'MONTAJE',
  'MONTAJE_PINTURA',
  'REPARACION_PINTURA',
  'PENDIENTE',
  'ADVERTENCIA',
];

export function userRequestsFullQuote(text?: string | null): boolean {
  return FULL_QUOTE_REQUEST_RE.test(String(text ?? ''));
}

export function userLooksLikeIdentityCorrection(text?: string | null): boolean {
  return IDENTITY_CORRECTION_RE.test(String(text ?? ''));
}

export function userLooksLikeAppointmentTurn(text?: string | null): boolean {
  return APPOINTMENT_TURN_RE.test(String(text ?? ''));
}

export function userLooksLikeAppointmentIntent(text?: string | null): boolean {
  const raw = String(text ?? '');
  return APPOINTMENT_TURN_RE.test(raw) || APPOINTMENT_ACCEPT_RE.test(raw);
}

export function snapshotOfferedAppointmentCta(
  snapshot?: QuoteSendSnapshot | null,
): boolean {
  return APPOINTMENT_CTA_ALREADY_RE.test(String(snapshot?.finalMessage ?? ''));
}

export function snapshotSharedLocation(
  snapshot?: QuoteSendSnapshot | null,
): boolean {
  return LOCATION_ALREADY_RE.test(String(snapshot?.finalMessage ?? ''));
}

export function vehicleLabelFromPeritaje(
  peritaje?: CanonicalPeritajeV1 | null,
): string {
  const vehicle = peritaje?.vehicles?.[0];
  if (!vehicle) return '';
  return (
    String(vehicle.displayLabel ?? '').trim() ||
    [vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(' ')
  );
}

export function extractLastUserText(
  turns?: ReadonlyArray<{ role?: string; content?: unknown }>,
): string {
  if (!turns?.length) return '';
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn?.role === 'user' && typeof turn.content === 'string') {
      return turn.content.trim();
    }
  }
  return '';
}

function stubLineFromFreeze(input: {
  quoteLineId: string;
  amount: number;
  serviceType?: string;
  damageItemId?: string;
  description?: string;
  vehicleId: string;
}): QuoteLine {
  const serviceType = (input.serviceType ||
    'REPARACION_PINTURA') as QuoteServiceType;
  return {
    quoteLineId: input.quoteLineId,
    damageItemId: input.damageItemId || input.quoteLineId,
    vehicleId: input.vehicleId,
    serviceType,
    description: input.description || input.quoteLineId,
    billable: true,
    amount: input.amount,
    confidence: 'HIGH',
  };
}

function roundMoney(n: number): number {
  return Math.max(0, Math.round(Number(n) || 0));
}

function lineChangedFields(before: QuoteLine, after: QuoteLine): string[] {
  const fields: string[] = [];
  if (roundMoney(before.amount) !== roundMoney(after.amount)) fields.push('amount');
  if (before.serviceType !== after.serviceType) fields.push('serviceType');
  if (before.pricingStatus !== after.pricingStatus) fields.push('pricingStatus');
  if (before.pricingSource !== after.pricingSource) fields.push('pricingSource');
  if (Boolean(before.billable) !== Boolean(after.billable)) fields.push('billable');
  const beforeMin = before.priceRange?.min;
  const beforeMax = before.priceRange?.max;
  const afterMin = after.priceRange?.min;
  const afterMax = after.priceRange?.max;
  if (beforeMin !== afterMin || beforeMax !== afterMax) fields.push('priceRange');
  return fields;
}

/**
 * Compara por quoteLineId contra el freeze realmente enviado al cliente.
 */
export function computeQuoteDelta(
  current: CanonicalQuoteV1,
  previousSnapshot?: QuoteSendSnapshot | null,
): QuoteDelta {
  const freeze = previousSnapshot?.canonicalFreeze;
  const vehicleId = current.lines[0]?.vehicleId || 'veh';
  if (!freeze) {
    return {
      addedLines: [...current.lines],
      updatedLines: [],
      removedLines: [],
      unchangedLineIds: [],
      totalBefore: null,
      totalAfter: current.total,
      isPartialBefore: null,
      isPartialAfter: current.isPartial === true,
      becameComplete: false,
      becamePartial: false,
    };
  }

  const currentById = new Map(current.lines.map((line) => [line.quoteLineId, line]));
  const prevById = new Map(
    (freeze.amounts ?? []).map((row) => [row.quoteLineId, row]),
  );
  const desgloseById = new Map(
    (previousSnapshot?.desglose ?? [])
      .filter((row) => row.quoteLineId)
      .map((row) => [String(row.quoteLineId), row]),
  );

  const addedLines: QuoteLine[] = [];
  const updatedLines: QuoteDeltaUpdatedLine[] = [];
  const removedLines: QuoteLine[] = [];
  const unchangedLineIds: string[] = [];

  for (const line of current.lines) {
    const prev = prevById.get(line.quoteLineId);
    if (!prev) {
      addedLines.push(line);
      continue;
    }
    const before = stubLineFromFreeze({
      quoteLineId: prev.quoteLineId,
      amount: prev.amount,
      serviceType: prev.serviceType || line.serviceType,
      damageItemId: prev.damageItemId || line.damageItemId,
      description:
        desgloseById.get(line.quoteLineId)?.pieza || line.description,
      vehicleId: line.vehicleId,
    });
    if (line.priceRange) {
      const desglose = desgloseById.get(line.quoteLineId);
      if (desglose?.precioMaximo != null) {
    before.priceRange = {
      min: roundMoney(desglose.precioMx),
      max: roundMoney(desglose.precioMaximo),
      central: roundMoney(desglose.precioMx),
    };
      }
    }
    const changed = lineChangedFields(before, line);
    if (changed.length) {
      updatedLines.push({
        quoteLineId: line.quoteLineId,
        before,
        after: line,
        changedFields: changed,
      });
    } else {
      unchangedLineIds.push(line.quoteLineId);
    }
  }

  for (const prev of freeze.amounts ?? []) {
    if (currentById.has(prev.quoteLineId)) continue;
    removedLines.push(
      stubLineFromFreeze({
        quoteLineId: prev.quoteLineId,
        amount: prev.amount,
        serviceType: prev.serviceType,
        damageItemId: prev.damageItemId,
        description: desgloseById.get(prev.quoteLineId)?.pieza,
        vehicleId,
      }),
    );
  }

  const isPartialBefore = freeze.isPartial === true;
  const isPartialAfter = current.isPartial === true;
  return {
    addedLines,
    updatedLines,
    removedLines,
    unchangedLineIds,
    totalBefore: freeze.total,
    totalAfter: current.total,
    isPartialBefore,
    isPartialAfter,
    becameComplete: isPartialBefore && !isPartialAfter,
    becamePartial: !isPartialBefore && isPartialAfter,
  };
}

function freezeHadAwaitingVehicleData(
  snapshot?: QuoteSendSnapshot | null,
): boolean {
  const warnings = snapshot?.canonicalFreeze?.warnings ?? snapshot?.shownWarnings ?? [];
  return warnings.includes('AWAITING_VEHICLE_DATA');
}

function deltaHasMaterialLineChanges(delta: QuoteDelta): boolean {
  return (
    delta.addedLines.length +
      delta.updatedLines.length +
      delta.removedLines.length >
    0
  );
}

function largeQuoteRefresh(delta: QuoteDelta, quote: CanonicalQuoteV1): boolean {
  const changed =
    delta.addedLines.length +
    delta.updatedLines.length +
    delta.removedLines.length;
  const total = Math.max(1, quote.lines.length);
  return changed >= Math.max(3, Math.ceil(total * 0.5));
}

export function shouldGreetForMode(mode: ClientMessageMode): boolean {
  if (mode === 'INITIAL_QUOTE') return true;
  if (mode === 'GENERAL_REPLY') return false;
  return false;
}

const NON_MATERIAL_LINE_FIELDS = new Set([
  'amount',
  'priceRange',
  'pricingStatus',
  'pricingSource',
  'billable',
]);

/**
 * Cambio técnico/material del daño. Precio, disponibilidad, identidad
 * vehicular y market status NO cuentan.
 */
export function hasMaterialTechnicalChange(input: {
  delta: QuoteDelta;
  previousPeritaje?: CanonicalPeritajeV1 | null;
  currentPeritaje?: CanonicalPeritajeV1 | null;
}): boolean {
  for (const row of input.delta.updatedLines) {
    if (row.changedFields.includes('serviceType')) return true;
    const extra = row.changedFields.filter(
      (field) => !NON_MATERIAL_LINE_FIELDS.has(field),
    );
    if (extra.length) return true;
  }

  const prevById = new Map(
    (input.previousPeritaje?.damages ?? []).map((d) => [d.damageItemId, d]),
  );
  for (const curr of input.currentPeritaje?.damages ?? []) {
    const prev = prevById.get(curr.damageItemId);
    if (!prev) {
      if ((input.previousPeritaje?.damages ?? []).length > 0) return true;
      continue;
    }
    if (prev.treatment !== curr.treatment) return true;
    if (
      (prev.damageEvidenceStatus ?? 'CONFIRMED_VISIBLE') !==
      (curr.damageEvidenceStatus ?? 'CONFIRMED_VISIBLE')
    ) {
      return true;
    }
    if (
      Boolean(prev.possibleHiddenDamage?.detected) !==
      Boolean(curr.possibleHiddenDamage?.detected)
    ) {
      return true;
    }
    if (Boolean(prev.requiresReplacement) !== Boolean(curr.requiresReplacement)) {
      return true;
    }
    if (Boolean(prev.possibleReplacement) !== Boolean(curr.possibleReplacement)) {
      return true;
    }
  }
  return false;
}

export function resolveTechnicalExplanationPolicy(
  mode: ClientMessageMode,
  delta: QuoteDelta,
  previousPeritaje?: CanonicalPeritajeV1 | null,
  currentPeritaje?: CanonicalPeritajeV1 | null,
): TechnicalExplanationPolicy {
  if (mode === 'INITIAL_QUOTE' || mode === 'QUOTE_FULL_REFRESH') return 'allowed';
  if (mode === 'QUOTE_RESUME') return 'omitted';
  if (mode === 'QUOTE_UPDATE' || mode === 'QUOTE_CORRECTION') {
    return hasMaterialTechnicalChange({
      delta,
      previousPeritaje,
      currentPeritaje,
    })
      ? 'material_change_only'
      : 'omitted';
  }
  return 'omitted';
}

export function resolveCtaType(input: {
  mode: ClientMessageMode;
  quote: CanonicalQuoteV1;
  peritaje?: CanonicalPeritajeV1 | null;
  hasActiveAppointment?: boolean;
  appointmentIntent?: boolean;
}): { ctaType: CtaType; missingVehicleFields: string[] } {
  const vehicle = input.peritaje?.vehicles?.[0];
  const gaps = refaccionIdentityGaps(vehicle);
  const awaiting = (input.quote.warnings ?? []).includes('AWAITING_VEHICLE_DATA');
  const missingVehicleFields = awaiting
    ? [...new Set([...gaps.missingFields, ...gaps.confirmationFields])]
    : [];

  if (input.mode === 'APPOINTMENT_FOLLOWUP' || input.hasActiveAppointment) {
    return { ctaType: 'CONTINUE_APPOINTMENT', missingVehicleFields };
  }
  if (input.quote.isPartial && awaiting && missingVehicleFields.length) {
    return { ctaType: 'ASK_MISSING_VEHICLE_DATA', missingVehicleFields };
  }
  if (input.appointmentIntent && !input.quote.isPartial) {
    return { ctaType: 'CONTINUE_APPOINTMENT', missingVehicleFields };
  }
  return { ctaType: 'OFFER_APPOINTMENT', missingVehicleFields };
}

export function resolveClientMessageMode(
  input: ResolveClientMessageModeInput,
): { mode: ClientMessageMode; reason: string } {
  const userText = String(input.userText ?? '').trim();
  const snapshot = input.previousSnapshot ?? null;
  const hasFreeze = Boolean(snapshot?.canonicalFreeze);
  const delta = computeQuoteDelta(input.quote, snapshot);
  const offeredCta =
    input.appointmentCtaAlreadyOffered ?? snapshotOfferedAppointmentCta(snapshot);

  if (input.source === 'user_requested_full_quote' || userRequestsFullQuote(userText)) {
    return { mode: 'QUOTE_FULL_REFRESH', reason: 'user_requested_full_quote' };
  }
  if (input.source === 'appointment_turn') {
    return { mode: 'APPOINTMENT_FOLLOWUP', reason: 'source_appointment_turn' };
  }
  if (
    hasFreeze &&
    !userRequestsFullQuote(userText) &&
    userLooksLikeAppointmentTurn(userText)
  ) {
    return { mode: 'APPOINTMENT_FOLLOWUP', reason: 'user_appointment_turn' };
  }
  if (input.source === 'pending_requirement_resume') {
    return { mode: 'QUOTE_RESUME', reason: 'source_pending_requirement_resume' };
  }
  if (input.source === 'vehicle_identity_correction') {
    return { mode: 'QUOTE_CORRECTION', reason: 'source_vehicle_identity_correction' };
  }
  if (input.source === 'panel_refresh') {
    return { mode: 'QUOTE_FULL_REFRESH', reason: 'source_panel_refresh' };
  }
  if (userLooksLikeIdentityCorrection(userText) && hasFreeze) {
    return { mode: 'QUOTE_CORRECTION', reason: 'user_identity_correction' };
  }
  if (
    hasFreeze &&
    freezeHadAwaitingVehicleData(snapshot) &&
    deltaHasMaterialLineChanges(delta)
  ) {
    return { mode: 'QUOTE_RESUME', reason: 'partial_awaiting_vehicle_resumed' };
  }
  if (input.source === 'cart_edit' && deltaHasMaterialLineChanges(delta)) {
    return { mode: 'QUOTE_UPDATE', reason: 'source_cart_edit' };
  }
  if (input.source === 'first_quote' || !hasFreeze) {
    return { mode: 'INITIAL_QUOTE', reason: 'no_previous_send_snapshot' };
  }
  if (largeQuoteRefresh(delta, input.quote) && !hasFreeze) {
    return { mode: 'QUOTE_FULL_REFRESH', reason: 'unreliable_previous_snapshot' };
  }
  if (deltaHasMaterialLineChanges(delta)) {
    return { mode: 'QUOTE_UPDATE', reason: 'quote_line_delta' };
  }
  if (offeredCta && input.hasActiveAppointment) {
    return { mode: 'APPOINTMENT_FOLLOWUP', reason: 'appointment_already_active' };
  }
  if (input.source === 'general') {
    return { mode: 'GENERAL_REPLY', reason: 'source_general' };
  }
  return { mode: 'QUOTE_FULL_REFRESH', reason: 'no_quote_delta' };
}

export function presentationForMode(
  mode: ClientMessageMode,
): 'FULL' | 'DELTA' | 'NONE' {
  if (mode === 'INITIAL_QUOTE' || mode === 'QUOTE_FULL_REFRESH') return 'FULL';
  if (mode === 'APPOINTMENT_FOLLOWUP' || mode === 'GENERAL_REPLY') return 'NONE';
  return 'DELTA';
}

function companionLineIds(quote: CanonicalQuoteV1, delta: QuoteDelta): string[] {
  const ids = new Set<string>();
  const damageIds = new Set<string>();
  for (const line of delta.addedLines) {
    ids.add(line.quoteLineId);
    damageIds.add(line.damageItemId);
  }
  for (const row of delta.updatedLines) {
    ids.add(row.quoteLineId);
    damageIds.add(row.after.damageItemId);
  }
  for (const line of quote.lines) {
    if (!damageIds.has(line.damageItemId)) continue;
    if (line.serviceType === 'MONTAJE' || line.serviceType === 'MONTAJE_PINTURA') {
      ids.add(line.quoteLineId);
    }
    const refaccionChanged = [...delta.addedLines, ...delta.updatedLines.map((r) => r.after)]
      .some(
        (changed) =>
          changed.damageItemId === line.damageItemId &&
          changed.serviceType === 'REFACCION',
      );
    if (refaccionChanged && line.serviceType === 'REFACCION') {
      ids.add(line.quoteLineId);
    }
  }
  return [...ids];
}

export function resolveClientMessageUx(
  input: ResolveClientMessageModeInput,
): ResolvedClientMessageUx {
  const resolved = resolveClientMessageMode(input);
  const delta = computeQuoteDelta(input.quote, input.previousSnapshot);
  const mode = resolved.mode;
  const shouldGreet = shouldGreetForMode(mode);
  const vehicleLabel = vehicleLabelFromPeritaje(input.peritaje);
  const locationAlreadyShared =
    input.locationAlreadyShared ?? snapshotSharedLocation(input.previousSnapshot);
  const cta = resolveCtaType({
    mode,
    quote: input.quote,
    peritaje: input.peritaje,
    hasActiveAppointment: input.hasActiveAppointment,
    appointmentIntent: userLooksLikeAppointmentIntent(input.userText),
  });
  const presentation = presentationForMode(mode);
  const requiredQuoteLineIds =
    presentation === 'DELTA'
      ? companionLineIds(input.quote, delta)
      : presentation === 'FULL'
        ? input.quote.lines.map((line) => line.quoteLineId)
        : [];
  const changedLines = [
    ...delta.addedLines,
    ...delta.updatedLines.map((row) => row.after),
  ];
  const warningCodes = selectWarningCodesForPresentation({
    quote: input.quote,
    mode,
    previousSnapshot: input.previousSnapshot,
  });
  const shouldShareLocation =
    (mode === 'INITIAL_QUOTE' && !locationAlreadyShared) ||
    (mode === 'APPOINTMENT_FOLLOWUP' && input.hasActiveAppointment === true);

  const ctx: ResolvedClientMessageUx = {
    mode,
    reason: resolved.reason,
    shouldGreet,
    vehicleLabel,
    customerName: String(input.contactName ?? '').trim(),
    quote: input.quote,
    quoteDelta: delta,
    changedLines,
    warnings: warningCodes,
    ctaType: cta.ctaType,
    becameComplete: delta.becameComplete,
    technicalExplanation: resolveTechnicalExplanationPolicy(
      mode,
      delta,
      input.previousPeritaje,
      input.peritaje,
    ),
    shouldShareLocation,
    missingVehicleFields: cta.missingVehicleFields,
    presentation,
    requiredQuoteLineIds,
  };

  pegCanonicalTrace(CANONICAL_TRACE_EVENTS.CLIENT_MESSAGE_MODE_RESOLVED, {
    quoteId: input.quote.quoteId,
    mode,
    reason: resolved.reason,
    shouldGreet,
  });
  pegCanonicalTrace(CANONICAL_TRACE_EVENTS.QUOTE_DELTA_COMPUTED, {
    quoteId: input.quote.quoteId,
    added: delta.addedLines.length,
    updated: delta.updatedLines.length,
    removed: delta.removedLines.length,
    unchanged: delta.unchangedLineIds.length,
    totalBefore: delta.totalBefore,
    totalAfter: delta.totalAfter,
    becameComplete: delta.becameComplete,
    becamePartial: delta.becamePartial,
  });
  return ctx;
}

export function selectWarningCodesForPresentation(input: {
  quote: CanonicalQuoteV1;
  mode: ClientMessageMode;
  previousSnapshot?: QuoteSendSnapshot | null;
}): string[] {
  const codes = [...new Set(input.quote.warnings ?? [])];
  if (input.mode === 'INITIAL_QUOTE' || input.mode === 'QUOTE_FULL_REFRESH') {
    return codes;
  }
  const previouslyShown = new Set(
    input.previousSnapshot?.canonicalFreeze?.warnings ??
      input.previousSnapshot?.shownWarnings ??
      [],
  );
  return codes.filter(
    (code) => !previouslyShown.has(code) || CRITICAL_PENDING_WARNINGS.has(code),
  );
}

/**
 * Dedupe semántico de presentación. No muta quote.warnings.
 * Máximo 2 warnings visuales: cluster de daños ocultos + conceptos pendientes.
 */
export function presentClientWarnings(codes: readonly string[]): {
  text: string;
  shownWarnings: string[];
  warningsRenderedCount: number;
} {
  const unique = [...new Set(codes.filter(Boolean))];
  const cluster = unique.filter((code) => HIDDEN_DAMAGE_CLUSTER.has(code));
  const pending = unique.filter((code) => CRITICAL_PENDING_WARNINGS.has(code));
  const rest = unique.filter(
    (code) => !HIDDEN_DAMAGE_CLUSTER.has(code) && !CRITICAL_PENDING_WARNINGS.has(code),
  );
  const lines: string[] = [];
  const shown: string[] = [];

  if (cluster.length) {
    lines.push(`⚠️ ${PRESENTATION_HIDDEN_DAMAGE_COPY}`);
    shown.push(...cluster);
  }
  if (pending.length || rest.length) {
    shown.push(...pending, ...rest);
  }

  const visual = lines.slice(0, 2);
  return {
    text: visual.join('\n'),
    shownWarnings: shown,
    warningsRenderedCount: visual.length,
  };
}

function isMarketRefaccionLine(line: QuoteLine): boolean {
  return (
    line.serviceType === 'REFACCION' &&
    (line.pricingSource === 'WEB_MARKET_ESTIMATE' ||
      line.pricingSource === 'MARKET')
  );
}

function lineAmountText(
  line: QuoteLine,
  peritaje?: CanonicalPeritajeV1 | null,
): string {
  if (
    line.priceRange &&
    line.priceRange.min >= 0 &&
    line.priceRange.max >= line.priceRange.min &&
    isChargeableQuoteLine(line)
  ) {
    return `${formatQuoteMoneyRange(line.priceRange.min, line.priceRange.max)} MXN`;
  }
  if (!isChargeableQuoteLine(line)) {
    if (line.pricingStatus === 'AWAITING_VEHICLE_DATA') {
      return 'pendiente de datos del vehículo';
    }
    if (line.serviceType === 'MONTAJE' || line.serviceType === 'MONTAJE_PINTURA') {
      return 'tarifa pendiente';
    }
    if (line.serviceType === 'PENDIENTE' || line.serviceType === 'ADVERTENCIA') {
      return 'pendiente de revisión';
    }
    const damage = peritaje?.damages.find(
      (d) => d.damageItemId === line.damageItemId,
    );
    if (isPendingReviewDamage(damage)) {
      return 'pendiente de revisión';
    }
    return 'precio pendiente de estimación';
  }
  return `${formatQuoteMoney(line.amount)} MXN`;
}

function serviceShortLabel(serviceType: QuoteServiceType): string {
  if (serviceType === 'REFACCION') return 'Refacción';
  if (serviceType === 'MONTAJE') return 'Montaje';
  if (serviceType === 'MONTAJE_PINTURA') return 'Montaje y pintura';
  if (serviceType === 'REPARACION_PINTURA') return 'Reparación y pintura';
  if (serviceType === 'PENDIENTE') return 'Pendiente';
  return 'Concepto';
}

function isPendingReviewPiece(lines: readonly QuoteLine[]): boolean {
  return lines.every(
    (line) =>
      line.serviceType === 'PENDIENTE' ||
      line.serviceType === 'ADVERTENCIA' ||
      (line.serviceType !== 'REFACCION' &&
        line.serviceType !== 'MONTAJE' &&
        line.serviceType !== 'MONTAJE_PINTURA' &&
        line.serviceType !== 'REPARACION_PINTURA' &&
        !isChargeableQuoteLine(line)),
  );
}

function serviceEmoji(serviceType: QuoteServiceType): string {
  if (serviceType === 'REFACCION') return '🔧';
  if (serviceType === 'MONTAJE') return '🔩';
  if (serviceType === 'MONTAJE_PINTURA' || serviceType === 'REPARACION_PINTURA') {
    return serviceType === 'MONTAJE_PINTURA' ? '🎨' : '🛠️';
  }
  return '🛠️';
}

function sortLinesForDelta(lines: QuoteLine[]): QuoteLine[] {
  return [...lines].sort((a, b) => {
    if (a.damageItemId !== b.damageItemId) {
      return a.damageItemId.localeCompare(b.damageItemId);
    }
    return (
      SERVICE_RENDER_ORDER.indexOf(a.serviceType) -
      SERVICE_RENDER_ORDER.indexOf(b.serviceType)
    );
  });
}

export function renderQuoteDeltaFinancialBlock(
  quote: CanonicalQuoteV1,
  delta: QuoteDelta,
  peritaje?: CanonicalPeritajeV1 | null,
  requiredQuoteLineIds?: readonly string[],
): { text: string; displayedAmounts: number[] } {
  const ids = new Set(
    requiredQuoteLineIds?.length
      ? requiredQuoteLineIds
      : companionLineIds(quote, delta),
  );
  const lines = sortLinesForDelta(
    quote.lines.filter((line) => ids.has(line.quoteLineId)),
  );
  const grouped = new Map<string, QuoteLine[]>();
  for (const line of lines) {
    const list = grouped.get(line.damageItemId) ?? [];
    list.push(line);
    grouped.set(line.damageItemId, list);
  }
  const chunks: string[] = [];
  const displayedAmounts: number[] = [];

  for (const group of grouped.values()) {
    const piece = resolveQuoteLinePieceLabel(group[0]!, peritaje);
    if (isPendingReviewPiece(group) || group.some((line) => {
      const damage = peritaje?.damages.find((d) => d.damageItemId === line.damageItemId);
      return isPendingReviewDamage(damage);
    })) {
      chunks.push(`🟡 *${piece}:* pendiente de revisión`);
      continue;
    }
    const headerLine =
      group.find((line) => line.serviceType === 'REFACCION') ?? group[0]!;
    chunks.push(`${serviceEmoji(headerLine.serviceType)} *${piece}*`);
    for (const line of group) {
      const amountText = lineAmountText(line, peritaje);
      if (line.serviceType === 'MONTAJE' || line.serviceType === 'MONTAJE_PINTURA') {
        chunks.push(
          `${serviceEmoji(line.serviceType)} ${serviceShortLabel(line.serviceType)}: *${amountText}*`,
        );
      } else {
        chunks.push(`${serviceShortLabel(line.serviceType)}: *${amountText}*`);
      }
      if (isMarketRefaccionLine(line) && isChargeableQuoteLine(line)) {
        chunks.push(`_${REFACCION_AVAILABILITY_DISCLAIMER}_`);
      }
      if (isChargeableQuoteLine(line)) {
        displayedAmounts.push(roundMoney(line.amount));
        if (line.priceRange) {
          displayedAmounts.push(
            roundMoney(line.priceRange.min),
            roundMoney(line.priceRange.max),
          );
        }
      }
    }
  }

  displayedAmounts.push(roundMoney(quote.total));
  const totalFmt = formatQuoteMoney(quote.total);
  const totalLine = quote.isPartial
    ? `💰 *Total actualizado: ${totalFmt} MXN*`
    : `💰 *Total actualizado: ${totalFmt} MXN*`;
  chunks.push('', totalLine);
  const footer = formatPartialQuoteFooter(quote, peritaje);
  if (footer) chunks.push(footer);

  if (delta.becameComplete) {
    chunks.push('Con esta información ya pudimos completar la cotización. ✅');
  }
  if (delta.unchangedLineIds.length > 0) {
    chunks.push('El resto de los conceptos permanece sin cambios.');
  }

  return {
    text: chunks.filter((line, idx, arr) => line !== '' || arr[idx - 1] !== '').join('\n'),
    displayedAmounts,
  };
}

export function renderIdentifiedDamages(
  peritaje?: CanonicalPeritajeV1 | null,
  quote?: CanonicalQuoteV1 | null,
): string {
  const damages = peritaje?.damages ?? [];
  if (!damages.length) return '';
  const lines = quote?.lines ?? [];
  const rows = damages.map((damage) => {
    const label =
      getClientPieceLabel(damage.pieceCode, damage) ||
      damage.pieceLabel ||
      'pieza';
    const emoji = treatmentEmoji(damage.treatment);
    const status = identifiedDamageStatus(damage, lines);
    return `${emoji} ${label} — ${status}`;
  });
  return `🔎 *Daños identificados*\n\n${rows.join('\n')}`;
}

function identifiedDamageStatus(
  damage: DamageItem,
  lines: readonly QuoteLine[],
): string {
  const related = lines.filter((line) => line.damageItemId === damage.damageItemId);
  const billablePaint = related.some(
    (line) => line.serviceType === 'REPARACION_PINTURA' && line.billable,
  );
  if (billablePaint) return 'reparación y pintura';
  if (isPendingReviewDamage(damage)) return 'pendiente de revisión';
  if (damage.treatment === 'SUSTITUIR') return 'sustitución';
  if (damage.treatment === 'REPARAR') return 'reparación y pintura';
  if (damage.treatment === 'INCIERTO') return 'requiere confirmación en revisión';
  return 'pendiente de revisión';
}

function treatmentEmoji(treatment: TreatmentDecision): string {
  if (treatment === 'SUSTITUIR') return '🔴';
  if (treatment === 'REPARAR' || treatment === 'INCIERTO') return '🟠';
  return '🟡';
}

export function stripForbiddenResumePhrases(text: string): string {
  return String(text ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !FORBIDDEN_RESUME_GREETING_RE.test(line))
    .filter((line) => !FORBIDDEN_RESUME_TECH_RE.test(line))
    .join('\n')
    .replace(/\bHola\s+\w+[,!]?\s*/gi, '')
    .trim();
}

function normalizeForFilterCompare(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function applyClientMessagePostFilter(
  text: string,
  mode: ClientMessageMode,
): { text: string; intervened: boolean } {
  if (shouldGreetForMode(mode)) {
    return { text: String(text ?? ''), intervened: false };
  }
  const original = String(text ?? '');
  const stripped = stripForbiddenResumePhrases(original);
  return {
    text: stripped,
    intervened:
      Boolean(original.trim()) &&
      normalizeForFilterCompare(stripped) !== normalizeForFilterCompare(original),
  };
}

const LLM_TRANSITION_MAX_CHARS = 200;

export function isCleanLlmTransitionPhrase(text?: string | null): boolean {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  if (raw.length > LLM_TRANSITION_MAX_CHARS) return false;
  if ((raw.match(/[.!?]/g) ?? []).length > 2) return false;
  if (FORBIDDEN_RESUME_GREETING_RE.test(raw)) return false;
  if (FORBIDDEN_RESUME_TECH_RE.test(raw)) return false;
  if (/\bhola\b|👋|¡\s*listo/i.test(raw)) return false;
  if (extractMonetaryAmounts(raw).length > 0) return false;
  if (/🛠️|🔧|🔩|💰|inversi[oó]n total|total actualizado/i.test(raw)) return false;
  if (/refacci[oó]n|montaje|priceRange|MXN/i.test(raw)) return false;
  if (/gracias por confirmar|se puede continuar la actualizaci|con ese dato se puede/i.test(raw)) return false;
  return true;
}

export function traceClientMessagePostFilterIntervention(input: {
  quoteId: string;
  mode: ClientMessageMode;
}): void {
  pegCanonicalTrace(CANONICAL_TRACE_EVENTS.CLIENT_MESSAGE_POST_FILTER_INTERVENTION, {
    quoteId: input.quoteId,
    mode: input.mode,
  });
}

export function deterministicAcknowledge(ctx: ClientQuoteMessageContext): string {
  const vehicle = ctx.vehicleLabel || 'tu vehículo';
  const name = ctx.customerName && ctx.customerName !== 'Estimado cliente'
    ? ctx.customerName
    : '';
  if (ctx.mode === 'QUOTE_CORRECTION') {
    return name
      ? `Perfecto, ${name}. Corregí el vehículo a *${vehicle}* y recalculé la cotización.`
      : `Perfecto. Corregí el vehículo a *${vehicle}* y recalculé la cotización.`;
  }
  if (ctx.mode === 'QUOTE_RESUME') {
    return name
      ? `Perfecto, ${name}. Ya actualicé la cotización con tu *${vehicle}*.`
      : `Perfecto. Ya actualicé la cotización con tu *${vehicle}*.`;
  }
  if (ctx.mode === 'QUOTE_UPDATE') {
    return 'Actualicé la cotización con el cambio solicitado.';
  }
  return '';
}

export function renderDeterministicCta(input: {
  ctx: ClientQuoteMessageContext;
  hasActiveAppointment: boolean;
  appointmentFormatted?: string;
  mapsUrl?: string;
}): string {
  const { ctx } = input;
  if (ctx.ctaType === 'NONE') return '';
  if (ctx.ctaType === 'ASK_MISSING_VEHICLE_DATA') {
    const fields = ctx.missingVehicleFields;
    if (fields.includes('model') && fields.includes('year')) {
      return '¿Me confirmas *modelo y año* de tu vehículo para completar la refacción?';
    }
    if (fields.includes('year')) {
      return '¿Me confirmas el *año* de tu vehículo para completar la refacción?';
    }
    if (fields.includes('model')) {
      return '¿Me confirmas el *modelo* de tu vehículo para completar la refacción?';
    }
    return '¿Me confirmas marca, modelo y año para completar la refacción?';
  }
  if (ctx.ctaType === 'CONTINUE_APPOINTMENT') {
    if (input.hasActiveAppointment) {
      const when =
        String(input.appointmentFormatted ?? '').trim() ||
        'el día acordado para tu visita';
      return `**Te esperamos ${when} con tu vehículo en el taller.**`;
    }
    return '¿Qué día y hora te funciona para la visita?';
  }
  const offer = '📅 ¿Quieres que agendemos una valoración en taller?';
  if (ctx.shouldShareLocation && input.mapsUrl) {
    return `📍 Estamos aquí, fácil de llegar: ${input.mapsUrl}\n\n${offer}`;
  }
  return offer;
}

export function modeHeader(mode: ClientMessageMode): string {
  if (mode === 'INITIAL_QUOTE') return '🚗 *Cotización preliminar*';
  if (mode === 'QUOTE_FULL_REFRESH') return '🚗 *Cotización*';
  if (
    mode === 'QUOTE_RESUME' ||
    mode === 'QUOTE_UPDATE' ||
    mode === 'QUOTE_CORRECTION'
  ) {
    return '✅ *Cotización actualizada*';
  }
  return '';
}

export function llmNarrativeContract(ctx: ClientQuoteMessageContext): Record<string, unknown> {
  return {
    mode: ctx.mode,
    shouldGreet: ctx.shouldGreet,
    vehicleLabel: ctx.vehicleLabel,
    customerName: ctx.customerName,
    changedLineLabels: ctx.changedLines.map((line) =>
      buildControlledQuoteLineLabel(
        line.serviceType,
        resolveQuoteLinePieceLabel(line),
      ),
    ),
    warnings: ctx.warnings,
    ctaType: ctx.ctaType,
    becameComplete: ctx.becameComplete,
    technicalExplanation: ctx.technicalExplanation,
    constraints: {
      noMoney: true,
      noLineItems: true,
      noTotals: true,
      noGreeting: !ctx.shouldGreet,
      noPhotoRecap: !ctx.shouldGreet,
    },
  };
}

export function buildModeAwareNarrativeAppendix(
  ctx: ClientQuoteMessageContext,
): string {
  const extra = !ctx.shouldGreet
    ? `
- PROHIBIDO saludar ("Hola", "¡Listo!", 👋).
- PROHIBIDO decir que revisaste o analizaste las fotografías.
- PROHIBIDO repetir el análisis visual ("Se observa", "Se aprecia", "El daño visible").
- technicalExplanation DEBE ser "".
- intro: 1-2 oraciones reconociendo el dato. Tono natural, no burocrático.
- Preferido resume: "Perfecto, {nombre}. Ya actualicé la cotización con tu {vehículo}."
- Preferido corrección: "Perfecto, {nombre}. Corregí el vehículo a {vehículo} y recalculé la cotización."
- PROHIBIDO: "gracias por confirmar", "con ese dato se puede continuar", "se puede continuar la actualización".`
    : `
- intro: saludo breve y contexto. Máximo 1–2 párrafos cortos. SIN precios.
- technicalExplanation: breve, no financiera. PROHIBIDO listar líneas de cotización.`;

  return `
[Tarea: partes narrativas de cotización — SIN autoridad financiera]
Responde SOLO un JSON válido, sin markdown:
{"intro":"...","technicalExplanation":"...","cta":"..."}

Contrato (no reconstruyas estado desde el historial):
${JSON.stringify(llmNarrativeContract(ctx))}

Reglas:
- El CTA lo puede reescribir el backend. Si escribes cta, SIN precios y SIN volver a ofrecer agendar si ctaType es CONTINUE_APPOINTMENT.
- PROHIBIDO: $, pesos, MXN, "mil pesos", importes, desglose, serviceType, montos de montaje o refacción.
- PROHIBIDO explicar la causa de cotización parcial o mencionar "falta el precio de refacción".
- PROHIBIDO incluir IDs internos de pieza (Calavera_Derecha, Faro_Izquierdo).
${extra}
`.trim();
}

function ensureHeader(text: string, header: string): string {
  const body = String(text ?? '').trim();
  const head = String(header ?? '').trim();
  if (!head) return body;
  if (body.includes(head)) return body;
  return [head, body].filter(Boolean).join('\n\n');
}

export function assembleModeAwareClientQuoteParts(input: {
  ctx: ResolvedClientMessageUx;
  peritaje?: CanonicalPeritajeV1 | null;
  llmIntro?: string;
  llmTechnicalExplanation?: string;
  llmCta?: string;
  hasActiveAppointment: boolean;
  appointmentFormatted?: string;
  mapsUrl?: string;
  damageIntro?: string;
}): {
  parts: ClientQuoteMessage;
  financialBlock: string;
  warningsBlock: string;
  shownWarnings: string[];
  warningsRenderedCount: number;
  fullQuoteRendered: boolean;
  deltaRendered: boolean;
  greetingRendered: boolean;
  technicalExplanationRendered: boolean;
  postFilterInterventionsCount: number;
  preFilterClean: boolean;
} {
  const { ctx } = input;
  const warnings = presentClientWarnings(ctx.warnings);
  let financialBlock = '';
  let fullQuoteRendered = false;
  let deltaRendered = false;
  let postFilterInterventionsCount = 0;

  if (ctx.presentation === 'FULL') {
    financialBlock = renderCanonicalQuoteFinancialBlock(ctx.quote, input.peritaje)
      .text;
    fullQuoteRendered = true;
  } else if (ctx.presentation === 'DELTA') {
    financialBlock = renderQuoteDeltaFinancialBlock(
      ctx.quote,
      ctx.quoteDelta,
      input.peritaje,
      ctx.requiredQuoteLineIds,
    ).text;
    deltaRendered = true;
  }

  const cta = renderDeterministicCta({
    ctx,
    hasActiveAppointment: input.hasActiveAppointment,
    appointmentFormatted: input.appointmentFormatted,
    mapsUrl: ctx.shouldShareLocation ? input.mapsUrl : '',
  });

  const deltaMode = ctx.presentation === 'DELTA';
  let intro = String(input.llmIntro ?? '').trim();
  let technicalExplanation = String(input.llmTechnicalExplanation ?? '').trim();

  if (ctx.mode === 'APPOINTMENT_FOLLOWUP') {
    intro = 'Perfecto, seguimos con tu cita.';
    technicalExplanation = '';
    financialBlock = '';
    fullQuoteRendered = false;
    deltaRendered = false;
  } else if (deltaMode) {
    const llm = intro;
    intro = isCleanLlmTransitionPhrase(llm) ? llm : '';
    technicalExplanation = '';
  }

  if (ctx.technicalExplanation === 'omitted') {
    technicalExplanation = '';
  }

  if (!intro) {
    intro = ctx.shouldGreet
      ? deterministicInitialIntro(ctx, input.damageIntro)
      : deterministicAcknowledge(ctx);
  } else if (deltaMode && ctx.vehicleLabel && !intro.includes(ctx.vehicleLabel)) {
    const ack = deterministicAcknowledge(ctx);
    if (ack) intro = `${ack}\n\n${intro}`.trim();
  }

  const introBeforeFilter = intro;
  if (!ctx.shouldGreet) {
    const filtered = applyClientMessagePostFilter(intro, ctx.mode);
    if (filtered.intervened) {
      postFilterInterventionsCount += 1;
      traceClientMessagePostFilterIntervention({
        quoteId: ctx.quote.quoteId,
        mode: ctx.mode,
      });
    }
    intro = filtered.text;
    if (!intro) {
      intro =
        ctx.mode === 'APPOINTMENT_FOLLOWUP'
          ? 'Perfecto, seguimos con tu cita.'
          : deterministicAcknowledge(ctx);
    }
    const techFiltered = applyClientMessagePostFilter(
      technicalExplanation,
      ctx.mode,
    );
    if (techFiltered.intervened) {
      postFilterInterventionsCount += 1;
      traceClientMessagePostFilterIntervention({
        quoteId: ctx.quote.quoteId,
        mode: ctx.mode,
      });
    }
    technicalExplanation = techFiltered.text;
  }

  const preFilterClean =
    postFilterInterventionsCount === 0 &&
    normalizeForFilterCompare(introBeforeFilter) ===
      normalizeForFilterCompare(intro);

  intro = ensureHeader(intro, modeHeader(ctx.mode));

  if (ctx.presentation === 'FULL') {
    const damages = renderIdentifiedDamages(input.peritaje, ctx.quote);
    const estimateLabel = '💰 *Estimación*';
    technicalExplanation = [damages, technicalExplanation, estimateLabel]
      .map((s) => s.trim())
      .filter(Boolean)
      .join('\n\n');
  }

  const parts: ClientQuoteMessage = {
    intro,
    technicalExplanation,
    financialBlock,
    warningsBlock: warnings.text,
    cta,
  };

  return {
    parts,
    financialBlock,
    warningsBlock: warnings.text,
    shownWarnings: warnings.shownWarnings,
    warningsRenderedCount: warnings.warningsRenderedCount,
    fullQuoteRendered,
    deltaRendered,
    greetingRendered: ctx.shouldGreet && /\bhola\b|👋|¡\s*listo/i.test(parts.intro),
    technicalExplanationRendered:
      ctx.technicalExplanation === 'allowed' &&
      Boolean(parts.technicalExplanation) &&
      ctx.presentation === 'FULL',
    postFilterInterventionsCount,
    preFilterClean,
  };
}

function deterministicInitialIntro(
  ctx: ClientQuoteMessageContext,
  damageIntro?: string,
): string {
  const name = ctx.customerName || 'Estimado cliente';
  const vehicle = ctx.vehicleLabel ? ` de tu ${ctx.vehicleLabel}` : '';
  const fallback = `Ya revisamos las fotos${vehicle} y preparamos una valoración inicial.`;
  const intro = String(damageIntro ?? '').trim() || fallback;
  return `Hola, ${name}. ${intro}`.replace(/\s+/g, ' ').trim();
}

export function traceClientMessageRendered(input: {
  quoteId: string;
  mode: ClientMessageMode;
  fullQuoteRendered: boolean;
  deltaRendered: boolean;
  deltaCount?: number;
  greetingRendered: boolean;
  technicalExplanationRendered: boolean;
  warningsRenderedCount: number;
  ctaType: CtaType;
}): void {
  pegCanonicalTrace(CANONICAL_TRACE_EVENTS.CLIENT_MESSAGE_RENDERED, {
    quoteId: input.quoteId,
    mode: input.mode,
    fullQuoteRendered: input.fullQuoteRendered,
    deltaRendered: input.deltaRendered,
    deltaCount: input.deltaCount ?? (input.deltaRendered ? 1 : 0),
    greetingRendered: input.greetingRendered,
    technicalExplanationRendered: input.technicalExplanationRendered,
    warningsRenderedCount: input.warningsRenderedCount,
    ctaType: input.ctaType,
  });
}

export function humanLabelsLeakPieceCodes(text: string, damages?: DamageItem[]): boolean {
  const raw = String(text ?? '');
  if (
    /Calavera_Derecha|Calavera_Izquierda|Faro_Derecho|Faro_Izquierdo|Faro_Niebla_/i.test(
      raw,
    )
  ) {
    return true;
  }
  for (const damage of damages ?? []) {
    if (!damage.pieceCode || !/_/.test(damage.pieceCode)) continue;
    if (raw.includes(damage.pieceCode)) return true;
  }
  return false;
}
