import { DataSource } from 'typeorm';
import { isLocalDatabaseUrl } from './db-synchronize';
import {
  assertStagingBootstrapAllowed,
  runStagingBootstrap,
  schemaIsEmpty,
} from './staging-bootstrap';

describe('assertStagingBootstrapAllowed', () => {
  const local = 'postgres://postgres@127.0.0.1:54334/pegazuz_bootstrap';
  const remote = 'postgres://user:secret@db.staging.internal:5432/app';
  const production = 'postgres://user:secret@db.production.internal:5432/app';
  const ready = {
    PEGAZUZ_ENV: 'staging',
    STAGING_SCHEMA_BOOTSTRAP: 'yes',
    STAGING_DB_HOST: '127.0.0.1',
    DB_SYNCHRONIZE: 'false',
  };

  it('acepta staging con el host fijado y synchronize apagado', () => {
    expect(() => assertStagingBootstrapAllowed(local, ready)).not.toThrow();
    expect(() =>
      assertStagingBootstrapAllowed(remote, {
        ...ready,
        STAGING_DB_HOST: 'db.staging.internal',
      }),
    ).not.toThrow();
  });

  it('exige las tres confirmaciones', () => {
    expect(() => assertStagingBootstrapAllowed('', ready)).toThrow(/DATABASE_URL/);
    expect(() =>
      assertStagingBootstrapAllowed(local, { ...ready, PEGAZUZ_ENV: '' }),
    ).toThrow(/PEGAZUZ_ENV/);
    expect(() =>
      assertStagingBootstrapAllowed(local, {
        ...ready,
        STAGING_SCHEMA_BOOTSTRAP: '',
      }),
    ).toThrow(/STAGING_SCHEMA_BOOTSTRAP/);
  });

  it('rechaza dejar DB_SYNCHRONIZE activo', () => {
    expect(() =>
      assertStagingBootstrapAllowed(local, { ...ready, DB_SYNCHRONIZE: 'true' }),
    ).toThrow(/permanecer en false/);
  });

  it('rechaza producción y no revela el host ni la clave', () => {
    expect(() =>
      assertStagingBootstrapAllowed(production, {
        ...ready,
        STAGING_DB_HOST: 'db.production.internal',
      }),
    ).toThrow(/producción/);
    expect(() =>
      assertStagingBootstrapAllowed(remote, {
        ...ready,
        STAGING_DB_HOST: 'db.staging.internal',
        CRM_MIGRATE_TARGET: 'production',
      }),
    ).toThrow(/producción/);
    expect(() =>
      assertStagingBootstrapAllowed(remote, {
        ...ready,
        STAGING_DB_HOST: 'db.staging.internal',
        CRM_PRODUCTION_MIGRATE: 'yes',
      }),
    ).toThrow(/producción/);
    expect(() =>
      assertStagingBootstrapAllowed(remote, {
        ...ready,
        STAGING_DB_HOST: 'db.staging.internal',
        RAILWAY_ENVIRONMENT: 'production',
      }),
    ).toThrow(/producción/);

    try {
      assertStagingBootstrapAllowed(production, {
        ...ready,
        STAGING_DB_HOST: 'otro.example.test',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('db.production.internal');
      expect(message).not.toContain('secret');
      expect(message).not.toContain('otro.example.test');
    }
  });

  it('exige coincidencia exacta con STAGING_DB_HOST', () => {
    expect(() =>
      assertStagingBootstrapAllowed(local, {
        ...ready,
        STAGING_DB_HOST: 'db.staging.internal',
      }),
    ).toThrow(/no coincide/);
  });
});

describe('schemaIsEmpty', () => {
  it('trata una base sin tablas de aplicación como vacía', () => {
    expect(schemaIsEmpty([])).toBe(true);
    expect(schemaIsEmpty(['spatial_ref_sys'])).toBe(true);
    expect(schemaIsEmpty(['talleres'])).toBe(false);
  });
});

const disposableUrl = process.env.STAGING_BOOTSTRAP_DATABASE_URL?.trim() ?? '';
const disposable =
  disposableUrl && isLocalDatabaseUrl(disposableUrl) ? describe : describe.skip;

disposable('bootstrap en PostgreSQL local', () => {
  const admin = disposableUrl;
  const databaseUrl = admin.replace(/\/[^/]*$/, '/pegazuz_bootstrap');
  const env = {
    DATABASE_URL: databaseUrl,
    PEGAZUZ_ENV: 'staging',
    STAGING_SCHEMA_BOOTSTRAP: 'yes',
    STAGING_DB_HOST: '127.0.0.1',
    DB_SYNCHRONIZE: 'false',
  };

  beforeAll(async () => {
    const ds = new DataSource({
      type: 'postgres',
      url: admin,
      ssl: false,
      entities: [],
      synchronize: false,
    });
    await ds.initialize();
    await ds.query('DROP DATABASE IF EXISTS pegazuz_bootstrap');
    await ds.query('CREATE DATABASE pegazuz_bootstrap');
    await ds.destroy();
  });

  it('crea el esquema, aplica 004-006, carga el taller de ensayo y se puede repetir', async () => {
    const first = await runStagingBootstrap(env);
    expect(first.createdSchema).toBe(true);
    expect(env.DB_SYNCHRONIZE).toBe('false');

    const ds = new DataSource({
      type: 'postgres',
      url: databaseUrl,
      ssl: false,
      entities: [],
      synchronize: false,
    });
    await ds.initialize();
    const taller = await ds.query(
      `SELECT nombre FROM talleres WHERE nombre = 'Taller de ensayo'`,
    );
    const prices = await ds.query(
      `SELECT COUNT(*)::int AS total FROM price_matrix`,
    );
    const contacts = await ds.query(`SELECT COUNT(*)::int AS total FROM contacts`);
    const snapshot = await ds.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'appointment_service_lines'
        AND column_name = 'catalogPieceCode'
    `,
    );
    await ds.destroy();

    expect(taller).toHaveLength(1);
    expect(prices[0].total).toBe(3);
    expect(contacts[0].total).toBe(0);
    expect(snapshot).toHaveLength(1);

    const second = await runStagingBootstrap(env);
    expect(second.createdSchema).toBe(false);
    expect(env.DB_SYNCHRONIZE).toBe('false');
  });
});
