/**
 * Contrato de una cotización humana de calibración.
 * Es una observación. No es CanonicalQuoteV1 y no autoriza precios de producción.
 * La fuente versionada vive en pegazuz-calibration-data (schema/case-v1.schema.json,
 * commit 35818ba9f3fb4ee8beecea1f7d09f7e2e4022cfd). Este módulo aplica ese contrato
 * y reglas más estrictas para una cotización autorizada.
 */

export const CALIBRATION_SCHEMA_VERSION = '1.0.0';
export const EVIDENCE_KINDS = ['customer_provided', 'visual_inference', 'unknown'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const TREATMENTS = [
  'repair_paint',
  'paint',
  'replace_paint',
  'replace',
  'other',
  'uncertain',
] as const;
export type CalibrationTreatment = (typeof TREATMENTS)[number];

export type CalibrationValidationCode =
  | 'incomplete'
  | 'unauthorized_price'
  | 'inconsistent_identity'
  | 'personal_data'
  | 'invalid';

export class CalibrationValidationError extends Error {
  readonly code: CalibrationValidationCode;
  constructor(code: CalibrationValidationCode, message: string) {
    super(message);
    this.name = 'CalibrationValidationError';
    this.code = code;
  }
}

export type CalibrationLine = {
  line_id: string;
  part: string;
  treatment: CalibrationTreatment;
  price_mxn: number;
  damage_severity: 'minor' | 'moderate' | 'severe' | 'unknown';
  validation: 'human_confirmed';
};

export type ValidatedHumanQuote = {
  schema_version: typeof CALIBRATION_SCHEMA_VERSION;
  source: {
    kind: 'autofix_human_quote';
    source_case_key: string;
    quoted_at: string | null;
  };
  vehicle: {
    make: string | null;
    model: string | null;
    year: number | null;
    variant: string | null;
    make_evidence: EvidenceKind;
    model_evidence: EvidenceKind;
    year_evidence: EvidenceKind;
  };
  line_items: CalibrationLine[];
  visual_observations: string[];
  status: 'human_verified';
};

const SOURCE_KEY = /^[a-zA-Z0-9_.:-]{4,150}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /\d{10,}/;
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

export function nextCalibrationCaseId(used: readonly string[]): string {
  let max = 0;
  for (const id of used) {
    const match = /^AF-(\d{6})$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  const next = max + 1;
  if (next > 999999) {
    throw new CalibrationValidationError('invalid', 'Case identifier space exhausted');
  }
  return `AF-${String(next).padStart(6, '0')}`;
}

export function validateHumanQuote(input: unknown): ValidatedHumanQuote {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CalibrationValidationError('incomplete', 'The quote is missing');
  }
  rejectPersonalData(input);
  const record = input as Record<string, unknown>;
  if (record.schema_version != null && record.schema_version !== CALIBRATION_SCHEMA_VERSION) {
    throw new CalibrationValidationError('invalid', 'Unsupported calibration schema version');
  }
  if (record.status !== 'human_verified') {
    throw new CalibrationValidationError('incomplete', 'An authorized quote must be human verified');
  }
  const source = readSource(record.source);
  const vehicle = readVehicle(record.vehicle);
  const lineItems = readLines(record.line_items);
  const observations = readObservations(record.visual_observations);
  return {
    schema_version: CALIBRATION_SCHEMA_VERSION,
    source,
    vehicle,
    line_items: lineItems,
    visual_observations: observations,
    status: 'human_verified',
  };
}

function readSource(value: unknown): ValidatedHumanQuote['source'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CalibrationValidationError('incomplete', 'The quote source is missing');
  }
  const source = value as Record<string, unknown>;
  if (source.kind !== 'autofix_human_quote') {
    throw new CalibrationValidationError('invalid', 'Only a human AutoFix quote can be recorded');
  }
  if (typeof source.source_case_key !== 'string' || !SOURCE_KEY.test(source.source_case_key)) {
    throw new CalibrationValidationError('incomplete', 'The source key is missing or unstable');
  }
  let quotedAt: string | null = null;
  if (source.quoted_at != null) {
    if (typeof source.quoted_at !== 'string' || !DATE_TIME.test(source.quoted_at)) {
      throw new CalibrationValidationError('invalid', 'quoted_at must be an explicit UTC timestamp or null');
    }
    quotedAt = source.quoted_at;
  }
  return { kind: 'autofix_human_quote', source_case_key: source.source_case_key, quoted_at: quotedAt };
}

