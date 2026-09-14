import {
  REFACCION_AVAILABILITY_DISCLAIMER,
  extractMonetaryAmounts,
  formatQuoteMoney,
  formatQuoteMoneyRange,
} from '../../domain/peritaje-v1/quote-narrative';
import type {
  ConversationUxActual,
  ConversationUxCheckId,
  ConversationUxCompareResult,
  ConversationUxFailureCode,
} from './types';
import { CONVERSATION_UX_CHECK_TITLES } from './types';
import {
  ALTAMA_TOTAL_AFTER,
  CALAVERA_RANGE_MAX,
  CALAVERA_RANGE_MIN,
} from './fixtures';

const GREETING_RE = /\bhola\b|👋|¡\s*listo/i;
const TECH_REPEAT_RE =
  /ya revisamos|ya analizamos|se observa|se aprecia|el da[nñ]o visible/i;
const UNCHANGED_BODY_RE =
  /fascia trasera|salpicadera trasera derecha|tapa de cajuela/i;
const APPOINTMENT_OFFER_RE = /¿quieres (?:que )?agendar|agendemos/i;

function push(
  failures: ConversationUxFailureCode[],
  code: ConversationUxFailureCode,
  cond: boolean,
) {
  if (cond) failures.push(code);
}

function commonFinancial(actual: ConversationUxActual, failures: ConversationUxFailureCode[]) {
  push(failures, 'WRONG_TOTAL', !actual.displayedTotalMatches && actual.canonicalTotal > 0 && actual.mode !== 'APPOINTMENT_FOLLOWUP');
  push(failures, 'INVENTED_MONEY', actual.inventedAmounts > 0);
  push(failures, 'INTERNAL_LABEL', actual.humanLabelLeak);
}

