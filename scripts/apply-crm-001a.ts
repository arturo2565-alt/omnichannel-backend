/**
 * Aplica src/chat/migrations/004_crm_manual_appointments.sql
 *
 *   DATABASE_URL=postgres://... DATABASE_SSL=true npm run migrate:crm-001a
 *
 * El SQL es idempotente. No reescribe filas. synchronize queda en false.
 * El rol necesita ALTER en appointments, CREATE en el esquema y REFERENCES
 * hacia talleres y contacts. No hace falta ser superusuario.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import {
  migrationUsesSsl,
  redactDatabaseUrl,
} from '../src/config/db-synchronize';

const REQUIRED_COLUMNS = [
  'tallerId',
  'contactId',
  'quotedAmount',
  'source',
  'clientRequestId',
];

export const MISSING_DATABASE_URL_MESSAGE =
  'migrate:crm-001a ERROR: falta DATABASE_URL. No se aplicó ninguna migración.';

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error(MISSING_DATABASE_URL_MESSAGE);
    process.exit(1);
  }

  const useSsl = migrationUsesSsl(url, process.env.DATABASE_SSL);
  const sql = readFileSync(
    join(__dirname, '../src/chat/migrations/004_crm_manual_appointments.sql'),
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
    await ds.query(sql);
    const cols = await ds.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'appointments'
        AND column_name = ANY($1)
      ORDER BY column_name
    `,
      [REQUIRED_COLUMNS],
    );
    const found = cols.map((c: { column_name: string }) => c.column_name);
    const missing = REQUIRED_COLUMNS.filter((name) => !found.includes(name));
    const tables = await ds.query(
      `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'contracted_works'
    `,
    );
    if (missing.length > 0 || tables.length === 0) {
      incomplete = missing.join(', ') || 'contracted_works';
    } else {
      console.log(
        `OK: migración CRM-001-A aplicada. Columnas: ${found.join(', ')}. Tabla: contracted_works. Reaplicable.`,
      );
    }
  } finally {
    await ds.destroy();
  }
  if (incomplete) {
    console.error(
      `migrate:crm-001a ERROR: el esquema quedó incompleto. Faltan: ${incomplete}`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  const text = err instanceof Error ? err.message : String(err);
  console.error(redactDatabaseUrl(text));
  process.exit(1);
});
