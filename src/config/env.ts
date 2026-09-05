/**
 * Validación de variables de entorno de infraestructura.
 * Se ejecuta al arrancar Nest (`ConfigModule.forRoot`).
 */

export type AppEnv = {
  REDIS_URL: string;
  [key: string]: unknown;
};

export function getRedisUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = String(env.REDIS_URL ?? '').trim();
  if (!url) {
    throw new Error(
      'REDIS_URL es requerida. Ejemplo: redis://127.0.0.1:6379 (BullMQ / colas omnichannel).',
    );
  }
  return url;
}

export function parseRedisUrl(raw: string): URL {
  const url = String(raw ?? '').trim();
  try {
    return new URL(url);
  } catch {
    throw new Error(
      `REDIS_URL no es una URL válida: "${url}". Usa redis:// o rediss://`,
    );
  }
}

/** Opciones de conexión ioredis / BullMQ a partir de REDIS_URL. */
export function buildBullMqRedisConnection(redisUrl: string): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
  maxRetriesPerRequest: null;
} {
  const parsed = parseRedisUrl(redisUrl);
  const protocol = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (protocol !== 'redis' && protocol !== 'rediss') {
    throw new Error(
      `REDIS_URL debe usar protocolo redis:// o rediss:// (recibido: ${parsed.protocol})`,
    );
  }

  const dbPath = parsed.pathname.replace(/^\//, '');
  const db = dbPath ? Number(dbPath) : undefined;

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(Number.isFinite(db) ? { db } : {}),
    ...(protocol === 'rediss' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

/** Schema mínimo: REDIS_URL obligatoria y parseable (redis:// o rediss://). */
export function validateEnv(env: Record<string, unknown>): AppEnv {
  const REDIS_URL = getRedisUrl(env as NodeJS.ProcessEnv);
  buildBullMqRedisConnection(REDIS_URL);
  return { ...env, REDIS_URL };
}
