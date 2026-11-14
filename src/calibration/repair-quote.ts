import { createHash } from 'node:crypto';
import { CalibrationValidationError } from './calibration-case';

/**
 * Cotización humana de reparación sin fotografías. No es un expediente visual,
 * no es una cotización de pintura integral y no autoriza precios de producción.
 * El archivo asigna RQ-######. El total cotizado tiene que coincidir con la
 * suma de las partidas. Montaje y pintura es mano de obra de este contrato,
 * no un tratamiento del expediente visual.
 */
export const REPAIR_SCHEMA_VERSION = '1.0.0';
export const REPAIR_SOURCE_KEY = /^[a-zA-Z0-9_.:-]{4,150}$/;
export const REPAIR_QUOTE_ID = /^RQ-\d{6}$/;
export const REPAIR_LABOR = ['mount_and_paint', 'paint', 'repair'] as const;
const LINE_ID = /^L(?:0[1-9]|[1-9]\d)$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /\d{10,}/;
const PLATE = /\b[A-Z]{3}-?\d{3,4}(?:-?[A-Z])?\b/;
const RESERVED_PREFIX = /^(?:probe-|autofix-sim-|case-test-|seed-case-)/;
const IMAGE_KEYS = new Set([
  'image',
  'images',
  'photo',
  'photos',
  'photo_refs',
  'photo_archive_status',
]);
const FORBIDDEN_KEYS = new Set([
  'contact',
  'customer',
  'customername',
  'email',
  'name',
  'nombre',
  'phone',
  'placa',
  'plate',
  'telefono',
  'vin',
]);
const ROOT_KEYS = [
  'schema_version',
  'status',
  'evidence',
  'photo_status',
  'source',
  'vehicle',
  'lines',
  'quoted_total_mxn',
  'conditions',
];
const SOURCE_KEYS = [
  'kind',
  'source_case_key',
  'opportunity_key',
  'prior_quote_id',
  'quoted_at',
];
const VEHICLE_KEYS = [
  'make',
  'make_evidence',
  'model',
  'model_evidence',
  'year',
  'year_evidence',
  'variant',
  'variant_evidence',
];
const LINE_KEYS = ['line_id', 'part', 'role', 'labor', 'prices'];
const PRICE_KEYS = ['quoted', 'contracted', 'collected'];
const SLOT_KEYS = ['amount_mxn', 'validation'];
const MAX_LINES = 30;
const MAX_CONDITIONS = 8;

export type RepairLabor = (typeof REPAIR_LABOR)[number];
export type RepairRole = 'part' | 'labor';
export type RepairEvidence = 'customer_provided' | 'unknown';
export type RepairPriceSlot = {
  amount_mxn: number | null;
  validation: 'human_confirmed' | 'not_provided';
};

export type RepairLine = {
  line_id: string;
  part: string;
  role: RepairRole;
  labor: RepairLabor | null;
  prices: {
    quoted: RepairPriceSlot;
    contracted: RepairPriceSlot;
    collected: RepairPriceSlot;
  };
};

export type ValidatedRepairQuote = {
  schema_version: typeof REPAIR_SCHEMA_VERSION;
  evidence: 'text_only';
  photo_status: 'not_provided';
  source: {
    kind: 'autofix_human_repair_quote';
    source_case_key: string;
    opportunity_key: string;
    prior_quote_id: string | null;
    quoted_at: string | null;
  };
  vehicle: {
    make: string | null;
    make_evidence: RepairEvidence;
    model: string | null;
    model_evidence: RepairEvidence;
    year: number | null;
    year_evidence: RepairEvidence;
    variant: string | null;
    variant_evidence: RepairEvidence;
  };
  lines: RepairLine[];
  quoted_total_mxn: number;
  conditions: string[];
  status: 'human_verified';
};

export type StoredRepairQuote = ValidatedRepairQuote & {
  quote_id: string;
  revision: number;
  recorded_at: string;
};

export function reservedRepairKey(value: string): boolean {
  return RESERVED_PREFIX.test(value);
}

export function repairQuotedTotal(lines: readonly RepairLine[]): number {
  return lines.reduce(
    (sum, line) => sum + (line.prices.quoted.amount_mxn ?? 0),
    0,
  );
}