export function compareConversationUxCheck(
  checkId: ConversationUxCheckId,
  actual: ConversationUxActual,
): ConversationUxCompareResult {
  const failures: ConversationUxFailureCode[] = [];
  const msg = actual.finalMessage;

  switch (checkId) {
    case 'initial_quote_greeting': {
      push(failures, 'WRONG_MODE', actual.mode !== 'INITIAL_QUOTE');
      push(failures, 'MISSING_GREETING', actual.shouldGreet !== true);
      push(failures, 'FULL_QUOTE_UNEXPECTED', actual.fullQuoteRendered !== true);
      push(failures, 'TECHNICAL_REPEAT', actual.technicalExplanationRendered !== true);
      push(failures, 'MISSING_REQUIRED_COPY', !/cotizaci[oó]n preliminar/i.test(msg));
      commonFinancial(actual, failures);
      break;
    }
    case 'resume_no_greeting': {
      push(failures, 'WRONG_MODE', actual.mode !== 'QUOTE_RESUME');
      push(failures, 'UNEXPECTED_GREETING', actual.shouldGreet !== false || GREETING_RE.test(msg));
      push(failures, 'TECHNICAL_REPEAT', TECH_REPEAT_RE.test(msg));
      commonFinancial(actual, failures);
      break;
    }
    case 'resume_delta_only': {
      push(failures, 'WRONG_MODE', actual.mode !== 'QUOTE_RESUME');
      push(failures, 'FULL_QUOTE_UNEXPECTED', actual.fullQuoteRendered !== false);
      push(failures, 'DELTA_NOT_RENDERED', actual.deltaRendered !== true);
      push(failures, 'MISSING_REQUIRED_COPY', !/cotizaci[oó]n actualizada/i.test(msg));
      push(failures, 'MISSING_REQUIRED_COPY', !/Nissan Altima 2014/.test(msg));
      push(failures, 'MISSING_REQUIRED_COPY', !/Calavera derecha/.test(msg));
      push(
        failures,
        'MISSING_REQUIRED_COPY',
        !msg.includes(formatQuoteMoneyRange(CALAVERA_RANGE_MIN, CALAVERA_RANGE_MAX)),
      );
      push(failures, 'MISSING_REQUIRED_COPY', !msg.includes(REFACCION_AVAILABILITY_DISCLAIMER));
      push(failures, 'MISSING_REQUIRED_COPY', !/Montaje Calavera derecha/.test(msg));
      push(failures, 'MISSING_REQUIRED_COPY', !/total actualizado/i.test(msg));
      push(failures, 'MISSING_REQUIRED_COPY', !msg.includes(formatQuoteMoney(ALTAMA_TOTAL_AFTER)));
      push(failures, 'MISSING_REQUIRED_COPY', !/permanece sin cambios/i.test(msg));
      push(failures, 'UNCHANGED_LINE_RENDERED', UNCHANGED_BODY_RE.test(msg));
      commonFinancial(actual, failures);
      break;
    }
    case 'resume_no_technical_repeat': {
      push(failures, 'WRONG_MODE', actual.mode !== 'QUOTE_RESUME');
      push(failures, 'TECHNICAL_REPEAT', actual.technicalExplanationRendered !== false);
      push(failures, 'TECHNICAL_REPEAT', TECH_REPEAT_RE.test(msg));
      push(failures, 'TECHNICAL_REPEAT', actual.materialTechnicalChange === true);
      push(failures, 'POST_FILTER_REQUIRED', actual.preFilterClean !== true);
      commonFinancial(actual, failures);
      break;
    }
    case 'correction_delta': {
      push(failures, 'WRONG_MODE', actual.mode !== 'QUOTE_CORRECTION');
      push(failures, 'UNEXPECTED_GREETING', actual.shouldGreet !== false || GREETING_RE.test(msg));
      push(failures, 'FULL_QUOTE_UNEXPECTED', actual.fullQuoteRendered !== false);
      push(failures, 'DELTA_NOT_RENDERED', actual.deltaRendered !== true);
      push(failures, 'TECHNICAL_REPEAT', TECH_REPEAT_RE.test(msg));
      push(failures, 'UNCHANGED_LINE_RENDERED', UNCHANGED_BODY_RE.test(msg));
      push(failures, 'MISSING_REQUIRED_COPY', !/Nissan Altima 2015/.test(msg));
      commonFinancial(actual, failures);
      break;
    }
    case 'update_delta': {
      push(failures, 'WRONG_MODE', actual.mode !== 'QUOTE_UPDATE');
      push(failures, 'FULL_QUOTE_UNEXPECTED', actual.fullQuoteRendered !== false);
      push(failures, 'DELTA_NOT_RENDERED', actual.deltaRendered !== true);
      push(failures, 'MISSING_REQUIRED_COPY', !/Espejo derecho/.test(msg));
      push(failures, 'UNCHANGED_LINE_RENDERED', UNCHANGED_BODY_RE.test(msg));
      push(failures, 'MISSING_REQUIRED_COPY', !/total actualizado/i.test(msg));
      commonFinancial(actual, failures);
      break;
    }
    case 'full_refresh': {
      push(failures, 'WRONG_MODE', actual.mode !== 'QUOTE_FULL_REFRESH');
      push(failures, 'UNEXPECTED_GREETING', actual.shouldGreet !== false || /^[\s*]*hola\b/i.test(msg));
      push(failures, 'FULL_QUOTE_UNEXPECTED', actual.fullQuoteRendered !== true);
      push(failures, 'MISSING_REQUIRED_COPY', !/Fascia trasera/.test(msg));
      push(failures, 'MISSING_REQUIRED_COPY', !/Calavera derecha/.test(msg));
      commonFinancial(actual, failures);
      break;
    }
    case 'appointment_no_quote': {
      push(failures, 'WRONG_MODE', actual.mode !== 'APPOINTMENT_FOLLOWUP');
      push(failures, 'UNEXPECTED_GREETING', actual.shouldGreet !== false || GREETING_RE.test(msg));
      push(failures, 'FULL_QUOTE_UNEXPECTED', actual.fullQuoteRendered !== false);
      push(failures, 'DELTA_NOT_RENDERED', actual.deltaRendered !== false);
      push(failures, 'MISSING_REQUIRED_COPY', !/cita/i.test(msg));
      push(failures, 'UNCHANGED_LINE_RENDERED', /cotizaci[oó]n|total actualizado/i.test(msg));
      push(failures, 'WRONG_CTA', APPOINTMENT_OFFER_RE.test(msg));
      push(failures, 'INVENTED_MONEY', actual.inventedAmounts > 0);
      push(failures, 'INTERNAL_LABEL', actual.humanLabelLeak);
      break;
    }
    case 'warning_ux': {
      push(failures, 'WARNING_UX', actual.warningsRenderedCount > 2);
      push(failures, 'WARNING_UX', actual.resumeWarningsRepeated === true);
      break;
    }
    case 'cta_state': {
      const seq = actual.ctaSequence ?? [];
      push(
        failures,
        'WRONG_CTA',
        seq[0] !== 'ASK_MISSING_VEHICLE_DATA' ||
          seq[1] !== 'OFFER_APPOINTMENT' ||
          seq[2] !== 'CONTINUE_APPOINTMENT' ||
          seq[3] !== 'CONTINUE_APPOINTMENT',
      );
      push(failures, 'WRONG_CTA', actual.appointmentCtaRepeated === true);
      break;
    }
    case 'human_labels': {
      push(failures, 'INTERNAL_LABEL', actual.humanLabelLeak);
      push(failures, 'MISSING_REQUIRED_COPY', !/Calavera derecha/.test(msg));
      break;
    }
    case 'financial_integrity': {
      commonFinancial(actual, failures);
      push(failures, 'WRONG_TOTAL', !msg.includes(formatQuoteMoney(actual.canonicalTotal)));
      break;
    }
    default:
      break;
  }

  return {
    checkId,
    title: CONVERSATION_UX_CHECK_TITLES[checkId],
    passed: failures.length === 0,
    failures: [...new Set(failures)],
    actual,
  };
}

export function remainderInventedAmounts(
  finalMessage: string,
  financialBlock: string,
): number {
  const remainder = String(finalMessage ?? '').replace(financialBlock || '___none___', '');
  return extractMonetaryAmounts(remainder).length;
}
