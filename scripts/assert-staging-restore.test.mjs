import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  assertCustomDump,
  assertDisposableRestoreUrl,
  assertPostgres18,
  assertRestoredIntegrity,
  assertSyntheticWorkshop,
  rowsFromPsql,
  STAGING_TALLER_ID,
  STAGING_TALLER_NAME,
} from './assert-staging-restore.mjs';
import { decryptDump, encryptDump } from './staging-backup-crypto.mjs';
import { openDump, sealDump } from './staging-backup-envelope.mjs';
import { stageExternalObject } from './staging-private-backup.mjs';

const workflows = join(import.meta.dirname, '../.github/workflows');
const pg18 = process.env.PG18_BIN || '/opt/homebrew/opt/postgresql@18/bin';
const pgDump18 = join(pg18, 'pg_dump');
const hasPg18 = existsSync(pgDump18);

test('rechaza destinos remotos, de producción y de staging sin revelarlos', () => {
  assert.doesNotThrow(() =>
    assertDisposableRestoreUrl('postgres://postgres@127.0.0.1:5432/postgres'),
  );
  for (const url of [
    'postgres://user:secret@postgres.railway.internal:5432/app',
    'postgres://user:secret@db.production.example:5432/app',
    'postgres://user:secret@db.staging.example.test:5432/app',
    'postgres://user:secret@roundhouse.proxy.rlwy.net:1234/railway',
    'postgres://postgres@localhost:5432/postgres',
    'postgres://postgres@127.0.0.1:5432/production',
  ]) {
    assert.throws(
      () => assertDisposableRestoreUrl(url),
      (err) => {
        assert.match(err.message, /127\.0\.0\.1/);
        assert.equal(err.message.includes('secret'), false);
        assert.equal(err.message.includes('railway'), false);
        assert.equal(err.message.includes('rlwy'), false);
        assert.equal(err.message.includes('staging.example'), false);
        assert.equal(err.message.includes('production.example'), false);
        return true;
      },
    );
  }
});

test('rechaza un volcado vacío, uno SQL y uno truncado', () => {
  assert.throws(() => assertCustomDump(Buffer.alloc(0)), /custom completo/);
  assert.throws(() => assertCustomDump(Buffer.from('INSERT INTO talleres')), /custom completo/);
  assert.throws(() => assertCustomDump(Buffer.from('PGDMP')), /custom completo/);
  const header = Buffer.alloc(24);
  header.write('PGDMP');
  assert.doesNotThrow(() => assertCustomDump(header));
});

test('rechaza la restauración si falta el taller de ensayo', () => {
  assert.throws(() => assertSyntheticWorkshop([]), /taller de ensayo/);
  assert.throws(
    () => assertSyntheticWorkshop([{ id: STAGING_TALLER_ID, nombre: 'Otro taller' }]),
    /taller de ensayo/,
  );
  assert.doesNotThrow(() =>
    assertSyntheticWorkshop(
      rowsFromPsql(`${STAGING_TALLER_ID}|${STAGING_TALLER_NAME}\n`),
    ),
  );
});

test('el cliente 16 del PATH no sirve y el binario 18 sí', () => {
  assert.throws(
    () => assertPostgres18('pg_dump (PostgreSQL) 16.15 (Homebrew)', 'pg_dump'),
    /PostgreSQL 18/,
  );
  assert.throws(
    () => assertPostgres18('pg_restore (PostgreSQL) 17.2', 'pg_restore'),
    /PostgreSQL 18/,
  );
  const system = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (system.status === 0 && !/\(PostgreSQL\)\s+18\./.test(system.stdout)) {
    assert.throws(() => assertPostgres18(system.stdout, 'pg_dump'), /PostgreSQL 18/);
  }
  if (hasPg18) {
    const pinned = spawnSync(pgDump18, ['--version'], { encoding: 'utf8' });
    assert.equal(pinned.status, 0);
    assert.doesNotThrow(() => assertPostgres18(pinned.stdout, 'pg_dump'));
    assert.doesNotThrow(() =>
      assertPostgres18(spawnSync(join(pg18, 'pg_restore'), ['--version'], { encoding: 'utf8' }).stdout, 'pg_restore'),
    );
  }
});

