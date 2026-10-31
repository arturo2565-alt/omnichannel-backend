/**
 * Recorrido interno del contenedor. La cerradura se evalúa antes de cualquier binario.
 * No lee CONTAINER_REHEARSAL_EXECUTION del entorno. No publica puertos.
 * El plaintext y la clave privada no se escriben fuera de PGDATA.
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assertCustomDump, assertRestoredIntegrity } from '../assert-staging-restore.mjs';
import { openDump } from '../staging-backup-envelope.mjs';
import { consumeSealed, discardSealed, sealBlocks } from '../staging-backup-seal.mjs';
import {
  PGDATA,
  PLAINTEXT_MAX_BYTES,
  assertContainerAuthorized,
  reportPhases,
} from './contract.mjs';

const BIN = '/usr/lib/postgresql/18/bin';
const DATA_PARENT = '/var/lib/postgresql';
const SOCKET_DIR = '/run/postgresql';
const PWFILE = `${DATA_PARENT}/initdb.pw`;

function fail(message) {
  throw new Error(message);
}

function tool(name, args, env, cwd = PGDATA) {
  const result = spawnSync(`${BIN}/${name}`, args, {
    encoding: 'utf8',
    shell: false,
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) fail(`backup ERROR: ${name} no completó el ensayo.`);
  return result.stdout ?? '';
}

async function readSealed(handle) {
  const parts = [];
  await consumeSealed(handle, (chunk) => parts.push(Buffer.from(chunk)));
  return Buffer.concat(parts);
}

export async function runInside() {
  assertContainerAuthorized();
  const secret = randomBytes(24).toString('base64url');
  const env = {
    PATH: BIN,
    LC_ALL: 'C',
    LANG: 'C',
    PGDATA,
    HOME: DATA_PARENT,
  };
  const phases = {};
  const started = Date.now();
  mkdirSync(`${DATA_PARENT}/18`, { recursive: true, mode: 0o700 });
  mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(PWFILE, `${secret}\n`, { mode: 0o600 });
  chmodSync(PWFILE, 0o600);
  try {
    tool('initdb', ['--username=postgres', '--auth-local=scram-sha-256', '--auth-host=reject', '--pwfile', PWFILE, '--pgdata', PGDATA, '--no-instructions'], env, DATA_PARENT);
  } finally {
    try {
      unlinkSync(PWFILE);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  phases.init = true;
  writeFileSync(`${PGDATA}/pg_hba.conf`, 'local all all scram-sha-256\n', { mode: 0o600 });
  writeFileSync(`${PGDATA}/postgresql.auto.conf`, [
    "listen_addresses = ''",
    `unix_socket_directories = '${SOCKET_DIR}'`,
    "unix_socket_permissions = '0700'",
    "password_encryption = 'scram-sha-256'",
    '',
  ].join('\n'), { mode: 0o600 });
  phases.socket = true;
  const pgpass = `${PGDATA}/pgpass`;
  writeFileSync(pgpass, `${SOCKET_DIR}:5432:*:postgres:${secret}\n`, { mode: 0o600 });
  chmodSync(pgpass, 0o600);
  phases.credentials = true;
  const clientEnv = { ...env, PGPASSFILE: pgpass };
  tool('pg_ctl', ['--pgdata', PGDATA, 'start'], clientEnv);
  const client = ['--host', SOCKET_DIR, '--username', 'postgres'];
  tool('createdb', [...client, 'ensayo'], clientEnv);
  phases.createdb = true;
  tool('psql', [...client, '--dbname', 'ensayo', '--file', new URL('./schema.sql', import.meta.url).pathname, '--file', new URL('../staging-synthetic.sql', import.meta.url).pathname], clientEnv);
  phases.load = true;
  const dumpPath = `${PGDATA}/ensayo.dump`;
  tool('pg_dump', ['--format=custom', '--no-owner', '--file', dumpPath, ...client, '--dbname', 'ensayo'], clientEnv);
  phases.dump = true;
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const { readFileSync } = await import('node:fs');
  const plain = readFileSync(dumpPath);
  if (plain.length > PLAINTEXT_MAX_BYTES) fail('backup ERROR: el archivo supera el límite del ensayo.');
  async function* chunks() { yield plain; }
  const handle = await sealBlocks(chunks(), publicKey, { maxBytes: PLAINTEXT_MAX_BYTES });
  const sealed = await readSealed(handle);
  await discardSealed(handle);
  phases.seal = true;
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 0xff;
  try {
    openDump(tampered, privateKey);
    fail('backup ERROR: el sobre alterado fue aceptado.');
  } catch (err) {
    if (err instanceof Error && err.message === 'backup ERROR: el sobre alterado fue aceptado.') throw err;
  }
  phases.tamper = true;
  const opened = openDump(sealed, privateKey);
  phases.open = true;
  assertCustomDump(opened);
  phases.header = true;
  const openedPath = `${PGDATA}/abierto.dump`;
  writeFileSync(openedPath, opened, { mode: 0o600 });
  tool('createdb', [...client, 'restaurado'], clientEnv);
  tool('pg_restore', ['--no-owner', '--exit-on-error', ...client, '--dbname', 'restaurado', openedPath], clientEnv);
  phases.restore = true;
  const checked = tool('psql', [...client, '--dbname', 'restaurado', '--no-align', '--tuples-only', '--file', new URL('../staging-backup-integrity.sql', import.meta.url).pathname], clientEnv);
  assertRestoredIntegrity(checked);
  phases.integrity = true;
  tool('pg_ctl', ['--pgdata', PGDATA, 'stop', '-m', 'fast'], clientEnv);
  return {
    ...reportPhases({ ...phases, clientInvoked: true, sealedBytes: sealed.length }),
    durationMs: Date.now() - started,
    sealedBytes: sealed.length,
  };
}

function main() {
  console.error('backup ERROR: el ensayo en contenedor no está autorizado.');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
