import { openAiResponsesParams } from './openai-model-config';

describe('openai-responses-tool-loop helpers', () => {
  it('openAiResponsesParams incluye reasoning nested para chat tier', () => {
    const p = openAiResponsesParams({ tier: 'chat', maxOutputTokens: 4096 });
    expect(p.model).toBe('gpt-5.5');
    expect(p.reasoning).toEqual({ effort: 'low' });
    expect(p.max_output_tokens).toBe(4096);
  });
});
