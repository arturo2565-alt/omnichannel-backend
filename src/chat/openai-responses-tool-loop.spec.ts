import { openAiResponsesParams } from './openai-model-config';

describe('openai-responses-tool-loop helpers', () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.PEGAZUZ_ENV;
    delete process.env.OPENAI_MODEL_CHAT;
  });

  afterAll(() => {
    process.env = env;
  });

  it('openAiResponsesParams incluye reasoning nested para chat tier', () => {
    const p = openAiResponsesParams({ tier: 'chat', maxOutputTokens: 4096 });
    expect(p.model).toBe('gpt-5.5');
    expect(p.reasoning).toEqual({ effort: 'low' });
    expect(p.max_output_tokens).toBe(4096);
  });
});
