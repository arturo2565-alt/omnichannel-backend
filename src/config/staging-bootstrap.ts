import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import {
  migrationUsesSsl,
  redactDatabaseUrl,
} from './db-synchronize';
import { TYPEORM_ENTITIES } from './typeorm-entities';

/** 004, 005 y 006. El orden es el de producción: citas, desglose, snapshot. */
export const STAGING_MIGRATION_FILES = [
  '004_crm_manual_appointments.sql',
  '005_crm_service_lines.sql',
  '006_crm_catalog_snapshot.sql',
] as const;

const IGNORED_TABLES = new Set(['spatial_ref_sys']);

export function schemaIsEmpty(tableNames: string[]): boolean {
  return tableNames.every((name) => IGNORED_TABLES.has(name));
}

/**
 * El comando de una sola vez exige staging, la confirmación y el host fijado.
 * Producción queda rechazada aunque las otras variables parezcan correctas.
 * DB_SYNCHRONIZE del entorno tiene que seguir en false: el esquema se crea
 * solo dentro de este proceso y la conexión se cierra al terminar.
 */
export function assertStagingBootstrapAllowed(
  databaseUrl: string,
  env: NodeJS.ProcessEnv,
): void {
  if (!String(databaseUrl ?? '').trim()) {
    throw new Error('bootstrap ERROR: falta DATABASE_URL. No se creó el esquema.');
  }
  if (String(env.PEGAZUZ_ENV ?? '').trim().toLowerCase() !== 'staging') {
    throw new Error('bootstrap ERROR: exige PEGAZUZ_ENV=staging.');
  }
  if (String(env.STAGING_SCHEMA_BOOTSTRAP ?? '').trim().toLowerCase() !== 'yes') {
    throw new Error('bootstrap ERROR: exige STAGING_SCHEMA_BOOTSTRAP=yes.');
  }

  const sync = String(env.DB_SYNCHRONIZE ?? '').trim().toLowerCase();
  if (sync === 'true' || sync === '1' || sync === 'yes') {
    throw new Error(
      'bootstrap ERROR: DB_SYNCHRONIZE tiene que permanecer en false. Este comando crea el esquema y cierra la conexión.',
    );
  }

  const target = String(env.CRM_MIGRATE_TARGET ?? '').trim().toLowerCase();
  const productionMigrate =
    String(env.CRM_PRODUCTION_MIGRATE ?? '').trim().toLowerCase() === 'yes';
  if (target === 'production' || productionMigrate) {
    throw new Error(
      'bootstrap ERROR: este comando no puede ejecutarse contra producción.',
    );
  }

  const railway = String(
    env.RAILWAY_ENVIRONMENT ?? env.RAILWAY_ENVIRONMENT_NAME ?? '',
  )
    .trim()
    .toLowerCase();
  if (railway === 'prod' || railway.includes('production')) {
    throw new Error('bootstrap ERROR: el entorno de Railway es de producción.');
  }

  const host = postgresHost(databaseUrl);
  const pinned = String(env.STAGING_DB_HOST ?? '').trim().toLowerCase();
  if (!host || host.includes('production') || pinned.includes('production')) {
    throw new Error('bootstrap ERROR: el destino no puede ser producción.');
  }
  if (!pinned || host !== pinned) {
    throw new Error('bootstrap ERROR: el host no coincide con STAGING_DB_HOST.');
  }
}