export function repairObservationFingerprint(
  value: ValidatedRepairQuote | Record<string, unknown>,
): string {
  const record = value as Record<string, unknown>;
  const stable = {
    schema_version: record.schema_version ?? null,
    evidence: record.evidence ?? null,
    photo_status: record.photo_status ?? null,
    source: record.source ?? null,
    vehicle: record.vehicle ?? null,
    lines: record.lines ?? null,
    quoted_total_mxn: record.quoted_total_mxn ?? null,
    conditions: record.conditions ?? null,
    status: record.status ?? null,
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function validateRepairQuote(input: unknown): ValidatedRepairQuote {
  const record = objectOf(input, 'The quote is missing');
  if (
    'quote_id' in record ||
    'revision' in record ||
    'recorded_at' in record ||
    'case_id' in record
  ) {
    throw new CalibrationValidationError(
      'invalid',
      'The archive assigns the quote identity',
    );
  }
  rejectPhotographs(record);
  rejectPersonalData(record);
  return parseRepairObservation(record);
}

export function assertStoredRepairQuote(input: unknown): StoredRepairQuote {
  const record = objectOf(input, 'The quote is missing');
  const quoteId = record.quote_id;
  const revision = record.revision;
  const recordedAt = record.recorded_at;
  if (typeof quoteId !== 'string' || !REPAIR_QUOTE_ID.test(quoteId)) {
    throw new CalibrationValidationError('invalid', 'Invalid repair quote id');
  }
  if (
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision < 1
  ) {
    throw new CalibrationValidationError(
      'invalid',
      'Revision sequence is invalid',
    );
  }
  if (typeof recordedAt !== 'string' || !DATE_TIME.test(recordedAt)) {
    throw new CalibrationValidationError(
      'invalid',
      'The recording time is invalid',
    );
  }
  const body = { ...record };
  delete body.quote_id;
  delete body.revision;
  delete body.recorded_at;
  rejectPhotographs(body);
  rejectPersonalData(body);
  const parsed = parseRepairObservation(body);
  return {
    schema_version: parsed.schema_version,
    quote_id: quoteId,
    revision,
    recorded_at: recordedAt,
    evidence: parsed.evidence,
    photo_status: parsed.photo_status,
    source: parsed.source,
    vehicle: parsed.vehicle,
    lines: parsed.lines,
    quoted_total_mxn: parsed.quoted_total_mxn,
    conditions: parsed.conditions,
    status: parsed.status,
  };
}

function parseRepairObservation(
  record: Record<string, unknown>,
): ValidatedRepairQuote {
  assertKeys(
    record,
    ROOT_KEYS,
    'The repair quote contains an undeclared field',
  );
  if (record.schema_version !== REPAIR_SCHEMA_VERSION) {
    throw new CalibrationValidationError(
      'invalid',
      'Unsupported repair schema version',
    );
  }
  if (record.evidence !== 'text_only') {
    throw new CalibrationValidationError(
      'invalid',
      'A textual repair quote is not a visual diagnosis',
    );
  }
  if (record.photo_status !== 'not_provided') {
    throw new CalibrationValidationError(
      'invalid',
      'A textual repair quote cannot claim photographs',
    );
  }
  if (record.status !== 'human_verified') {
    throw new CalibrationValidationError(
      'incomplete',
      'An authorized quote must be human verified',
    );
  }
  const source = readSource(record.source);
  const vehicle = readVehicle(record.vehicle);
  const lines = readLines(record.lines);
  const quotedTotal = readQuotedTotal(record.quoted_total_mxn, lines);
  const conditions = readConditions(record.conditions);
  return {
    schema_version: REPAIR_SCHEMA_VERSION,
    evidence: 'text_only',
    photo_status: 'not_provided',
    source,
    vehicle,
    lines,
    quoted_total_mxn: quotedTotal,
    conditions,
    status: 'human_verified',
  };
}

function readSource(value: unknown): ValidatedRepairQuote['source'] {
  const source = objectOf(value, 'The quote source is missing');
  assertKeys(
    source,
    SOURCE_KEYS,
    'The repair quote contains an undeclared field',
  );
  if (source.kind !== 'autofix_human_repair_quote') {
    throw new CalibrationValidationError(
      'invalid',
      'Unsupported repair source',
    );
  }
  return {
    kind: 'autofix_human_repair_quote',
    source_case_key: readKey(source.source_case_key, 'source_case_key'),
    opportunity_key: readKey(source.opportunity_key, 'opportunity_key'),
    prior_quote_id: readPrior(source.prior_quote_id),
    quoted_at: readQuotedAt(source.quoted_at),
  };
}

function readKey(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !REPAIR_SOURCE_KEY.test(value) ||
    reservedRepairKey(value)
  ) {
    throw new CalibrationValidationError(
      'invalid',
      `${label} is not a stable repair key`,
    );
  }
  assertNoPersonalText(value, label);
  return value;
}

function readPrior(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !REPAIR_QUOTE_ID.test(value)) {
    throw new CalibrationValidationError(
      'invalid',
      'The previous observation is not a repair quote',
    );
  }
  return value;
}

