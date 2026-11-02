/**
 * CATALOG-002B. Operación fija del taller sintético.
 * No acepta SQL y no incorpora los importes al repositorio:
 * el manifiesto llega en la solicitud y tiene que coincidir con las huellas aprobadas.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { STAGING_TALLER_ID } from '../config/staging-synthetic';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

export const CATALOG_IMPORT_CONFIRM = 'catalog-002b';
export const CATALOG_RESTORE_CONFIRM = 'catalog-002b-restore';
export const APPROVED_ROWS_SHA12 = '26ea2ec8da16';
export const APPROVED_RULES_SHA12 = '46fdbe033831';
export const APPROVED_MANIFEST_SHA12 = '5deba5f15d44';
export const EXPECTED_CELL_COUNT = 94;
export const MANIFEST_TEXT_LIMIT = 80_000;

export const APPROVED_CATALOG_LOCKS = {
  rowsSha12: APPROVED_ROWS_SHA12,
  rulesSha12: APPROVED_RULES_SHA12,
  manifestSha12: APPROVED_MANIFEST_SHA12,
} as const;

/** Orden de producción usado para la huella de filas. No contiene importes. */
export const APPROVED_CATALOG_KEYS: readonly (readonly [string, string])[] = [
  ['Baño de Pintura con Cambio de Color', 'BASE'],
  ['Baño de Pintura Exterior', 'BASE'],
  ['Baño de Pintura Exterior', 'Chico'],
  ['Baño de Pintura Exterior', 'Chico Premium'],
  ['Baño de Pintura Exterior', 'Grande'],
  ['Baño de Pintura Exterior', 'Grande Premium'],
  ['Baño de Pintura Exterior', 'Mediano'],
  ['Baño de Pintura Exterior', 'Mediano Premium'],
  ['Baño de Pintura Exterior', 'XL'],
  ['Baño de Pintura Exterior', 'XL Premium'],
  ['Baño de Pintura Exterior e Interiores', 'BASE'],
  ['BiCO', 'MONTAJE_PINTURA'],
  ['Calavera', 'MONTAJE'],
  ['Cerámico Automotriz', 'BASE'],
  ['Cofre', 'DF'],
  ['Cofre', 'DM'],
  ['Cofre', 'DMF'],
  ['Cofre', 'DMFuerte'],
  ['Cofre', 'DML'],
  ['Cofre', 'LEVE'],
  ['Cofre', 'MONTAJE_PINTURA'],
  ['Espejo', 'DF'],
  ['Espejo', 'DM'],
  ['Espejo', 'DMF'],
  ['Espejo', 'DMFuerte'],
  ['Espejo', 'DML'],
  ['Espejo', 'LEVE'],
  ['Espejo', 'MONTAJE_PINTURA'],
  ['Estética Automotriz', 'BASE'],
  ['Estética Automotriz', 'N/A'],
  ['Estetica Exterior', 'DF'],
  ['Estetica Exterior', 'DL'],
  ['Estetica Exterior', 'DM'],
  ['Estetica Exterior', 'DMF'],
  ['Estetica Exterior', 'DMFuerte'],
  ['Estetica Exterior', 'DML'],
  ['Estribo', 'DF'],
  ['Estribo', 'DM'],
  ['Estribo', 'DMF'],
  ['Estribo', 'DMFuerte'],
  ['Estribo', 'DML'],
  ['Estribo', 'LEVE'],
  ['Estribo', 'MONTAJE_PINTURA'],
  ['Faro', 'MONTAJE'],
  ['Faro niebla', 'MONTAJE'],
  ['Fascia', 'DF'],
  ['Fascia', 'DM'],
  ['Fascia', 'DMF'],
  ['Fascia', 'DMFuerte'],
  ['Fascia', 'DML'],
  ['Fascia', 'LEVE'],
  ['Fascia', 'MONTAJE_PINTURA'],
  ['MOLDURA', 'MONTAJE'],
  ['MOLDURA_PINTADA', 'LEVE'],
  ['Parilla', 'MONTAJE'],
  ['Parilla', 'MONTAJE_PINTURA'],
  ['Poste', 'MONTAJE_PINTURA'],
  ['Puerta', 'DF'],
  ['Puerta', 'DM'],
  ['Puerta', 'DMF'],
  ['Puerta', 'DMFuerte'],
  ['Puerta', 'DML'],
  ['Puerta', 'LEVE'],
  ['Puerta', 'MONTAJE_PINTURA'],
  ['Salpicadera', 'DF'],
  ['Salpicadera', 'DM'],
  ['Salpicadera', 'DMF'],
  ['Salpicadera', 'DMFuerte'],
  ['Salpicadera', 'DML'],
  ['Salpicadera', 'LEVE'],
  ['Salpicadera', 'MONTAJE_PINTURA'],
  ['Salpicadera trasera', 'DF'],
  ['Salpicadera trasera', 'DM'],
  ['Salpicadera trasera', 'DMF'],
  ['Salpicadera trasera', 'DMFuerte'],
  ['Salpicadera trasera', 'DML'],
  ['Salpicadera trasera', 'LEVE'],
  ['Salpicadera trasera', 'MONTAJE_PINTURA'],
  ['Tapa Cajuela', 'DF'],
  ['Tapa Cajuela', 'DM'],
  ['Tapa Cajuela', 'DMF'],
  ['Tapa Cajuela', 'DMFuerte'],
  ['Tapa Cajuela', 'DML'],
  ['Tapa Cajuela', 'LEVE'],
  ['Tapa Cajuela', 'MONTAJE_PINTURA'],
  ['Toldo', 'DF'],
  ['Toldo', 'DM'],
  ['Toldo', 'DMF'],
  ['Toldo', 'DMFuerte'],
  ['Toldo', 'DML'],
  ['Toldo', 'LEVE'],
  ['Toldo', 'MONTAJE_PINTURA'],
];

