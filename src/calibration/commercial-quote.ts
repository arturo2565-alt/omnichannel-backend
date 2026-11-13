import { createHash } from 'node:crypto';
import { CalibrationValidationError } from './calibration-case';

/**
 * Cotización humana de pintura integral. No es un expediente visual y no
 * autoriza precios de producción. El archivo asigna CQ-######; esta validación
 * no inventa marca, color, alcance ni un cobro a partir del precio cotizado.
 */
export const COMMERCIAL_SCHEMA_VERSION = '1.0.0';
export const COMMERCIAL_SOURCE_KEY = /^[a-zA-Z0-9_.:-]{4,150}$/;
export const COMMERCIAL_QUOTE_ID = /^CQ-\d{6}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /\d{10,}/;
const PLATE = /\b[A-Z]{3}-?\d{3,4}(?:-?[A-Z])?\b/;
const RESERVED_PREFIX = /^(?:probe-|autofix-sim-|case-test-|seed-case-)/;
const SERVICES = ['exterior_bath', 'bath_with_bodywork', 'color_change'] as const;
const WORK = ['bodywork', 'disassembly', 'interior_frames'] as const;
const IMAGE_KEYS = new Set(['image', 'images', 'photo', 'photos', 'photo_refs', 'photo_archive_status']);
const FORBIDDEN_KEYS = new Set([
  'contact', 'customer', 'customername', 'email', 'name', 'nombre', 'phone', 'placa', 'plate', 'telefono', 'vin',
]);

export type CommercialService = (typeof SERVICES)[number];
export type CommercialWork = (typeof WORK)[number];
export type CommercialEvidence = 'customer_provided' | 'unknown';
export type CommercialPriceSlot = {
  amount_mxn: number | null;
  validation: 'human_confirmed' | 'not_provided';
};

export type ValidatedCommercialQuote = {
  schema_version: typeof COMMERCIAL_SCHEMA_VERSION;
  source: {
    kind: 'autofix_human_commercial_quote';
    source_case_key: string;
    opportunity_key: string;
    prior_quote_id: string | null;
    quoted_at: string | null;
  };
  vehicle: {
    make: string | null;
    make_evidence: CommercialEvidence;
    model: string | null;
    model_evidence: CommercialEvidence;
    year: number | null;
    year_evidence: CommercialEvidence;
    variant: string | null;
    variant_evidence: CommercialEvidence;
  };
  service: CommercialService;
  colors: {
    current: string | null;
    current_evidence: CommercialEvidence;
    requested: string | null;
    requested_evidence: CommercialEvidence;
  };
  work_scope: CommercialWork[];
  prices: {
    quoted: CommercialPriceSlot;
    contracted: CommercialPriceSlot;
    collected: CommercialPriceSlot;
  };
  status: 'human_verified';
};

export type StoredCommercialQuote = ValidatedCommercialQuote & {
  quote_id: string;
  revision: number;
  recorded_at: string;
};

export function reservedCommercialKey(value: string): boolean {
  return RESERVED_PREFIX.test(value);
}

