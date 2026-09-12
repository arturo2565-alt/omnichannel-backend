import { createMatrixPricingSnapshot } from '../../catalog/matrix-pricing-snapshot';
import { autonomyMockSnap } from './pricing-snap';
import { resolveMontajePinturaPrice } from '../../chat/draft-quote-inventory-pricing';
import { isUnconfiguredPriceSource } from '../../chat/unconfigured-price';
import {
  hashPromptText,
  buildCatalogContextForLlm,
} from '../../chat/catalog-prompt-append';
import {
  runWithLlmAuditContextAsync,
  getLlmAuditContext,
  reportLlmUsage,
  registerLlmUsageReporter,
  type LlmUsageReportInput,
} from '../../chat/llm-audit-context';
import { parseVisionModelJsonResponse } from '../../chat/vision-json-parse';
import {
  LIVE_EVAL_PRODUCTION_PARSER,
  LIVE_EVAL_USES_PRODUCTION_PARSER,
  runLiveAutonomyEvaluation,
} from './live-eval';
import { createAutonomySideEffectMocks } from './side-effects';
import { validateVisionContract } from './vision-contract';
import { buildPreliveReadinessReport } from './prelive-readiness';
import { parseVisionDamageItems } from '../../chat/vision-item-normalize';
import { canonicalizePanelCode } from '../../catalog/panel-pieza-catalog';

