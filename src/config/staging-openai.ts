import { OpenAI } from 'openai';
import { isStagingRuntime, STAGING_EXTERNAL_BLOCKED } from './staging-guard';
import { readStagingSandbox, stagingOpenAiFetch } from './staging-sandbox';

/**
 * Producción usa OPENAI_API_KEY. Staging permanece inerte hasta que el sandbox
 * esté completo; entonces usa solo STAGING_OPENAI_API_KEY y el presupuesto del proceso.
 */
export function createOpenAiClient(env: NodeJS.ProcessEnv = process.env): OpenAI {
  if (!isStagingRuntime(env)) {
    return new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  const sandbox = readStagingSandbox(env);
  if (sandbox.active) {
    return new OpenAI({
      apiKey: sandbox.config.openAiApiKey,
      maxRetries: 0,
      fetch: stagingOpenAiFetch(sandbox.config),
    });
  }
  return new OpenAI({
    apiKey: 'staging-disabled',
    maxRetries: 0,
    fetch: async () =>
      new Response(
        JSON.stringify({
          error: {
            message: STAGING_EXTERNAL_BLOCKED,
            type: 'staging_external_blocked',
          },
        }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      ),
  });
}