export function commercialObservationFingerprint(
  value: ValidatedCommercialQuote | Record<string, unknown>,
): string {
  const record = value as Record<string, unknown>;
  const stable = {
    schema_version: record.schema_version ?? null,
    source: record.source ?? null,
    vehicle: record.vehicle ?? null,
    service: record.service ?? null,
    colors: record.colors ?? null,
    work_scope: record.work_scope ?? null,
    prices: record.prices ?? null,
    status: record.status ?? null,
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function validateCommercialQuote(input: unknown): ValidatedCommercialQuote {
  const record = objectOf(input, 'The quote is missing');
  if (
    'quote_id' in record
    || 'revision' in record
    || 'recorded_at' in record
    || 'case_id' in record
  ) {
    throw new CalibrationValidationError('invalid', 'The archive assigns the quote identity');
  }
  rejectPhotographs(record);
  rejectPersonalData(record);
  return parseCommercialObservation(record);
}

export function assertStoredCommercialQuote(input: unknown): StoredCommercialQuote {
  const record = objectOf(input, 'The quote is missing');
  const quoteId = record.quote_id;
  const revision = record.revision;
  const recordedAt = record.recorded_at;
  if (typeof quoteId !== 'string' || !COMMERCIAL_QUOTE_ID.test(quoteId)) {
    throw new CalibrationValidationError('invalid', 'Invalid commercial quote id');
  }
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    throw new CalibrationValidationError('invalid', 'Revision sequence is invalid');
  }
  if (typeof recordedAt !== 'string' || !DATE_TIME.test(recordedAt)) {
    throw new CalibrationValidationError('invalid', 'The recording time is invalid');
  }
  const body = { ...record };
  delete body.quote_id;
  delete body.revision;
  delete body.recorded_at;
  rejectPhotographs(body);
  rejectPersonalData(body);
  const parsed = parseCommercialObservation(body);
  return {
    schema_version: parsed.schema_version,
    quote_id: quoteId,
    revision,
    recorded_at: recordedAt,
    source: parsed.source,
    vehicle: parsed.vehicle,
    service: parsed.service,
    colors: parsed.colors,
    work_scope: parsed.work_scope,
    prices: parsed.prices,
    status: parsed.status,
  };
}

function parseCommercialObservation(record: Record<string, unknown>): ValidatedCommercialQuote {
  if (record.schema_version != null && record.schema_version !== COMMERCIAL_SCHEMA_VERSION) {
    throw new CalibrationValidationError('invalid', 'Unsupported commercial schema version');
  }
  if (record.status !== 'human_verified') {
    throw new CalibrationValidationError('incomplete', 'An authorized quote must be human verified');
  }
  const source = readSource(record.source);
  const vehicle = readVehicle(record.vehicle);
  const service = readService(record.service);
  const colors = readColors(record.colors);
  const workScope = readWorkScope(record.work_scope);
  const prices = readPrices(record.prices);
  assertServiceRules(service, colors, workScope);
  return {
    schema_version: COMMERCIAL_SCHEMA_VERSION,
    source,
    vehicle,
    service,
    colors,
    work_scope: workScope,
    prices,
    status: 'human_verified',
  };
}

function readSource(value: unknown): ValidatedCommercialQuote['source'] {
  const source = objectOf(value, 'The quote source is missing');
  if (source.kind !== 'autofix_human_commercial_quote') {
    throw new CalibrationValidationError('invalid', 'Unsupported commercial source');
  }
  return {
    kind: 'autofix_human_commercial_quote',
    source_case_key: readKey(source.source_case_key, 'source_case_key'),
    opportunity_key: readKey(source.opportunity_key, 'opportunity_key'),
    prior_quote_id: readPrior(source.prior_quote_id),
    quoted_at: readQuotedAt(source.quoted_at),
  };
}

function readKey(value: unknown, label: string): string {
  if (typeof value !== 'string' || !COMMERCIAL_SOURCE_KEY.test(value) || reservedCommercialKey(value)) {
    throw new CalibrationValidationError('invalid', `${label} is not a stable commercial key`);
  }
  assertNoPersonalText(value, label);
  return value;
}

function readPrior(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !COMMERCIAL_QUOTE_ID.test(value)) {
    throw new CalibrationValidationError('invalid', 'The previous observation is not a commercial quote');
  }
  return value;
}

function readQuotedAt(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !DATE_TIME.test(value)) {
    throw new CalibrationValidationError('invalid', 'quoted_at must be a UTC timestamp or null');
  }
  return value;
}

function readVehicle(value: unknown): ValidatedCommercialQuote['vehicle'] {
  const vehicle = objectOf(value, 'The vehicle is missing');
  const make = readTextIdentity(vehicle.make, vehicle.make_evidence, 'make');
  const model = readTextIdentity(vehicle.model, vehicle.model_evidence, 'model');
  const variant = readTextIdentity(vehicle.variant, vehicle.variant_evidence, 'variant');
  const year = readYear(vehicle.year, vehicle.year_evidence);
  return {
    make: make.value,
    make_evidence: make.evidence,
    model: model.value,
    model_evidence: model.evidence,
    year: year.value,
    year_evidence: year.evidence,
    variant: variant.value,
    variant_evidence: variant.evidence,
  };
}

function readTextIdentity(
  value: unknown,
  evidence: unknown,
  label: string,
): { value: string | null; evidence: CommercialEvidence } {
  const kind = readEvidence(evidence, label);
  if (kind === 'unknown') {
    if (value != null && value !== '') {
      throw new CalibrationValidationError('inconsistent_identity', `${label} cannot be both unknown and present`);
    }
    return { value: null, evidence: 'unknown' };
  }
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) {
    throw new CalibrationValidationError('incomplete', `${label} was not provided`);
  }
  assertNoPersonalText(value, label);
  return { value: value.trim(), evidence: 'customer_provided' };
}

function readYear(
  value: unknown,
  evidence: unknown,
): { value: number | null; evidence: CommercialEvidence } {
  const kind = readEvidence(evidence, 'year');
  if (kind === 'unknown') {
    if (value != null && value !== '') {
      throw new CalibrationValidationError('inconsistent_identity', 'year cannot be both unknown and present');
    }
    return { value: null, evidence: 'unknown' };
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1900 || value > 2100) {
    throw new CalibrationValidationError('incomplete', 'year was not provided');
  }
  return { value, evidence: 'customer_provided' };
}

function readEvidence(value: unknown, label: string): CommercialEvidence {
  if (value === 'visual_inference') {
    throw new CalibrationValidationError('invalid', `${label} cannot be inferred without a visual expediente`);
  }
  if (value !== 'customer_provided' && value !== 'unknown') {
    throw new CalibrationValidationError('inconsistent_identity', `${label} evidence is not recognized`);
  }
  return value;
}

function readService(value: unknown): CommercialService {
  if (typeof value !== 'string' || !SERVICES.includes(value as CommercialService)) {
    throw new CalibrationValidationError('incomplete', 'The commercial service is missing');
  }
  return value as CommercialService;
}

