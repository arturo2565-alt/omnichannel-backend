/**
 * SQL fijo contra la conexión que el backend de staging ya tiene.
 * Cada escritura filtra el taller sintético. No arma SQL con el manifiesto.
 */
import type { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { STAGING_TALLER_ID } from '../config/staging-synthetic';
import {
  CatalogImportRejected,
  type CatalogCell,
  type CatalogDb,
  type CatalogSnapshot,
  type CatalogTx,
  type Preimage,
  type RulesImage,
  type RunState,
  type StoredCell,
} from './staging-catalog-import';

export const STAGING_CATALOG_SQL = {
  readOnly: 'SET TRANSACTION READ ONLY',
  lockTimeout: "SET LOCAL lock_timeout = '5s'",
  statementTimeout: "SET LOCAL statement_timeout = '20s'",
  tables: `SELECT to_regclass('public.catalog_002b_matrix_preimage') AS matrix,
       to_regclass('public.catalog_002b_rules_preimage') AS rules,
       to_regclass('public.catalog_002b_run') AS run`,
  matrix: `SELECT id::text AS id, pieza, severidad, precio, dias_entrega, is_instant_service
     FROM price_matrix WHERE "tallerId" = $1`,
  rules: `SELECT "rulesJson" FROM catalog_pricing_rules WHERE "tallerId" = $1`,
  others: `SELECT "tallerId"::text AS taller, COUNT(*)::int AS n
     FROM price_matrix WHERE "tallerId" IS DISTINCT FROM $1 GROUP BY "tallerId"`,
  uniqueKey: `SELECT pg_get_constraintdef(c.oid) AS definition
     FROM pg_constraint c
     WHERE c.conrelid = 'public.price_matrix'::regclass AND c.contype = 'u'`,
  rulesKey: `SELECT pg_get_constraintdef(c.oid) AS definition
     FROM pg_constraint c
     WHERE c.conrelid = 'public.catalog_pricing_rules'::regclass AND c.contype = 'p'`,
  createMatrix: `CREATE TABLE IF NOT EXISTS catalog_002b_matrix_preimage (
       id uuid PRIMARY KEY,
       "tallerId" uuid NOT NULL,
       pieza character varying(120) NOT NULL,
       severidad character varying(32) NOT NULL,
       precio integer NOT NULL,
       dias_entrega integer NOT NULL,
       is_instant_service boolean NOT NULL
     )`,
  createRules: `CREATE TABLE IF NOT EXISTS catalog_002b_rules_preimage (
       "tallerId" uuid PRIMARY KEY,
       rules_present boolean NOT NULL,
       "rulesJson" text
     )`,
  createRun: `CREATE TABLE IF NOT EXISTS catalog_002b_run (
       id text PRIMARY KEY,
       phase text NOT NULL,
       matrix_count integer NOT NULL,
       rules_present boolean NOT NULL,
       rows_sha12 text NOT NULL,
       rules_sha12 text NOT NULL,
       manifest_sha12 text NOT NULL,
       preimage_sha text NOT NULL
     )`,
  clearMatrix: 'DELETE FROM catalog_002b_matrix_preimage WHERE "tallerId" = $1',
  clearRules: 'DELETE FROM catalog_002b_rules_preimage WHERE "tallerId" = $1',
  insertMatrix: `INSERT INTO catalog_002b_matrix_preimage
       (id, "tallerId", pieza, severidad, precio, dias_entrega, is_instant_service)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`,
  insertRules: `INSERT INTO catalog_002b_rules_preimage ("tallerId", rules_present, "rulesJson")
     VALUES ($1::uuid, $2, $3)`,
  readPreimageMatrix: `SELECT id::text AS id, pieza, severidad, precio, dias_entrega, is_instant_service
     FROM catalog_002b_matrix_preimage WHERE "tallerId" = $1`,
  readPreimageRules: `SELECT rules_present, "rulesJson" FROM catalog_002b_rules_preimage WHERE "tallerId" = $1`,
  readRun: `SELECT phase, matrix_count, rules_present, rows_sha12, rules_sha12, manifest_sha12, preimage_sha
     FROM catalog_002b_run WHERE id = 'catalog-002b'`,
  markRun: `INSERT INTO catalog_002b_run
       (id, phase, matrix_count, rules_present, rows_sha12, rules_sha12, manifest_sha12, preimage_sha)
     VALUES ('catalog-002b', $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       phase = EXCLUDED.phase,
       matrix_count = EXCLUDED.matrix_count,
       rules_present = EXCLUDED.rules_present,
       rows_sha12 = EXCLUDED.rows_sha12,
       rules_sha12 = EXCLUDED.rules_sha12,
       manifest_sha12 = EXCLUDED.manifest_sha12,
       preimage_sha = EXCLUDED.preimage_sha`,
  upsertCell: `INSERT INTO price_matrix (id, "tallerId", pieza, severidad, precio, dias_entrega, is_instant_service)
     VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6)
     ON CONFLICT ("tallerId", pieza, severidad) DO UPDATE SET
       precio = EXCLUDED.precio,
       dias_entrega = EXCLUDED.dias_entrega,
       is_instant_service = EXCLUDED.is_instant_service
     WHERE price_matrix.precio IS DISTINCT FROM EXCLUDED.precio
        OR price_matrix.dias_entrega IS DISTINCT FROM EXCLUDED.dias_entrega
        OR price_matrix.is_instant_service IS DISTINCT FROM EXCLUDED.is_instant_service`,
  upsertRules: `INSERT INTO catalog_pricing_rules ("tallerId", "rulesJson")
     VALUES ($1::uuid, $2)
     ON CONFLICT ("tallerId") DO UPDATE SET "rulesJson" = EXCLUDED."rulesJson"
     WHERE catalog_pricing_rules."rulesJson" IS DISTINCT FROM EXCLUDED."rulesJson"`,
  advisoryLock: 'SELECT pg_try_advisory_lock(20261102, 2) AS locked',
  advisoryUnlock: 'SELECT pg_advisory_unlock(20261102, 2)',
  deleteMatrix: 'DELETE FROM price_matrix WHERE "tallerId" = $1',
  deleteRules: 'DELETE FROM catalog_pricing_rules WHERE "tallerId" = $1',
  insertLiveMatrix: `INSERT INTO price_matrix
       (id, "tallerId", pieza, severidad, precio, dias_entrega, is_instant_service)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`,
  insertLiveRules: `INSERT INTO catalog_pricing_rules ("tallerId", "rulesJson") VALUES ($1::uuid, $2)`,
} as const;

type QueryRow = Record<string, unknown>;

function asRows(value: unknown): QueryRow[] {
  return Array.isArray(value) ? (value as QueryRow[]) : [];
}

function asCell(row: QueryRow): StoredCell {
  return {
    id: String(row.id),
    pieza: String(row.pieza),
    severidad: String(row.severidad),
    precio: Number(row.precio),
    diasEntrega: Number(row.dias_entrega),
    isInstantService: row.is_instant_service === true,
  };
}

function definitionIncludes(rows: QueryRow[], ...needles: string[]): boolean {
  return rows.some((row) => {
    const definition = String(row.definition ?? '');
    return needles.every((needle) => definition.includes(needle));
  });
}

class PgCatalogTx implements CatalogTx {
  constructor(
    private readonly manager: EntityManager,
    private readonly writable: boolean,
  ) {}

  private write(): void {
    if (!this.writable) throw new CatalogImportRejected('la consulta de solo lectura no puede escribir');
  }

  async inspect(tallerId: string): Promise<CatalogSnapshot> {
    if (tallerId !== STAGING_TALLER_ID) throw new CatalogImportRejected('el taller no es el sintético');
    const present = asRows(await this.manager.query(STAGING_CATALOG_SQL.tables));
    const flags = present[0] ?? {};
    const matrix = asRows(await this.manager.query(STAGING_CATALOG_SQL.matrix, [tallerId])).map(asCell);
    const ruleRows = asRows(await this.manager.query(STAGING_CATALOG_SQL.rules, [tallerId]));
    if (ruleRows.length > 1) throw new CatalogImportRejected('las reglas no quedaron guardadas');
    const rules: RulesImage = {
      present: ruleRows.length === 1,
      rulesJson: ruleRows.length === 1 ? String(ruleRows[0]?.rulesJson ?? '') : null,
    };
    const others = asRows(await this.manager.query(STAGING_CATALOG_SQL.others, [tallerId]))
      .map((row) => `${String(row.taller)}:${Number(row.n)}`)
      .sort()
      .join('|');
    const uniqueOk = definitionIncludes(
      asRows(await this.manager.query(STAGING_CATALOG_SQL.uniqueKey)),
      'tallerId',
      'pieza',
      'severidad',
    );
    const rulesKeyOk = definitionIncludes(
      asRows(await this.manager.query(STAGING_CATALOG_SQL.rulesKey)),
      'tallerId',
    );
    const ready = Boolean(flags.matrix && flags.rules && flags.run);
    const preimageMatrix = ready
      ? asRows(await this.manager.query(STAGING_CATALOG_SQL.readPreimageMatrix, [tallerId])).map(asCell)
      : [];
    const preimageRuleRows = ready
      ? asRows(await this.manager.query(STAGING_CATALOG_SQL.readPreimageRules, [tallerId]))
      : [];
    const preimageRules: RulesImage =
      preimageRuleRows.length === 1
        ? {
            present: preimageRuleRows[0]?.rules_present === true,
            rulesJson:
              preimageRuleRows[0]?.rulesJson == null ? null : String(preimageRuleRows[0]?.rulesJson),
          }
        : { present: false, rulesJson: null };
    const runRows = ready ? asRows(await this.manager.query(STAGING_CATALOG_SQL.readRun)) : [];
    const runRow = runRows[0];
    const run: RunState | null = runRow
      ? {
          phase: runRow.phase === 'applied' ? 'applied' : 'preimage',
          matrixCount: Number(runRow.matrix_count),
          rulesPresent: runRow.rules_present === true,
          rowsSha12: String(runRow.rows_sha12),
          rulesSha12: String(runRow.rules_sha12),
          manifestSha12: String(runRow.manifest_sha12),
          preimageSha: String(runRow.preimage_sha),
        }
      : null;
    return {
      matrix,
      rules,
      preimageMatrix,
      preimageRules,
      preimageReady: ready && preimageRuleRows.length === 1,
      run,
      otherCounts: others,
      uniqueOk,
      rulesKeyOk,
    };
  }

  async savePreimage(tallerId: string, preimage: Preimage): Promise<void> {
    this.write();
    if (tallerId !== STAGING_TALLER_ID) throw new CatalogImportRejected('el taller no es el sintético');
    await this.manager.query(STAGING_CATALOG_SQL.createMatrix);
    await this.manager.query(STAGING_CATALOG_SQL.createRules);
    await this.manager.query(STAGING_CATALOG_SQL.createRun);
    await this.manager.query(STAGING_CATALOG_SQL.clearMatrix, [tallerId]);
    await this.manager.query(STAGING_CATALOG_SQL.clearRules, [tallerId]);
    for (const row of preimage.matrix) {
      await this.manager.query(STAGING_CATALOG_SQL.insertMatrix, [
        row.id,
        tallerId,
        row.pieza,
        row.severidad,
        row.precio,
        row.diasEntrega,
        row.isInstantService,
      ]);
    }
    await this.manager.query(STAGING_CATALOG_SQL.insertRules, [
      tallerId,
      preimage.rules.present,
      preimage.rules.rulesJson,
    ]);
  }

  async markRun(state: RunState): Promise<void> {
    this.write();
    await this.manager.query(STAGING_CATALOG_SQL.createRun);
    await this.manager.query(STAGING_CATALOG_SQL.markRun, [
      state.phase,
      state.matrixCount,
      state.rulesPresent,
      state.rowsSha12,
      state.rulesSha12,
      state.manifestSha12,
      state.preimageSha,
    ]);
  }

  async upsertCell(tallerId: string, cell: CatalogCell): Promise<void> {
    this.write();
    if (tallerId !== STAGING_TALLER_ID) throw new CatalogImportRejected('el taller no es el sintético');
    await this.manager.query(STAGING_CATALOG_SQL.upsertCell, [
      tallerId,
      cell.pieza,
      cell.severidad,
      cell.precio,
      cell.diasEntrega,
      cell.isInstantService,
    ]);
  }

  async upsertRules(tallerId: string, rulesJson: string): Promise<void> {
    this.write();
    if (tallerId !== STAGING_TALLER_ID) throw new CatalogImportRejected('el taller no es el sintético');
    await this.manager.query(STAGING_CATALOG_SQL.upsertRules, [tallerId, rulesJson]);
  }

  async restore(tallerId: string, preimage: Preimage): Promise<void> {
    this.write();
    if (tallerId !== STAGING_TALLER_ID) throw new CatalogImportRejected('el taller no es el sintético');
    await this.manager.query(STAGING_CATALOG_SQL.deleteMatrix, [tallerId]);
    for (const row of preimage.matrix) {
      await this.manager.query(STAGING_CATALOG_SQL.insertLiveMatrix, [
        row.id,
        tallerId,
        row.pieza,
        row.severidad,
        row.precio,
        row.diasEntrega,
        row.isInstantService,
      ]);
    }
    await this.manager.query(STAGING_CATALOG_SQL.deleteRules, [tallerId]);
    if (preimage.rules.present && preimage.rules.rulesJson != null) {
      await this.manager.query(STAGING_CATALOG_SQL.insertLiveRules, [tallerId, preimage.rules.rulesJson]);
    }
  }
}

export class PgCatalogDb implements CatalogDb {
  constructor(
    private readonly dataSource: DataSource,
    private readonly runner?: QueryRunner,
  ) {}

  private async inTransaction<T>(writable: boolean, fn: (tx: CatalogTx) => Promise<T>): Promise<T> {
    const run = async (manager: EntityManager) => {
      if (!writable) await manager.query(STAGING_CATALOG_SQL.readOnly);
      await manager.query(STAGING_CATALOG_SQL.statementTimeout);
      if (writable) await manager.query(STAGING_CATALOG_SQL.lockTimeout);
      return fn(new PgCatalogTx(manager, writable));
    };
    if (!this.runner) return this.dataSource.transaction((manager) => run(manager));
    await this.runner.startTransaction();
    try {
      const result = await run(this.runner.manager);
      await this.runner.commitTransaction();
      return result;
    } catch (err) {
      await this.runner.rollbackTransaction();
      throw err;
    }
  }

  readOnly<T>(fn: (tx: CatalogTx) => Promise<T>): Promise<T> {
    return this.inTransaction(false, fn);
  }

  readWrite<T>(fn: (tx: CatalogTx) => Promise<T>): Promise<T> {
    return this.inTransaction(true, fn);
  }

  async exclusive<T>(fn: (db: CatalogDb) => Promise<T>): Promise<T> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    let locked = false;
    try {
      const rows = asRows(await runner.query(STAGING_CATALOG_SQL.advisoryLock));
      locked = rows[0]?.locked === true;
      if (!locked) throw new CatalogImportRejected('operación en curso');
      return await fn(new PgCatalogDb(this.dataSource, runner));
    } finally {
      if (locked) await runner.query(STAGING_CATALOG_SQL.advisoryUnlock);
      await runner.release();
    }
  }
}
