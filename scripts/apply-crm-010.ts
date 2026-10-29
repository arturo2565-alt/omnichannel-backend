/**
 * Aplica src/chat/migrations/006_crm_catalog_snapshot.sql
 *
 *   DATABASE_URL=postgres://... npm run migrate:crm-010
 *
 * En local no pide confirmación. Staging y producción sí.
 * No reescribe cotizaciones. synchronize queda en false.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import {
  migrationUsesSsl,
  redactDatabaseUrl,
} from '../src/config/db-synchronize';
import { assertCrmMigrationAllowed } from '../src/config/migration-target';

const REQUIRED_COLUMNS = [
  'catalogPieceCode',
  'tariffKind',
  'catalogOperations',
  'catalogMatrixRowId',
  'catalogUnitPriceCents',
];

export const MISSING_DATABASE_URL_MESSAGE =
  'migrate:crm-010 ERROR: falta DATABASE_URL. No se aplicó ninguna migración.';

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error(MISSING_DATABASE_URL_MESSAGE);
    process.exit(1);
  }
  assertCrmMigrationAllowed(url, process.env);

  const useSsl = migrationUsesSsl(url, process.env.DATABASE_SSL);
  const sql = readFileSync(
    join(__dirname, '../src/chat/migrations/006_crm_catalog_snapshot.sql'),
    'utf8',
  );
  const ds = new DataSource({
    type: 'postgres',
    url,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    entities: [],
    synchronize: false,
  });

  let incomplete = '';
  await ds.initialize();
  try {
    const tables = await ds.query(
      `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'appointment_service_lines'
    `,
    );
    if (tables.length === 0) {
      console.error(
        'migrate:crm-010 ERROR: falta appointment_service_lines. Aplica migrate:crm-008 antes. No se cambió el esquema.',
      );
      process.exit(1);
    }
    await ds.query(sql);
    const cols = await ds.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'appointment_service_lines'
        AND column_name = ANY($1)
      ORDER BY column_name
    `,
      [REQUIRED_COLUMNS],
    );
    const found = cols.map((row: { column_name: string }) => row.column_name);
    const missing = REQUIRED_COLUMNS.filter((name) => !found.includes(name));
    if (missing.length > 0) {
      incomplete = missing.join(', ');
    } else {
      console.log(
        `OK: migración CRM-010 aplicada. Columnas: ${found.join(', ')}. Reaplicable.`,
      );
    }
  } finally {
    await ds.destroy();
  }
  if (incomplete) {
    console.error(
      `migrate:crm-010 ERROR: el esquema quedó incompleto. Faltan: ${incomplete}`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  const text = err instanceof Error ? err.message : String(err);
  console.error(redactDatabaseUrl(text));
  process.exit(1);
});