export async function runStagingBootstrap(
  env: NodeJS.ProcessEnv,
): Promise<{ createdSchema: boolean }> {
  const url = String(env.DATABASE_URL ?? '').trim();
  assertStagingBootstrapAllowed(url, env);
  const syncFlag = String(env.DB_SYNCHRONIZE ?? '');

  const probe = openDataSource(url, env, false);
  let created: DataSource | undefined;
  let apply: DataSource | undefined;
  let createdSchema = false;
  try {
    await probe.initialize();
    const tables = await listPublicTables(probe);
    await probe.destroy();
    createdSchema = schemaIsEmpty(tables);
    if (createdSchema) {
      created = openDataSource(url, env, true);
      await created.initialize();
      await created.destroy();
      created = undefined;
    }

    apply = openDataSource(url, env, false);
    await apply.initialize();
    await apply.transaction(async (manager) => {
      for (const file of STAGING_MIGRATION_FILES) {
        const sql = readFileSync(migrationPath(file), 'utf8');
        await manager.query(sql);
      }
      await manager.query(readFileSync(seedPath(), 'utf8'));
    });
    await assertBootstrapReady(apply);
  } catch (err) {
    if (isBootstrapError(err)) throw err;
    throw new Error(redactDatabaseUrl(err instanceof Error ? err.message : String(err)));
  } finally {
    await closeQuietly(probe);
    await closeQuietly(created);
    await closeQuietly(apply);
  }

  if (String(env.DB_SYNCHRONIZE ?? '') !== syncFlag) {
    throw new Error('bootstrap ERROR: DB_SYNCHRONIZE cambió durante el comando.');
  }
  return { createdSchema };
}

function openDataSource(
  url: string,
  env: NodeJS.ProcessEnv,
  synchronize: boolean,
): DataSource {
  const useSsl = migrationUsesSsl(url, env.DATABASE_SSL);
  return new DataSource({
    type: 'postgres',
    url,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    entities: TYPEORM_ENTITIES,
    synchronize,
  });
}

async function listPublicTables(ds: DataSource): Promise<string[]> {
  const rows = await ds.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  return rows.map((row: { tablename: string }) => row.tablename);
}

async function assertBootstrapReady(ds: DataSource): Promise<void> {
  const columns = await ds.query(
    `
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (
        (table_name = 'appointments' AND column_name = ANY($1))
        OR (table_name = 'appointment_service_lines' AND column_name = ANY($2))
      )
  `,
    [
      [
        'tallerId',
        'quotedAmount',
        'source',
        'clientRequestId',
        'campaignName',
        'adName',
        'adExternalId',
        'attributionKind',
      ],
      [
        'quantityHundredths',
        'catalogPieceCode',
        'tariffKind',
        'catalogOperations',
        'catalogMatrixRowId',
        'catalogUnitPriceCents',
      ],
    ],
  );
  const found = new Set(
    columns.map(
      (row: { table_name: string; column_name: string }) =>
        `${row.table_name}.${row.column_name}`,
    ),
  );
  const expected = [
    'appointments.tallerId',
    'appointments.quotedAmount',
    'appointments.source',
    'appointments.clientRequestId',
    'appointments.campaignName',
    'appointments.adName',
    'appointments.adExternalId',
    'appointments.attributionKind',
    'appointment_service_lines.quantityHundredths',
    'appointment_service_lines.catalogPieceCode',
    'appointment_service_lines.tariffKind',
    'appointment_service_lines.catalogOperations',
    'appointment_service_lines.catalogMatrixRowId',
    'appointment_service_lines.catalogUnitPriceCents',
  ];
  const missing = expected.filter((name) => !found.has(name));
  if (missing.length > 0) {
    throw new Error(
      `bootstrap ERROR: el esquema quedó incompleto. Faltan: ${missing.join(', ')}`,
    );
  }

  const taller = await ds.query(
    `SELECT nombre FROM talleres WHERE nombre = 'Taller de ensayo'`,
  );
  if (taller.length !== 1) {
    throw new Error('bootstrap ERROR: no quedó el taller sintético.');
  }
  const people = await ds.query(
    `SELECT (SELECT COUNT(*)::int FROM contacts) AS contacts`,
  );
  if (Number(people[0]?.contacts) !== 0) {
    throw new Error('bootstrap ERROR: el esquema no está libre de contactos.');
  }
}

function migrationPath(file: string): string {
  return join(__dirname, '../chat/migrations', file);
}

function seedPath(): string {
  return join(__dirname, '../../scripts/staging-synthetic.sql');
}

function postgresHost(databaseUrl: string): string {
  const normalized = String(databaseUrl ?? '')
    .trim()
    .replace(/^postgres(ql)?:\/\//i, 'http://');
  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isBootstrapError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('bootstrap ERROR:');
}

async function closeQuietly(ds: DataSource | undefined): Promise<void> {
  if (ds?.isInitialized) await ds.destroy();
}