const SEED_KEYS = [
  ['Salpicadera', 'LEVE'],
  ['Fascia delantera', 'MONTAJE'],
  ['Fascia delantera', 'MONTAJE_PINTURA'],
] as const;

const RULE_KEYS = ['sizeTierFactors', 'premiumFactor', 'severityFactors', 'roundToMx'] as const;

export class CatalogImportRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogImportRejected';
  }
}

export type CatalogLocks = {
  rowsSha12: string;
  rulesSha12: string;
  manifestSha12: string;
};

export type CatalogCell = {
  pieza: string;
  severidad: string;
  precio: number;
  diasEntrega: number;
  isInstantService: boolean;
};

export type StoredCell = CatalogCell & { id: string };

export type RulesImage = { present: boolean; rulesJson: string | null };

export type RunPhase = 'preimage' | 'applied';

export type RunState = {
  phase: RunPhase;
  matrixCount: number;
  rulesPresent: boolean;
  rowsSha12: string;
  rulesSha12: string;
  manifestSha12: string;
  preimageSha: string;
};

export type CatalogSnapshot = {
  matrix: StoredCell[];
  rules: RulesImage;
  preimageMatrix: StoredCell[];
  preimageRules: RulesImage;
  preimageReady: boolean;
  run: RunState | null;
  otherCounts: string;
  uniqueOk: boolean;
  rulesKeyOk: boolean;
};

export type Preimage = {
  matrix: StoredCell[];
  rules: RulesImage;
  sha: string;
};

export interface CatalogTx {
  inspect(tallerId: string): Promise<CatalogSnapshot>;
  savePreimage(tallerId: string, preimage: Preimage): Promise<void>;
  markRun(state: RunState): Promise<void>;
  upsertCell(tallerId: string, cell: CatalogCell): Promise<void>;
  upsertRules(tallerId: string, rulesJson: string): Promise<void>;
  restore(tallerId: string, preimage: Preimage): Promise<void>;
}

