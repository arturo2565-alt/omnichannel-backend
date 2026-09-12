export {
  PERITAJE_SCHEMA_VERSION,
  QUOTE_SCHEMA_VERSION,
  TREATMENT_DECISIONS,
  QUOTE_SERVICE_TYPES,
  IDENTITY_SOURCES,
  TREATMENT_SOURCES,
  DAMAGE_ITEM_SOURCES,
  PRICING_SOURCES,
  PRICING_STATUSES,
  PRICING_TYPES,
  CONFIDENCE_LEVELS,
} from './types';

export type {
  TreatmentDecision,
  QuoteServiceType,
  IdentitySource,
  TreatmentSource,
  DamageItemSource,
  PricingSource,
  PricingStatus,
  PricingType,
  ConfidenceLevel,
  EvidenceType,
  EvidenceSource,
  VehicleIdentity,
  DamageEvidence,
  PossibleHiddenDamage,
  DamageItem,
  PhysicalPieceIdentity,
  PeritajeViability,
  CanonicalPeritajeV1,
  PriceRange,
  MarketEvidence,
  QuoteLine,
  CanonicalQuoteV1,
  InvariantViolation,
  CommercialItemV1,
  CommercialItemSource,
} from './types';

export { COMMERCIAL_ITEM_SOURCES } from './types';

export {
  UNKNOWN_VEHICLE_ID,
  createVehicleId,
  createEvidenceId,
  createImageEvidence,
  createDamageItemId,
  createQuoteLineId,
  createPeritajeId,
  createQuoteId,
  createCommercialItemId,
  createCommercialCatalogId,
  isCommercialItemId,
  physicalMergeKey,
  normalizePhysicalPanelKey,
} from './ids';

export {
  isStructuredTreatment,
  parseStructuredTreatment,
  resolveLockedTreatment,
  rejectTextInferenceWhenLocked,
  treatmentImpliesReplacement,
  mergeLockedTreatments,
} from './treatment';

export type { TreatmentLockMode, TreatmentResolution } from './treatment';

export {
  expectedServiceTypesForTreatment,
  treatmentIsDistinctFromServiceType,
  validateCanonicalPeritajeV1,
  validateCanonicalQuoteV1,
  assumesIndexCorrespondence,
} from './invariants';

export {
  vehicleIdentityFromLegacyLabel,
  resolveModernVehicleIdentity,
  damageItemFromLegacy,
  peritajeFromLegacyAnalysis,
} from './from-legacy';

export type {
  LegacyDetectedDamageShape,
  LegacyAnalysisShape,
  LegacyViabilityShape,
} from './from-legacy';

export {
  SHADOW_DIFF_TYPES,
  resolveShadowVehicleIdentity,
  normalizeEvidenceList,
  mergeDamageEvidence,
  mergeShadowPeritaje,
  buildVisionCanonicalShadow,
  tryBuildVisionCanonicalShadow,
  isCanonicalPeritajeV1,
  selectCanonicalShadowToPersist,
  compareLegacyVsCanonical,
  formatShadowLogPayload,
} from './shadow';

export type {
  ShadowDiffType,
  ShadowDifference,
  CanonicalShadowComparison,
  LegacyProjectionShape,
  ShadowVehicleHints,
} from './shadow';

export {
  CANONICAL_QUOTE_WARNINGS,
  FINANCIAL_DIFF_TYPES,
  isChargeableQuoteLine,
  sumChargeableAmount,
  deriveIsPartial,
  deriveCanonicalWarnings,
  finalizeCanonicalQuote,
  canAttemptCanonicalFinancialFlow,
  isCanonicalFinancialAuthority,
  validateCanonicalQuoteFinancial,
  compareCanonicalVsLegacyFinance,
} from './quote-engine';

export type { FinancialDiffType, FinancialDifference } from './quote-engine';

export {
  NARRATIVE_FLOW,
  NARRATIVE_EVENTS,
  CANONICAL_WARNING_COPY,
  isCanonicalNarrativeEligible,
  formatQuoteMoney,
  formatQuoteMoneyRange,
  inferPieceLabelFromQuoteLine,
  resolveQuoteLinePieceLabel,
  buildControlledQuoteLineLabel,
  renderCanonicalQuoteFinancialBlock,
  renderCanonicalQuoteWarningsBlock,
  assembleClientQuoteMessage,
  extractMonetaryAmounts,
  llmNarrativeContainsForbiddenMoney,
  sanitizeLlmNarrativeParts,
  validateFinalClientQuoteMessage,
  logNarrativeEvents,
  renderDeterministicClientQuoteFallback,
  buildNarrativeSnapshotFields,
} from './quote-narrative';

export type {
  NarrativeFlow,
  NarrativeEventCode,
  NarrativeObservabilityEvent,
  ClientQuoteMessage,
  LlmNarrativeParts,
  RenderedFinancialBlock,
  FinalMessageValidation,
  MonetaryHit,
  NarrativeSendSnapshotFields,
} from './quote-narrative';

export {
  QUOTE_FLOW_MODE,
  FLOW_EVENTS,
  resolveQuoteFlowMode,
  resolveModernPanelFallbackText,
  logFlowEvent,
} from './quote-flow-mode';

export type { QuoteFlowMode, QuoteFlowDecision } from './quote-flow-mode';

export {
  buildAggregateQuoteView,
  renderAggregateFinancialBlock,
  composeAggregateClientQuoteMessage,
  quotesMixVehicles,
} from './aggregate-quote';

export type { AggregateQuoteView, LabeledVehicleQuote } from './aggregate-quote';
