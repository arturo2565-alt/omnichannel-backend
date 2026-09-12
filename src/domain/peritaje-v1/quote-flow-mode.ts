/**
 * Fase 7 — un carrito es CANONICAL o LEGACY, nunca ambas a la vez.
 */
import { isCanonicalNarrativeEligible } from './quote-narrative';
import { canAttemptCanonicalFinancialFlow } from './quote-engine';
import type { CanonicalPeritajeV1, CanonicalQuoteV1, CommercialItemV1 } from './types';

export const QUOTE_FLOW_MODE = {
  CANONICAL: 'CANONICAL',
  LEGACY: 'LEGACY',
} as const;

export type QuoteFlowMode = (typeof QUOTE_FLOW_MODE)[keyof typeof QUOTE_FLOW_MODE];

export const FLOW_EVENTS = {
  NON_CANONICAL_MONEY_PATH: 'NON_CANONICAL_MONEY_PATH',
  FRONTEND_FINANCIAL_FALLBACK_ATTEMPT: 'FRONTEND_FINANCIAL_FALLBACK_ATTEMPT',
  MODERN_FLOW_LEGACY_DOWNGRADE: 'MODERN_FLOW_LEGACY_DOWNGRADE',
  UNMODELED_EXTRA_AMOUNT: 'UNMODELED_EXTRA_AMOUNT',
  DUPLICATE_FINANCIAL_RENDERER: 'DUPLICATE_FINANCIAL_RENDERER',
  CANONICAL_MODE_AMBIGUOUS: 'CANONICAL_MODE_AMBIGUOUS',
} as const;

export type QuoteFlowDecision = {
  mode: QuoteFlowMode;
  reason: string;
  upgraded: boolean;
  blockedDowngrade: boolean;
};

export function resolveQuoteFlowMode(input: {
  lockedMode?: QuoteFlowMode | string | null;
  canonicalQuote?: CanonicalQuoteV1 | null;
  canonicalPeritaje?: CanonicalPeritajeV1 | null;
  commercialEntries?: readonly CommercialItemV1[] | null;
  fromExpress?: boolean;
  /** Carrito nuevo / mutación moderna sin peritaje visual (agregarAlCarrito). */
  preferCanonical?: boolean;
}): QuoteFlowDecision {
  const locked = String(input.lockedMode ?? '').toUpperCase();
  const hasQuote = isCanonicalNarrativeEligible(input.canonicalQuote);
  const hasPeritaje = canAttemptCanonicalFinancialFlow(input.canonicalPeritaje);
  const hasCommercial = (input.commercialEntries?.length ?? 0) > 0;
  const modernSignal =
    hasQuote ||
    hasPeritaje ||
    hasCommercial ||
    input.fromExpress === true ||
    input.preferCanonical === true;

  if (locked === QUOTE_FLOW_MODE.CANONICAL) {
    if (!modernSignal) {
      return {
        mode: QUOTE_FLOW_MODE.CANONICAL,
        reason: 'locked_canonical_no_downgrade',
        upgraded: false,
        blockedDowngrade: true,
      };
    }
    return {
      mode: QUOTE_FLOW_MODE.CANONICAL,
      reason: 'locked_canonical',
      upgraded: false,
      blockedDowngrade: false,
    };
  }

  if (modernSignal) {
    return {
      mode: QUOTE_FLOW_MODE.CANONICAL,
      reason: hasQuote
        ? 'canonical_quote'
        : hasPeritaje
          ? 'canonical_peritaje'
          : hasCommercial
            ? 'commercial_entries'
            : input.fromExpress === true
              ? 'express_source'
              : 'prefer_canonical',
      upgraded: locked === QUOTE_FLOW_MODE.LEGACY,
      blockedDowngrade: false,
    };
  }

  if (locked === QUOTE_FLOW_MODE.LEGACY) {
    return {
      mode: QUOTE_FLOW_MODE.LEGACY,
      reason: 'locked_legacy',
      upgraded: false,
      blockedDowngrade: false,
    };
  }

  return {
    mode: QUOTE_FLOW_MODE.LEGACY,
    reason: 'no_canonical_signal',
    upgraded: false,
    blockedDowngrade: false,
  };
}

/**
 * Panel moderno: si falla la API, no se reconstruye un total local.
 * Solo se reutiliza texto/financialBlock ya persistido.
 */
export function resolveModernPanelFallbackText(input: {
  quoteFlowMode?: string | null;
  narrativeFlow?: string | null;
  hasCanonicalQuote?: boolean;
  persistedFinalMessage?: string;
  persistedFinancialBlock?: string;
}): { text: string; usedLocalFinance: boolean } {
  const modern =
    input.quoteFlowMode === QUOTE_FLOW_MODE.CANONICAL ||
    input.narrativeFlow === 'CANONICAL_NARRATIVE_FLOW' ||
    input.hasCanonicalQuote === true;
  if (!modern) {
    return { text: '', usedLocalFinance: false };
  }
  const text = String(
    input.persistedFinalMessage || input.persistedFinancialBlock || '',
  ).trim();
  if (!text) {
    logFlowEvent(FLOW_EVENTS.FRONTEND_FINANCIAL_FALLBACK_ATTEMPT, {
      blocked: true,
    });
  }
  return { text, usedLocalFinance: false };
}

export function logFlowEvent(
  event: string,
  payload: Record<string, unknown>,
): void {
  console.log(
    '[QuoteFlow]',
    JSON.stringify({
      event,
      ...payload,
    }),
  );
}
