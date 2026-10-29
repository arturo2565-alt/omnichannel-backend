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

/**
 * La migración CRM usa SSL en hosts que no son locales.
 * DATABASE_SSL=false lo apaga; DATABASE_SSL=true o sslmode=require lo encienden.
 */
export function migrationUsesSsl(
  databaseUrl: string,
  databaseSslFlag: string | undefined,
): boolean {
  const flag = String(databaseSslFlag ?? '').trim().toLowerCase();
  if (flag === 'true' || flag === '1' || flag === 'yes') return true;
  if (flag === 'false' || flag === '0' || flag === 'no') return false;
  if (/sslmode=require/i.test(databaseUrl)) return true;
  const host = postgresHostname(databaseUrl);
  if (!host) return true;
  return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
}

export function redactDatabaseUrl(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://***');
}

export function isLocalDatabaseUrl(databaseUrl: string | undefined): boolean {
  const host = postgresHostname(databaseUrl);
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
