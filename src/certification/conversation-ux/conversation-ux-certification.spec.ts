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
