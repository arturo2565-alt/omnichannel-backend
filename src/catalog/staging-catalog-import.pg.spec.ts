import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { STAGING_TALLER_ID } from '../config/staging-synthetic';
import { approvedPayload } from './staging-catalog-import.fixture';
import { PgCatalogDb } from './staging-catalog-import.pg';
import {
  CATALOG_IMPORT_CONFIRM,
  CATALOG_RESTORE_CONFIRM,
  restoreStagingCatalog,
  runStagingCatalogImport,
} from './staging-catalog-import';

const PORT = 55444;
const OTHER_TALLER = '99999999-0000-4000-8000-000000000099';

jest.setTimeout(120_000);

describe('importador contra PostgreSQL desechable', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'catalog-002b-'));
  let dataSource: DataSource;

  beforeAll(async () => {
    const locale = { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' };
    const init = spawnSync('initdb', ['-D', dataDir, '-U', 'pegazuz', '--auth=trust', '-E', 'UTF8'], {
      env: locale,
      stdio: 'ignore',
    });
    if (init.status !== 0) throw new Error('no se pudo crear la base desechable');
    const start = spawnSync(
      'pg_ctl',
      ['-D', dataDir, '-l', join(dataDir, 'server.log'), '-o', `-p ${PORT} -h 127.0.0.1`, 'start'],
      { env: locale, stdio: 'ignore' },
    );
    if (start.status !== 0) throw new Error('no se pudo arrancar la base desechable');
    dataSource = new DataSource({
      type: 'postgres',
      host: '127.0.0.1',
      port: PORT,
      username: 'pegazuz',
      database: 'postgres',
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();
    await dataSource.query(`
      CREATE TABLE talleres (
        id uuid PRIMARY KEY,
        nombre text NOT NULL
      );
      CREATE TABLE price_matrix (
        id uuid PRIMARY KEY,
        "tallerId" uuid REFERENCES talleres(id) ON DELETE CASCADE,
        pieza character varying(120) NOT NULL,
        severidad character varying(32) NOT NULL,
        precio integer NOT NULL,
        dias_entrega integer NOT NULL,
        is_instant_service boolean NOT NULL,
        UNIQUE ("tallerId", pieza, severidad)
      );
      CREATE TABLE catalog_pricing_rules (
        "tallerId" uuid PRIMARY KEY,
        "rulesJson" text NOT NULL
      );
      INSERT INTO talleres (id, nombre) VALUES
        ('${STAGING_TALLER_ID}', 'Taller de ensayo'),
        ('${OTHER_TALLER}', 'Otro');
      INSERT INTO price_matrix (id, "tallerId", pieza, severidad, precio, dias_entrega, is_instant_service) VALUES
        ('01000000-0000-4000-8000-000000000011', '${STAGING_TALLER_ID}', 'Salpicadera', 'LEVE', 4500, 3, false),
        ('01000000-0000-4000-8000-000000000012', '${STAGING_TALLER_ID}', 'Fascia delantera', 'MONTAJE', 1800, 1, false),
        ('01000000-0000-4000-8000-000000000013', '${STAGING_TALLER_ID}', 'Fascia delantera', 'MONTAJE_PINTURA', 3200, 2, false),
        ('01000000-0000-4000-8000-0000000000aa', '${OTHER_TALLER}', 'Cofre', 'LEVE', 1, 1, false);
    `);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    spawnSync('pg_ctl', ['-D', dataDir, 'stop', '-m', 'fast'], { stdio: 'ignore' });
    rmSync(dataDir, { recursive: true, force: true });
  });

  function db(): PgCatalogDb {
    return new PgCatalogDb(dataSource);
  }

  it('serializa con un cerrojo y rechaza la operación simultánea', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const first = db().exclusive(async () => {
      entered = true;
      await hold;
    });
    while (!entered) await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(db().exclusive(async () => undefined)).rejects.toThrow('operación en curso');
    release();
    await first;
  });

  it('confirma la preimagen, importa, revierte un fallo y restaura', async () => {
    const payload = approvedPayload();
    const catalog = db();
    const report = await catalog.exclusive((locked) =>
      runStagingCatalogImport(locked, { confirm: CATALOG_IMPORT_CONFIRM, manifestText: payload.manifestText }, payload.locks),
    );
    expect(report).toMatchObject({ cells: 94, preimageCells: 3, idempotent: false, rulesPresent: true });
    const tables = await dataSource.query(`
      SELECT to_regclass('public.catalog_002b_matrix_preimage') AS matrix,
             to_regclass('public.catalog_002b_rules_preimage') AS rules,
             to_regclass('public.catalog_002b_run') AS run
    `);
    expect(tables[0].matrix).toBeTruthy();
    expect(tables[0].rules).toBeTruthy();
    expect(tables[0].run).toBeTruthy();
    const again = await catalog.exclusive((locked) =>
      runStagingCatalogImport(locked, { confirm: CATALOG_IMPORT_CONFIRM, manifestText: payload.manifestText }, payload.locks),
    );
    expect(again.idempotent).toBe(true);

    await dataSource.query(`
      CREATE OR REPLACE FUNCTION catalog_002b_test_fail() RETURNS trigger AS $$
      BEGIN
        IF NEW.pieza = 'Toldo' AND NEW.severidad = 'MONTAJE_PINTURA' THEN
          RAISE EXCEPTION 'fallo de prueba';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER catalog_002b_test_fail BEFORE INSERT ON price_matrix
      FOR EACH ROW EXECUTE FUNCTION catalog_002b_test_fail();
    `);
    await dataSource.query(`UPDATE catalog_002b_run SET phase = 'preimage' WHERE id = 'catalog-002b'`);
    await dataSource.query(`
      DELETE FROM price_matrix WHERE "tallerId" = '${STAGING_TALLER_ID}';
      INSERT INTO price_matrix (id, "tallerId", pieza, severidad, precio, dias_entrega, is_instant_service)
      SELECT id, "tallerId", pieza, severidad, precio, dias_entrega, is_instant_service
      FROM catalog_002b_matrix_preimage;
      DELETE FROM catalog_pricing_rules WHERE "tallerId" = '${STAGING_TALLER_ID}';
    `);
    await expect(
      catalog.exclusive((locked) =>
        runStagingCatalogImport(locked, { confirm: CATALOG_IMPORT_CONFIRM, manifestText: payload.manifestText }, payload.locks),
      ),
    ).rejects.toThrow('fallo de prueba');
    const afterFailure = await dataSource.query(
      `SELECT COUNT(*)::int AS n FROM price_matrix WHERE "tallerId" = $1`,
      [STAGING_TALLER_ID],
    );
    const preimageLeft = await dataSource.query(
      `SELECT COUNT(*)::int AS n FROM catalog_002b_matrix_preimage WHERE "tallerId" = $1`,
      [STAGING_TALLER_ID],
    );
    const otherLeft = await dataSource.query(
      `SELECT COUNT(*)::int AS n FROM price_matrix WHERE "tallerId" = $1`,
      [OTHER_TALLER],
    );
    expect(afterFailure[0].n).toBe(3);
    expect(preimageLeft[0].n).toBe(3);
    expect(otherLeft[0].n).toBe(1);

    await dataSource.query('DROP TRIGGER catalog_002b_test_fail ON price_matrix');
    const completed = await catalog.exclusive((locked) =>
      runStagingCatalogImport(locked, { confirm: CATALOG_IMPORT_CONFIRM, manifestText: payload.manifestText }, payload.locks),
    );
    expect(completed.cells).toBe(94);
    const seedKept = await dataSource.query(
      `SELECT (precio = 4500) AS original FROM catalog_002b_matrix_preimage WHERE id = '01000000-0000-4000-8000-000000000011'`,
    );
    expect(seedKept[0].original).toBe(true);

    const restored = await catalog.exclusive((locked) => restoreStagingCatalog(locked, CATALOG_RESTORE_CONFIRM));
    expect(restored.cells).toBe(3);
    expect(restored.rulesPresent).toBe(false);
    const live = await dataSource.query(
      `SELECT COUNT(*)::int AS n FROM price_matrix WHERE "tallerId" = $1`,
      [STAGING_TALLER_ID],
    );
    expect(live[0].n).toBe(3);
    expect(otherLeft[0].n).toBe(1);
  });
});
