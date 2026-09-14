import { CONVERSATION_UX_CHECK_IDS } from './types';
import { compareConversationUxCheck } from './compare';
import {
  countGreetings,
  runConversationUxCheck,
  runGreetingSequence,
} from './pipeline';
import {
  buildConversationUxReport,
  formatConversationUxReport,
} from './report';
import { hasMaterialTechnicalChange } from '../../chat/client-message-ux';
import { computeQuoteDelta } from '../../chat/client-message-ux';
import { composeModernClientQuoteMessage } from '../../chat/canonical-quote-narrative';
import {
  QUOTE_SCHEMA_VERSION,
  sumChargeableAmount,
} from '../../domain/peritaje-v1';
import {
  extractMonetaryAmounts,
  formatQuoteMoney,
  formatQuoteMoneyRange,
  validateFinalClientQuoteMessage,
} from '../../domain/peritaje-v1/quote-narrative';
import {
  altimaPeritaje,
  partialAltimaQuote,
  resumedAltimaQuote,
  sendSnapshot,
} from './fixtures';

describe('Conversation UX certification', () => {
  it('certifica 12 / 12 y reporta métricas', async () => {
    const results = [];
    for (const checkId of CONVERSATION_UX_CHECK_IDS) {
      const actual = await runConversationUxCheck(checkId);
      const compared = compareConversationUxCheck(checkId, actual);
      if (!compared.passed) {
        // eslint-disable-next-line no-console
        console.log(
          `${compared.title} FAIL`,
          compared.failures,
          actual.mode,
          actual.finalMessage.slice(0, 400),
        );
      }
      results.push(compared);
    }

    const sequence = await runGreetingSequence();
    const greetingCount = countGreetings(sequence);
    const greetingDuplicates = Math.max(0, greetingCount - 1);

    const report = buildConversationUxReport(results, {
      greetingDuplicates,
      fullQuoteUnexpectedRenders: results.filter((r) =>
        r.failures.includes('FULL_QUOTE_UNEXPECTED'),
      ).length,
      technicalRepeatViolations: results.filter((r) =>
        r.failures.includes('TECHNICAL_REPEAT'),
      ).length,
    });

    // eslint-disable-next-line no-console
    console.log(`\n${formatConversationUxReport(report, results)}\n`);

    expect(results).toHaveLength(15);
    expect(report.casesPassed).toBe(15);
    expect(report.casesFailed).toBe(0);
    expect(greetingCount).toBe(1);
    expect(report.greetingDuplicates).toBe(0);
    expect(report.fullQuoteUnexpectedRenders).toBe(0);
    expect(report.technicalRepeatViolations).toBe(0);
    expect(report.internalLabelsExposed).toBe(0);
    expect(report.inventedAmounts).toBe(0);
  });

  it('range visible vs amount canónico mantiene integridad', async () => {
    const quote = {
      schemaVersion: QUOTE_SCHEMA_VERSION,
      quoteId: 'q_range_amount',
      peritajeId: 'per_range',
      generatedAt: '2026-09-14T00:00:00.000Z',
      warnings: [] as string[],
      isPartial: false,
      subtotal: 10050,
      total: 10050,
      lines: [
        {
          quoteLineId: 'ql_base',
          damageItemId: 'dmg_ft',
          vehicleId: 'veh_1',
          serviceType: 'REPARACION_PINTURA' as const,
          description: 'fascia trasera',
          billable: true,
          amount: 6700,
          confidence: 'HIGH' as const,
        },
        {
          quoteLineId: 'ql_ref',
          damageItemId: 'dmg_cala',
          vehicleId: 'veh_1',
          serviceType: 'REFACCION' as const,
          description: 'calavera derecha',
          billable: true,
          amount: 3350,
          priceRange: { min: 3000, max: 3650, central: 3350 },
          pricingSource: 'WEB_MARKET_ESTIMATE' as const,
          pricingStatus: 'OK' as const,
          confidence: 'HIGH' as const,
        },
      ],
    };
    expect(sumChargeableAmount(quote.lines)).toBe(10050);
    expect(quote.total).toBe(10050);

    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: quote,
      contactName: 'Arturo',
      hasActiveAppointment: false,
      llmParts: { intro: 'Hola Arturo', technicalExplanation: '', cta: '' },
    });
    expect(composed.finalMessage).toContain(formatQuoteMoneyRange(3000, 3650));
    expect(composed.finalMessage).toContain(formatQuoteMoney(10050));
    expect(composed.finalMessage).not.toContain('Calavera_Derecha');
    const remainder = composed.finalMessage.replace(composed.financialBlock, '');
    expect(extractMonetaryAmounts(remainder)).toEqual([]);
    const validation = validateFinalClientQuoteMessage({
      canonicalQuote: quote,
      renderedFinancialBlock: composed.financialBlock,
      finalMessage: composed.finalMessage,
    });
    expect(validation.ok).toBe(true);
  });

  it('hasMaterialTechnicalChange ignora precio e identidad vehicular', () => {
    const partial = partialAltimaQuote();
    const resumed = resumedAltimaQuote();
    const delta = computeQuoteDelta(resumed, sendSnapshot(partial));
    expect(
      hasMaterialTechnicalChange({
        delta,
        previousPeritaje: altimaPeritaje(),
        currentPeritaje: altimaPeritaje('2014'),
      }),
    ).toBe(false);

    const withTreatment = altimaPeritaje('2014');
    withTreatment.damages = withTreatment.damages.map((d) =>
      d.damageItemId === 'dmg_cala'
        ? { ...d, treatment: 'REPARAR', requiresReplacement: false }
        : d,
    );
    expect(
      hasMaterialTechnicalChange({
        delta,
        previousPeritaje: altimaPeritaje(),
        currentPeritaje: withTreatment,
      }),
    ).toBe(true);
  });
});