function readQuotedAt(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !DATE_TIME.test(value)) {
    throw new CalibrationValidationError(
      'invalid',
      'quoted_at must be a UTC timestamp or null',
    );
  }
  return value;
}

function readVehicle(value: unknown): ValidatedRepairQuote['vehicle'] {
  const vehicle = objectOf(value, 'The vehicle is missing');
  assertKeys(
    vehicle,
    VEHICLE_KEYS,
    'The repair quote contains an undeclared field',
  );
  const make = readTextIdentity(vehicle.make, vehicle.make_evidence, 'make');
  const model = readTextIdentity(
    vehicle.model,
    vehicle.model_evidence,
    'model',
  );
  const variant = readTextIdentity(
    vehicle.variant,
    vehicle.variant_evidence,
    'variant',
  );
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
): { value: string | null; evidence: RepairEvidence } {
  const kind = readEvidence(evidence, label);
  if (kind === 'unknown') {
    if (value != null && value !== '') {
      throw new CalibrationValidationError(
        'inconsistent_identity',
        `${label} cannot be both unknown and present`,
      );
    }
    return { value: null, evidence: 'unknown' };
  }
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) {
    throw new CalibrationValidationError(
      'incomplete',
      `${label} was not provided`,
    );
  }
  assertNoPersonalText(value, label);
  return { value: value.trim(), evidence: 'customer_provided' };
}

function readYear(
  value: unknown,
  evidence: unknown,
): { value: number | null; evidence: RepairEvidence } {
  const kind = readEvidence(evidence, 'year');
  if (kind === 'unknown') {
    if (value != null && value !== '') {
      throw new CalibrationValidationError(
        'inconsistent_identity',
        'year cannot be both unknown and present',
      );
    }
    return { value: null, evidence: 'unknown' };
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1900 ||
    value > 2100
  ) {
    throw new CalibrationValidationError('incomplete', 'year was not provided');
  }
  return { value, evidence: 'customer_provided' };
}

function readEvidence(value: unknown, label: string): RepairEvidence {
  if (value === 'visual_inference') {
    throw new CalibrationValidationError(
      'invalid',
      `${label} cannot be inferred without a visual expediente`,
    );
  }
  if (value !== 'customer_provided' && value !== 'unknown') {
    throw new CalibrationValidationError(
      'inconsistent_identity',
      `${label} evidence is not recognized`,
    );
  }
  return value;
}

function readLines(value: unknown): RepairLine[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CalibrationValidationError(
      'incomplete',
      'The repair quote has no lines',
    );
  }
  if (value.length > MAX_LINES) {
    throw new CalibrationValidationError(
      'invalid',
      'The repair quote has too many lines',
    );
  }
  const ids = new Set<string>();
  const roles = new Set<string>();
  const lines: RepairLine[] = [];
  for (const item of value) {
    const line = readLine(item);
    if (ids.has(line.line_id)) {
      throw new CalibrationValidationError(
        'invalid',
        'A line repeats its identity',
      );
    }
    const signature = `${line.part.toLocaleLowerCase('es-MX')}\0${line.role}\0${line.labor ?? ''}`;
    if (roles.has(signature)) {
      throw new CalibrationValidationError(
        'invalid',
        'The same part repeats a price role',
      );
    }
    ids.add(line.line_id);
    roles.add(signature);
    lines.push(line);
  }
  return lines;
}

function readLine(value: unknown): RepairLine {
  const line = objectOf(value, 'A repair line is missing');
  assertKeys(line, LINE_KEYS, 'The repair quote contains an undeclared field');
  if (typeof line.line_id !== 'string' || !LINE_ID.test(line.line_id)) {
    throw new CalibrationValidationError(
      'invalid',
      'A line identity is invalid',
    );
  }
  if (
    typeof line.part !== 'string' ||
    !line.part.trim() ||
    line.part.trim().length > 80
  ) {
    throw new CalibrationValidationError(
      'incomplete',
      'A part was not provided',
    );
  }
  assertNoPersonalText(line.part, 'part');
  const role = readRole(line.role);
  const labor = readLabor(role, line.labor);
  return {
    line_id: line.line_id,
    part: line.part.trim(),
    role,
    labor,
    prices: readPrices(line.prices),
  };
}

function readRole(value: unknown): RepairRole {
  if (value !== 'part' && value !== 'labor') {
    throw new CalibrationValidationError(
      'invalid',
      'The line role is not admitted',
    );
  }
  return value;
}

