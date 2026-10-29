import {
  assertRemoteSynchronizeAllowed,
  migrationUsesSsl,
  redactDatabaseUrl,
  resolveDbSynchronize,
} from './db-synchronize';

describe('resolveDbSynchronize', () => {
  const remote = 'postgresql://user:secret@db.example.railway.app:5432/railway';

  it('solo sincroniza una base remota si se pide en true', () => {
    expect(resolveDbSynchronize(undefined, remote)).toBe(false);
    expect(resolveDbSynchronize('', remote)).toBe(false);
    expect(resolveDbSynchronize('FALSE', remote)).toBe(false);
    expect(resolveDbSynchronize('false', remote)).toBe(false);
    expect(resolveDbSynchronize('true', remote)).toBe(true);
  });

  it('mantiene el sincronizado local cuando no hay bandera', () => {
    expect(resolveDbSynchronize(undefined, undefined)).toBe(true);
    expect(
      resolveDbSynchronize(undefined, 'postgres://u:p@127.0.0.1:5432/pegazuz'),
    ).toBe(true);
    expect(
      resolveDbSynchronize('false', 'postgres://u:p@localhost:5432/pegazuz'),
    ).toBe(false);
  });

  it('no sincroniza una URL que no se puede interpretar', () => {
    expect(resolveDbSynchronize(undefined, 'not a url')).toBe(false);
  });

  it('usa SSL contra un host remoto y no contra localhost', () => {
    expect(migrationUsesSsl(remote, undefined)).toBe(true);
    expect(migrationUsesSsl('postgres://u:p@127.0.0.1:5432/pegazuz', undefined)).toBe(
      false,
    );
    expect(migrationUsesSsl('postgres://u:p@127.0.0.1:5432/pegazuz', 'true')).toBe(
      true,
    );
    expect(migrationUsesSsl(remote, 'false')).toBe(false);
  });

  it('no deja una URL de base en un mensaje de error', () => {
    expect(redactDatabaseUrl(`falló ${remote}`)).toBe('falló postgresql://***');
  });
});

describe('assertRemoteSynchronizeAllowed', () => {
  const remote = 'postgresql://user:secret@db.example.railway.app:5432/railway';

  it('deja pasar producción con synchronize apagado', () => {
    expect(() =>
      assertRemoteSynchronizeAllowed('false', remote, {}),
    ).not.toThrow();
  });

  it('bloquea synchronize remoto y no revela el host ni la clave', () => {
    expect(() => assertRemoteSynchronizeAllowed('true', remote, {})).toThrow(
      /no puede quedar activo/,
    );
    try {
      assertRemoteSynchronizeAllowed('true', remote, {
        PEGAZUZ_ENV: 'staging',
        STAGING_SCHEMA_BOOTSTRAP: 'yes',
        STAGING_DB_HOST: 'otro.example.test',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('db.example.railway.app');
      expect(message).not.toContain('secret');
    }
  });

  it('permite el bootstrap solo con el host de staging fijado', () => {
    expect(() =>
      assertRemoteSynchronizeAllowed('true', remote, {
        PEGAZUZ_ENV: 'staging',
        STAGING_SCHEMA_BOOTSTRAP: 'yes',
        STAGING_DB_HOST: 'db.example.railway.app',
      }),
    ).not.toThrow();
    expect(() =>
      assertRemoteSynchronizeAllowed('true', 'postgres://u:p@127.0.0.1:5432/app', {}),
    ).not.toThrow();
  });
});