function readVehicle(value: unknown): ValidatedHumanQuote['vehicle'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CalibrationValidationError('incomplete', 'The vehicle is missing');
  }
  const vehicle = value as Record<string, unknown>;
  return {
    make: readIdentityValue(vehicle.make, vehicle.make_evidence, 'make'),
    model: readIdentityValue(vehicle.model, vehicle.model_evidence, 'model'),
    year: readYear(vehicle.year, vehicle.year_evidence),
    variant: readOptionalText(vehicle.variant, 'variant'),
    make_evidence: evidenceOf(vehicle.make_evidence, 'make'),
    model_evidence: evidenceOf(vehicle.model_evidence, 'model'),
    year_evidence: evidenceOf(vehicle.year_evidence, 'year'),
  };
}

function readIdentityValue(value: unknown, evidence: unknown, label: string): string | null {
  const kind = evidenceOf(evidence, label);
  if (value == null || value === '') {
    if (kind !== 'unknown') {
      throw new CalibrationValidationError(
        'inconsistent_identity',
        `${label} evidence requires a value`,
      );
    }
    return null;
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new CalibrationValidationError('incomplete', `${label} is incomplete`);
  }
  if (kind === 'unknown') {
    throw new CalibrationValidationError(
      'inconsistent_identity',
      `${label} is unknown and must stay empty`,
    );
  }
  assertNoPersonalText(value, label);
  return value.trim();
}

function readYear(value: unknown, evidence: unknown): number | null {
  const kind = evidenceOf(evidence, 'year');
  if (value == null) {
    if (kind !== 'unknown') {
      throw new CalibrationValidationError('inconsistent_identity', 'year evidence requires a value');
    }
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1900 || value > 2100) {
    throw new CalibrationValidationError('invalid', 'year is outside the calibration contract');
  }
  if (kind === 'unknown') {
    throw new CalibrationValidationError('inconsistent_identity', 'year is unknown and must stay empty');
  }
  return value;
}

function evidenceOf(value: unknown, label: string): EvidenceKind {
  if (value !== 'customer_provided' && value !== 'visual_inference' && value !== 'unknown') {
    throw new CalibrationValidationError('incomplete', `${label} evidence is required`);
  }
  return value;
}

function readLines(value: unknown): CalibrationLine[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CalibrationValidationError('incomplete', 'The quote has no line items');
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new CalibrationValidationError('incomplete', `Line ${index + 1} is incomplete`);
    }
    const line = entry as Record<string, unknown>;
    if (typeof line.line_id !== 'string' || !line.line_id.trim()) {
      throw new CalibrationValidationError('incomplete', `Line ${index + 1} has no id`);
    }
    if (seen.has(line.line_id)) {
      throw new CalibrationValidationError('invalid', `Line id ${line.line_id} is duplicated`);
    }
    seen.add(line.line_id);
    if (typeof line.part !== 'string' || !line.part.trim()) {
      throw new CalibrationValidationError('incomplete', `Line ${index + 1} has no part`);
    }
    assertNoPersonalText(line.part, 'part');
    if (!TREATMENTS.includes(line.treatment as CalibrationTreatment)) {
      throw new CalibrationValidationError('incomplete', `Line ${index + 1} has no treatment`);
    }
    if (line.validation !== 'human_confirmed') {
      throw new CalibrationValidationError(
        'unauthorized_price',
        `Line ${line.line_id} is not an authorized human price`,
      );
    }
    if (typeof line.price_mxn !== 'number' || !Number.isInteger(line.price_mxn) || line.price_mxn < 1) {
      throw new CalibrationValidationError(
        'unauthorized_price',
        `Line ${line.line_id} has no authorized integer price`,
      );
    }
    const severity = line.damage_severity ?? 'unknown';
    if (severity !== 'minor' && severity !== 'moderate' && severity !== 'severe' && severity !== 'unknown') {
      throw new CalibrationValidationError('invalid', `Line ${line.line_id} has an unknown severity`);
    }
    return {
      line_id: line.line_id.trim(),
      part: line.part.trim(),
      treatment: line.treatment as CalibrationTreatment,
      price_mxn: line.price_mxn,
      damage_severity: severity,
      validation: 'human_confirmed' as const,
    };
  });
}

function readObservations(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new CalibrationValidationError('invalid', 'Visual observations must be plain text');
  }
  value.forEach((item) => assertNoPersonalText(item, 'observation'));
  return value.map((item) => item.trim());
}

function readOptionalText(value: unknown, label: string): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw new CalibrationValidationError('invalid', `${label} must be text or null`);
  }
  assertNoPersonalText(value, label);
  return value.trim();
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
    rejectPersonalData(nested);
  }
}

function assertNoPersonalText(value: string, label: string): void {
  if (EMAIL.test(value) || PHONE.test(value)) {
    throw new CalibrationValidationError('personal_data', `${label} includes unnecessary personal data`);
  }
}
