/**
 * Inserta el taller y las tarifas de ensayo.
 * Local no pide confirmación. Staging exige el mismo candado que las migraciones.
 * No copia clientes.
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

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error('seed:staging ERROR: falta DATABASE_URL. No se insertó nada.');
    process.exit(1);
  }
  assertCrmMigrationAllowed(url, process.env);

  const sql = readFileSync(join(__dirname, 'staging-synthetic.sql'), 'utf8');
  const ds = new DataSource({
    type: 'postgres',
    url,
    ssl: migrationUsesSsl(url, process.env.DATABASE_SSL)
      ? { rejectUnauthorized: false }
      : false,
    entities: [],
    synchronize: false,
  });

  await ds.initialize();
  try {
    const tables = await ds.query(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1)
    `,
      [['talleres', 'price_matrix']],
    );
    if (tables.length < 2) {
      console.error(
        'seed:staging ERROR: faltan talleres o price_matrix. Crea el esquema vacío antes. No se insertó nada.',
      );
      process.exit(1);
    }
    await ds.query(sql);
    console.log('OK: datos sintéticos de staging. Reaplicable.');
  } catch (err) {
    const message = redactDatabaseUrl(
      err instanceof Error ? err.message : String(err),
    );
    console.error(`seed:staging ERROR: ${message}`);
    process.exit(1);
  } finally {
    if (ds.isInitialized) await ds.destroy();
  }
}

void main();
