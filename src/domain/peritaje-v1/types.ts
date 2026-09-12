/**
 * Contrato Canónico de Peritaje v1.
 *
 * Capa aislada del legacy (`DetectedDamageItem`, `DraftQuote`, OpenAI, TypeORM).
 * Persistible como JSON plano. No contiene objetos de proveedores externos.
 *
 * CanonicalPeritajeV1 = verdad técnica.
 * CanonicalQuoteV1    = verdad financiera.
 */

export const PERITAJE_SCHEMA_VERSION = 'peritaje.v1' as const;
export const QUOTE_SCHEMA_VERSION = 'quote.v1' as const;

export const TREATMENT_DECISIONS = [
  'REPARAR',
  'SUSTITUIR',
  'INCIERTO',
  'PENDIENTE',
] as const;

export type TreatmentDecision = (typeof TREATMENT_DECISIONS)[number];

export const QUOTE_SERVICE_TYPES = [
  'REPARACION_PINTURA',
  'REFACCION',
  'MONTAJE_PINTURA',
  'PENDIENTE',
  'ADVERTENCIA',
] as const;

export type QuoteServiceType = (typeof QUOTE_SERVICE_TYPES)[number];

export const IDENTITY_SOURCES = [
  'vision',
  'user',
  'operator',
  'inferred',
  'system',
] as const;

export type IdentitySource = (typeof IDENTITY_SOURCES)[number];

export const TREATMENT_SOURCES = [
  'vision',
  'user',
  'operator',
  'merge_rule',
  'degraded',
  'legacy',
] as const;

export type TreatmentSource = (typeof TREATMENT_SOURCES)[number];

export const DAMAGE_ITEM_SOURCES = [
  'vision',
  'user',
  'operator',
  'express',
  'market',
  'legacy',
] as const;

export type DamageItemSource = (typeof DAMAGE_ITEM_SOURCES)[number];

export const PRICING_SOURCES = [
  'AUTOFIX_CATALOG',
  'MARKET',
  'FALLBACK',
  'LEGACY_REPAIR_MATRIX_FALLBACK',
  'WEB_MARKET_ESTIMATE',
  'INSUFFICIENT_MARKET_SAMPLE',
  'MANUAL',
  'UNCONFIGURED',
] as const;

export type PricingSource = (typeof PRICING_SOURCES)[number];

export const PRICING_STATUSES = ['OK', 'INSUFFICIENT_MARKET_SAMPLE'] as const;
export type PricingStatus = (typeof PRICING_STATUSES)[number];

export const PRICING_TYPES = ['RANGE', 'NONE'] as const;
export type PricingType = (typeof PRICING_TYPES)[number];

export const CONFIDENCE_LEVELS = [
  'HIGH',
  'MEDIUM',
  'LOW',
  'UNKNOWN',
] as const;

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** Identidad vehicular estructurada. El legacy solo tiene `vehiculoDetectado: string`. */
export interface VehicleIdentity {
  vehicleId: string;
  make?: string;
  model?: string;
  year?: string;
  version?: string;
  generation?: string;
  displayLabel: string;
  confidence: ConfidenceLevel;
  source: IdentitySource;
  confirmedByUser: boolean;
}

export const EVIDENCE_TYPES = ['IMAGE'] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const EVIDENCE_SOURCES = ['customer', 'operator', 'system'] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/**
 * Una pieza de evidencia (hoy: foto del cliente).
 * `evidenceId` es estable por URL para no duplicar al reconstruir.
 */
export interface DamageEvidence {
  evidenceId: string;
  type: EvidenceType;
  url: string;
  messageId?: string;
  source: EvidenceSource;
}

export interface PossibleHiddenDamage {
  detected: boolean;
  areas: string[];
  requiresDisassembly: boolean;
}

/**
 * Decisión técnica de una pieza física en un vehículo.
 * No lleva importes: el dinero vive en QuoteLine.
 */
export interface DamageItem {
  damageItemId: string;
  vehicleId: string;
  pieceCode: string;
  pieceLabel: string;
  physicalPanelKey: string;
  severity: string;
  damageType?: string;
  descriptionTechnical: string;
  treatment: TreatmentDecision;
  treatmentConfidence: ConfidenceLevel;
  treatmentSource: TreatmentSource;
  treatmentReason: string;
  requiresReplacement: boolean;
  possibleReplacement: boolean;
  possibleHiddenDamage?: PossibleHiddenDamage;
  evidence: DamageEvidence[];
  source: DamageItemSource;
}

/** Identidad física para merges futuros: nunca solo `physicalPanelKey`. */
export interface PhysicalPieceIdentity {
  vehicleId: string;
  physicalPanelKey: string;
}

export interface PeritajeViability {
  viable: boolean;
  reasonCode?: string;
  clientClarification?: string;
}

export interface CanonicalPeritajeV1 {
  schemaVersion: typeof PERITAJE_SCHEMA_VERSION;
  peritajeId: string;
  conversationId: string;
  tallerId: string | null;
  vehicles: VehicleIdentity[];
  damages: DamageItem[];
  viability: PeritajeViability;
  createdAt: string;
  updatedAt: string;
}

export interface PriceRange {
  min: number;
  max: number;
  central: number;
}

/** Evidencia de mercado adjunta a una línea económica, no a la decisión visual. */
export interface MarketEvidence {
  sampleCount?: number;
  domainCount?: number;
  providersUsed?: string[];
  partTypeGroup?: string;
  marketPriceRange?: PriceRange;
  query?: string;
}

/**
 * Línea económica. `treatment` no vive aquí: el servicio es `serviceType`.
 * Una pieza SUSTITUIR puede emitir REFACCION + MONTAJE_PINTURA.
 */
export interface QuoteLine {
  quoteLineId: string;
  damageItemId: string;
  /**
   * Identidad comercial (express / extra / BPC sin daño visual).
   * No es un DamageItem falso: vive fuera del peritaje.
   */
  commercialItemId?: string;
  vehicleId: string;
  serviceType: QuoteServiceType;
  description: string;
  billable: boolean;
  amount: number;
  priceRange?: PriceRange;
  pricingSource?: PricingSource;
  pricingStatus?: PricingStatus;
  pricingType?: PricingType;
  confidence: ConfidenceLevel;
  marketEvidence?: MarketEvidence;
}

export const COMMERCIAL_ITEM_SOURCES = ['express', 'bpc', 'operator'] as const;
export type CommercialItemSource = (typeof COMMERCIAL_ITEM_SOURCES)[number];

/**
 * Concepto cobrable que no es un daño visual.
 * Extra express, addon de color, servicio pedido por texto.
 */
export interface CommercialItemV1 {
  commercialItemId: string;
  vehicleId: string;
  serviceKey: string;
  serviceLabel: string;
  source: CommercialItemSource;
}

export interface CanonicalQuoteV1 {
  schemaVersion: typeof QUOTE_SCHEMA_VERSION;
  quoteId: string;
  peritajeId: string;
  lines: QuoteLine[];
  subtotal: number;
  total: number;
  isPartial: boolean;
  warnings: string[];
  generatedAt: string;
}

export interface InvariantViolation {
  code: string;
  message: string;
  path?: string;
}