describe('pre-live hardening extras', () => {
  it('montaje dedicado identifica DEDICATED_TARIFF', () => {
    const snap = createMatrixPricingSnapshot([
      {
        id: '1',
        servicio: 'Cofre',
        severidad: 'MONTAJE_PINTURA',
        precio: 6900,
        diasEntrega: 4,
      },
    ]);
    const r = resolveMontajePinturaPrice(snap, 'Cofre');
    expect(r.mountPaintPriceSource).toBe('DEDICATED_TARIFF');
    expect(r.priceSource).toBe('AUTOFIX_CATALOG');
    expect(r.precio).toBeGreaterThan(0);
  });

  it('montaje fallback identifica LEGACY_REPAIR_MATRIX_FALLBACK', () => {
    const snap = createMatrixPricingSnapshot([
      {
        id: '1',
        servicio: 'Fascia',
        severidad: 'DL',
        precio: 2900,
        diasEntrega: 3,
      },
    ]);
    const r = resolveMontajePinturaPrice(snap, 'Fascia');
    expect(r.mountPaintPriceSource).toBe('LEGACY_REPAIR_MATRIX_FALLBACK');
    expect(r.priceSource).toBe('LEGACY_REPAIR_MATRIX_FALLBACK');
  });

  it('prompt version y catalog append hash llegan al audit context / reportLlmUsage', async () => {
    const captured: LlmUsageReportInput[] = [];
    registerLlmUsageReporter((input) => {
      captured.push(input);
    });
    await runWithLlmAuditContextAsync(
      {
        purpose: 'orchestrator',
        caseId: 'live_case_01',
        catalogAppendVersion: hashPromptText('append'),
        effectiveChatPromptHash: hashPromptText('base\nappend'),
        chatPromptVersion: hashPromptText('base\nappend'),
        visionPromptVersion: hashPromptText('vision'),
      },
      async () => {
        expect(getLlmAuditContext()?.caseId).toBe('live_case_01');
        reportLlmUsage({ model: 'gpt-test', purpose: 'orchestrator' });
      },
    );
    registerLlmUsageReporter(null);
    expect(captured[0]?.caseId).toBe('live_case_01');
    expect(captured[0]?.catalogAppendVersion).toBe(hashPromptText('append'));
    expect(captured[0]?.effectiveChatPromptHash).toBe(
      hashPromptText('base\nappend'),
    );
    expect(captured[0]?.visionPromptVersion).toBe(hashPromptText('vision'));
  });

  it('live eval ejecuta createVisionDamageAnalysisCompletion adaptado y parser productivo', async () => {
    expect(LIVE_EVAL_USES_PRODUCTION_PARSER).toBe(true);
    expect(LIVE_EVAL_PRODUCTION_PARSER).toBe(parseVisionModelJsonResponse);

    let called = 0;
    const report = await runLiveAutonomyEvaluation({
      openai: {} as never,
      systemPrompt: 'vision-v2-test',
      userSchemaHint: '{"items":[]}',
      visionCompletion: async () => {
        called += 1;
        return {
          content: JSON.stringify({
            peritaje_viable: true,
            vehiculo_detectado: 'Mazda 3 2020',
            items: [
              {
                pieza: 'FD',
                severidad: 'DF',
                descripcionTecnica: 'quebrada',
                tratamiento: 'SUSTITUIR',
              },
            ],
          }),
          finishReason: 'stop',
          reasoningEffort: undefined,
          attempt: 1,
          maxOutputTokens: 1000,
          completionTokens: 10,
          reasoningTokens: 0,
          promptTokens: 10,
          cachedTokens: 0,
          model: 'gpt-test',
        };
      },
      cases: [
        {
          caseId: 'live_fd_unit',
          images: [],
          expected: { treatments: ['SUSTITUIR'] },
          vehicleContext: 'Mazda 3 2020',
        },
      ],
    });
    expect(called).toBe(1);
    expect(report.level).toBe('LIVE_VISION');
    expect(report.results[0]?.treatments).toContain('SUSTITUIR');
  });

  it('JSON inválido se reporta como contrato fallido', () => {
    expect(
      validateVisionContract({ parseError: true, items: [] }),
    ).toContain('INVALID_JSON');
  });

  it('unknown piece se reporta', () => {
    const items = parseVisionDamageItems({
      items: [
        { pieza: 'SpoilerInexistenteXYZ', severidad: 'DL', descripcionTecnica: 'x' },
      ],
    }).map((it) => ({
      ...it,
      pieza: canonicalizePanelCode(it.pieza) || it.pieza,
    }));
    expect(validateVisionContract({ items })).toContain('UNKNOWN_PIECE_CODE');
  });

  it('side effect WhatsApp y appointments bloqueados', async () => {
    const side = createAutonomySideEffectMocks();
    await expect(side.sendWhatsApp({})).rejects.toThrow(/whatsapp/i);
    await expect(side.createAppointment({})).rejects.toThrow(/createAppointment/);
  });

  it('BPEI/BPCC live sin config marca PRODUCT_CONFIGURATION_REQUIRED', async () => {
    const report = await runLiveAutonomyEvaluation({
      openai: {} as never,
      pricingSnap: autonomyMockSnap({
        'Baño de Pintura Exterior e Interiores|BASE': 0,
        'Baño de Pintura Exterior e Interiores|Mediano': 0,
      }),
      visionCompletion: async () => {
        throw new Error('no debe llamar visión');
      },
      cases: [
        {
          caseId: 'live_bpei_unconfigured',
          images: [],
          banioCode: 'BPEI',
        },
      ],
    });
    expect(report.results[0]?.productDecision).toBe(
      'PRODUCT_CONFIGURATION_REQUIRED',
    );
    expect(report.configurationRequired).toBe(1);
  });

  it('prelive readiness: append CANONICAL limpio', () => {
    const report = buildPreliveReadinessReport({
      canonicalAppend: buildCatalogContextForLlm(['Fascia']),
    });
    expect(report.prompts.hardcodedFinancialAppendRemoved).toBe(true);
    expect(report.verdict).toBe('READY_FOR_PROMPT_V2');
  });

  it('$0 UNCONFIGURED no es fuente cobrable', () => {
    expect(isUnconfiguredPriceSource('UNCONFIGURED')).toBe(true);
  });

  it('LlmCall persiste columnas de versión de prompt', () => {
    const { LlmCall } = require('../../chat/entities/llm-call.entity') as typeof import('../../chat/entities/llm-call.entity');
    const cols = ['visionPromptVersion', 'baseChatPromptVersion', 'catalogAppendVersion', 'effectiveChatPromptHash', 'caseId', 'promptLabel'];
    const proto = new LlmCall();
    for (const c of cols) {
      expect(c in proto || Object.prototype.hasOwnProperty.call(proto, c) || c in LlmCall.prototype).toBeTruthy();
    }
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '../../chat/entities/llm-call.entity.ts'),
      'utf8',
    ) as string;
    for (const c of cols) {
      expect(source).toContain(c);
    }
  });
});
