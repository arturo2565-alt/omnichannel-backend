import { pegLogger } from './pegazuz-logger';
import { resetPegazuzLogEnvForTests } from './pegazuz-log-level';
import { runWithPegazuzContext } from './pegazuz-context';
import { emitTurnComplete } from './turn-log';
import { logWebhookPayloadTrace } from './webhook-log';
import { logStablePromptPrefixAudit, reportLlmUsage } from '../chat/llm-audit-context';
import {
  CANONICAL_TRACE_EVENTS,
  PEG_CANONICAL_TRACE_PREFIX,
  pegCanonicalTrace,
} from '../chat/canonical-trace';
import {
  emitMarketTrace,
  MARKET_TRACE_EVENTS,
  PEG_MARKET_TRACE_PREFIX,
} from '../chat/refaccion-market/market-search-trace';

const MARKET_IDS = {
  searchRunId: 'mrs_123',
  pieceCode: 'Calavera_Derecha',
  marketIdentityKey: 'k',
  marketStrategyVersion: 'v1',
  conversationId: '5f75532e-aaaa-bbbb-cccc-ddddeeeeffff',
};

function captureStd(): {
  logs: string[];
  warns: string[];
  errors: string[];
  restore: () => void;
} {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const logSpy = jest.spyOn(console, 'log').mockImplementation((...args) => {
    logs.push(args.map(String).join(' '));
  });
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation((...args) => {
    warns.push(args.map(String).join(' '));
  });
  const errSpy = jest.spyOn(console, 'error').mockImplementation((...args) => {
    errors.push(args.map(String).join(' '));
  });
  return {
    logs,
    warns,
    errors,
    restore: () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

describe('PegazuzLogger production compact', () => {
  afterEach(() => {
    resetPegazuzLogEnvForTests();
    delete process.env.PEG_CANONICAL_TRACE;
    delete process.env.PEG_MARKET_TRACE;
    delete process.env.PEG_MARKET_TRACE_VERBOSE;
    jest.restoreAllMocks();
  });

  it('INFO no imprime RAW_SAMPLE ni SAMPLE_EVALUATED individual', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_TRACE_MODE = 'compact';
    const cap = captureStd();
    emitMarketTrace(MARKET_TRACE_EVENTS.RAW_SAMPLE, MARKET_IDS, {
      title: 'Calavera derecha raw',
    });
    emitMarketTrace(MARKET_TRACE_EVENTS.SAMPLE_EVALUATED, MARKET_IDS, {
      accepted: false,
    });
    const joined = [...cap.logs, ...cap.warns].join('\n');
    expect(joined).not.toContain('REFACCION_RAW_SAMPLE');
    expect(joined).not.toContain('REFACCION_SAMPLE_EVALUATED');
    expect(joined).not.toContain(PEG_MARKET_TRACE_PREFIX);
    cap.restore();
  });

  it('INFO sí imprime MARKET summary y no el audit JSON completo', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_TRACE_MODE = 'compact';
    const cap = captureStd();
    emitMarketTrace(MARKET_TRACE_EVENTS.SEARCH_STARTED, MARKET_IDS, {
      vehicle: { make: 'Nissan', model: 'Altima', year: '2014' },
    });
    emitMarketTrace(MARKET_TRACE_EVENTS.SEARCH_FINISHED, MARKET_IDS, {
      pricingStatus: 'INSUFFICIENT_MARKET_SAMPLE',
      rawResultCount: 83,
      uniqueSamples: 5,
      acceptedSampleCount: 2,
      requiredSamples: 4,
      selectedPartType: 'AFTERMARKET_NEW',
      totalDurationMs: 2800,
      vehicleLabel: 'Nissan Altima 2014',
      providerPath: 'SERPER_SHOPPING',
      rejectedByReason: { MODEL_MISMATCH: 9, YEAR_MISMATCH: 4, ACCESSORY: 2 },
    });
    const joined = [...cap.logs, ...cap.warns].join('\n');
    expect(joined).toContain('[MARKET]');
    expect(joined).toContain('piece=Calavera_Derecha');
    expect(joined).toContain('START');
    expect(joined).toContain('raw=83');
    expect(joined).toContain('unique=5');
    expect(joined).toContain('samples=2/4');
    expect(joined).toContain('status=INSUFFICIENT');
    expect(joined).not.toContain(PEG_MARKET_TRACE_PREFIX);
    expect(joined).not.toContain('REFACCION_RAW_SAMPLE');
    cap.restore();
  });

  it('INFO sí imprime QUOTE summary', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_TRACE_MODE = 'compact';
    const cap = captureStd();
    pegCanonicalTrace(CANONICAL_TRACE_EVENTS.CANONICAL_QUOTE, {
      quoteId: 'quo_123',
      total: 6700,
      isPartial: true,
      lines: [
        { billable: true },
        { billable: true },
        { billable: false },
      ],
    });
    const joined = cap.logs.join('\n');
    expect(joined).toContain('[QUOTE]');
    expect(joined).toContain('total=6700');
    expect(joined).toContain('partial=true');
    expect(joined).not.toContain(PEG_CANONICAL_TRACE_PREFIX);
    cap.restore();
  });

  it('INFO sí imprime TURN COMPLETE', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_TRACE_MODE = 'compact';
    const cap = captureStd();
    runWithPegazuzContext(
      {
        turnId: 'turn_abc123',
        conversationId: '5f75532e-aaaa-bbbb-cccc-ddddeeeeffff',
        turnSummary: {
          mode: 'QUOTE_CORRECTION',
          vehicle: 'Nissan Altima 2015',
          market: 'INSUFFICIENT',
          quoteTotal: 6700,
          partial: true,
          outbound: 'SENT',
        },
      },
      () => emitTurnComplete(Date.now() - 4210),
    );
    const joined = cap.logs.join('\n');
    expect(joined).toContain('[TURN]');
    expect(joined).toContain('COMPLETE');
    expect(joined).toContain('turn=abc123');
    expect(joined).toContain('conv=5f75532e');
    expect(joined).toContain('mode=QUOTE_CORRECTION');
    expect(joined).toContain('quoteTotal=6700');
    expect(joined).toContain('outbound=SENT');
    cap.restore();
  });

  it('INFO no imprime first300 de prompts', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_TRACE_MODE = 'compact';
    process.env.LLM_CACHE_DEBUG = 'true';
    const cap = captureStd();
    logStablePromptPrefixAudit(
      'narrative',
      'Eres un asesor. first300-secret-prefix-should-not-leak ' + 'x'.repeat(400),
    );
    const joined = cap.logs.join('\n');
    expect(joined).not.toContain('first300');
    expect(joined).not.toContain('first300-secret-prefix-should-not-leak');
    expect(joined).not.toContain('[LlmCacheDebug]');
    cap.restore();
  });

  it('INFO no imprime payload Meta completo', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_TRACE_MODE = 'compact';
    const cap = captureStd();
    logWebhookPayloadTrace('messenger', {
      object: 'page',
      entry: [{ messaging: [{ sender: { id: '123' }, message: { text: 'hola' } }] }],
    });
    const joined = cap.logs.join('\n');
    expect(joined).not.toContain('"object":"page"');
    expect(joined).not.toContain('hola');
    cap.restore();
  });

  it('ERROR siempre aparece', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_TRACE_MODE = 'compact';
    const cap = captureStd();
    pegLogger.error('MARKET', {
      message: 'provider timeout',
      errorType: 'TimeoutError',
      conversationId: '5f75532e-aaaa-bbbb-cccc-ddddeeeeffff',
      turnId: 'turn_abc123',
      searchRunId: 'mrs_123',
    });
    const joined = cap.errors.join('\n');
    expect(joined).toContain('[MARKET]');
    expect(joined).toContain('provider timeout');
    expect(joined).toContain('TimeoutError');
    cap.restore();
  });

  it('secretos nunca aparecen', () => {
    process.env.LOG_LEVEL = 'info';
    const cap = captureStd();
    pegLogger.info('WEBHOOK', {
      apiKey: 'sk-secret-openai-key-value',
      Authorization: 'Bearer EAA1234567890secret',
      token: 'meta-page-token',
      phone: '+525512345678',
      channel: 'messenger',
    });
    pegLogger.error('OUTBOUND', {
      message: 'fail Bearer sk-secret-openai-key-value',
      apiKey: 'sk-secret-openai-key-value',
    });
    const joined = [...cap.logs, ...cap.errors].join('\n');
    expect(joined).not.toContain('sk-secret-openai-key-value');
    expect(joined).not.toContain('EAA1234567890secret');
    expect(joined).not.toContain('meta-page-token');
    expect(joined).not.toContain('+525512345678');
    cap.restore();
  });

  it('TRACE conserva detalle diagnóstico', () => {
    process.env.LOG_LEVEL = 'trace';
    process.env.PEG_TRACE_MODE = 'trace';
    const cap = captureStd();
    emitMarketTrace(MARKET_TRACE_EVENTS.SAMPLE_EVALUATED, MARKET_IDS, {
      accepted: false,
      reason: 'MODEL_MISMATCH',
    });
    logWebhookPayloadTrace('messenger', { object: 'page', hello: 'payload-meta' });
    const joined = cap.logs.join('\n');
    expect(joined).toContain('REFACCION_SAMPLE_EVALUATED');
    expect(joined).toContain('MODEL_MISMATCH');
    expect(joined).toContain('payload-meta');
    cap.restore();
  });

  it('mismo evento no aparece duplicado bajo Market y Canonical', () => {
    process.env.LOG_LEVEL = 'trace';
    process.env.PEG_TRACE_MODE = 'trace';
    process.env.PEG_CANONICAL_TRACE = 'true';
    process.env.PEG_MARKET_TRACE = 'true';
    process.env.PEG_MARKET_TRACE_VERBOSE = 'true';
    const cap = captureStd();
    emitMarketTrace(MARKET_TRACE_EVENTS.SAMPLE_EVALUATED, MARKET_IDS, {
      accepted: true,
    });
    const joined = cap.logs.join('\n');
    const marketHits = joined
      .split('\n')
      .filter((line) => line.includes('REFACCION_SAMPLE_EVALUATED'));
    expect(marketHits.length).toBeGreaterThan(0);
    expect(joined).not.toContain(PEG_CANONICAL_TRACE_PREFIX);
    cap.restore();
  });

  it('INFO LLM es una línea compacta con cachePct', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_TRACE_MODE = 'compact';
    const cap = captureStd();
    reportLlmUsage({
      model: 'gpt-5.4',
      purpose: 'narrative',
      promptTokens: 6165,
      cachedTokens: 5888,
      completionTokens: 61,
      durationMs: 1200,
    });
    const joined = cap.logs.join('\n');
    expect(joined).toContain('[LLM]');
    expect(joined).toContain('source=narrative');
    expect(joined).toContain('input=6165');
    expect(joined).toContain('cached=5888');
    expect(joined).toContain('output=61');
    expect(joined).toContain('cachePct=96');
    expect(joined).not.toContain('first300');
    expect(joined).not.toContain('pathsTried');
    cap.restore();
  });
});
