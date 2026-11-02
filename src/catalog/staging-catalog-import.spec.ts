import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { STAGING_TALLER_ID } from '../config/staging-synthetic';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { approvedPayload } from './staging-catalog-import.fixture';
import { StagingCatalogImportController } from './staging-catalog-import.controller';
import { STAGING_CATALOG_SQL } from './staging-catalog-import.pg';
import {
  APPROVED_CATALOG_KEYS,
  APPROVED_CATALOG_LOCKS,
  CATALOG_IMPORT_CONFIRM,
  CATALOG_RESTORE_CONFIRM,
  CatalogImportRejected,
  restoreStagingCatalog,
  runStagingCatalogImport,
  stagingCatalogAccess,
  type CatalogCell,
  type CatalogDb,
  type CatalogSnapshot,
  type CatalogTx,
  type Preimage,
  type RulesImage,
  type RunState,
  type StoredCell,
} from './staging-catalog-import';

const OTHER_TALLER = '99999999-0000-4000-8000-000000000099';

type LiveRow = StoredCell & { tallerId: string };

type MemoryState = {
  matrix: LiveRow[];
  rules: Array<{ tallerId: string; rulesJson: string }>;
  preimageMatrix: LiveRow[];
  preimageRules: Array<{ tallerId: string; present: boolean; rulesJson: string | null }>;
  run: RunState | null;
  tablesReady: boolean;
  uniqueOk: boolean;
  rulesKeyOk: boolean;
};

class MemoryTx implements CatalogTx {
  constructor(
    private readonly state: MemoryState,
    private readonly writable: boolean,
  ) {}

  private write(): void {
    if (!this.writable) throw new CatalogImportRejected('la consulta de solo lectura no puede escribir');
  }

  async inspect(tallerId: string): Promise<CatalogSnapshot> {
    const matrix = this.state.matrix.filter((row) => row.tallerId === tallerId);
    const rule = this.state.rules.find((row) => row.tallerId === tallerId);
    const rules: RulesImage = rule
      ? { present: true, rulesJson: rule.rulesJson }
      : { present: false, rulesJson: null };
    const others = new Map<string, number>();
    for (const row of this.state.matrix) {
      if (row.tallerId === tallerId) continue;
      others.set(row.tallerId, (others.get(row.tallerId) ?? 0) + 1);
    }
    const preimageMatrix = this.state.tablesReady
      ? this.state.preimageMatrix.filter((row) => row.tallerId === tallerId)
      : [];
    const preimageRule = this.state.tablesReady
      ? this.state.preimageRules.find((row) => row.tallerId === tallerId)
      : undefined;
    return {
      matrix,
      rules,
      preimageMatrix,
      preimageRules: preimageRule
        ? { present: preimageRule.present, rulesJson: preimageRule.rulesJson }
        : { present: false, rulesJson: null },
      preimageReady: Boolean(this.state.tablesReady && preimageRule),
      run: this.state.tablesReady ? this.state.run : null,
      otherCounts: [...others.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, count]) => `${id}:${count}`)
        .join('|'),
      uniqueOk: this.state.uniqueOk,
      rulesKeyOk: this.state.rulesKeyOk,
    };
  }

  async savePreimage(tallerId: string, preimage: Preimage): Promise<void> {
    this.write();
    this.state.tablesReady = true;
    this.state.preimageMatrix = this.state.preimageMatrix.filter((row) => row.tallerId !== tallerId);
    this.state.preimageRules = this.state.preimageRules.filter((row) => row.tallerId !== tallerId);
    this.state.preimageMatrix.push(...preimage.matrix.map((row) => ({ ...row, tallerId })));
    this.state.preimageRules.push({
      tallerId,
      present: preimage.rules.present,
      rulesJson: preimage.rules.rulesJson,
    });
  }

  async markRun(state: RunState): Promise<void> {
    this.write();
    this.state.tablesReady = true;
    this.state.run = { ...state };
  }

  async upsertCell(tallerId: string, cell: CatalogCell): Promise<void> {
    this.write();
    if (this.state.uniqueOk === false) throw new CatalogImportRejected('la base de staging no admite la clave esperada');
    const found = this.state.matrix.find(
      (row) => row.tallerId === tallerId && row.pieza === cell.pieza && row.severidad === cell.severidad,
    );
    if (found) {
      found.precio = cell.precio;
      found.diasEntrega = cell.diasEntrega;
      found.isInstantService = cell.isInstantService;
      return;
    }
    this.state.matrix.push({
      ...cell,
      id: `new-${this.state.matrix.length}`,
      tallerId,
    });
  }

  async upsertRules(tallerId: string, rulesJson: string): Promise<void> {
    this.write();
    const found = this.state.rules.find((row) => row.tallerId === tallerId);
    if (found) found.rulesJson = rulesJson;
    else this.state.rules.push({ tallerId, rulesJson });
  }

  async restore(tallerId: string, preimage: Preimage): Promise<void> {
    this.write();
    this.state.matrix = this.state.matrix.filter((row) => row.tallerId !== tallerId);
    this.state.matrix.push(...preimage.matrix.map((row) => ({ ...row, tallerId })));
    this.state.rules = this.state.rules.filter((row) => row.tallerId !== tallerId);
    if (preimage.rules.present && preimage.rules.rulesJson != null) {
      this.state.rules.push({ tallerId, rulesJson: preimage.rules.rulesJson });
    }
  }
}

