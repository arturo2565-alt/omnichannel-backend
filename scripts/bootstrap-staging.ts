/**
 * Inicializa una sola vez el Postgres vacío de staging.
 * No arranca Nest y no deja DB_SYNCHRONIZE activo.
 *
 * Dentro de la red privada de Railway, en pegazuz-backend-staging,
 * con DATABASE_URL, PEGAZUZ_ENV=staging, DB_SYNCHRONIZE=false y
 * STAGING_DB_HOST ya presentes:
 *
 *   STAGING_SCHEMA_BOOTSTRAP=yes npm run bootstrap:staging
 *
 * STAGING_SCHEMA_BOOTSTRAP no se guarda en el servicio.
 */
import 'reflect-metadata';
import { redactDatabaseUrl } from '../src/config/db-synchronize';
import { runStagingBootstrap } from '../src/config/staging-bootstrap';

async function main() {
  const result = await runStagingBootstrap(process.env);
  console.log(
    result.createdSchema
      ? 'OK: esquema de staging creado, migraciones 004-006 aplicadas y datos sintéticos cargados. Conexiones cerradas. DB_SYNCHRONIZE sigue en false.'
      : 'OK: el esquema ya existía. Migraciones 004-006 y datos sintéticos reaplicados. Conexiones cerradas. DB_SYNCHRONIZE sigue en false.',
  );
}

main().catch((err) => {
  const text = err instanceof Error ? err.message : String(err);
  console.error(redactDatabaseUrl(text));
  process.exit(1);
});
