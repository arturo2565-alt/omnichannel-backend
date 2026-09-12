import type { DetectedDamageItem } from '../../chat/entities/chat.entity';
import type { TreatmentDecision, QuoteServiceType } from '../../domain/peritaje-v1';

export type AutonomyCaseKind =
  | 'vision'
  | 'express'
  | 'commercial'
  | 'panel_manual'
  | 'multi_vehicle'
  | 'adversarial_narrative'
  | 'adversarial_safety'
  | 'product_decision';

export type AutonomyCertificationCase = {
  caseId: string;
  description: string;
  category: string;
  kind: AutonomyCaseKind;
  productDecisionRequired?: string;
  input: {
    visionItems?: DetectedDamageItem[];
    priorTreatments?: Array<{
      pieza: string;
      treatment: TreatmentDecision;
      vehicleLabel?: string;
    }>;
    vehicleContext?: string;
    express?: {
      lines: Array<{
        servicio: string;
        canonical?: string;
        tipo?: string;
        precioLineaMx: number;
      }>;
      extras?: Array<{ label: string; amount: number }>;
      vehicleDisplayLabel?: string;
      modeloVehiculo?: string;
    };
    extraLines?: Array<{ label: string; amount: number }>;
    secondVehicleExpress?: AutonomyCertificationCase['input']['express'];
    injectedLlmParts?: {
      intro: string;
      technicalExplanation: string;
      cta: string;
    };
    simulateOpenaiFailure?: boolean;
    simulateRebuildFailure?: boolean;
    simulateFrontendFallback?: boolean;
    simulateDowngrade?: boolean;
    manualAmount?: number;
    forcedQuoteLines?: Array<{
      serviceType: import('../../domain/peritaje-v1').QuoteServiceType;
      amount: number;
      billable: boolean;
      description?: string;
      pricingSource?: string;
      pricingStatus?: string;
      vehicleId?: string;
    }>;
  };
  expected: {
    vehicleLabel?: string;
    treatments?: TreatmentDecision[];
    quoteLines?: Array<{
      serviceType: QuoteServiceType;
      billable?: boolean;
      pricingSource?: string;
      pricingStatus?: string;
    }>;
    total?: number;
    isPartial?: boolean;
    requiredWarnings?: string[];
    forbiddenServiceTypes?: QuoteServiceType[];
    shouldRequestMoreEvidence?: boolean;
    sameDamageItemId?: boolean;
    distinctVehicleIds?: boolean;
    quoteFlowMode?: 'CANONICAL' | 'LEGACY';
    pricingSource?: string;
    noInventedMoney?: boolean;
    noUnsafeLegacyFallback?: boolean;
    usedLocalFinance?: boolean;
  };
};

export type CaseFailureCode =
  | 'WRONG_TREATMENT'
  | 'WRONG_QUOTE_LINE'
  | 'WRONG_TOTAL'
  | 'INVENTED_MONEY'
  | 'MISSING_REQUIRED_WARNING'
  | 'PARTIAL_PRESENTED_AS_COMPLETE'
  | 'CROSS_VEHICLE_MIX'
  | 'WRONG_EVIDENCE_ASSOCIATION'
  | 'UNSAFE_LEGACY_FALLBACK'
  | 'MISSING_MONTAJE_PINTURA'
  | 'WRONG_PRICING_SOURCE'
  | 'FRONTEND_FINANCIAL_FALLBACK'
  | 'PIPELINE_ERROR';

export type CaseActual = {
  treatments: TreatmentDecision[];
  serviceTypes: QuoteServiceType[];
  quoteLines: Array<{
    serviceType: QuoteServiceType;
    billable: boolean;
    amount: number;
    vehicleId: string;
    damageItemId: string;
    pricingSource?: string;
    pricingStatus?: string;
  }>;
  total: number;
  isPartial: boolean;
  warnings: string[];
  finalMessage: string;
  financialBlock: string;
  quoteFlowMode: 'CANONICAL' | 'LEGACY' | 'BLOCKED';
  damageItemIds: string[];
  vehicleIds: string[];
  inventedMoney: boolean;
  unsafeLegacyFallback: boolean;
  usedLocalFinance: boolean;
  narrativeOk: boolean;
};

export type CaseCompareResult = {
  caseId: string;
  passed: boolean;
  productDecision?: string;
  failures: CaseFailureCode[];
  trace: string;
};

export type CertificationReport = {
  casesTotal: number;
  casesPassed: number;
  casesFailed: number;
  vehicleIdentityAccuracy: number;
  pieceDetectionAccuracy: number;
  treatmentAccuracy: number;
  quoteLineAccuracy: number;
  financialExactMatchRate: number;
  warningRecall: number;
  partialQuoteCorrectness: number;
  narrativeFinancialIntegrityRate: number;
  unsafeLegacyFallbackCount: number;
  crossVehicleCollisions: number;
  inventedMonetaryAmounts: number;
  knownProductDecisions: string[];
  failures: Array<{ caseId: string; failures: CaseFailureCode[] }>;
};
