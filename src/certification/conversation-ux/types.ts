import type {
  ClientMessageMode,
  CtaType,
} from '../../chat/client-message-ux';

export const CONVERSATION_UX_CHECK_IDS = [
  'initial_quote_greeting',
  'resume_no_greeting',
  'resume_delta_only',
  'resume_no_technical_repeat',
  'correction_delta',
  'update_delta',
  'full_refresh',
  'appointment_no_quote',
  'warning_ux',
  'cta_state',
  'human_labels',
  'financial_integrity',
  'vehicle_correction_reruns_market',
  'full_refresh_emits_financial_block',
  'no_appointment_assumption',
] as const;

export type ConversationUxCheckId = (typeof CONVERSATION_UX_CHECK_IDS)[number];

export type ConversationUxCheckTitle =
  | '1. Initial quote greeting'
  | '2. Resume no greeting'
  | '3. Resume delta only'
  | '4. Resume no technical repeat'
  | '5. Correction delta'
  | '6. Update delta'
  | '7. Full refresh'
  | '8. Appointment no quote'
  | '9. Warning UX'
  | '10. CTA state'
  | '11. Human labels'
  | '12. Financial integrity'
  | '13. Vehicle correction reruns market'
  | '14. Full refresh emits financial block'
  | '15. No appointment assumption';

export const CONVERSATION_UX_CHECK_TITLES: Record<
  ConversationUxCheckId,
  ConversationUxCheckTitle
> = {
  initial_quote_greeting: '1. Initial quote greeting',
  resume_no_greeting: '2. Resume no greeting',
  resume_delta_only: '3. Resume delta only',
  resume_no_technical_repeat: '4. Resume no technical repeat',
  correction_delta: '5. Correction delta',
  update_delta: '6. Update delta',
  full_refresh: '7. Full refresh',
  appointment_no_quote: '8. Appointment no quote',
  warning_ux: '9. Warning UX',
  cta_state: '10. CTA state',
  human_labels: '11. Human labels',
  financial_integrity: '12. Financial integrity',
  vehicle_correction_reruns_market: '13. Vehicle correction reruns market',
  full_refresh_emits_financial_block: '14. Full refresh emits financial block',
  no_appointment_assumption: '15. No appointment assumption',
};

export type ConversationUxFailureCode =
  | 'WRONG_MODE'
  | 'UNEXPECTED_GREETING'
  | 'MISSING_GREETING'
  | 'FULL_QUOTE_UNEXPECTED'
  | 'DELTA_NOT_RENDERED'
  | 'TECHNICAL_REPEAT'
  | 'UNCHANGED_LINE_RENDERED'
  | 'MISSING_REQUIRED_COPY'
  | 'WARNING_UX'
  | 'WRONG_CTA'
  | 'INTERNAL_LABEL'
  | 'INVENTED_MONEY'
  | 'WRONG_TOTAL'
  | 'POST_FILTER_REQUIRED'
  | 'MARKET_NOT_RERUN'
  | 'MISSING_FINANCIAL_BLOCK'
  | 'IDENTITY_NOT_PRESERVED';

export type ConversationUxActual = {
  checkId: ConversationUxCheckId;
  mode?: ClientMessageMode;
  shouldGreet?: boolean;
  fullQuoteRendered?: boolean;
  deltaRendered?: boolean;
  technicalExplanationRendered?: boolean;
  greetingRendered?: boolean;
  ctaType?: CtaType;
  finalMessage: string;
  financialBlock: string;
  canonicalTotal: number;
  displayedTotalMatches: boolean;
  inventedAmounts: number;
  warningsRenderedCount: number;
  postFilterInterventions: number;
  preFilterClean: boolean;
  humanLabelLeak: boolean;
  materialTechnicalChange?: boolean;
  ctaSequence?: CtaType[];
  resumeWarningsRepeated?: boolean;
  appointmentCtaRepeated?: boolean;
  marketLookupCount?: number;
  idsPreserved?: boolean;
  oldMarketIdentityKey?: string;
  newMarketIdentityKey?: string;
  visionCalled?: boolean;
  financialBlockPresent?: boolean;
};

export type ConversationUxCompareResult = {
  checkId: ConversationUxCheckId;
  title: ConversationUxCheckTitle;
  passed: boolean;
  failures: ConversationUxFailureCode[];
  actual: ConversationUxActual;
};

export type ConversationUxReport = {
  casesTotal: number;
  casesPassed: number;
  casesFailed: number;
  greetingDuplicates: number;
  fullQuoteUnexpectedRenders: number;
  technicalRepeatViolations: number;
  internalLabelsExposed: number;
  inventedAmounts: number;
  postFilterInterventions: number;
  failures: Array<{
    checkId: ConversationUxCheckId;
    failures: ConversationUxFailureCode[];
  }>;
};
