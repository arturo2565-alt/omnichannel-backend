import { assertCrmMigrationAllowed } from './migration-target';

/**
 * Candado del job que publica staging.
 * No abre bases ni imprime identificadores.
 */
export function assertStagingDeployTarget(env: NodeJS.ProcessEnv): void {
  const environment = required(env.RAILWAY_ENVIRONMENT, 'RAILWAY_ENVIRONMENT');
  if (environment !== 'staging') {
    throw new Error('deploy ERROR: el entorno de Railway tiene que ser staging.');
  }

  const projectId = required(env.RAILWAY_PROJECT_ID, 'RAILWAY_PROJECT_ID');
  const productionProject = required(
    env.PRODUCTION_RAILWAY_PROJECT_ID,
    'PRODUCTION_RAILWAY_PROJECT_ID',
  );
  if (
    !isUuid(projectId) ||
    !isUuid(productionProject) ||
    projectId.toLowerCase() === productionProject.toLowerCase()
  ) {
    throw new Error('deploy ERROR: el proyecto de Railway no está separado de producción.');
  }

  const service = required(env.RAILWAY_SERVICE, 'RAILWAY_SERVICE');
  const production = required(
    env.PRODUCTION_RAILWAY_SERVICE,
    'PRODUCTION_RAILWAY_SERVICE',
  );
  if (!service.includes('staging') || looksLikeProduction(service)) {
    throw new Error('deploy ERROR: el servicio no es el de staging.');
  }
  if (service === production) {
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
