import * as Sentry from '@sentry/node';

let sentryEnabled = false;

export function isSentryEnabled(): boolean {
  return sentryEnabled;
}

/**
 * Debe llamarse antes de `NestFactory.create`.
 * Sin `SENTRY_DSN` no inicializa (local/CI seguro).
 */
export function initSentry(): void {
  const dsn = String(process.env.SENTRY_DSN ?? '').trim();
  if (!dsn) {
    console.warn(
      '[Sentry] SENTRY_DSN no definido — captura de errores desactivada (ok en local/CI).',
    );
    sentryEnabled = false;
    return;
  }

  const isProd = String(process.env.NODE_ENV ?? '').trim() === 'production';
  const sampleRaw = Number(process.env.SENTRY_TRACES_SAMPLE_RATE);
  const tracesSampleRate = Number.isFinite(sampleRaw)
    ? Math.min(1, Math.max(0, sampleRaw))
    : isProd
      ? 0.2
      : 1.0;

  Sentry.init({
    dsn,
    environment:
      String(process.env.SENTRY_ENVIRONMENT ?? '').trim() ||
      String(process.env.NODE_ENV ?? '').trim() ||
      'development',
    tracesSampleRate,
    sendDefaultPii: false,
  });

  sentryEnabled = true;
  console.log(
    `[Sentry] inicializado (env=${process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development'}, tracesSampleRate=${tracesSampleRate})`,
  );
}
