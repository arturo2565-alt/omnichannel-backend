/**
 * Vuelca el proxy público de staging con verify-full.
 * No pasa la URL a pg_dump y no imprime la clave.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertSyntheticWorkshop, rowsFromPsql, STAGING_TALLER_ID } from './assert-staging-restore.mjs';

export function libpqEnv(databaseUrl, env) {
  const raw = String(databaseUrl ?? '').trim();
  if (/sslmode=(disable|allow|prefer|require|verify-ca)\b/i.test(raw)) {
    throw new Error('backup ERROR: la URL no puede debilitar TLS.');
  }
  let parsed;
  try {
    parsed = new URL(raw.replace(/^postgres(ql)?:\/\//i, 'http://'));
  } catch {
    throw new Error('backup ERROR: la URL de origen no es válida.');
  }
  const host = parsed.hostname.toLowerCase();
  const expected = String(env?.STAGING_DB_PUBLIC_HOST ?? '').trim().toLowerCase();
  const production = String(env?.PRODUCTION_DB_PUBLIC_HOST ?? '').trim().toLowerCase();
  if (
    !host ||
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host.endsWith('.internal') ||
    !expected ||
    host !== expected ||
    !production ||
    host === production
  ) {
    throw new Error('backup ERROR: el origen no es el proxy público de staging.');
  }
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!user || !password || !database || /[\r\n]/.test(password)) {
    throw new Error('backup ERROR: la URL de origen está incompleta.');
  }
  return {
    PGHOST: host,
    PGPORT: parsed.port || '5432',
    PGUSER: user,
    PGPASSWORD: password,
    PGDATABASE: database,
    PGSSLMODE: 'verify-full',
  };
}

export function redactBackupLog(text) {
  return String(text ?? '')
    .replace(/postgres(ql)?:\/\/\S+/gi, 'postgres://redacted')
    .replace(/\bpassword=\S+/gi, 'password=redacted');
}

function fail(err) {
  const message = err instanceof Error ? err.message : 'backup ERROR';
  console.error(redactBackupLog(message));
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2];
  const cert = String(process.env.STAGING_DB_ROOT_CERT ?? '');
  if (!out || !cert.includes('BEGIN CERTIFICATE') || cert.includes('PRIVATE KEY')) {
    console.error('backup ERROR: falta el certificado público de la base de staging.');
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), 'pegazuz-backup-'));
  const certPath = join(dir, 'root.crt');
  try {
    writeFileSync(certPath, cert, { mode: 0o600 });
    const lib = libpqEnv(process.env.DATABASE_URL, process.env);
    const childEnv = { ...process.env, ...lib, PGSSLROOTCERT: certPath };
    delete childEnv.DATABASE_URL;
    delete childEnv.STAGING_BACKUP_KEY;
    delete childEnv.STAGING_DB_ROOT_CERT;
    const psql = spawnSync(
      process.env.PSQL,
      [
        '--no-align',
        '--tuples-only',
        '--field-separator=|',
        '--command',
        `SELECT id, nombre FROM talleres WHERE id = '${STAGING_TALLER_ID}'`,
      ],
      { env: childEnv, encoding: 'utf8' },
    );
    if (psql.status !== 0) {
      console.error(redactBackupLog(psql.stderr || 'backup ERROR: no se pudo identificar la base.'));
      process.exit(psql.status || 1);
    }
    assertSyntheticWorkshop(rowsFromPsql(psql.stdout));
    const dump = spawnSync(
      process.env.PG_DUMP,
      ['--format=custom', '--no-owner', `--file=${out}`],
      { env: childEnv, encoding: 'utf8' },
    );
    if (dump.status !== 0) {
      console.error(redactBackupLog(dump.stderr || 'backup ERROR: pg_dump falló.'));
      process.exit(dump.status || 1);
    }
    console.log('OK: el volcado salió del proxy público de staging.');
  } catch (err) {
    fail(err);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
