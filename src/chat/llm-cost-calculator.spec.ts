import {
  estimateLlmCostUsd,
  normalizeLlmModelKey,
  resolveLlmModelRates,
} from './llm-cost-calculator';

describe('llm-cost-calculator', () => {
  it('normaliza nombres de modelo', () => {
    expect(normalizeLlmModelKey(' GPT-5.5 ')).toBe('gpt-5.5');
  });

  it('resuelve tarifas por prefijo versionado', () => {
    expect(resolveLlmModelRates('gpt-5.5-2026-03')?.input).toBe(2.5);
    expect(resolveLlmModelRates('gpt-4o-mini')?.output).toBe(0.6);
  });

  it('calcula costo con cached tokens', () => {
    // 500k uncached @ 2.5 + 500k cached @ 1.25 + 100k out @ 10
    const cost = estimateLlmCostUsd({
      model: 'gpt-5.5',
      promptTokens: 1_000_000,
      completionTokens: 100_000,
      cachedTokens: 500_000,
    });
    expect(cost).toBeCloseTo(2.5 * 0.5 + 1.25 * 0.5 + 10 * 0.1, 6);
  });

  it('modelo desconocido → 0', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      estimateLlmCostUsd({
        model: 'unknown-model-xyz',
        promptTokens: 1000,
        completionTokens: 1000,
      }),
    ).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
