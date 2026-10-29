import { assertCrmMigrationAllowed } from './migration-target';

describe('assertCrmMigrationAllowed', () => {
  const local = 'postgres://postgres@127.0.0.1:54332/postgres';
  const remote = 'postgres://user:secret@db.example.test:5432/app';
  const production = 'postgres://user:secret@db.production.internal:5432/app';

  it('permite una base local sin confirmación', () => {
    expect(() => assertCrmMigrationAllowed(local, {})).not.toThrow();
  });

  it('rechaza una base remota y no revela el host ni la clave', () => {
    expect(() => assertCrmMigrationAllowed(remote, {})).toThrow(/no es local/);
    try {
      assertCrmMigrationAllowed(remote, {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('db.example.test');
      expect(message).not.toContain('secret');
    }
  });

  it('staging no puede apuntar a un host de producción', () => {
    expect(() =>
      assertCrmMigrationAllowed(production, {
        CRM_MIGRATE_TARGET: 'staging',
        CRM_STAGING_MIGRATE: 'yes',
      }),
    ).toThrow(/producción/);
  });

  it('staging remoto exige su propia confirmación', () => {
    expect(() =>
      assertCrmMigrationAllowed(remote, { CRM_MIGRATE_TARGET: 'staging' }),
    ).toThrow(/CRM_STAGING_MIGRATE/);
    expect(() =>
      assertCrmMigrationAllowed(remote, {
        CRM_MIGRATE_TARGET: 'staging',
        CRM_STAGING_MIGRATE: 'yes',
      }),
    ).toThrow(/STAGING_DB_HOST/);
    expect(() =>
      assertCrmMigrationAllowed(remote, {
        CRM_MIGRATE_TARGET: 'staging',
        CRM_STAGING_MIGRATE: 'yes',
        STAGING_DB_HOST: 'db.example.test',
      }),
    ).not.toThrow();
    try {
      assertCrmMigrationAllowed(remote, {
        CRM_MIGRATE_TARGET: 'staging',
        CRM_STAGING_MIGRATE: 'yes',
        STAGING_DB_HOST: 'otro.example.test',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/no coincide/);
      expect(message).not.toContain('db.example.test');
      expect(message).not.toContain('secret');
    }
  });

  it('producción exige autorización explícita', () => {
    expect(() =>
      assertCrmMigrationAllowed(production, { CRM_MIGRATE_TARGET: 'production' }),
    ).toThrow(/CRM_PRODUCTION_MIGRATE/);
    expect(() =>
      assertCrmMigrationAllowed(production, {
        CRM_MIGRATE_TARGET: 'production',
        CRM_PRODUCTION_MIGRATE: 'yes',
      }),
    ).not.toThrow();
  });

  it('una URL ilegible no se trata como local', () => {
    expect(() => assertCrmMigrationAllowed('no-es-una-url', {})).toThrow(/no es local/);
  });
});
