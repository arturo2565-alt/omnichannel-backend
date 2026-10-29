import { isLocalDatabaseUrl } from './db-synchronize';

const REFUSED =
  'migrate ERROR: la base no es local. Define CRM_MIGRATE_TARGET=staging con CRM_STAGING_MIGRATE=yes, o CRM_MIGRATE_TARGET=production con CRM_PRODUCTION_MIGRATE=yes. No se aplicó la migración.';

/**
 * Las pruebas y los scripts locales solo abren Postgres local.
 * Staging y producción exigen una confirmación distinta, y staging
 * no puede usar un host marcado como producción.
 */
export function assertCrmMigrationAllowed(
  databaseUrl: string,
  env: NodeJS.ProcessEnv,
): void {
  if (isLocalDatabaseUrl(databaseUrl)) return;

  const target = String(env.CRM_MIGRATE_TARGET ?? '').trim().toLowerCase();
  const host = hostname(databaseUrl);
  const productionHost = host.includes('production');

  if (target === 'staging') {
    if (productionHost) {
      throw new Error(
        'migrate ERROR: CRM_MIGRATE_TARGET=staging no puede apuntar a un host de producción.',
      );
    }
    if (String(env.CRM_STAGING_MIGRATE ?? '').trim().toLowerCase() !== 'yes') {
      throw new Error(
        'migrate ERROR: la migración de staging requiere CRM_STAGING_MIGRATE=yes.',
      );
    }
    const pinned = String(env.STAGING_DB_HOST ?? '').trim().toLowerCase();
    if (!pinned || pinned.includes('production')) {
      throw new Error(
        'migrate ERROR: staging requiere STAGING_DB_HOST y no puede ser un host de producción.',
      );
    }
    if (host !== pinned) {
      throw new Error(
        'migrate ERROR: el host no coincide con STAGING_DB_HOST.',
      );
    }
    return;
  }

  if (target === 'production') {
    if (String(env.CRM_PRODUCTION_MIGRATE ?? '').trim().toLowerCase() !== 'yes') {
      throw new Error(
        'migrate ERROR: la migración de producción requiere CRM_PRODUCTION_MIGRATE=yes.',
      );
    }
    return;
  }

  throw new Error(REFUSED);
}

function hostname(databaseUrl: string): string {
  const normalized = String(databaseUrl ?? '')
    .trim()
    .replace(/^postgres(ql)?:\/\//i, 'http://');
  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return '';
  }
}
