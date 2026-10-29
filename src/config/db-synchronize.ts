/**
 * TypeORM synchronize altera el esquema al arrancar.
 * En una base remota queda apagado salvo DB_SYNCHRONIZE=true explícito.
 * Las migraciones SQL no se ejecutan aquí: son scripts aparte.
 */
export function resolveDbSynchronize(
  flag: string | undefined,
  databaseUrl: string | undefined,
): boolean {
  const value = String(flag ?? '').trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;

  const host = postgresHostname(databaseUrl);
  if (!host) return !String(databaseUrl ?? '').trim();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function postgresHostname(databaseUrl: string | undefined): string | null {
  const url = String(databaseUrl ?? '').trim();
  if (!url) return null;
  const normalized = url.replace(/^postgres(ql)?:\/\//i, 'http://');
  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return null;
  }
}
