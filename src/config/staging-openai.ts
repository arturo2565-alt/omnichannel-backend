import { OpenAI } from 'openai';
import { isStagingRuntime, STAGING_EXTERNAL_BLOCKED } from './staging-guard';

/**
 * En staging el cliente se construye sin OPENAI_API_KEY y cualquier
 * solicitud se rechaza antes de salir a la red. Producción conserva
 * la clave del entorno.
 */
export function createOpenAiClient(env: NodeJS.ProcessEnv = process.env): OpenAI {
  if (!isStagingRuntime(env)) {
    return new OpenAI({ apiKey: env.OPENAI_API_KEY });
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
