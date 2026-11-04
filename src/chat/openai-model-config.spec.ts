import {
  openAiChatCompletionParams,
  openAiResponsesParams,
  resolveOpenAiModel,
} from './openai-model-config';

describe('openai-model-config', () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.PEGAZUZ_ENV;
    delete process.env.OPENAI_MODEL_CHAT;
    delete process.env.OPENAI_MODEL_VISION;
    delete process.env.OPENAI_MODEL_NARRATIVE;
    delete process.env.OPENAI_MODEL_FAST;
    delete process.env.OPENAI_REASONING_EFFORT;
    delete process.env.OPENAI_REASONING_EFFORT_CHAT;
    delete process.env.OPENAI_REASONING_EFFORT_VISION;
    delete process.env.OPENAI_REASONING_EFFORT_NARRATIVE;
    delete process.env.OPENAI_REASONING_EFFORT_FAST;
  });

  afterAll(() => {
    process.env = env;
  });

  it('defaults chat tier to gpt-5.5', () => {
    expect(resolveOpenAiModel('chat')).toBe('gpt-5.5');
  });

  it('defaults vision tier to gpt-5.6-sol', () => {
    expect(resolveOpenAiModel('vision')).toBe('gpt-5.6-sol');
  });

  it('visión chat.completions usa gpt-5.6-sol', () => {
    const p = openAiChatCompletionParams({
      tier: 'vision',
      maxOutputTokens: 12_000,
    });
    expect(p.model).toBe('gpt-5.6-sol');
    expect(p.reasoning_effort).toBe('high');
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

  it('visión usa reasoning high por defecto', () => {
    delete process.env.OPENAI_REASONING_EFFORT_VISION;
    const p = openAiChatCompletionParams({ tier: 'vision', maxOutputTokens: 12_000 });
    expect(p.reasoning_effort).toBe('high');
  });

  it('openAiResponsesParams usa reasoning nested (Responses API)', () => {
    const p = openAiResponsesParams({ tier: 'chat', maxOutputTokens: 4096 });
    expect(p.reasoning).toEqual({ effort: 'low' });
  });

  it('staging usa gpt-6.1-sol y gpt-6-luna sin cambiar el default de producción', () => {
    process.env.PEGAZUZ_ENV = 'staging';
    expect(resolveOpenAiModel('vision')).toBe('gpt-6.1-sol');
    expect(resolveOpenAiModel('chat')).toBe('gpt-6.1-sol');
    expect(resolveOpenAiModel('narrative')).toBe('gpt-6.1-sol');
    expect(resolveOpenAiModel('fast')).toBe('gpt-6-luna');

    const vision = openAiChatCompletionParams({
      tier: 'vision',
      maxOutputTokens: 12_000,
      temperature: 0.4,
    });
    expect(vision.model).toBe('gpt-6.1-sol');
    expect(vision.reasoning_effort).toBe('high');
    expect(vision.temperature).toBeUndefined();

    const narrative = openAiChatCompletionParams({
      tier: 'narrative',
      maxOutputTokens: 800,
      temperature: 0.6,
    });
    expect(narrative.model).toBe('gpt-6.1-sol');
    expect(narrative.reasoning_effort).toBe('low');
    expect(narrative.temperature).toBeUndefined();

    const fast = openAiChatCompletionParams({
      tier: 'fast',
      maxOutputTokens: 400,
      temperature: 0.1,
    });
    expect(fast.model).toBe('gpt-6-luna');
    expect(fast.reasoning_effort).toBe('none');
    expect(fast.temperature).toBe(0.1);

    const orchestrator = openAiResponsesParams({
      tier: 'chat',
      maxOutputTokens: 4096,
    });
    expect(orchestrator.model).toBe('gpt-6.1-sol');
    expect(orchestrator.reasoning).toEqual({ effort: 'low' });

    delete process.env.PEGAZUZ_ENV;
    expect(resolveOpenAiModel('chat')).toBe('gpt-5.5');
    expect(resolveOpenAiModel('vision')).toBe('gpt-5.6-sol');
  });

  it('gpt-6.1-sol convierte none en low y no envía temperature', () => {
    process.env.PEGAZUZ_ENV = 'staging';
    process.env.OPENAI_REASONING_EFFORT_VISION = 'none';
    const p = openAiChatCompletionParams({
      tier: 'vision',
      maxOutputTokens: 12_000,
      temperature: 0.2,
    });
    expect(p.model).toBe('gpt-6.1-sol');
    expect(p.reasoning_effort).toBe('low');
    expect(p.temperature).toBeUndefined();
  });
});
