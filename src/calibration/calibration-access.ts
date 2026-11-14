import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

/**
 * Misma compuerta que la consulta: staging, lectura habilitada, sin ingesta,
 * fuera de producción, rol owner y correo exacto en CALIBRATION_READ_ACTORS.
 */

const ACTOR = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function calibrationQueryAccess(
  env: NodeJS.ProcessEnv,
  user: AuthenticatedUser | undefined,
): 'open' | 'hidden' | 'forbidden' {
  if (!queryVisible(env)) return 'hidden';
  if (user?.role !== 'owner' || !actorPermitted(user.email, env)) return 'forbidden';
  return 'open';
}

function actorPermitted(email: unknown, env: NodeJS.ProcessEnv): boolean {
  if (typeof email !== 'string') return false;
  const normalized = email.trim().toLowerCase();
  if (!ACTOR.test(normalized) || normalized.length > 254) return false;
  return new Set(readActors(env)).has(normalized);
}

function queryVisible(env: NodeJS.ProcessEnv): boolean {
  if (String(env.CALIBRATION_READ_ENABLED ?? '').trim() !== 'true') return false;
  if (String(env.CALIBRATION_INGEST_ENABLED ?? '').trim() === 'true') return false;
  if (String(env.PEGAZUZ_ENV ?? '').trim().toLowerCase() !== 'staging') return false;
  const railwayEnv = String(env.RAILWAY_ENVIRONMENT_NAME ?? '').trim();
  if (railwayEnv === 'production') return false;
  const service = String(env.RAILWAY_SERVICE_NAME ?? '').trim();
  return service !== 'omnichannel-backend' && service !== 'Postgres';
}

function readActors(env: NodeJS.ProcessEnv): string[] {
  return String(env.CALIBRATION_READ_ACTORS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => ACTOR.test(item))
    .slice(0, 20);
}
