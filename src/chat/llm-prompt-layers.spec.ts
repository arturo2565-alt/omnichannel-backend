import {
  buildCacheFriendlyChatMessages,
  buildLlmDynamicServerTimeBlock,
  joinLlmPromptLayers,
  LLM_PROMPT_DYNAMIC_MARKER,
} from './llm-prompt-layers';
import { estimateLlmCostUsd } from './llm-cost-calculator';
import {
  extractChatCompletionUsage,
  extractResponsesApiUsage,
} from './llm-audit-context';

describe('llm-prompt-layers (prompt caching)', () => {
  it('pone el tiempo en bloque dinámico, no como único prefijo vacío', () => {
    const dyn = buildLlmDynamicServerTimeBlock(new Date('2026-09-04T18:00:00.000Z'));
    expect(dyn.startsWith(LLM_PROMPT_DYNAMIC_MARKER)).toBe(true);
    expect(dyn).toContain('2026-09-04');
  });

  it('buildCacheFriendlyChatMessages ordena system → dinámico → historial', () => {
    const msgs = buildCacheFriendlyChatMessages({
      stableSystem: 'REGLAS_ESTABLES',
      dynamicContext: buildLlmDynamicServerTimeBlock(
        new Date('2026-09-04T18:00:00.000Z'),
      ),
      history: [{ role: 'user', content: 'Hola' }],
    });
    expect(msgs[0]).toEqual({ role: 'system', content: 'REGLAS_ESTABLES' });
    expect(msgs[1]?.role).toBe('user');
    expect(String(msgs[1]?.content)).toContain(LLM_PROMPT_DYNAMIC_MARKER);
    expect(msgs[2]).toEqual({ role: 'user', content: 'Hola' });
  });

  it('joinLlmPromptLayers deja estable antes que dinámico', () => {
    const joined = joinLlmPromptLayers({
      stablePrefix: 'STATIC',
      dynamicContext: 'DYNAMIC',
    });
    expect(joined.indexOf('STATIC')).toBeLessThan(joined.indexOf('DYNAMIC'));
  });
});

describe('cached tokens usage + cost', () => {
  it('extrae cached_tokens de chat y responses', () => {
    expect(
      extractChatCompletionUsage({
        prompt_tokens: 8000,
        completion_tokens: 100,
        total_tokens: 8100,
        prompt_tokens_details: { cached_tokens: 7500 },
      }).cachedTokens,
    ).toBe(7500);

    expect(
      extractResponsesApiUsage({
        input_tokens: 9000,
        output_tokens: 200,
        total_tokens: 9200,
        input_tokens_details: { cached_tokens: 8200 },
      }).cachedTokens,
    ).toBe(8200);
  });

  it('no salta un cached_tokens=0 legítimo con ||', () => {
    expect(
      extractResponsesApiUsage({
        input_tokens: 5000,
        output_tokens: 10,
        total_tokens: 5010,
        input_tokens_details: { cached_tokens: 0 },
        // ruido en otra ruta no debe sobrescribir el 0 del path correcto
        prompt_tokens_details: { cached_tokens: 999 },
      }).cachedTokens,
    ).toBe(0);
  });

  it('aplica ~50% de descuento a cached tokens', () => {
    const full = estimateLlmCostUsd({
      model: 'gpt-5.5',
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedTokens: 0,
    });
    const halfCached = estimateLlmCostUsd({
      model: 'gpt-5.5',
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedTokens: 1_000_000,
    });
    expect(full).toBeCloseTo(2.5, 6);
    expect(halfCached).toBeCloseTo(1.25, 6);
  });
});
