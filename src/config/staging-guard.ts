/** Staging no llama a Meta. Producción no define PEGAZUZ_ENV=staging. */
export function isStagingRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.PEGAZUZ_ENV ?? '').trim().toLowerCase() === 'staging';
}

export const STAGING_OUTBOUND_BLOCKED =
  'staging: el envío real a Meta está apagado.';