test('el workflow de GitHub no extrae y la restauración local exige la marca', () => {
  const backup = readFileSync(join(workflows, 'staging-backup.yml'), 'utf8');
  const production = readFileSync(join(workflows, 'production.yml'), 'utf8');
  const synthetic = readFileSync(join(import.meta.dirname, 'staging-synthetic.sql'), 'utf8');
  assert.match(synthetic, new RegExp(STAGING_TALLER_ID));
  assert.match(synthetic, new RegExp(STAGING_TALLER_NAME));
  assert.match(backup, /STAGING_BACKUP_ENABLED == 'true'/);
  assert.match(backup, /refs\/heads\/genesis\/staging/);
  assert.match(backup, /refuse-github/);
  assert.doesNotMatch(backup, /refs\/heads\/main/);
  assert.doesNotMatch(backup, /pg_dump|pg_restore|upload-artifact|DATABASE_URL|StrictHostKeyChecking|retention-days/);
  assert.match(backup, /actions\/checkout@v5/);
  assert.match(backup, /actions\/setup-node@v5/);
  assert.match(backup, /node-version: 22/);
  assert.match(production, /actions\/checkout@v4/);
  assert.doesNotMatch(production, /actions\/checkout@v5/);
  for (const name of ['staging.yml', 'staging-migrate.yml', 'crm-verify.yml']) {
    const text = readFileSync(join(workflows, name), 'utf8');
    assert.match(text, /actions\/checkout@v5/);
    assert.match(text, /actions\/setup-node@v5/);
    assert.match(text, /node-version: 22/);
    assert.doesNotMatch(text, /actions\/checkout@v4/);
  }
});

