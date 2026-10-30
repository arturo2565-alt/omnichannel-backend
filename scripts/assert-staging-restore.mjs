/**
 * Candados del ensayo de restauración.
 * El destino solo puede ser 127.0.0.1 y el cliente tiene que ser PostgreSQL 18.
 * No abre conexiones y no imprime URLs.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const STAGING_TALLER_ID = '01000000-0000-4000-8000-000000000010';
export const STAGING_TALLER_NAME = 'Taller de ensayo';

export function assertPostgres18(versionText, tool) {
  const match = String(versionText ?? '').match(/\(PostgreSQL\)\s+(\d+)\./);
  if (!match || match[1] !== '18') {
    throw new Error(`backup ERROR: ${tool} tiene que ser PostgreSQL 18.`);
  }
}

export function assertDisposableRestoreUrl(databaseUrl) {
  const raw = String(databaseUrl ?? '');
  const host = hostname(raw);
  const lower = raw.toLowerCase();
  if (
    host !== '127.0.0.1' ||
    lower.includes('railway') ||
    lower.includes('rlwy') ||
    lower.includes('.internal') ||
    lower.includes('production')
  ) {
    throw new Error('backup ERROR: la restauración solo acepta 127.0.0.1.');
  }
}

export function assertCustomDump(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const magic = buffer.length >= 5 ? buffer.subarray(0, 5).toString('utf8') : '';
  if (magic !== 'PGDMP' || buffer.length < 24) {
    throw new Error('backup ERROR: el volcado no es un archivo custom completo.');
  }
}

export function rowsFromPsql(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, nombre] = line.split('|');
      return { id: String(id ?? '').trim(), nombre: String(nombre ?? '').trim() };
    });
}

const INTEGRITY_LINES = [
  `taller|${STAGING_TALLER_ID}|${STAGING_TALLER_NAME}`,
  'price|01000000-0000-4000-8000-000000000011',
  'price|01000000-0000-4000-8000-000000000012',
  'price|01000000-0000-4000-8000-000000000013',
  'table|talleres',
  'table|price_matrix',
  'table|appointments',
  'table|appointment_service_lines',
  'column|catalogPieceCode',
];

export function assertRestoredIntegrity(text) {
  const lines = new Set(
    String(text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
  if (!INTEGRITY_LINES.every((line) => lines.has(line))) {
    throw new Error('backup ERROR: la restauración no conserva el esquema ni los datos sintéticos.');
  }
}

export function assertSyntheticWorkshop(rows) {
  const found = (Array.isArray(rows) ? rows : []).some(
    (row) =>
      String(row?.id ?? '').toLowerCase() === STAGING_TALLER_ID &&
      String(row?.nombre ?? '') === STAGING_TALLER_NAME,
  );
  if (!found) {
    throw new Error('backup ERROR: la restauración no contiene el taller de ensayo.');
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

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function fail(err) {
  console.error(err instanceof Error ? err.message : 'backup ERROR');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  try {
    if (mode === 'client') {
      assertPostgres18(process.argv[3], 'pg_dump');
      assertPostgres18(process.argv[4], 'pg_restore');
      console.log('OK: el cliente es PostgreSQL 18.');
    } else if (mode === 'target') {
      assertDisposableRestoreUrl(process.env.LOCAL_DATABASE_URL);
      console.log('OK: la restauración apunta a 127.0.0.1.');
    } else if (mode === 'dump') {
      assertCustomDump(readFileSync(process.argv[3]));
      console.log('OK: el volcado custom está completo.');
    } else if (mode === 'marker') {
      const input = await readStdin();
      assertSyntheticWorkshop(rowsFromPsql(input));
      console.log('OK: la restauración contiene el taller de ensayo.');
    } else if (mode === 'integrity') {
      const input = await readStdin();
      assertRestoredIntegrity(input);
      console.log('OK: el esquema y los datos sintéticos están en la restauración.');
    } else {
      console.error('backup ERROR: falta el modo de comprobación.');
      process.exit(1);
    }
  } catch (err) {
    fail(err);
  }
}