function readColors(value: unknown): ValidatedCommercialQuote['colors'] {
  if (value == null) {
    return {
      current: null,
      current_evidence: 'unknown',
      requested: null,
      requested_evidence: 'unknown',
    };
  }
  const colors = objectOf(value, 'Colors must be an object');
  const current = readTextIdentity(colors.current, colors.current_evidence ?? 'unknown', 'current color');
  const requested = readTextIdentity(
    colors.requested,
    colors.requested_evidence ?? 'unknown',
    'requested color',
  );
  return {
    current: current.value,
    current_evidence: current.evidence,
    requested: requested.value,
    requested_evidence: requested.evidence,
  };
}

function readWorkScope(value: unknown): CommercialWork[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new CalibrationValidationError('invalid', 'The work scope must list declared jobs');
  }
  const seen = new Set<CommercialWork>();
  for (const item of value) {
    if (typeof item !== 'string' || !WORK.includes(item as CommercialWork)) {
      throw new CalibrationValidationError('invalid', 'The work scope contains an undeclared job');
    }
    if (seen.has(item as CommercialWork)) {
      throw new CalibrationValidationError('invalid', 'The work scope repeats a job');
    }
    seen.add(item as CommercialWork);
  }
  return [...seen].sort();
}

function readPrices(value: unknown): ValidatedCommercialQuote['prices'] {
  const prices = objectOf(value, 'The quote has no prices');
  return {
    quoted: readPrice(prices.quoted, 'Quoted price', true),
    contracted: readPrice(prices.contracted, 'Contracted price', false),
    collected: readPrice(prices.collected, 'Collected price', false),
  };
}

function readPrice(value: unknown, label: string, required: boolean): CommercialPriceSlot {
  if (value == null) {
    if (required) {
      throw new CalibrationValidationError('unauthorized_price', `${label} is not an authorized human price`);
    }
    return { amount_mxn: null, validation: 'not_provided' };
  }
  const slot = objectOf(value, 'A price must state its own validation');
  if (slot.validation == null && slot.amount_mxn == null && !required) {
    return { amount_mxn: null, validation: 'not_provided' };
  }
  if (slot.validation === 'not_provided') {
    if (required || slot.amount_mxn != null) {
      throw new CalibrationValidationError(
        required ? 'unauthorized_price' : 'invalid',
        required ? `${label} is not an authorized human price` : 'An unconfirmed price cannot carry an amount',
      );
    }
    return { amount_mxn: null, validation: 'not_provided' };
  }
  if (slot.validation !== 'human_confirmed') {
    throw new CalibrationValidationError('unauthorized_price', `${label} is not an authorized human price`);
  }
  if (typeof slot.amount_mxn !== 'number' || !Number.isInteger(slot.amount_mxn) || slot.amount_mxn < 1) {
    throw new CalibrationValidationError('unauthorized_price', `${label} is not an authorized human price`);
  }
  return { amount_mxn: slot.amount_mxn, validation: 'human_confirmed' };
}

function assertServiceRules(
  service: CommercialService,
  colors: ValidatedCommercialQuote['colors'],
  workScope: readonly CommercialWork[],
): void {
  const changesColor = colors.requested != null;
  if (service === 'color_change' && !changesColor) {
    throw new CalibrationValidationError('incomplete', 'A color change requires the requested color');
  }
  if (service !== 'color_change' && changesColor) {
    throw new CalibrationValidationError('inconsistent_identity', 'A requested color requires a color change');
  }
  const hasBodywork = workScope.includes('bodywork');
  if (service === 'bath_with_bodywork' && !hasBodywork) {
    throw new CalibrationValidationError('incomplete', 'A bath with bodywork must include bodywork');
  }
  if (service !== 'bath_with_bodywork' && hasBodywork && service === 'exterior_bath') {
    throw new CalibrationValidationError('inconsistent_identity', 'Bodywork belongs to a bath with bodywork');
  }
}

function objectOf(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CalibrationValidationError('incomplete', message);
  }
  return value as Record<string, unknown>;
}

function rejectPhotographs(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (IMAGE_KEYS.has(key.toLowerCase())) {
      throw new CalibrationValidationError('invalid', 'The commercial import does not accept photographs');
    }
  }
}

function rejectPersonalData(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectPersonalData);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new CalibrationValidationError('personal_data', 'The quote includes unnecessary personal data');
    }
    if (typeof nested === 'string') assertNoPersonalText(nested, key);
    else rejectPersonalData(nested);
  }
}

function assertNoPersonalText(value: string, label: string): void {
  if (
    EMAIL.test(value)
    || PHONE.test(value)
    || PLATE.test(value)
    || hasVin(value)
    || value.includes('/')
    || value.includes('\\')
    || value.includes('\0')
  ) {
    throw new CalibrationValidationError('personal_data', `${label} includes unnecessary personal data`);
  }
}

function hasVin(value: string): boolean {
  return value.split(/[^A-Za-z0-9]/).some((part) => (
    /^[A-HJ-NPR-Z0-9]{17}$/i.test(part) && /\d/.test(part) && /[A-Z]/i.test(part)
  ));
}