test(
  'restaura el taller de ensayo en un PostgreSQL 18 desechable',
  { skip: hasPg18 ? false : 'esta máquina no tiene el cliente PostgreSQL 18', timeout: 90_000 },
  () => {
    const env = { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' };
    const root = mkdtempSync(join(tmpdir(), 'pegazuz-restore-'));
    const data = join(root, 'data');
    const port = '55418';
    const dump = join(root, 'ensayo.dump');
    const emptyDump = join(root, 'vacio.dump');
    const run = (command, args) => {
      const result = spawnSync(command, args, { encoding: 'utf8', env });
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || `${command} falló`);
      }
      return result.stdout;
    };
    const psql = (database, args) =>
      run(join(pg18, 'psql'), [
        '--host=127.0.0.1',
        `--port=${port}`,
        '--username=postgres',
        `--dbname=${database}`,
        ...args,
      ]);
    try {
      run(join(pg18, 'initdb'), [
        `--username=postgres`,
        '--auth=trust',
        '--no-instructions',
        `--pgdata=${data}`,
      ]);
      run(join(pg18, 'pg_ctl'), [
        `--pgdata=${data}`,
        `--log=${join(root, 'server.log')}`,
        'start',
        '-o',
        `-p ${port} -h 127.0.0.1`,
      ]);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const ready = spawnSync(
          join(pg18, 'pg_isready'),
          ['--host=127.0.0.1', `--port=${port}`],
          { encoding: 'utf8', env },
        );
        if (ready.status === 0) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        if (attempt === 29) throw new Error('el postgres desechable no arrancó');
      }
      run(join(pg18, 'createdb'), ['--host=127.0.0.1', `--port=${port}`, '--username=postgres', 'ensayo']);
      run(join(pg18, 'createdb'), ['--host=127.0.0.1', `--port=${port}`, '--username=postgres', 'restaurado']);
      run(join(pg18, 'createdb'), ['--host=127.0.0.1', `--port=${port}`, '--username=postgres', 'vacio']);
      const schema = join(root, 'schema.sql');
      writeFileSync(
        schema,
        `
        CREATE TABLE talleres (
          id uuid PRIMARY KEY,
          nombre text NOT NULL,
          "metaPageId" text,
          "createdAt" timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE price_matrix (
          id uuid PRIMARY KEY,
          "tallerId" uuid NOT NULL,
          pieza text NOT NULL,
          severidad text NOT NULL,
          precio integer NOT NULL,
          dias_entrega integer NOT NULL,
          is_instant_service boolean NOT NULL
        );
        CREATE TABLE appointments (id uuid PRIMARY KEY);
        CREATE TABLE appointment_service_lines (
          id uuid PRIMARY KEY,
          "catalogPieceCode" character varying(32)
        );
        `,
      );
      psql('ensayo', ['--file', schema, '--file', join(import.meta.dirname, 'staging-synthetic.sql')]);
      psql('vacio', ['--file', schema]);
      const source = `postgres://postgres@127.0.0.1:${port}/ensayo`;
      const target = `postgres://postgres@127.0.0.1:${port}/restaurado`;
      assertDisposableRestoreUrl(target);
      run(pgDump18, ['--format=custom', '--no-owner', `--file=${dump}`, `--dbname=${source}`]);
      assertCustomDump(readFileSync(dump));
      run(join(pg18, 'pg_restore'), ['--no-owner', '--exit-on-error', `--dbname=${target}`, dump]);
      const marker = psql('restaurado', [
        '--no-align',
        '--tuples-only',
        '--field-separator=|',
        '--command',
        `SELECT id, nombre FROM talleres WHERE id = '${STAGING_TALLER_ID}'`,
      ]);
      assertSyntheticWorkshop(rowsFromPsql(marker));
      const integrity = psql('restaurado', [
        '--no-align',
        '--tuples-only',
        '--file',
        join(import.meta.dirname, 'staging-backup-integrity.sql'),
      ]);
      assertRestoredIntegrity(integrity);
      const key = randomBytes(32);
      const encrypted = encryptDump(readFileSync(dump), key);
      const decryptedPath = join(root, 'descifrado.dump');
      writeFileSync(decryptedPath, decryptDump(encrypted, key));
      assertCustomDump(readFileSync(decryptedPath));
      run(join(pg18, 'createdb'), ['--host=127.0.0.1', `--port=${port}`, '--username=postgres', 'descifrado']);
      run(join(pg18, 'pg_restore'), [
        '--no-owner',
        '--exit-on-error',
        `--dbname=postgres://postgres@127.0.0.1:${port}/descifrado`,
        decryptedPath,
      ]);
      assertRestoredIntegrity(
        psql('descifrado', [
          '--no-align',
          '--tuples-only',
          '--file',
          join(import.meta.dirname, 'staging-backup-integrity.sql'),
        ]),
      );
      const corrupt = Buffer.from(encrypted);
      corrupt[corrupt.length - 1] ^= 0xff;
      assert.throws(() => decryptDump(corrupt, key), /no se pudo descifrar/);
      assert.throws(() => decryptDump(encrypted, randomBytes(32)), /no se pudo descifrar/);
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
      const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
      const sealed = sealDump(readFileSync(dump), publicPem);
      assert.throws(
        () => stageExternalObject('staging/postgres/20261030T081500Z.dump.enc', sealed),
        /archivo sellado/,
      );
      const openedPath = join(root, 'sobre.dump');
      writeFileSync(openedPath, openDump(sealed, privatePem));
      assertCustomDump(readFileSync(openedPath));
      run(join(pg18, 'createdb'), ['--host=127.0.0.1', `--port=${port}`, '--username=postgres', 'sobre']);
      run(join(pg18, 'pg_restore'), [
        '--no-owner',
        '--exit-on-error',
        `--dbname=postgres://postgres@127.0.0.1:${port}/sobre`,
        openedPath,
      ]);
      assertRestoredIntegrity(
        psql('sobre', [
          '--no-align',
          '--tuples-only',
          '--file',
          join(import.meta.dirname, 'staging-backup-integrity.sql'),
        ]),
      );
      const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
      assert.throws(
        () => openDump(sealed, other.privateKey.export({ type: 'pkcs8', format: 'pem' })),
        /no se pudo abrir el sobre/,
      );
      run(pgDump18, [
        '--format=custom',
        '--no-owner',
        `--file=${emptyDump}`,
        `--dbname=postgres://postgres@127.0.0.1:${port}/vacio`,
      ]);
      run(join(pg18, 'createdb'), ['--host=127.0.0.1', `--port=${port}`, '--username=postgres', 'sin_marca']);
      run(join(pg18, 'pg_restore'), [
        '--no-owner',
        '--exit-on-error',
        `--dbname=postgres://postgres@127.0.0.1:${port}/sin_marca`,
        emptyDump,
      ]);
      const missing = psql('sin_marca', [
        '--no-align',
        '--tuples-only',
        '--field-separator=|',
        '--command',
        `SELECT id, nombre FROM talleres WHERE id = '${STAGING_TALLER_ID}'`,
      ]);
      assert.throws(() => assertSyntheticWorkshop(rowsFromPsql(missing)), /taller de ensayo/);
    } finally {
      spawnSync(join(pg18, 'pg_ctl'), [`--pgdata=${data}`, 'stop', '-m', 'fast'], { env });
      rmSync(root, { recursive: true, force: true });
    }
  },
);
