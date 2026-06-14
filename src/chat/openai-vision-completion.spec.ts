import { openAiChatCompletionParams } from './openai-model-config';
import { resolveOpenAiVisionMaxOutputTokens } from './openai-vision-completion';

describe('openai-vision-completion config', () => {
  it('resolveOpenAiVisionMaxOutputTokens default 12000', () => {
    const prev = process.env.OPENAI_VISION_MAX_OUTPUT_TOKENS;
    delete process.env.OPENAI_VISION_MAX_OUTPUT_TOKENS;
    expect(resolveOpenAiVisionMaxOutputTokens()).toBe(12_000);
    process.env.OPENAI_VISION_MAX_OUTPUT_TOKENS = '16000';
    expect(resolveOpenAiVisionMaxOutputTokens()).toBe(16_000);
    if (prev !== undefined) {
      process.env.OPENAI_VISION_MAX_OUTPUT_TOKENS = prev;
    } else {
      delete process.env.OPENAI_VISION_MAX_OUTPUT_TOKENS;
    }
  });
});

describe('openai-model-config vision tier', () => {
  it('visión usa reasoning high por defecto (no xhigh)', () => {
    delete process.env.OPENAI_REASONING_EFFORT_VISION;
    const p = openAiChatCompletionParams({ tier: 'vision', maxOutputTokens: 12_000 });
    expect(p.reasoning_effort).toBe('high');
    expect(p.max_completion_tokens).toBe(12_000);
  });

  it('reasoningEffortOverride para reintentos', () => {
    const p = openAiChatCompletionParams({
      tier: 'vision',
      maxOutputTokens: 12_000,
      reasoningEffortOverride: 'low',
    });
    expect(p.reasoning_effort).toBe('low');
  });
});
