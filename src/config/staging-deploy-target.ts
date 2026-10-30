import { assertCrmMigrationAllowed } from './migration-target';

/**
 * Candado del job que publica staging.
 * No abre bases ni imprime identificadores.
 */
export const STAGING_RAILWAY_ENVIRONMENT = 'staging';
export const STAGING_RAILWAY_SERVICE = 'pegazuz-backend-staging';
export const PRODUCTION_RAILWAY_SERVICE = 'omnichannel-backend';

export function assertStagingDeployTarget(env: NodeJS.ProcessEnv): void {
  const environment = required(env.RAILWAY_ENVIRONMENT, 'RAILWAY_ENVIRONMENT');
  if (environment !== STAGING_RAILWAY_ENVIRONMENT) {
    throw new Error('deploy ERROR: el entorno de Railway tiene que ser staging.');
  }

  const projectId = required(env.RAILWAY_PROJECT_ID, 'RAILWAY_PROJECT_ID');
  if (!isUuid(projectId)) {
    throw new Error('deploy ERROR: falta el UUID del proyecto de Railway.');
  }
  const productionProject = String(env.PRODUCTION_RAILWAY_PROJECT_ID ?? '').trim();
  if (productionProject && !isUuid(productionProject)) {
    throw new Error('deploy ERROR: el UUID de producción no es válido.');
  }

  const environmentId = required(
    env.RAILWAY_STAGING_ENVIRONMENT_ID,
    'RAILWAY_STAGING_ENVIRONMENT_ID',
  );
  const serviceId = required(env.RAILWAY_STAGING_SERVICE_ID, 'RAILWAY_STAGING_SERVICE_ID');
  if (!isUuid(environmentId) || !isUuid(serviceId) || sameId(environmentId, serviceId)) {
    throw new Error('deploy ERROR: faltan los UUID de entorno y servicio de staging.');
  }

  const service = required(env.RAILWAY_SERVICE, 'RAILWAY_SERVICE');
  if (service === PRODUCTION_RAILWAY_SERVICE) {
    throw new Error('deploy ERROR: el servicio de producción queda fuera de este pipeline.');
  }
  if (service !== STAGING_RAILWAY_SERVICE) {
    throw new Error('deploy ERROR: el servicio de Railway tiene que ser pegazuz-backend-staging.');
  }
  const productionService = String(env.PRODUCTION_RAILWAY_SERVICE ?? '').trim();
  if (productionService && productionService === service) {
    throw new Error('deploy ERROR: el servicio de staging no está separado de producción.');
  }

  const dbHost = required(env.STAGING_DB_HOST, 'STAGING_DB_HOST');
  if (looksLikeProduction(dbHost)) {
    throw new Error('deploy ERROR: el host de la base no puede ser de producción.');
  }

  const publicHost = required(env.STAGING_PUBLIC_HOST, 'STAGING_PUBLIC_HOST').toLowerCase();
  if (looksLikeProduction(publicHost)) {
    throw new Error('deploy ERROR: el host público no puede ser de producción.');
  }

  assertSmokeUrl(env.STAGING_SMOKE_URL, publicHost);

  if (env.STAGING_NATIVE_DEPLOY !== 'off') {
    throw new Error(
      'deploy ERROR: apaga el autodeploy nativo y fija STAGING_NATIVE_DEPLOY=off.',
    );
  }
  if (String(env.PEGAZUZ_ENV ?? '').trim() !== 'staging') {
    throw new Error('deploy ERROR: PEGAZUZ_ENV tiene que ser staging.');
  }
  if (!isExplicitFalse(env.DB_SYNCHRONIZE)) {
    throw new Error('deploy ERROR: DB_SYNCHRONIZE tiene que quedar en false.');
  }
  if (String(env.CRM_PRODUCTION_MIGRATE ?? '').trim()) {
    throw new Error('deploy ERROR: el despliegue no acepta la confirmación de producción.');
  }
  if (String(env.CRM_MIGRATE_TARGET ?? '').trim()) {
    throw new Error('deploy ERROR: el despliegue no migra.');
  }
}

/**
 * Un project token de Railway pertenece a un solo entorno del proyecto.
 * La consulta projectToken no autentica un token de cuenta.
 */
export function assertRailwayProjectToken(payload: unknown, env: NodeJS.ProcessEnv): void {
  const token = readProjectToken(payload);
  const projectId = String(token?.projectId ?? '').trim();
  const environmentId = String(token?.environmentId ?? '').trim();
  const expectedProject = String(env.RAILWAY_PROJECT_ID ?? '').trim();
  const expectedEnvironment = String(env.RAILWAY_STAGING_ENVIRONMENT_ID ?? '').trim();
  if (!projectId || !environmentId || !expectedProject || !expectedEnvironment) {
    throw new Error('deploy ERROR: el token no es un project token limitado a staging.');
  }
  if (!sameId(projectId, expectedProject) || !sameId(environmentId, expectedEnvironment)) {
    throw new Error('deploy ERROR: el token no está limitado al entorno staging fijado.');
  }
}

function readProjectToken(payload: unknown): { projectId?: string; environmentId?: string } | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = (payload as { data?: { projectToken?: { projectId?: string; environmentId?: string } } })
    .data;
  return data?.projectToken ?? null;
}

/**
 * El volcado desde GitHub no puede usar el hostname privado de Railway.
 * La comparación con el host fijado sigue en assertCrmMigrationAllowed.
 */
export function assertStagingBackupUrl(
  databaseUrl: string,
  env: NodeJS.ProcessEnv,
): void {
  assertCrmMigrationAllowed(databaseUrl, env);
  const host = postgresHostname(databaseUrl);
  if (!host || host.endsWith('.internal') || host.endsWith('.railway.internal')) {
    throw new Error(
      'backup ERROR: el host es de la red privada. No se vuelca desde GitHub.',
    );
  }
}

function assertSmokeUrl(value: string | undefined, publicHost: string): void {
  let url: URL;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new Error('deploy ERROR: la URL de humo no es válida.');
  }
  if (url.protocol !== 'https:' || url.pathname !== '/api/health') {
    throw new Error('deploy ERROR: el humo tiene que ser https y /api/health.');
  }
  if (url.hostname.toLowerCase() !== publicHost || looksLikeProduction(url.hostname)) {
    throw new Error('deploy ERROR: el humo no coincide con el host público de staging.');
  }
}

function required(value: string | undefined, name: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`deploy ERROR: falta ${name}.`);
  return text;
}

function looksLikeProduction(value: string): boolean {
  const text = value.trim().toLowerCase();
  return text.includes('production') || text === 'prod' || text === 'main';
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function sameId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isExplicitFalse(value: string | undefined): boolean {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'false' || text === '0' || text === 'no';
}

function postgresHostname(databaseUrl: string): string {
  const normalized = String(databaseUrl ?? '')
    .trim()
    .replace(/^postgres(ql)?:\/\//i, 'http://');
  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return '';
  }
}