function readLabor(role: RepairRole, value: unknown): RepairLabor | null {
  if (role === 'part') {
    if (value != null) {
      throw new CalibrationValidationError(
        'invalid',
        'A part line cannot carry labor',
      );
    }
    return null;
  }
  if (
    typeof value !== 'string' ||
    !REPAIR_LABOR.includes(value as RepairLabor)
  ) {
    throw new CalibrationValidationError(
      'invalid',
      'The labor treatment is not admitted',
    );
  }
  return value as RepairLabor;
}

function readPrices(value: unknown): RepairLine['prices'] {
  const prices = objectOf(value, 'The line has no prices');
  assertKeys(
    prices,
    PRICE_KEYS,
    'The repair quote contains an undeclared field',
  );
  return {
    quoted: readPrice(prices.quoted, 'Quoted price', true),
    contracted: readPrice(prices.contracted, 'Contracted price', false),
    collected: readPrice(prices.collected, 'Collected price', false),
  };
}

function readPrice(
  value: unknown,
  label: string,
  required: boolean,
): RepairPriceSlot {
  if (value == null) {
    if (required) {
      throw new CalibrationValidationError(
        'unauthorized_price',
        `${label} is not an authorized human price`,
      );
    }
    return { amount_mxn: null, validation: 'not_provided' };
  }
  const slot = objectOf(value, 'A price must state its own validation');
  assertKeys(slot, SLOT_KEYS, 'The repair quote contains an undeclared field');
  if (slot.validation == null && slot.amount_mxn == null && !required) {
    return { amount_mxn: null, validation: 'not_provided' };
  }
  if (slot.validation === 'not_provided') {
    if (required || slot.amount_mxn != null) {
      throw new CalibrationValidationError(
        required ? 'unauthorized_price' : 'invalid',
        required
          ? `${label} is not an authorized human price`
          : 'An unconfirmed price cannot carry an amount',
      );
    }
    return { amount_mxn: null, validation: 'not_provided' };
  }
  if (slot.validation !== 'human_confirmed') {
    throw new CalibrationValidationError(
      'unauthorized_price',
      `${label} is not an authorized human price`,
    );
  }
  if (
    typeof slot.amount_mxn !== 'number' ||
    !Number.isSafeInteger(slot.amount_mxn) ||
    slot.amount_mxn < 1
  ) {
    throw new CalibrationValidationError(
      'unauthorized_price',
      `${label} is not an authorized human price`,
    );
  }
  return { amount_mxn: slot.amount_mxn, validation: 'human_confirmed' };
}

function readQuotedTotal(value: unknown, lines: readonly RepairLine[]): number {
  const sum = repairQuotedTotal(lines);
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value !== sum
  ) {
    throw new CalibrationValidationError(
      'invalid',
      'The declared total does not match the lines',
    );
  }
  return sum;
}

function readConditions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new CalibrationValidationError(
      'incomplete',
      'Commercial conditions were not declared',
    );
  }
  if (value.length > MAX_CONDITIONS) {
    throw new CalibrationValidationError(
      'invalid',
      'Commercial conditions were not declared',
    );
  }
  return value.map((item) => {
    if (typeof item !== 'string' || !item.trim() || item.trim().length > 240) {
      throw new CalibrationValidationError(
        'invalid',
        'Commercial conditions were not declared',
      );
    }
    assertNoPersonalText(item, 'conditions');
    return item.trim();
  });
}

function assertKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  message: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key))
      throw new CalibrationValidationError('invalid', message);
  }
}

function objectOf(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CalibrationValidationError('incomplete', message);
  }
  return value as Record<string, unknown>;
}

function rejectPhotographs(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectPhotographs);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (IMAGE_KEYS.has(key.toLowerCase())) {
      throw new CalibrationValidationError(
        'invalid',
        'The repair import does not accept photographs',
      );
    }
    rejectPhotographs(nested);
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
      throw new CalibrationValidationError(
        'personal_data',
        'The quote includes unnecessary personal data',
      );
    }
    if (typeof nested === 'string') assertNoPersonalText(nested, key);
    else rejectPersonalData(nested);
  }
}

function assertNoPersonalText(value: string, label: string): void {
  if (
    EMAIL.test(value) ||
    PHONE.test(value) ||
    PLATE.test(value) ||
    hasVin(value) ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new CalibrationValidationError(
      'personal_data',
      `${label} includes unnecessary personal data`,
    );
  }
}

function hasVin(value: string): boolean {
  return value
    .split(/[^A-Za-z0-9]/)
    .some(
      (part) =>
        /^[A-HJ-NPR-Z0-9]{17}$/i.test(part) &&
        /\d/.test(part) &&
        /[A-Z]/i.test(part),
    );
}