export interface CatalogDb {
  readOnly<T>(fn: (tx: CatalogTx) => Promise<T>): Promise<T>;
  readWrite<T>(fn: (tx: CatalogTx) => Promise<T>): Promise<T>;
  exclusive<T>(fn: (db: CatalogDb) => Promise<T>): Promise<T>;
}

export type CatalogImportReport = {
  ok: true;
  idempotent: boolean;
  phase: RunPhase | 'restored';
  cells: number;
  rulesPresent: boolean;
  preimageCells: number;
  preimageRulesPresent: boolean;
  rowsSha12: string;
  rulesSha12: string;
  manifestSha12: string;
  preimageSha12: string;
  fasciaLevePositive: true;
  seedsKept: number;
};

type ParsedManifest = {
  cells: CatalogCell[];
  rulesJson: string;
  rowsSha12: string;
  rulesSha12: string;
  manifestSha12: string;
};

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function catalogKey(pieza: string, severidad: string): string {
  return `${pieza}\u0000${severidad}`;
}

export function canonicalRowsJson(rows: readonly CatalogCell[]): string {
  return JSON.stringify(
    rows.map((row) => ({
      pieza: row.pieza,
      severidad: row.severidad,
      precio: row.precio,
      diasEntrega: row.diasEntrega,
      isInstantService: row.isInstantService,
    })),
  );
}

export function stagingCatalogAccess(
  env: NodeJS.ProcessEnv,
  user: AuthenticatedUser,
): 'ok' | 'hidden' | 'forbidden' {
  if (String(env.PEGAZUZ_ENV ?? '').trim() !== 'staging') return 'hidden';
  if (String(env.STAGING_SANDBOX ?? '').trim() !== 'on') return 'hidden';
  if (String(env.RAILWAY_ENVIRONMENT_NAME ?? '').trim() === 'production') return 'hidden';
  const service = String(env.RAILWAY_SERVICE_NAME ?? '').trim();
  if (service === 'omnichannel-backend' || service === 'Postgres') return 'hidden';
  if (String(env.DATABASE_URL ?? '').includes('caboose.proxy.rlwy.net')) return 'hidden';
  if (
    user.role !== 'owner' ||
    user.tallerId !== STAGING_TALLER_ID ||
    !String(user.email ?? '').endsWith('@ensayo.test')
  ) {
    return 'forbidden';
  }
  return 'ok';
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function reject(message: string): never {
  throw new CatalogImportRejected(message);
}

function integerField(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    reject('el manifiesto no coincide');
  }
  return value;
}

