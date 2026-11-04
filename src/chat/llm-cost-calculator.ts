/**
 * Tarifas estimadas USD por 1M tokens (input / output / cached input).
 * Actualizar cuando OpenAI cambie precios; el tracking no bloquea si faltan.
 */
export type LlmTokenRatesPerMillion = {
  input: number;
  output: number;
  /** Si no se define, se usa `input`. */
  cachedInput?: number;
  /**
   * Escritura de caché, contexto corto, retención 30 minutos.
   * Si no se define, esos tokens se cobran como input.
   */
  cacheWrite?: number;
};

/** Claves normalizadas (minúsculas, sin espacios raros). */
export const LLM_MODEL_RATES_PER_MILLION: Record<string, LlmTokenRatesPerMillion> =
  {
    // GPT-5.x (defaults de producción en openai-model-config)
    // gpt-5.6-sol: OpenAI API $4 / $20 / cached $0.40 / escritura 30m $5 por 1M
    'gpt-5.6-sol': { input: 4.0, output: 20.0, cachedInput: 0.4, cacheWrite: 5.0 },
    'gpt-5.6': { input: 4.0, output: 20.0, cachedInput: 0.4, cacheWrite: 5.0 },
    'gpt-5.5': { input: 2.5, output: 10.0, cachedInput: 1.25 },
    'gpt-5.4-mini': { input: 0.15, output: 0.6, cachedInput: 0.075 },
    'gpt-5.4': { input: 2.5, output: 10.0, cachedInput: 1.25 },
    'gpt-5': { input: 2.5, output: 10.0, cachedInput: 1.25 },
    // Staging: tarifas estándar de contexto corto (docs OpenAI, noviembre 2026).
    // Por encima de 272k tokens de entrada la tarifa publicada es mayor; no se aplica aquí.
    'gpt-6.1-sol': { input: 2.0, output: 10.0, cachedInput: 0.1, cacheWrite: 2.5 },
    'gpt-6-luna': { input: 0.1, output: 0.5, cachedInput: 0.01, cacheWrite: 0.125 },
    // Legacy / fallback documentados (tarifas pedidas para gpt-4o)
    'gpt-4o': { input: 0.15, output: 0.6, cachedInput: 0.075 },
    'gpt-4o-mini': { input: 0.15, output: 0.6, cachedInput: 0.075 },
    'gpt-4.1': { input: 2.0, output: 8.0, cachedInput: 0.5 },
    'gpt-4.1-mini': { input: 0.4, output: 1.6, cachedInput: 0.1 },
  };

export function normalizeLlmModelKey(model: string): string {
  return String(model ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

export function resolveLlmModelRates(
  model: string,
): LlmTokenRatesPerMillion | null {
  const key = normalizeLlmModelKey(model);
  if (!key) return null;
  if (LLM_MODEL_RATES_PER_MILLION[key]) {
    return LLM_MODEL_RATES_PER_MILLION[key]!;
  }
  // Prefijo: "gpt-5.5-2025-…" → gpt-5.5
  const prefixes = Object.keys(LLM_MODEL_RATES_PER_MILLION).sort(
    (a, b) => b.length - a.length,
  );
  for (const p of prefixes) {
    if (key === p || key.startsWith(`${p}-`) || key.startsWith(`${p}:`)) {
      return LLM_MODEL_RATES_PER_MILLION[p]!;
    }
  }
  return null;
}

export function estimateLlmCostUsd(input: {
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
}): number {
  const prompt = Math.max(0, Math.floor(Number(input.promptTokens) || 0));
  const completion = Math.max(
    0,
    Math.floor(Number(input.completionTokens) || 0),
  );
  const cached = Math.min(
    prompt,
    Math.max(0, Math.floor(Number(input.cachedTokens) || 0)),
  );
  const cacheWrite = Math.min(
    Math.max(0, prompt - cached),
    Math.max(0, Math.floor(Number(input.cacheWriteTokens) || 0)),
  );
  const rates = resolveLlmModelRates(input.model);
  if (!rates) {
    console.warn(
      '[LlmCostCalculator] modelo sin tarifa configurada; costo=0',
      JSON.stringify({ model: input.model }),
    );
    return 0;
  }
  // Prompt Caching: lectura cacheada a tarifa propia; la escritura no se cobra otra vez como input.
  const cachedRate =
    rates.cachedInput != null ? rates.cachedInput : rates.input * 0.5;
  const cacheWriteRate =
    rates.cacheWrite != null ? rates.cacheWrite : rates.input;
  const uncachedPrompt = Math.max(0, prompt - cached - cacheWrite);
  const usd =
    (uncachedPrompt * rates.input) / 1_000_000 +
    (cached * cachedRate) / 1_000_000 +
    (cacheWrite * cacheWriteRate) / 1_000_000 +
    (completion * rates.output) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
