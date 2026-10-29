/**
 * Aplica src/chat/migrations/004_crm_manual_appointments.sql
 *
 *   DATABASE_URL=postgres://... npm run migrate:crm-001a
 *
 * En local, con DB_SYNCHRONIZE=true, TypeORM también puede crear las columnas.
 * Este script es el camino controlado cuando synchronize está desactivado.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.log(
      'migrate:crm-001a SKIP — no DATABASE_URL. El SQL está en src/chat/migrations/004_crm_manual_appointments.sql',
    );
    process.exit(0);
  }

  const useSsl =
    process.env.DATABASE_SSL === 'true' || /sslmode=require/i.test(url);
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

  await ds.initialize();
  try {
    await ds.query(sql);
    const cols = await ds.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'appointments'
        AND column_name IN (
          'tallerId',
          'contactId',
          'quotedAmount',
          'source',
          'clientRequestId'
        )
      ORDER BY column_name
    `);
    console.log(
      `OK: migración CRM-001-A aplicada. Columnas: ${cols
        .map((c: { column_name: string }) => c.column_name)
        .join(', ')}`,
    );
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
