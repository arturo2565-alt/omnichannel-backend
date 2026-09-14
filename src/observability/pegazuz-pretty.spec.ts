import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pegLogger } from './pegazuz-logger';
import { resetPegazuzLogEnvForTests, nestFactoryLoggerLevels } from './pegazuz-log-level';
import { runWithPegazuzContext } from './pegazuz-context';
import { emitTurnComplete, emitVisionSummary, markOutboundEnqueued } from './turn-log';
import { logInboundReceived, logWebhookPayloadTrace } from './webhook-log';
import {
  CANONICAL_TRACE_EVENTS,
  pegCanonicalTrace,
  traceVisionInput,
} from '../chat/canonical-trace';
import { logRefaccionMarketEvent } from '../chat/refaccion-market/refaccion-market-events';
import {
  emitMarketTrace,
  MARKET_TRACE_EVENTS,
} from '../chat/refaccion-market/market-search-trace';

const MARKET_IDS = {
  searchRunId: 'mrs_4000fde9abcd',
  pieceCode: 'Calavera_Derecha',
  marketIdentityKey: 'k',
  marketStrategyVersion: 'v1',
  conversationId: '10da48c3-aaaa-bbbb-cccc-ddddeeeeffff',
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

function emitPrettyMarket(): void {
  emitMarketTrace(MARKET_TRACE_EVENTS.SEARCH_FINISHED, MARKET_IDS, {
    pricingStatus: 'INSUFFICIENT_MARKET_SAMPLE',
    rawResults: 85,
    afterDedupe: 37,
    independentSamples: 5,
    selectedGroupSamples: 3,
    requiredSamples: 4,
    selectedPartType: 'UNKNOWN',
    totalDurationMs: 9890,
    vehicleLabel: 'Nissan Altima 2014',
    providerPath: 'SERPER_SHOPPING',
    rejectedByReason: {
      DUPLICATE: 48,
      SIDE_MISSING: 13,
      PIEZA_MISMATCH: 9,
      YEAR_MISMATCH: 2,
    },
  });
}

describe('Production Logging v1.1 pretty', () => {
  afterEach(() => {
    resetPegazuzLogEnvForTests();
    jest.restoreAllMocks();
  });

  it('pretty MARKET tiene labels humanos y no JSON gigante', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_TRACE_MODE = 'compact';
    process.env.PEG_LOG_FORMAT = 'pretty';
    const cap = captureStd();
    emitPrettyMarket();
    const joined = [...cap.logs, ...cap.warns].join('\n');
    expect(joined).toContain('Raw: 85');
    expect(joined).toContain('Deduplicados: 37');
    expect(joined).toContain('Independientes: 5');
    expect(joined).toContain('Grupo seleccionado: 3/4');
    expect(joined).toContain('Tipo: UNKNOWN');
    expect(joined).toContain('insuficiente');
    expect(joined).toContain('· SIDE_MISSING: 13');
    expect(joined).not.toContain('"DUPLICATE":48');
    expect(joined).not.toContain('accepted=5/4');
    cap.restore();
  });

  it('pretty usa short IDs', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_LOG_FORMAT = 'pretty';
    const cap = captureStd();
    runWithPegazuzContext(
      {
        turnId: 'turn_1a6738',
        conversationId: '10da48c3-aaaa-bbbb-cccc-ddddeeeeffff',
        quoteId: 'quo_368f5e9eabcd',
      },
      () => {
        logInboundReceived({
          channel: 'messenger',
          type: 'text',
          conversationId: '10da48c3-aaaa-bbbb-cccc-ddddeeeeffff',
        });
        pegCanonicalTrace(CANONICAL_TRACE_EVENTS.CANONICAL_QUOTE, {
          quoteId: 'quo_368f5e9eabcd',
          total: 6700,
          isPartial: true,
          lines: [{ billable: true }, { billable: false }],
        });
        emitTurnComplete(Date.now() - 19950);
      },
    );
    const joined = cap.logs.join('\n');
    expect(joined).toContain('1a6738');
    expect(joined).toContain('10da48c3');
    expect(joined).not.toContain('10da48c3-aaaa-bbbb-cccc-ddddeeeeffff');
    expect(joined).not.toContain('turn_1a6738');
    cap.restore();
  });

  it('raw webhook no aparece INFO', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_LOG_FORMAT = 'pretty';
    const cap = captureStd();
    logWebhookPayloadTrace('messenger', {
      object: 'page',
      entry: [{ messaging: [{ sender: { id: '123' }, message: { text: 'hola' } }] }],
    });
    const joined = [...cap.logs, ...cap.warns].join('\n');
    expect(joined).not.toContain('--- NUEVO WEBHOOK ---');
    expect(joined).not.toContain('"object"');
    expect(joined).not.toContain('hola');
    cap.restore();
  });

  it('legacy console logs no aparecen en fuentes de INFO', () => {
    const controller = readFileSync(
      join(__dirname, '../chat/chat.controller.ts'),
      'utf8',
    );
    const chatService = readFileSync(
      join(__dirname, '../chat/chat.service.ts'),
      'utf8',
    );
    expect(controller).not.toContain('--- NUEVO WEBHOOK ---');
    expect(controller).not.toContain('[webhook] procesamiento terminado');
    expect(chatService).not.toContain('[VisionPipeline] Borrador listo');
    expect(chatService).not.toContain(
      '[DraftQuoteItems] buildDraftQuoteLineRowsForPersist',
    );
    expect(chatService).not.toContain('[AutopilotAgent]');
    expect(chatService).not.toMatch(/console\.log\(\s*'\[DraftClientNarrative\]/);
  });

  it('INBOUND aparece exactamente 1 vez', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_LOG_FORMAT = 'pretty';
    const cap = captureStd();
    runWithPegazuzContext(
      { conversationId: '10da48c3-aaaa-bbbb-cccc-ddddeeeeffff' },
      () =>
        logInboundReceived({
          channel: 'messenger',
          type: 'text',
          conversationId: '10da48c3-aaaa-bbbb-cccc-ddddeeeeffff',
        }),
    );
    runWithPegazuzContext(
      {
        conversationId: '10da48c3-aaaa-bbbb-cccc-ddddeeeeffff',
        turnId: 'turn_1a6738',
      },
      () =>
        logInboundReceived({
          channel: 'messenger',
          type: 'text',
          conversationId: '10da48c3-aaaa-bbbb-cccc-ddddeeeeffff',
        }),
    );
    const joined = cap.logs.join('\n');
    expect(joined.match(/TURN START/g)?.length).toBe(1);
    cap.restore();
  });

  it('audit Market no aparece INFO', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_LOG_FORMAT = 'pretty';
    const cap = captureStd();
    logRefaccionMarketEvent('REFACCION_MARKET_AUDIT', {
      searchRunId: 'mrs_4000fde9abcd',
      rawResultCount: 85,
      acceptedSampleCount: 5,
      minValidSamples: 4,
      pricingStatus: 'INSUFFICIENT_MARKET_SAMPLE',
    });
    const joined = [...cap.logs, ...cap.warns].join('\n');
    expect(joined).not.toContain('audit=');
    expect(joined).not.toContain('REFACCION_MARKET_AUDIT');
    expect(joined).not.toContain('accepted=5/4');
    cap.restore();
  });

  it('selectedGroupSamples no se confunde con independentSamples', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_LOG_FORMAT = 'pretty';
    const cap = captureStd();
    emitPrettyMarket();
    const joined = [...cap.logs, ...cap.warns].join('\n');
    expect(joined).toContain('Independientes: 5');
    expect(joined).toContain('Grupo seleccionado: 3/4');
    expect(joined).not.toContain('Grupo seleccionado: 5/4');
    cap.restore();
  });

  it('solo UX final aparece INFO', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_LOG_FORMAT = 'pretty';
    const cap = captureStd();
    runWithPegazuzContext({ turnId: 'turn_1a6738' }, () => {
      pegCanonicalTrace(CANONICAL_TRACE_EVENTS.CLIENT_MESSAGE_RENDERED, {
        mode: 'QUOTE_CORRECTION',
        deltaCount: 1,
        greetingRendered: false,
        technicalExplanationRendered: true,
        warningsRenderedCount: 0,
        ctaType: 'NONE',
      });
      pegCanonicalTrace(CANONICAL_TRACE_EVENTS.CLIENT_MESSAGE_RENDERED, {
        mode: 'QUOTE_RESUME',
        deltaCount: 3,
        greetingRendered: false,
        technicalExplanationRendered: false,
        warningsRenderedCount: 2,
        ctaType: 'OFFER_APPOINTMENT',
      });
      emitTurnComplete(Date.now() - 1000);
    });
    const joined = cap.logs.join('\n');
    expect(joined).toContain('QUOTE_RESUME');
    expect(joined).not.toContain('QUOTE_CORRECTION');
    expect(joined.match(/Modo: /g)?.length).toBe(1);
    cap.restore();
  });

  it('TURN visual con outbound ENQUEUED', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_LOG_FORMAT = 'pretty';
    const cap = captureStd();
    runWithPegazuzContext({ turnId: 'turn_1a6738' }, () => {
      markOutboundEnqueued();
      pegLogger.info('OUTBOUND', { status: 'enqueued', channel: 'messenger' });
      emitTurnComplete(Date.now() - 19950);
    });
    const joined = cap.logs.join('\n');
    expect(joined).toContain('TURN COMPLETE');
    expect(joined).toContain('encolado');
    expect(joined).not.toContain('outbound=NONE');
    expect(joined).toContain('────────────────────────────────────────────────────');
    cap.restore();
  });

  it('TREATMENT y QUOTE summary presentes', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_LOG_FORMAT = 'pretty';
    const cap = captureStd();
    pegCanonicalTrace(CANONICAL_TRACE_EVENTS.CANONICAL_PERITAJE, {
      damages: [
        { treatment: 'REPARAR' },
        { treatment: 'SUSTITUIR' },
        { treatment: 'INCIERTO' },
        { treatment: 'PENDIENTE' },
      ],
    });
    pegCanonicalTrace(CANONICAL_TRACE_EVENTS.CANONICAL_QUOTE, {
      quoteId: 'quo_368f5e9eabcd',
      total: 6700,
      isPartial: true,
      lines: [
        { billable: true },
        { billable: true },
        { billable: false },
        { billable: false },
        { billable: false },
      ],
    });
    const joined = cap.logs.join('\n');
    expect(joined).toContain('Reparar: 1');
    expect(joined).toContain('Sustituir: 1');
    expect(joined).toContain('Incierto: 1');
    expect(joined).toContain('Pendiente: 1');
    expect(joined).toContain('$6,700 MXN');
    expect(joined).toContain('Cobrables: 2');
    expect(joined).toContain('Pendientes: 3');
    expect(joined).toContain('Estado: parcial');
    expect(joined).not.toContain('"billable":true');
    cap.restore();
  });

  it('secretos sanitizados y ERROR siempre visible', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_LOG_FORMAT = 'pretty';
    const cap = captureStd();
    pegLogger.info('WEBHOOK', {
      apiKey: 'sk-secret-openai-key-value',
      Authorization: 'Bearer EAA1234567890secret',
      token: 'meta-page-token',
      phone: '+525512345678',
      psid: '1234567890123456',
      channel: 'messenger',
    });
    pegLogger.error('MARKET', {
      message: 'HTTP 500',
      provider: 'SERPER_SHOPPING',
      piece: 'Calavera_Derecha',
      retry: '1/3',
    });
    const info = cap.logs.join('\n');
    const err = cap.errors.join('\n');
    expect(info).not.toContain('sk-secret-openai-key-value');
    expect(info).not.toContain('EAA1234567890secret');
    expect(info).not.toContain('meta-page-token');
    expect(info).not.toContain('+525512345678');
    expect(info).not.toContain('1234567890123456');
    expect(err).toContain('❌');
    expect(err).toContain('HTTP 500');
    cap.restore();
  });

  it('compact sigue válido', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_LOG_FORMAT = 'compact';
    const cap = captureStd();
    emitPrettyMarket();
    const joined = cap.logs.join('\n');
    expect(joined).toContain('[MARKET]');
    expect(joined).toContain('rawResults=85');
    expect(joined).toContain('independentSamples=5');
    expect(joined).toContain('selectedGroupSamples=3');
    expect(joined).not.toContain('────────────────────────────────────────────────────');
    expect(cap.logs.every((line) => !line.includes('\n'))).toBe(true);
    cap.restore();
  });

  it('json genera JSON válido', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_LOG_FORMAT = 'json';
    const cap = captureStd();
    runWithPegazuzContext({ turnId: 'turn_1a6738' }, () => {
      emitPrettyMarket();
    });
    const infoLine = cap.logs.find((line) => line.includes('MARKET_FINISHED'));
    expect(infoLine).toBeTruthy();
    const parsed = JSON.parse(infoLine!);
    expect(parsed.event).toBe('MARKET_FINISHED');
    expect(parsed.rawResults).toBe(85);
    expect(parsed.afterDedupe).toBe(37);
    expect(parsed.independentSamples).toBe(5);
    expect(parsed.selectedGroupSamples).toBe(3);
    expect(parsed.requiredSamples).toBe(4);
    expect(parsed.status).toBe('INSUFFICIENT');
    expect(parsed.turnId).toBe('turn_1a6738');
    expect(infoLine).not.toContain('🔎');
    cap.restore();
  });

  it('TRACE conserva diagnóstico detallado', () => {
    process.env.LOG_LEVEL = 'trace';
    process.env.PEG_TRACE_MODE = 'trace';
    process.env.PEG_LOG_FORMAT = 'pretty';
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

  it('TURN START es el primer hito INFO', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_LOG_FORMAT = 'pretty';
    const cap = captureStd();
    runWithPegazuzContext(
      {
        turnId: 'turn_2f6adb',
        conversationId: '10da48c3-aaaa-bbbb-cccc-ddddeeeeffff',
      },
      () => {
        traceVisionInput({ inputImageCount: 4, itemCount: 4 });
        logInboundReceived({
          channel: 'messenger',
          type: 'image',
          count: 4,
          conversationId: '10da48c3-aaaa-bbbb-cccc-ddddeeeeffff',
        });
        emitVisionSummary({
          photos: 4,
          items: 4,
          vehicle: 'Nissan Altima',
          durationMs: 44190,
          complete: true,
        });
      },
    );
    const joined = cap.logs.join('\n');
    const startAt = joined.indexOf('TURN START');
    const visionAt = joined.indexOf('👁️ Visión');
    expect(startAt).toBeGreaterThanOrEqual(0);
    expect(visionAt).toBeGreaterThan(startAt);
    expect(joined).toContain('Fotos: 4');
    expect(joined).toContain('Vehículo detectado: Nissan Altima');
    expect(joined).toContain('4 fotos');
    cap.restore();
  });

  it('Vision raw y Cloudinary no aparecen INFO', () => {
    const vision = readFileSync(
      join(__dirname, '../chat/openai-vision-completion.ts'),
      'utf8',
    );
    const chatService = readFileSync(
      join(__dirname, '../chat/chat.service.ts'),
      'utf8',
    );
    expect(vision).not.toContain('[Vision] Intento OpenAI');
    expect(chatService).not.toContain('[Vision] Respuesta cruda');
    expect(chatService).not.toContain('urls_origen crudas');
    expect(chatService).not.toMatch(/Subida exitosa:.*secure_url/);
  });

  it('Nest DEBUG no aparece con LOG_LEVEL=info', () => {
    process.env.LOG_LEVEL = 'info';
    expect(nestFactoryLoggerLevels()).toEqual(['log', 'error', 'warn']);
    expect(nestFactoryLoggerLevels()).not.toContain('debug');
  });

  it('TURN outbound ENQUEUED sobrevive contexto anidado', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.PEG_LOG_FORMAT = 'pretty';
    const cap = captureStd();
    runWithPegazuzContext({ turnId: 'turn_114c9b' }, () => {
      runWithPegazuzContext({ conversationId: '10da48c3-aaaa' }, () => {
        markOutboundEnqueued();
      });
      emitTurnComplete(Date.now() - 16870);
    });
    const joined = cap.logs.join('\n');
    expect(joined).toContain('TURN COMPLETE');
    expect(joined).toContain('encolado');
    expect(joined).not.toMatch(/Outbound: ninguno/);
    cap.restore();
  });

  it('un LLM call no genera log legacy duplicado', () => {
    const vision = readFileSync(
      join(__dirname, '../chat/openai-vision-completion.ts'),
      'utf8',
    );
    const llm = readFileSync(
      join(__dirname, '../chat/llm-audit-context.ts'),
      'utf8',
    );
    expect(vision).not.toContain('[Vision] Intento OpenAI');
    expect(vision).not.toContain('this.logger.log');
    expect((llm.match(/pegLogger\.info\('LLM'/g) ?? []).length).toBe(1);
  });
});