export function parseCatalogManifest(manifestText: string, locks: CatalogLocks): ParsedManifest {
  if (typeof manifestText !== 'string' || manifestText.length < 2 || manifestText.length > MANIFEST_TEXT_LIMIT) {
    reject('el manifiesto no coincide');
  }
  const manifestSha12 = sha256(manifestText).slice(0, 12);
  if (!sameSecret(manifestSha12, locks.manifestSha12)) reject('el manifiesto no coincide');
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    reject('el manifiesto no coincide');
  }
  const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  const rawRows = record?.rows;
  const rulesJson = record?.rulesJson;
  if (!Array.isArray(rawRows) || typeof rulesJson !== 'string') reject('el manifiesto no coincide');
  let rules: Record<string, unknown>;
  try {
    const value = JSON.parse(rulesJson) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) reject('el manifiesto no coincide');
    rules = value as Record<string, unknown>;
  } catch (err) {
    if (err instanceof CatalogImportRejected) throw err;
    reject('el manifiesto no coincide');
  }
  for (const key of RULE_KEYS) {
    if (!(key in rules)) reject('el manifiesto no coincide');
  }
  if (rawRows.length !== APPROVED_CATALOG_KEYS.length) reject('el manifiesto no coincide');
  const byKey = new Map<string, CatalogCell>();
  for (const raw of rawRows) {
    if (!raw || typeof raw !== 'object') reject('el manifiesto no coincide');
    const row = raw as Record<string, unknown>;
    const pieza = String(row.pieza ?? '');
    const severidad = String(row.severidad ?? '');
    if (pieza.length > 120 || severidad.length > 32 || pieza.includes('\u0000') || severidad.includes('\u0000')) {
      reject('el manifiesto no coincide');
    }
    const cell: CatalogCell = {
      pieza,
      severidad,
      precio: integerField(row.precio),
      diasEntrega: integerField(row.diasEntrega),
      isInstantService: row.isInstantService === true,
    };
    const key = catalogKey(pieza, severidad);
    if (byKey.has(key)) reject('el manifiesto no coincide');
    byKey.set(key, cell);
  }
  const cells = APPROVED_CATALOG_KEYS.map(([pieza, severidad]) => {
    const cell = byKey.get(catalogKey(pieza, severidad));
    if (!cell) reject('el manifiesto no coincide');
    return cell;
  });
  if (byKey.size !== cells.length) reject('el manifiesto no coincide');
  const fascia = cells.find((cell) => cell.pieza === 'Fascia' && cell.severidad === 'LEVE');
  if (!fascia || fascia.precio <= 0) reject('falta la base canónica de Fascia');
  const rowsSha12 = sha256(canonicalRowsJson(cells)).slice(0, 12);
  const rulesSha12 = sha256(rulesJson).slice(0, 12);
  if (!sameSecret(rowsSha12, locks.rowsSha12) || !sameSecret(rulesSha12, locks.rulesSha12)) {
    reject('el manifiesto no coincide');
  }
  return { cells, rulesJson, rowsSha12, rulesSha12, manifestSha12 };
}

function preimageSha(matrix: readonly StoredCell[], rules: RulesImage): string {
  const ordered = [...matrix].sort((a, b) => catalogKey(a.pieza, a.severidad).localeCompare(catalogKey(b.pieza, b.severidad)));
  return sha256(
    JSON.stringify({
      matrix: ordered.map((row) => ({
        id: row.id,
        pieza: row.pieza,
        severidad: row.severidad,
        precio: row.precio,
        diasEntrega: row.diasEntrega,
        isInstantService: row.isInstantService,
      })),
      rulesPresent: rules.present,
      rulesJson: rules.rulesJson,
    }),
  );
}

function isSeedKey(pieza: string, severidad: string): boolean {
  return SEED_KEYS.some(([seedPieza, seedSeveridad]) => seedPieza === pieza && seedSeveridad === severidad);
}

function assertSeedMatrix(matrix: readonly StoredCell[]): void {
  const keys = matrix.map((row) => catalogKey(row.pieza, row.severidad)).sort();
  const expected = SEED_KEYS.map(([pieza, severidad]) => catalogKey(pieza, severidad)).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    reject('staging no conserva las tres filas esperadas');
  }
}

function assertKeptSeeds(live: readonly StoredCell[], preimage: Preimage): void {
  for (const seed of preimage.matrix.filter((row) => isSeedKey(row.pieza, row.severidad))) {
    const current = live.find((row) => catalogKey(row.pieza, row.severidad) === catalogKey(seed.pieza, seed.severidad));
    if (!current || current.id !== seed.id) reject('la fila sembrada no puede desaparecer');
    if (seed.pieza === 'Fascia delantera') {
      if (
        current.precio !== seed.precio ||
        current.diasEntrega !== seed.diasEntrega ||
        current.isInstantService !== seed.isInstantService
      ) {
        reject('la fila sembrada no puede desaparecer');
      }
    }
  }
}

