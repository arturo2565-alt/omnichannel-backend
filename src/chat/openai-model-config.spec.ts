import {
  OPENAI_MODEL_DEFAULTS,
  openAiChatCompletionParams,
  resolveOpenAiModel,
} from './openai-model-config';

describe('openai-model-config', () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.OPENAI_MODEL_CHAT;
    delete process.env.OPENAI_REASONING_EFFORT_CHAT;
  });

  afterAll(() => {
    process.env = env;
  });

  it('defaults chat tier to gpt-5.5', () => {
    expect(resolveOpenAiModel('chat')).toBe('gpt-5.5');
    expect(OPENAI_MODEL_DEFAULTS.fast).toBe('gpt-5.4-mini');
  });

  it('respects OPENAI_MODEL_CHAT override', () => {
    process.env.OPENAI_MODEL_CHAT = 'gpt-5.5-2026-04-23';
    expect(resolveOpenAiModel('chat')).toBe('gpt-5.5-2026-04-23');
  });

  it('openAiChatCompletionParams incluye reasoning_effort en gpt-5.5', () => {
    const p = openAiChatCompletionParams({
      tier: 'chat',
      maxOutputTokens: 1200,
      temperature: 0.4,
    });
    expect(p.model).toBe('gpt-5.5');
    expect(p.reasoning_effort).toBe('low');
    expect(p.max_completion_tokens).toBe(1200);
    expect(p.temperature).toBeUndefined();
  });

  it('visión usa reasoning xhigh por defecto', () => {
    const p = openAiChatCompletionParams({ tier: 'vision', maxOutputTokens: 3000 });
    expect(p.reasoning_effort).toBe('xhigh');
  });
});
