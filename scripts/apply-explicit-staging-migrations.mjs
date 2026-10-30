/**
 * Aplica 004, 005 y 006 dentro del servicio de staging.
 * No siembra, no sincroniza y no acepta la confirmación de producción.
 * Se ejecuta con node, sin ts-node, para poder correr en la imagen publicada.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FILES = [
  '004_crm_manual_appointments.sql',
  '005_crm_service_lines.sql',
  '006_crm_catalog_snapshot.sql',
];

export function assertExplicitStagingMigration(env, databaseUrl) {
  const sync = String(env.DB_SYNCHRONIZE ?? '').trim().toLowerCase();
  if (sync === 'true' || sync === '1' || sync === 'yes') {
    throw new Error('migrate ERROR: DB_SYNCHRONIZE no puede activarse.');
  }
  if (String(env.CRM_PRODUCTION_MIGRATE ?? '').trim()) {
    throw new Error('migrate ERROR: este comando no acepta la confirmación de producción.');
  }
  if (String(env.CRM_MIGRATE_TARGET ?? '').trim().toLowerCase() !== 'staging') {
    throw new Error('migrate ERROR: el destino tiene que ser staging.');
  }
  if (String(env.CRM_STAGING_MIGRATE ?? '').trim().toLowerCase() !== 'yes') {
    throw new Error('migrate ERROR: falta CRM_STAGING_MIGRATE=yes.');
  }
  const host = hostname(databaseUrl);
  const pinned = String(env.STAGING_DB_HOST ?? '').trim().toLowerCase();
  if (!host || !pinned || pinned.includes('production') || host.includes('production')) {
    throw new Error('migrate ERROR: el destino no puede ser producción.');
  }
  if (host !== pinned) {
    throw new Error('migrate ERROR: el host no coincide con STAGING_DB_HOST.');
  }
}

function hostname(databaseUrl) {
  const normalized = String(databaseUrl ?? '')
    .trim()
    .replace(/^postgres(ql)?:\/\//i, 'http://');
  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function useSsl(databaseUrl, flag) {
  const value = String(flag ?? '').trim().toLowerCase();
  if (value === 'false' || value === '0' || value === 'no') return false;
  if (value === 'true' || value === '1' || value === 'yes') return true;
  const host = hostname(databaseUrl);
  return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
}

async function main() {
  const url = String(process.env.DATABASE_URL ?? '').trim();
  if (!url) {
    console.error('migrate ERROR: falta DATABASE_URL. No se aplicó ninguna migración.');
    process.exit(1);
  }
  try {
    assertExplicitStagingMigration(process.env, url);
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'migrate ERROR');
    process.exit(1);
  }

  const { Client } = await import('pg');
  const client = new Client({
    connectionString: url,
    ssl: useSsl(url, process.env.DATABASE_SSL) ? { rejectUnauthorized: false } : false,
  });
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../src/chat/migrations');
  try {
    await client.connect();
    for (const file of FILES) {
      const sql = readFileSync(join(dir, file), 'utf8');
      await client.query(sql);
      console.log(`OK: ${file}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://***'));
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