function assertAppliedState(snapshot: CatalogSnapshot, preimage: Preimage, rulesJson: string): void {
  if (snapshot.matrix.length !== EXPECTED_CELL_COUNT) reject('el resultado no tiene 94 celdas');
  const fascia = snapshot.matrix.find((row) => row.pieza === 'Fascia' && row.severidad === 'LEVE');
  if (!fascia || fascia.precio <= 0) reject('falta la base canónica de Fascia');
  assertKeptSeeds(snapshot.matrix, preimage);
  if (!snapshot.rules.present || snapshot.rules.rulesJson !== rulesJson) reject('las reglas no quedaron guardadas');
}

function reportOf(
  phase: CatalogImportReport['phase'],
  idempotent: boolean,
  cells: number,
  rulesPresent: boolean,
  preimage: Preimage,
  locks: ParsedManifest | CatalogLocks,
): CatalogImportReport {
  return {
    ok: true,
    idempotent,
    phase,
    cells,
    rulesPresent,
    preimageCells: preimage.matrix.length,
    preimageRulesPresent: preimage.rules.present,
    rowsSha12: locks.rowsSha12,
    rulesSha12: locks.rulesSha12,
    manifestSha12: locks.manifestSha12,
    preimageSha12: preimage.sha.slice(0, 12),
    fasciaLevePositive: true,
    seedsKept: 2,
  };
}

function imageFrom(snapshot: CatalogSnapshot, expectedSha: string): Preimage | null {
  if (!snapshot.preimageReady) return null;
  const sha = preimageSha(snapshot.preimageMatrix, snapshot.preimageRules);
  if (sha !== expectedSha) return null;
  return { matrix: snapshot.preimageMatrix, rules: snapshot.preimageRules, sha };
}

export async function runStagingCatalogImport(
  db: CatalogDb,
  input: { confirm: string; manifestText: string },
  locks: CatalogLocks = APPROVED_CATALOG_LOCKS,
): Promise<CatalogImportReport> {
  if (!sameSecret(String(input.confirm ?? ''), CATALOG_IMPORT_CONFIRM)) reject('la confirmación no coincide');
  const parsed = parseCatalogManifest(input.manifestText, locks);
  const live = await db.readOnly((tx) => tx.inspect(STAGING_TALLER_ID));
  if (live.run?.phase === 'applied') {
    if (
      live.run.rowsSha12 !== parsed.rowsSha12 ||
      live.run.rulesSha12 !== parsed.rulesSha12 ||
      live.run.manifestSha12 !== parsed.manifestSha12
    ) {
      reject('el manifiesto no coincide');
    }
    const preimage = imageFrom(live, live.run.preimageSha);
    if (!preimage) reject('la preimagen no quedó guardada');
    assertAppliedState(live, preimage, parsed.rulesJson);
    return reportOf('applied', true, live.matrix.length, live.rules.present, preimage, parsed);
  }

  let preimage: Preimage;
  if (!live.run) {
    assertSeedMatrix(live.matrix);
    const draft: Preimage = {
      matrix: live.matrix.map((row) => ({ ...row })),
      rules: { present: live.rules.present, rulesJson: live.rules.rulesJson },
      sha: '',
    };
    draft.sha = preimageSha(draft.matrix, draft.rules);
    const run: RunState = {
      phase: 'preimage',
      matrixCount: draft.matrix.length,
      rulesPresent: draft.rules.present,
      rowsSha12: parsed.rowsSha12,
      rulesSha12: parsed.rulesSha12,
      manifestSha12: parsed.manifestSha12,
      preimageSha: draft.sha,
    };
    await db.readWrite(async (tx) => {
      await tx.savePreimage(STAGING_TALLER_ID, draft);
      await tx.markRun(run);
    });
    const saved = await db.readOnly((tx) => tx.inspect(STAGING_TALLER_ID));
    const durable = imageFrom(saved, draft.sha);
    if (!durable || saved.run?.phase !== 'preimage') reject('la preimagen no quedó guardada');
    preimage = durable;
  } else if (live.run.phase === 'preimage') {
    if (live.run.rowsSha12 !== parsed.rowsSha12 || live.run.rulesSha12 !== parsed.rulesSha12) {
      reject('el manifiesto no coincide');
    }
    const durable = imageFrom(live, live.run.preimageSha);
    if (!durable) reject('la preimagen no quedó guardada');
    preimage = durable;
  } else {
    reject('la preimagen no quedó guardada');
  }

  await db.readWrite(async (tx) => {
    const before = await tx.inspect(STAGING_TALLER_ID);
    if (!before.uniqueOk || !before.rulesKeyOk) reject('la base de staging no admite la clave esperada');
    for (const cell of parsed.cells) await tx.upsertCell(STAGING_TALLER_ID, cell);
    await tx.upsertRules(STAGING_TALLER_ID, parsed.rulesJson);
    const after = await tx.inspect(STAGING_TALLER_ID);
    if (after.otherCounts !== before.otherCounts) reject('otro taller no puede cambiar');
    assertAppliedState(after, preimage, parsed.rulesJson);
    await tx.markRun({
      phase: 'applied',
      matrixCount: after.matrix.length,
      rulesPresent: true,
      rowsSha12: parsed.rowsSha12,
      rulesSha12: parsed.rulesSha12,
      manifestSha12: parsed.manifestSha12,
      preimageSha: preimage.sha,
    });
  });

  const done = await db.readOnly((tx) => tx.inspect(STAGING_TALLER_ID));
  if (done.run?.phase !== 'applied') reject('la importación no se aplicó');
  assertAppliedState(done, preimage, parsed.rulesJson);
  return reportOf('applied', false, done.matrix.length, true, preimage, parsed);
}