function createDb(seedPrice = 10): { db: CatalogDb; state: MemoryState; writes: { count: number } } {
  const state: MemoryState = {
    matrix: [
      {
        id: 'seed-sal',
        tallerId: STAGING_TALLER_ID,
        pieza: 'Salpicadera',
        severidad: 'LEVE',
        precio: seedPrice,
        diasEntrega: 3,
        isInstantService: false,
      },
      {
        id: 'seed-mon',
        tallerId: STAGING_TALLER_ID,
        pieza: 'Fascia delantera',
        severidad: 'MONTAJE',
        precio: 1800,
        diasEntrega: 1,
        isInstantService: false,
      },
      {
        id: 'seed-pin',
        tallerId: STAGING_TALLER_ID,
        pieza: 'Fascia delantera',
        severidad: 'MONTAJE_PINTURA',
        precio: 3200,
        diasEntrega: 2,
        isInstantService: false,
      },
      {
        id: 'other-1',
        tallerId: OTHER_TALLER,
        pieza: 'Cofre',
        severidad: 'LEVE',
        precio: 1,
        diasEntrega: 1,
        isInstantService: false,
      },
    ],
    rules: [],
    preimageMatrix: [],
    preimageRules: [],
    run: null,
    tablesReady: false,
    uniqueOk: true,
    rulesKeyOk: true,
  };
  const writes = { count: 0 };
  let busy = false;
  const db: CatalogDb = {
    async readOnly(fn) {
      return fn(new MemoryTx(state, false));
    },
    async readWrite(fn) {
      const draft = structuredClone(state);
      const result = await fn(new MemoryTx(draft, true));
      writes.count += 1;
      state.matrix = draft.matrix;
      state.rules = draft.rules;
      state.preimageMatrix = draft.preimageMatrix;
      state.preimageRules = draft.preimageRules;
      state.run = draft.run;
      state.tablesReady = draft.tablesReady;
      state.uniqueOk = draft.uniqueOk;
      state.rulesKeyOk = draft.rulesKeyOk;
      return result;
    },
    async exclusive(fn) {
      if (busy) throw new CatalogImportRejected('operación en curso');
      busy = true;
      try {
        return await fn(db);
      } finally {
        busy = false;
      }
    },
  };
  return { db, state, writes };
}

const owner: AuthenticatedUser = {
  userId: 'owner',
  email: 'dueno@ensayo.test',
  tallerId: STAGING_TALLER_ID,
  role: 'owner',
};