export async function restoreStagingCatalog(db: CatalogDb, confirm: string): Promise<CatalogImportReport> {
  if (!sameSecret(String(confirm ?? ''), CATALOG_RESTORE_CONFIRM)) reject('la confirmación no coincide');
  const live = await db.readOnly(async (tx) => {
    const snapshot = await tx.inspect(STAGING_TALLER_ID);
    if (!snapshot.run) reject('la preimagen no quedó guardada');
    const preimage = imageFrom(snapshot, snapshot.run.preimageSha);
    if (!preimage) reject('la preimagen no quedó guardada');
    return { snapshot, preimage };
  });
  const sameMatrix =
    live.snapshot.matrix.length === live.preimage.matrix.length &&
    live.preimage.matrix.every((row) => {
      const current = live.snapshot.matrix.find((item) => item.id === row.id);
      return (
        current &&
        current.pieza === row.pieza &&
        current.severidad === row.severidad &&
        current.precio === row.precio &&
        current.diasEntrega === row.diasEntrega &&
        current.isInstantService === row.isInstantService
      );
    });
  const sameRules =
    live.snapshot.rules.present === live.preimage.rules.present &&
    live.snapshot.rules.rulesJson === live.preimage.rules.rulesJson;
  if (!sameMatrix || !sameRules) {
    await db.readWrite(async (tx) => {
      const before = await tx.inspect(STAGING_TALLER_ID);
      await tx.restore(STAGING_TALLER_ID, live.preimage);
      const after = await tx.inspect(STAGING_TALLER_ID);
      if (after.otherCounts !== before.otherCounts) reject('otro taller no puede cambiar');
      await tx.markRun({ ...live.snapshot.run!, phase: 'preimage' });
    });
  }
  const done = await db.readOnly((tx) => tx.inspect(STAGING_TALLER_ID));
  const image = imageFrom(done, live.preimage.sha);
  if (!image) reject('la preimagen no quedó guardada');
  return reportOf('restored', sameMatrix && sameRules, done.matrix.length, done.rules.present, image, {
    rowsSha12: done.run?.rowsSha12 ?? '',
    rulesSha12: done.run?.rulesSha12 ?? '',
    manifestSha12: done.run?.manifestSha12 ?? '',
  });
}