describe('importación de catálogo en staging', () => {
  it('solo acepta el sandbox de staging y al dueño del taller sintético', () => {
    const env = {
      PEGAZUZ_ENV: 'staging',
      STAGING_SANDBOX: 'on',
      RAILWAY_ENVIRONMENT_NAME: 'staging',
      RAILWAY_SERVICE_NAME: 'pegazuz-backend-staging',
      DATABASE_URL: 'postgres://db.railway.internal:5432/railway',
    };
    expect(stagingCatalogAccess(env, owner)).toBe('ok');
    expect(stagingCatalogAccess({ ...env, PEGAZUZ_ENV: 'production' }, owner)).toBe('hidden');
    expect(stagingCatalogAccess({ ...env, STAGING_SANDBOX: 'ON' }, owner)).toBe('hidden');
    expect(stagingCatalogAccess({ ...env, RAILWAY_ENVIRONMENT_NAME: 'production' }, owner)).toBe('hidden');
    expect(stagingCatalogAccess({ ...env, RAILWAY_SERVICE_NAME: 'Postgres' }, owner)).toBe('hidden');
    expect(
      stagingCatalogAccess({ ...env, DATABASE_URL: 'postgres://caboose.proxy.rlwy.net:1/railway' }, owner),
    ).toBe('hidden');
    expect(stagingCatalogAccess(env, { ...owner, role: 'admin' })).toBe('forbidden');
    expect(stagingCatalogAccess(env, { ...owner, email: 'dueno@otro.test' })).toBe('forbidden');
    expect(stagingCatalogAccess(env, { ...owner, tallerId: OTHER_TALLER })).toBe('forbidden');
  });

  it('rechaza un manifiesto distinto del aprobado y no escribe', async () => {
    const { db, writes } = createDb();
    await expect(
      runStagingCatalogImport(db, { confirm: 'otro', manifestText: '{}' }, APPROVED_CATALOG_LOCKS),
    ).rejects.toBeInstanceOf(CatalogImportRejected);
    await expect(
      runStagingCatalogImport(
        db,
        { confirm: CATALOG_IMPORT_CONFIRM, manifestText: approvedPayload().manifestText },
        APPROVED_CATALOG_LOCKS,
      ),
    ).rejects.toThrow('el manifiesto no coincide');
    expect(writes.count).toBe(0);
  });

  it('guarda la preimagen, importa 94 celdas y conserva la semilla y el otro taller', async () => {
    const { db, state, writes } = createDb();
    const payload = approvedPayload();
    const report = await runStagingCatalogImport(
      db,
      { confirm: CATALOG_IMPORT_CONFIRM, manifestText: payload.manifestText },
      payload.locks,
    );
    expect(report).toMatchObject({
      ok: true,
      idempotent: false,
      phase: 'applied',
      cells: 94,
      rulesPresent: true,
      preimageCells: 3,
      preimageRulesPresent: false,
      fasciaLevePositive: true,
      seedsKept: 2,
    });
    expect(report.rowsSha12).toBe(payload.locks.rowsSha12);
    expect(state.matrix.filter((row) => row.tallerId === STAGING_TALLER_ID)).toHaveLength(94);
    expect(state.matrix.find((row) => row.id === 'seed-sal')?.precio).toBe(
      payload.cells.find((cell) => cell.pieza === 'Salpicadera' && cell.severidad === 'LEVE')?.precio,
    );
    expect(state.matrix.find((row) => row.id === 'seed-mon')?.precio).toBe(1800);
    expect(state.matrix.find((row) => row.id === 'seed-pin')?.precio).toBe(3200);
    expect(state.matrix.filter((row) => row.tallerId === OTHER_TALLER)).toEqual([
      expect.objectContaining({ id: 'other-1', precio: 1 }),
    ]);
    expect(state.preimageMatrix).toHaveLength(3);
    expect(state.preimageMatrix.find((row) => row.id === 'seed-sal')?.precio).toBe(10);
    const again = await runStagingCatalogImport(
      db,
      { confirm: CATALOG_IMPORT_CONFIRM, manifestText: payload.manifestText },
      payload.locks,
    );
    expect(again.idempotent).toBe(true);
    expect(writes.count).toBe(2);
  });

  it('conserva la preimagen si la importación falla y luego puede completarse', async () => {
    const { db, state } = createDb();
    const payload = approvedPayload();
    state.uniqueOk = false;
    await expect(
      runStagingCatalogImport(db, { confirm: CATALOG_IMPORT_CONFIRM, manifestText: payload.manifestText }, payload.locks),
    ).rejects.toThrow('la base de staging no admite la clave esperada');
    expect(state.matrix.filter((row) => row.tallerId === STAGING_TALLER_ID)).toHaveLength(3);
    expect(state.preimageMatrix).toHaveLength(3);
    expect(state.run?.phase).toBe('preimage');
    state.uniqueOk = true;
    const report = await runStagingCatalogImport(
      db,
      { confirm: CATALOG_IMPORT_CONFIRM, manifestText: payload.manifestText },
      payload.locks,
    );
    expect(report.cells).toBe(94);
    expect(state.preimageMatrix.find((row) => row.id === 'seed-sal')?.precio).toBe(10);
  });

  it('restaura las tres filas y la ausencia de reglas sin tocar otro taller', async () => {
    const { db, state } = createDb();
    const payload = approvedPayload();
    await runStagingCatalogImport(
      db,
      { confirm: CATALOG_IMPORT_CONFIRM, manifestText: payload.manifestText },
      payload.locks,
    );
    const restored = await restoreStagingCatalog(db, CATALOG_RESTORE_CONFIRM);
    expect(restored.phase).toBe('restored');
    expect(restored.cells).toBe(3);
    expect(restored.rulesPresent).toBe(false);
    expect(state.matrix.filter((row) => row.tallerId === STAGING_TALLER_ID).map((row) => row.id).sort()).toEqual([
      'seed-mon',
      'seed-pin',
      'seed-sal',
    ]);
    expect(state.matrix.find((row) => row.id === 'seed-sal')?.precio).toBe(10);
    expect(state.rules).toEqual([]);
    expect(state.matrix.filter((row) => row.tallerId === OTHER_TALLER)).toHaveLength(1);
    const repeat = await restoreStagingCatalog(db, CATALOG_RESTORE_CONFIRM);
    expect(repeat.idempotent).toBe(true);
  });

  it('la lectura directa de reglas no inventa una fila ausente', async () => {
    const { db, state } = createDb();
    const payload = approvedPayload();
    await runStagingCatalogImport(
      db,
      { confirm: CATALOG_IMPORT_CONFIRM, manifestText: payload.manifestText },
      payload.locks,
    );
    expect(state.preimageRules).toEqual([
      { tallerId: STAGING_TALLER_ID, present: false, rulesJson: null },
    ]);
  });

  it('el sql fijo es de solo lectura al consultar y no alcanza otras tablas', () => {
    const text = Object.values(STAGING_CATALOG_SQL).join('\n');
    expect(STAGING_CATALOG_SQL.readOnly).toBe('SET TRANSACTION READ ONLY');
    expect(text).not.toMatch(/conversations|contacts|messages|appointments|users/i);
    for (const statement of [STAGING_CATALOG_SQL.deleteMatrix, STAGING_CATALOG_SQL.deleteRules, STAGING_CATALOG_SQL.clearMatrix, STAGING_CATALOG_SQL.clearRules]) {
      expect(statement).toContain('"tallerId" = $1');
    }
    expect(STAGING_CATALOG_SQL.upsertCell).toContain('gen_random_uuid()');
    expect(STAGING_CATALOG_SQL.upsertCell).toContain('ON CONFLICT ("tallerId", pieza, severidad)');
    expect(STAGING_CATALOG_SQL.advisoryLock).toContain('pg_try_advisory_lock(20261102, 2)');
    expect(APPROVED_CATALOG_KEYS).toHaveLength(92);
  });

  it('bloquea una segunda operación mientras la primera conserva el cerrojo', async () => {
    const { db } = createDb();
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const first = db.exclusive(async () => {
      entered = true;
      await hold;
      return 'primero';
    });
    while (!entered) await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(db.exclusive(async () => 'segundo')).rejects.toThrow('operación en curso');
    release();
    await expect(first).resolves.toBe('primero');
  });

  it('oculta la ruta fuera de staging y no acepta taller ni correo del cuerpo', async () => {
    const previous = process.env;
    const secret = 'MANIFIESTO-NO-DEBE-APARECER';
    const queries: string[] = [];
    const dataSource = {
      createQueryRunner: () => {
        queries.push('connect');
        throw new Error('no debe conectar');
      },
      transaction: () => {
        queries.push('transaction');
        throw new Error('no debe conectar');
      },
    } as unknown as DataSource;
    const controller = new StagingCatalogImportController(dataSource);
    try {
      process.env = { ...previous, PEGAZUZ_ENV: 'production', STAGING_SANDBOX: 'on' };
      await expect(
        controller.importCatalog(owner, {
          confirm: CATALOG_IMPORT_CONFIRM,
          manifestText: secret,
          tallerId: STAGING_TALLER_ID,
          email: 'dueno@ensayo.test',
        } as { confirm: string; manifestText: string }),
      ).rejects.toBeInstanceOf(NotFoundException);
      process.env = {
        ...previous,
        PEGAZUZ_ENV: 'staging',
        STAGING_SANDBOX: 'on',
        RAILWAY_ENVIRONMENT_NAME: 'staging',
        RAILWAY_SERVICE_NAME: 'pegazuz-backend-staging',
      };
      await expect(
        controller.importCatalog(
          { ...owner, email: 'falso@otro.test', tallerId: OTHER_TALLER },
          {
            confirm: CATALOG_IMPORT_CONFIRM,
            manifestText: secret,
            email: 'dueno@ensayo.test',
            tallerId: STAGING_TALLER_ID,
          } as { confirm: string; manifestText: string },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      try {
        await controller.importCatalog(owner, { confirm: 'otro', manifestText: secret });
        throw new Error('debía rechazar la confirmación');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect(JSON.stringify(err)).not.toContain(secret);
      }
    } finally {
      process.env = previous;
    }
    expect(queries).toEqual([]);
  });

  it('el controlador no registra el manifiesto ni credenciales', () => {
    const sources = [
      'staging-catalog-import.controller.ts',
      'staging-catalog-import.ts',
      'staging-catalog-import.pg.ts',
    ]
      .map((name) => readFileSync(join(__dirname, name), 'utf8'))
      .join('\n');
    expect(sources).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\b/);
    expect(sources).not.toMatch(/new Logger|Logger\.(log|error|warn|debug)/);
  });
});
