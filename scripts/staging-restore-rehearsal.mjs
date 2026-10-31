/**
 * Ensayo local de recuperación. Por defecto solo hace preflight.
 * SCRAM-SHA-256 y un socket Unix dentro del directorio privado.
 * No escucha por TCP y no usa trust.
 * No importa el worker plan-only. La CLI sigue cerrada.
 * SIGINT y SIGTERM vuelven a demostrar la identidad antes de pedir parada.
 * /bin/ps y la época de postmaster.pid identifican el proceso. kill(pid, 0) no demuestra propiedad.
 * La época tiene resolución de un segundo y no cierra la carrera hasta la señal de pg_ctl.
 * Darwin puede vincular el proceso con proc_pidinfo o kqueue EVFILT_PROC; este proceso no tiene esa interfaz.
 * SIGKILL no permite limpieza dentro del proceso. No hay barrido automático.
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { chmod, mkdir, mkdtemp, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertCustomDump,
  assertPostgres18,
  assertRestoredIntegrity,
} from './assert-staging-restore.mjs';
import { openDump } from './staging-backup-envelope.mjs';
import { assertSealedFile, consumeSealed, discardSealed, sealBlocks } from './staging-backup-seal.mjs';

export const REHEARSAL_EXECUTION = 'preflight-only';
export const TARGET_PORT = 55418;
export const REHEARSAL_MAX_BYTES = 32 * 1024 * 1024;
export const PLAINTEXT_MAX_BYTES = 32 * 1024 * 1024;
export const SEALED_MAX_BYTES = 32 * 1024 * 1024;
export const PINNED_BIN = '/opt/homebrew/opt/postgresql@18/bin';
export const CELLAR_PREFIX = '/opt/homebrew/Cellar/postgresql@18/';
export const DANGEROUS_ENV = Object.freeze([
  'PGHOST',
  'PGHOSTADDR',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGPASSWORD',
  'PGPASSFILE',
  'PGDATA',
  'PGOPTIONS',
  'PGAPPNAME',
  'PGSSLMODE',
  'PGSSLROOTCERT',
  'PGREQUIRESSL',
  'PGCHANNELBINDING',
  'DATABASE_URL',
  'STAGING_DATABASE_URL',
  'LOCAL_DATABASE_URL',
]);
export const TOOLS = Object.freeze(['initdb', 'postgres', 'pg_ctl', 'createdb', 'pg_dump', 'pg_restore', 'psql']);
const DATABASES = new Set(['ensayo', 'restaurado']);
const ROOT_NAME = /^pegazuz-restore-[A-Za-z0-9]{6}$/;
const CHILD_ENV = new Set(['PATH', 'LC_ALL', 'LANG', 'HOME', 'PGDATA', 'PGPASSFILE', 'PGSERVICEFILE']);
const SCHEMA_SQL = `
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
`;

function fail(message) {
  throw new Error(message);
}

export function assertRehearsalAuthorized() {
  if (REHEARSAL_EXECUTION !== 'execute') {
    fail('backup ERROR: el ensayo integral no está autorizado.');
  }
}

export function assertInheritedEnv(env) {
  for (const name of DANGEROUS_ENV) {
    if (env?.[name] !== undefined) {
      fail(`backup ERROR: la variable ${name} puede redirigir la conexión.`);
    }
  }
  if (env?.PG18_BIN !== undefined && env.PG18_BIN !== PINNED_BIN) {
    fail('backup ERROR: la variable PG18_BIN puede redirigir la conexión.');
  }
}

export function assertRehearsalBytes(size) {
  if (!Number.isSafeInteger(size) || size < 24 || size > REHEARSAL_MAX_BYTES) {
    fail('backup ERROR: el archivo supera el límite del ensayo.');
  }
}

export function assessSize(before, after, limit) {
  if (!before || before.isSymbolicLink === true || before.isFile !== true) return 'ambiguous';
  if (!Number.isSafeInteger(before.size) || !Number.isSafeInteger(limit)) return 'ambiguous';
  if (before.size < 24 || before.size > limit) return 'reject';
  if (!after || after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev || after.isSymbolicLink === true) {
    return 'ambiguous';
  }
  return 'ok';
}

export function readBounded(path, limit) {
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    fail('backup ERROR: el archivo del ensayo no es válido.');
  }
  try {
    const before = fstatSync(fd);
    const beforeMeta = {
      size: before.size,
      isFile: before.isFile(),
      isSymbolicLink: false,
      dev: before.dev,
      ino: before.ino,
    };
    if (assessSize(beforeMeta, beforeMeta, limit) !== 'ok') fail('backup ERROR: el archivo supera el límite del ensayo.');
    const buf = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < before.size) {
      const read = readSync(fd, buf, offset, before.size - offset, offset);
      if (read <= 0) fail('backup ERROR: el archivo del ensayo no es válido.');
      offset += read;
    }
    const after = fstatSync(fd);
    const afterMeta = {
      size: after.size,
      isFile: after.isFile(),
      isSymbolicLink: false,
      dev: after.dev,
      ino: after.ino,
    };
    if (assessSize(beforeMeta, afterMeta, limit) !== 'ok') fail('backup ERROR: el archivo del ensayo cambió durante la lectura.');
    return buf;
  } finally {
    closeSync(fd);
  }
}

export function renderInitdbPassword(secret) {
  if (!/^[A-Za-z0-9_-]{24,}$/.test(String(secret ?? ''))) fail('backup ERROR: la credencial del ensayo no es válida.');
  return `${secret}\n`;
}

export function renderPgpass(socketDir, secret) {
  renderInitdbPassword(secret);
  if (typeof socketDir !== 'string' || !socketDir.startsWith('/') || /[:\s]/.test(socketDir)) {
    fail('backup ERROR: el socket del ensayo no es válido.');
  }
  const line = `${socketDir}:${TARGET_PORT}:*:postgres:${secret}`;
  const fields = line.split(':');
  if (fields.length !== 5 || fields[4] !== secret) fail('backup ERROR: el socket del ensayo no es válido.');
  return `${line}\n`;
}

export function commandOwnsDataDir(command, dataDir) {
  if (typeof command !== 'string' || typeof dataDir !== 'string' || command.length === 0 || dataDir.length === 0) {
    return 'ambiguous';
  }
  if (command.length >= 4096 || command.endsWith('...') || /[\s]/.test(dataDir)) return 'ambiguous';
  const needle = `-D ${dataDir}`;
  let from = 0;
  while (from < command.length) {
    const index = command.indexOf(needle, from);
    if (index < 0) return 'foreign';
    const beforeOk = index === 0 || command[index - 1] === ' ' || command[index - 1] === '\n';
    const after = command[index + needle.length];
    const afterOk = after === undefined || after === ' ' || after === '\n';
    if (beforeOk && afterOk) return 'owned';
    from = index + needle.length;
  }
  return 'foreign';
}

export const PS_BIN = '/bin/ps';
const WEEKDAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const MONTHS = Object.freeze({
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
});

export function psInvocation(pid) {
  if (!Number.isInteger(pid) || pid <= 0) fail('backup ERROR: la identidad del clúster es ambigua.');
  return [PS_BIN, '-ww', '-p', String(pid), '-o', 'pid=,lstart=,command='];
}

export function formatDarwinLstart(epoch) {
  if (!Number.isSafeInteger(epoch) || epoch <= 0) fail('backup ERROR: la identidad del clúster es ambigua.');
  const date = new Date(epoch * 1000);
  const month = Object.keys(MONTHS).find((name) => MONTHS[name] === date.getMonth());
  const day = String(date.getDate()).padStart(2, ' ');
  const clock = [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
  return `${WEEKDAYS[date.getDay()]} ${month} ${day} ${clock} ${date.getFullYear()}`;
}

export function epochFromDarwinLstart(text) {
  const match = /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) +([0-9]{1,2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/.exec(text);
  if (!match || !WEEKDAYS.includes(match[1]) || MONTHS[match[2]] === undefined) return null;
  const year = Number(match[7]);
  const month = MONTHS[match[2]];
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = Number(match[6]);
  if (hours > 23 || minutes > 59 || seconds > 59 || day < 1 || day > 31) return null;
  const date = new Date(year, month, day, hours, minutes, seconds);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day ||
    date.getHours() !== hours ||
    WEEKDAYS[date.getDay()] !== match[1]
  ) {
    return null;
  }
  const epoch = Math.floor(date.getTime() / 1000);
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : null;
}

export function parsePsIdentity(stdout, expectedPid) {
  const raw = String(stdout ?? '');
  const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (
    raw.length === 0 ||
    raw.length >= 4096 ||
    line.length === 0 ||
    line.length >= 4096 ||
    line.includes('\n') ||
    line.endsWith('...')
  ) {
    return { ok: false };
  }
  const match = /^(\d+) +([A-Z][a-z]{2} [A-Z][a-z]{2} +[0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}) +(\S[\s\S]*)$/.exec(line);
  if (!match) return { ok: false };
  const pid = Number(match[1]);
  const startEpoch = epochFromDarwinLstart(match[2]);
  if (!Number.isInteger(pid) || pid !== expectedPid || String(pid) !== match[1] || startEpoch == null) return { ok: false };
  if (match[3].endsWith('...') || match[3].length >= 4096) return { ok: false };
  return { ok: true, pid, startEpoch, command: match[3] };
}

export function stampDirectory(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { ok: false };
  }
  if (st.isSymbolicLink()) return { ok: true, symlink: true };
  if (!st.isDirectory()) return { ok: false };
  return { ok: true, symlink: false, dev: st.dev, ino: st.ino };
}

export function interpretLiveness(code) {
  if (code === 'ESRCH') return 'dead';
  if (code == null) return 'alive';
  return 'ambiguous';
}

export function decideCleanup(snapshot) {
  const life = snapshot?.processAlive;
  if (life !== 'dead') {
    return { action: 'preserve', incident: snapshot?.started === true, signal: false };
  }
  if (snapshot?.started === true && snapshot?.identityProven !== true) {
    return { action: 'preserve', incident: true, signal: false };
  }
  if (snapshot?.started === true && snapshot?.stopVerified !== true) {
    return { action: 'preserve', incident: true, signal: false };
  }
  if (snapshot?.started === true && snapshot?.identityProven === true && snapshot?.stopVerified === true) {
    return { action: 'remove', incident: false, signal: false };
  }
  if (snapshot?.started !== true && snapshot?.pidFileExists !== true && snapshot?.rootOwned === true) {
    return { action: 'remove-empty', incident: false, signal: false };
  }
  return { action: 'preserve', incident: snapshot?.started === true, signal: false };
}

function completeBaseline(baseline) {
  return Boolean(
    baseline &&
    Number.isInteger(baseline.pid) &&
    baseline.pid > 0 &&
    Number.isSafeInteger(baseline.startEpoch) &&
    baseline.startEpoch > 0 &&
    typeof baseline.dataDir === 'string' &&
    baseline.dataDir.startsWith('/') &&
    Number.isSafeInteger(baseline.dataDev) &&
    Number.isSafeInteger(baseline.dataIno) &&
    Number.isSafeInteger(baseline.rootDev) &&
    Number.isSafeInteger(baseline.rootIno) &&
    baseline.port === TARGET_PORT &&
    typeof baseline.socketDir === 'string' &&
    baseline.socketDir.startsWith('/') &&
    baseline.listenAddress === ''
  );
}

function preserveStop(incident, reason) {
  return { action: 'preserve', signal: false, incident, reason };
}

export function authorizeStop(baseline, observed) {
  if (!completeBaseline(baseline)) return preserveStop(true, 'identidad no demostrada');
  if (!observed || observed.inspection !== 'ok' || observed.truncated === true) {
    return preserveStop(true, 'inspección ambigua');
  }
  if (observed.processPresent === 'dead') return preserveStop(false, 'el proceso ya no existe');
  if (observed.processPresent !== 'alive') return preserveStop(true, 'existencia ambigua');
  if (commandOwnsDataDir(observed.command, baseline.dataDir) !== 'owned') {
    return preserveStop(true, 'el directorio de datos no coincide');
  }
  const same =
    observed.pid === baseline.pid &&
    observed.startEpoch === baseline.startEpoch &&
    observed.processStartEpoch === baseline.startEpoch &&
    observed.dataDir === baseline.dataDir &&
    observed.dataDev === baseline.dataDev &&
    observed.dataIno === baseline.dataIno &&
    observed.rootDev === baseline.rootDev &&
    observed.rootIno === baseline.rootIno &&
    observed.dataIsSymlink === false &&
    observed.rootIsSymlink === false &&
    observed.port === TARGET_PORT &&
    observed.socketDir === baseline.socketDir &&
    observed.listenAddress === '' &&
    observed.tcpListenersEmpty === true &&
    observed.defaultSocketExists === false &&
    observed.socketIsSocket === true &&
    observed.socketIsSymlink === false &&
    observed.pidFilePresent === true;
  if (!same) return preserveStop(true, 'la identidad cambió');
  return { action: 'stop', signal: true, incident: false, reason: 'identidad vigente' };
}

export function confirmTermination(baseline, after, stopRequested) {
  if (stopRequested !== true || !completeBaseline(baseline)) {
    return { action: 'preserve', signal: false, incident: true, stopVerified: false };
  }
  if (!after || after.inspection !== 'ok' || after.truncated === true || after.processPresent !== 'dead') {
    return { action: 'preserve', signal: false, incident: true, stopVerified: false };
  }
  if (
    after.dataIsSymlink !== false ||
    after.rootIsSymlink !== false ||
    after.dataDev !== baseline.dataDev ||
    after.dataIno !== baseline.dataIno ||
    after.rootDev !== baseline.rootDev ||
    after.rootIno !== baseline.rootIno
  ) {
    return { action: 'preserve', signal: false, incident: true, stopVerified: false };
  }
  if (after.pidFilePresent === true && (after.pid !== baseline.pid || after.startEpoch !== baseline.startEpoch)) {
    return { action: 'preserve', signal: false, incident: true, stopVerified: false };
  }
  return { action: 'remove', signal: false, incident: false, stopVerified: true };
}

export function assertStopAuthorized(decision) {
  if (decision?.signal !== true || decision?.action !== 'stop' || decision?.reason !== 'identidad vigente') {
    fail('backup ERROR: la parada no tiene una identidad vigente.');
  }
}

export function decideCancel(signal, baseline, observed) {
  if (signal === 'SIGKILL') {
    return { action: 'preserve', incident: true, signal: false, reason: 'SIGKILL no permite limpieza dentro del proceso.' };
  }
  if (signal !== 'SIGINT' && signal !== 'SIGTERM') {
    return { action: 'preserve', incident: true, signal: false, reason: 'señal no manejada' };
  }
  return authorizeStop(baseline, observed);
}

export function describeOutcome(phase, facts = {}) {
  if (phase === 'preflight') {
    return { phase, connects: false, execution: REHEARSAL_EXECUTION, success: facts.ok === true, completed: facts.ok === true, port: TARGET_PORT };
  }
  if (phase === 'simulation') {
    return { phase, connects: false, execution: REHEARSAL_EXECUTION, success: false, completed: false };
  }
  if (phase === 'execution') {
    const completed = facts.clientInvoked === true && facts.sealed === true && facts.restored === true && facts.integrity === true;
    if (facts.clientInvoked === true) {
      return { phase, connects: true, execution: REHEARSAL_EXECUTION, success: completed, completed };
    }
    return { phase, connects: false, execution: REHEARSAL_EXECUTION, success: false, completed: false };
  }
  fail('backup ERROR: el informe del ensayo no es válido.');
}

export function childProcessSpec(identity, usePassfile) {
  const env = {
    PATH: PINNED_BIN,
    LC_ALL: 'en_US.UTF-8',
    LANG: 'en_US.UTF-8',
    HOME: identity.root,
    PGDATA: identity.dataDir,
    PGSERVICEFILE: identity.serviceFile,
  };
  if (usePassfile) env.PGPASSFILE = identity.pgpass;
  for (const key of Object.keys(env)) {
    if (!CHILD_ENV.has(key)) fail('backup ERROR: el entorno del ensayo no es válido.');
  }
  return { cwd: identity.root, env, shell: false };
}

export function initdbArgs(identity) {
  return [
    '--username=postgres',
    '--auth-local=scram-sha-256',
    '--auth-host=reject',
    '--pwfile',
    identity.pwfile,
    '--no-instructions',
    '--pgdata',
    identity.dataDir,
  ];
}

export function serverConfig(socketDir) {
  return [
    "listen_addresses = ''",
    `port = ${TARGET_PORT}`,
    `unix_socket_directories = '${socketDir}'`,
    "unix_socket_permissions = '0700'",
    "password_encryption = 'scram-sha-256'",
    '',
  ].join('\n');
}

export const HBA_TEXT = 'local all all scram-sha-256\n';

export function assertBinaries(binaries) {
  if (!Array.isArray(binaries) || binaries.length !== TOOLS.length) {
    fail('backup ERROR: el cliente PostgreSQL 18 no está fijado.');
  }
  for (const tool of TOOLS) {
    const found = binaries.find((item) => item?.tool === tool);
    if (!found || found.path !== join(PINNED_BIN, tool) || found.escaped === true) {
      fail('backup ERROR: el cliente PostgreSQL 18 no está fijado.');
    }
    if (found.regular !== true && found.symlinkWithinPin !== true) {
      fail('backup ERROR: el cliente PostgreSQL 18 no está fijado.');
    }
  }
}

export function assertSurface(surface) {
  if (surface == null || surface.ambiguous === true) {
    fail('backup ERROR: el ensayo no puede comprobar el entorno.');
  }
  assertInheritedEnv(surface.env ?? {});
  if (!Array.isArray(surface.listeners)) fail('backup ERROR: el puerto del ensayo es ambiguo.');
  if (surface.listeners.length > 0) fail('backup ERROR: el puerto del ensayo está ocupado.');
  if (surface.defaultSocketExists !== false) fail('backup ERROR: el socket del ensayo ya existe.');
  assertBinaries(surface.binaries);
}

export function assertSocketUrl(url, identity) {
  const raw = String(url ?? '');
  const lower = raw.toLowerCase();
  if (
    raw.includes('@') ||
    lower.includes('railway') ||
    lower.includes('rlwy') ||
    lower.includes('.internal') ||
    lower.includes('proxy') ||
    lower.includes('localhost') ||
    lower.includes('amazonaws') ||
    /127\.0\.0\.1/.test(raw) ||
    /:\/\//.test(raw) === false
  ) {
    fail('backup ERROR: la restauración solo acepta el socket privado del ensayo.');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail('backup ERROR: la restauración solo acepta el socket privado del ensayo.');
  }
  const dbname = parsed.pathname.replace(/^\//, '');
  if (
    parsed.protocol !== 'postgresql:' ||
    parsed.hostname !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    !DATABASES.has(dbname)
  ) {
    fail('backup ERROR: la restauración solo acepta el socket privado del ensayo.');
  }
  const keys = [...parsed.searchParams.keys()];
  if (keys.length !== 2 || !keys.includes('host') || !keys.includes('port')) {
    fail('backup ERROR: la restauración solo acepta el socket privado del ensayo.');
  }
  if (parsed.searchParams.get('host') !== identity?.socketDir || parsed.searchParams.get('port') !== String(TARGET_PORT)) {
    fail('backup ERROR: la restauración solo acepta el socket privado del ensayo.');
  }
}

export function socketUrl(identity, dbname) {
  if (!DATABASES.has(dbname)) fail('backup ERROR: la base del ensayo no está permitida.');
  if (identity?.socketDir == null || identity.socketDir.includes("'") || identity.socketDir.includes('?')) {
    fail('backup ERROR: el directorio del ensayo no es exclusivo.');
  }
  const url = `postgresql:///${dbname}?host=${encodeURIComponent(identity.socketDir)}&port=${TARGET_PORT}`;
  assertSocketUrl(url, identity);
  return url;
}

export function parsePostmasterPid(text) {
  const lines = String(text ?? '').split('\n');
  if (lines.length < 6) fail('backup ERROR: la identidad del clúster es ambigua.');
  if (!/^[1-9][0-9]*$/.test(lines[0]) || !/^[1-9][0-9]{8,}$/.test(lines[2]) || !/^[1-9][0-9]*$/.test(lines[3])) {
    fail('backup ERROR: la identidad del clúster es ambigua.');
  }
  const pid = Number(lines[0]);
  const dataDir = lines[1];
  const startEpoch = Number(lines[2]);
  const port = Number(lines[3]);
  const socketDir = lines[4];
  const listenAddress = lines[5];
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(startEpoch) ||
    startEpoch <= 0 ||
    !Number.isSafeInteger(port) ||
    port <= 0 ||
    !dataDir.startsWith('/') ||
    !socketDir.startsWith('/')
  ) {
    fail('backup ERROR: la identidad del clúster es ambigua.');
  }
  return { pid, dataDir, startEpoch, port, socketDir, listenAddress };
}

export function classifyCluster(identity, observed) {
  if (observed?.inspection === 'failed' || observed?.truncated === true || observed?.processPresent === 'dead' || observed?.processPresent === 'ambiguous') {
    return { action: 'preserve', identityProven: false, signal: false, incident: true };
  }
  const ownership = commandOwnsDataDir(observed?.command, identity?.dataDir);
  if (ownership === 'ambiguous') return { action: 'preserve', identityProven: false, signal: false, incident: true };
  let parsed;
  try {
    parsed = parsePostmasterPid(observed?.pidText);
  } catch {
    return { action: 'preserve', identityProven: false, signal: false, incident: ownership === 'owned' };
  }
  const proven =
    observed?.processPresent === 'alive' &&
    ownership === 'owned' &&
    parsed.dataDir === identity?.dataDir &&
    parsed.socketDir === identity?.socketDir &&
    parsed.startEpoch === observed?.processStartEpoch &&
    observed?.dataDev === identity?.dataDev &&
    observed?.dataIno === identity?.dataIno &&
    observed?.rootDev === identity?.dev &&
    observed?.rootIno === identity?.ino &&
    observed?.dataIsSymlink === false &&
    observed?.rootIsSymlink === false &&
    observed?.pid === parsed.pid &&
    parsed.port === TARGET_PORT &&
    parsed.listenAddress === '' &&
    observed?.socketIsSymlink === false &&
    observed?.socketIsSocket === true &&
    observed?.defaultSocketExists === false &&
    Array.isArray(observed?.tcpListeners) &&
    observed.tcpListeners.length === 0;
  if (!proven) return { action: 'preserve', identityProven: false, signal: false, incident: false };
  return {
    action: 'owned',
    identityProven: true,
    signal: false,
    incident: false,
    baseline: {
      pid: parsed.pid,
      startEpoch: parsed.startEpoch,
      dataDir: parsed.dataDir,
      dataDev: identity.dataDev,
      dataIno: identity.dataIno,
      rootDev: identity.dev,
      rootIno: identity.ino,
      port: parsed.port,
      socketDir: parsed.socketDir,
      listenAddress: '',
    },
  };
}

export function openAuthenticatedDump(bytes, privateKey) {
  const meta = { size: bytes?.length ?? -1, isFile: true, isSymbolicLink: false, dev: 1, ino: 1 };
  if (assessSize(meta, meta, SEALED_MAX_BYTES) !== 'ok') fail('backup ERROR: el archivo supera el límite del ensayo.');
  const plain = openDump(bytes, privateKey);
  assertCustomDump(plain);
  return plain;
}

function assertSpawn(command, args, env, identity, secret) {
  if (command !== join(PINNED_BIN, basename(command)) || !TOOLS.includes(basename(command))) {
    fail('backup ERROR: el cliente PostgreSQL 18 no está fijado.');
  }
  const flat = args.join('\n');
  if (secret && flat.includes(secret)) fail('backup ERROR: el ensayo no acepta ese argumento.');
  if (/\btrust\b|railway|rlwy|\.internal|127\.0\.0\.1|localhost/i.test(flat)) {
    fail('backup ERROR: el ensayo no acepta ese argumento.');
  }
  for (const key of Object.keys(env)) {
    if (!CHILD_ENV.has(key)) fail('backup ERROR: el entorno del ensayo no es válido.');
    if (secret && String(env[key]).includes(secret)) fail('backup ERROR: el entorno del ensayo no es válido.');
  }
  if (env.PGDATA !== identity.dataDir || env.HOME !== identity.root) {
    fail('backup ERROR: el entorno del ensayo no es válido.');
  }
  if (basename(command) === 'pg_ctl' && args.includes('stop') && !args.includes(identity.dataDir)) {
    fail('backup ERROR: la parada no tiene un directorio verificado.');
  }
}

function assertFresh(identity) {
  const st = lstatSync(identity.root);
  if (st.isSymbolicLink() || !st.isDirectory()) fail('backup ERROR: el directorio del ensayo no es exclusivo.');
  if (dirname(identity.root) !== tmpdir() || !ROOT_NAME.test(identity.name)) {
    fail('backup ERROR: el directorio del ensayo no es exclusivo.');
  }
  if (st.dev !== identity.dev || st.ino !== identity.ino) fail('backup ERROR: el directorio del ensayo no es exclusivo.');
}

export function assertCandidateRoot(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    fail('backup ERROR: el directorio del ensayo no es exclusivo.');
  }
  if (st.isSymbolicLink() || st.isDirectory() || st.isFile()) {
    fail('backup ERROR: el directorio del ensayo no es exclusivo.');
  }
  fail('backup ERROR: el directorio del ensayo no es exclusivo.');
}

export function removeRehearsalRoot(identity, proof) {
  const current = lstatSync(identity.root);
  if (current.isSymbolicLink()) fail('backup ERROR: el clúster queda en incidente y se preserva.');
  const decision = decideCleanup(proof);
  if (decision.action !== 'remove' && decision.action !== 'remove-empty') {
    fail('backup ERROR: el clúster queda en incidente y se preserva.');
  }
  if (proof?.processAlive === 'alive') fail('backup ERROR: el clúster queda en incidente y se preserva.');
  assertFresh(identity);
  const dataPid = join(identity.dataDir, 'postmaster.pid');
  let pidExists = false;
  try {
    if (lstatSync(dataPid).isSymbolicLink()) fail('backup ERROR: el clúster queda en incidente y se preserva.');
    pidExists = true;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  if (pidExists && proof?.processAlive !== 'dead') fail('backup ERROR: el clúster queda en incidente y se preserva.');
  if (decision.action === 'remove-empty' && pidExists) fail('backup ERROR: el clúster queda en incidente y se preserva.');
  rmSync(identity.root, { recursive: true });
}

async function writeExclusive(path, data, mode) {
  const fh = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode);
  try {
    await fh.writeFile(data);
    await fh.chmod(mode);
  } finally {
    await fh.close();
  }
}

async function overwritePlain(path, data, mode) {
  const fh = await open(path, fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, mode);
  try {
    await fh.writeFile(data);
    await fh.chmod(mode);
  } finally {
    await fh.close();
  }
}

function tool(name) {
  return join(PINNED_BIN, name);
}

function runTool(spawn, identity, secret, name, args, usePassfile) {
  const command = tool(name);
  const spec = childProcessSpec(identity, usePassfile);
  assertSpawn(command, args, spec.env, identity, secret);
  const result = spawn(command, args, spec.env, spec.cwd);
  if (result?.status !== 0) fail(`backup ERROR: ${name} no completó el ensayo.`);
  return result;
}

async function sealDumpFile(dumpPath, publicKey) {
  const listed = lstatSync(dumpPath);
  const listedMeta = {
    size: listed.size,
    isFile: listed.isFile(),
    isSymbolicLink: listed.isSymbolicLink(),
    dev: listed.dev,
    ino: listed.ino,
  };
  if (assessSize(listedMeta, listedMeta, PLAINTEXT_MAX_BYTES) !== 'ok') {
    fail('backup ERROR: el archivo supera el límite del ensayo.');
  }
  async function* chunks() {
    const fh = await open(dumpPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const st = await fh.stat();
      const opened = { size: st.size, isFile: st.isFile(), isSymbolicLink: false, dev: st.dev, ino: st.ino };
      if (assessSize(listedMeta, opened, PLAINTEXT_MAX_BYTES) !== 'ok') {
        fail('backup ERROR: el archivo del ensayo cambió durante la lectura.');
      }
      let offset = 0;
      while (offset < st.size) {
        const length = Math.min(64 * 1024, st.size - offset);
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        if (bytesRead !== length) fail('backup ERROR: el volcado del ensayo no es válido.');
        offset += bytesRead;
        yield buf;
      }
    } finally {
      await fh.close();
    }
  }
  return sealBlocks(chunks(), publicKey, { maxBytes: PLAINTEXT_MAX_BYTES });
}

async function readSealed(handle) {
  const inspected = assertSealedFile(handle);
  const meta = { size: inspected.byteLength, isFile: true, isSymbolicLink: false, dev: 1, ino: 1 };
  if (assessSize(meta, meta, SEALED_MAX_BYTES) !== 'ok') fail('backup ERROR: el archivo supera el límite del ensayo.');
  const parts = [];
  await consumeSealed(handle, (chunk) => {
    parts.push(Buffer.from(chunk));
  });
  const sealed = Buffer.concat(parts);
  const sealedMeta = { size: sealed.length, isFile: true, isSymbolicLink: false, dev: 2, ino: 2 };
  if (assessSize(sealedMeta, sealedMeta, SEALED_MAX_BYTES) !== 'ok') fail('backup ERROR: el archivo supera el límite del ensayo.');
  return sealed;
}

function rejectTampered(sealed, privateKey) {
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 0xff;
  let rejected = false;
  try {
    openAuthenticatedDump(tampered, privateKey);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('backup ERROR:')) throw err;
    rejected = true;
  }
  if (!rejected) fail('backup ERROR: el sobre alterado fue aceptado.');
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  try {
    openAuthenticatedDump(sealed, other.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    fail('backup ERROR: una clave ajena abrió el sobre.');
  } catch (err) {
    if (err instanceof Error && err.message === 'backup ERROR: una clave ajena abrió el sobre.') throw err;
    if (!(err instanceof Error) || !err.message.startsWith('backup ERROR:')) throw err;
  }
}

function rememberData(identity) {
  const st = lstatSync(identity.dataDir);
  if (st.isSymbolicLink() || !st.isDirectory()) fail('backup ERROR: el directorio del ensayo no es exclusivo.');
  identity.dataDev = st.dev;
  identity.dataIno = st.ino;
}

function clientArgs(identity, dbname, extra) {
  return ['--host', identity.socketDir, '--port', String(TARGET_PORT), '--username', 'postgres', '--dbname', dbname, ...extra];
}

function readPostmasterFile(pidPath) {
  const opened = openSync(pidPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const st = fstatSync(opened);
    if (!st.isFile() || st.size <= 0 || st.size > 4096) fail('backup ERROR: la identidad del clúster es ambigua.');
    const buf = Buffer.alloc(st.size);
    if (readSync(opened, buf, 0, st.size, 0) !== st.size) fail('backup ERROR: la identidad del clúster es ambigua.');
    return buf.toString('utf8');
  } finally {
    closeSync(opened);
  }
}

function queryProcess(pid) {
  const argv = psInvocation(pid);
  let listed;
  try {
    listed = spawnSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      shell: false,
      cwd: '/',
      env: { LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return { inspection: 'failed', processPresent: 'ambiguous', truncated: true };
  }
  if (listed.error) return { inspection: 'failed', processPresent: 'ambiguous', truncated: true };
  const stdout = listed.stdout ?? '';
  if (stdout.length >= 4096) return { inspection: 'failed', processPresent: 'ambiguous', truncated: true };
  if (listed.status === 1 && stdout.trim() === '') {
    return { inspection: 'ok', processPresent: 'dead', truncated: false };
  }
  if (listed.status !== 0) return { inspection: 'failed', processPresent: 'ambiguous', truncated: true };
  const parsed = parsePsIdentity(stdout, pid);
  if (parsed.ok !== true) return { inspection: 'failed', processPresent: 'ambiguous', truncated: true };
  return {
    inspection: 'ok',
    processPresent: 'alive',
    truncated: false,
    pid: parsed.pid,
    processStartEpoch: parsed.startEpoch,
    command: parsed.command,
  };
}

function socketObservation(identity) {
  const listeners = liveListeners();
  const tcpListeners = listeners == null
    ? null
    : listeners.map((line) => {
      const pid = Number(line.trim().split(/\s+/)[1]);
      return { pid: Number.isInteger(pid) ? pid : -1 };
    });
  let socketIsSymlink = true;
  let socketIsSocket = false;
  try {
    const sock = lstatSync(join(identity.socketDir, `.s.PGSQL.${TARGET_PORT}`));
    socketIsSymlink = sock.isSymbolicLink();
    socketIsSocket = sock.isSocket();
  } catch {
    socketIsSymlink = false;
  }
  let defaultSocketExists = true;
  try {
    lstatSync(`/tmp/.s.PGSQL.${TARGET_PORT}`);
  } catch (err) {
    defaultSocketExists = err?.code !== 'ENOENT';
  }
  return { tcpListeners, socketIsSymlink, socketIsSocket, defaultSocketExists };
}

function liveInspect(identity, hintPid) {
  const data = stampDirectory(identity.dataDir);
  const root = stampDirectory(identity.root);
  const failed = {
    inspection: 'failed',
    truncated: true,
    processPresent: 'ambiguous',
    dataIsSymlink: data.symlink === true,
    rootIsSymlink: root.symlink === true,
    dataDev: data.dev,
    dataIno: data.ino,
    rootDev: root.dev,
    rootIno: root.ino,
    pidFilePresent: false,
  };
  if (data.ok !== true || root.ok !== true || data.symlink === true || root.symlink === true) return failed;
  let parsed = null;
  let pidText = '';
  try {
    pidText = readPostmasterFile(join(identity.dataDir, 'postmaster.pid'));
    parsed = parsePostmasterPid(pidText);
  } catch {
    parsed = null;
  }
  const pid = parsed?.pid ?? hintPid;
  if (!Number.isInteger(pid) || pid <= 0) return failed;
  const proc = queryProcess(pid);
  const sockets = socketObservation(identity);
  return {
    inspection: proc.inspection,
    truncated: proc.truncated === true,
    processPresent: proc.processPresent,
    pidText,
    pid: parsed?.pid ?? pid,
    startEpoch: parsed?.startEpoch,
    processStartEpoch: proc.processStartEpoch,
    command: proc.command,
    dataDir: parsed?.dataDir,
    dataDev: data.dev,
    dataIno: data.ino,
    dataIsSymlink: false,
    rootDev: root.dev,
    rootIno: root.ino,
    rootIsSymlink: false,
    port: parsed?.port,
    socketDir: parsed?.socketDir,
    listenAddress: parsed?.listenAddress,
    pidFilePresent: parsed != null,
    tcpListeners: sockets.tcpListeners,
    socketIsSymlink: sockets.socketIsSymlink,
    socketIsSocket: sockets.socketIsSocket,
    defaultSocketExists: sockets.defaultSocketExists,
  };
}

export async function placeCredentials(root, socketDir, secret) {
  const pwfile = join(root, 'initdb.pw');
  const pgpass = join(root, 'pgpass');
  await writeExclusive(pwfile, renderInitdbPassword(secret), 0o600);
  await writeExclusive(pgpass, renderPgpass(socketDir, secret), 0o600);
  return { pwfile, pgpass };
}

export function discardInitdbPassword(identity) {
  const path = identity?.pwfile;
  if (typeof path !== 'string' || basename(path) !== 'initdb.pw' || dirname(path) !== identity.root) {
    fail('backup ERROR: la credencial del ensayo no se puede retirar.');
  }
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isFile()) fail('backup ERROR: la credencial del ensayo no se puede retirar.');
  unlinkSync(path);
}

export async function runRehearsal() {
  assertRehearsalAuthorized();
  return executeLocked();
}

async function executeLocked() {
  assertRehearsalAuthorized();
  const spawn = realSpawn;
  const root = await mkdtemp(join(tmpdir(), 'pegazuz-restore-'));
  const rootStat = lstatSync(root);
  const identity = {
    root,
    name: basename(root),
    dev: rootStat.dev,
    ino: rootStat.ino,
    dataDir: join(root, 'data'),
    socketDir: join(root, 'socket'),
    dataDev: null,
    dataIno: null,
    pid: null,
    pwfile: join(root, 'initdb.pw'),
    pgpass: join(root, 'pgpass'),
    serviceFile: join(root, 'pg_service.conf'),
  };
  const secret = randomBytes(24).toString('base64url');
  const state = { started: false, identityProven: false, pid: null, stopVerified: false, cancel: null, baseline: null };
  const onSignal = (signal) => {
    state.cancel = signal;
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let handle = null;
  try {
    await chmod(root, 0o700);
    await mkdir(identity.socketDir, { mode: 0o700 });
    await chmod(identity.socketDir, 0o700);
    assertFresh(identity);
    const names = readdirSync(identity.root);
    if (names.some((name) => name === 'PG_VERSION' || name === 'postmaster.pid' || name === 'data')) {
      fail('backup ERROR: el directorio del ensayo no es exclusivo.');
    }
    await writeExclusive(identity.serviceFile, '', 0o600);
    await writeExclusive(identity.pwfile, renderInitdbPassword(secret), 0o600);
    await writeExclusive(identity.pgpass, renderPgpass(identity.socketDir, secret), 0o600);
    const dumpVersion = runTool(spawn, identity, secret, 'pg_dump', ['--version'], false);
    const restoreVersion = runTool(spawn, identity, secret, 'pg_restore', ['--version'], false);
    assertPostgres18(dumpVersion.stdout, 'pg_dump');
    assertPostgres18(restoreVersion.stdout, 'pg_restore');
    assertSurface(collectSurface(process.env));
    runTool(spawn, identity, secret, 'initdb', initdbArgs(identity), false);
    discardInitdbPassword(identity);
    rememberData(identity);
    await overwritePlain(join(identity.dataDir, 'pg_hba.conf'), HBA_TEXT, 0o600);
    await overwritePlain(join(identity.dataDir, 'postgresql.auto.conf'), serverConfig(identity.socketDir), 0o600);
    assertSurface(collectSurface(process.env));
    runTool(spawn, identity, secret, 'pg_ctl', ['--pgdata', identity.dataDir, '--log', join(root, 'server.log'), 'start'], true);
    state.started = true;
    noteCancel(state, identity, secret);
    const verdict = classifyCluster(identity, liveInspect(identity));
    if (verdict.identityProven !== true) {
      const err = new Error('backup ERROR: el clúster queda en incidente y se preserva.');
      err.incident = true;
      throw err;
    }
    state.baseline = verdict.baseline;
    state.identityProven = true;
    state.pid = verdict.baseline.pid;
    identity.pid = verdict.baseline.pid;
    await writeExclusive(join(root, 'schema.sql'), SCHEMA_SQL, 0o600);
    const synthetic = join(import.meta.dirname, 'staging-synthetic.sql');
    const integrity = join(import.meta.dirname, 'staging-backup-integrity.sql');
    for (const sql of [synthetic, integrity]) {
      const st = lstatSync(sql);
      if (st.isSymbolicLink() || !st.isFile()) fail('backup ERROR: el fixture del ensayo no es válido.');
    }
    requireOwned(identity, state, secret);
    runTool(spawn, identity, secret, 'createdb', ['--host', identity.socketDir, '--port', String(TARGET_PORT), '--username', 'postgres', 'ensayo'], true);
    requireOwned(identity, state, secret);
    runTool(spawn, identity, secret, 'psql', clientArgs(identity, 'ensayo', ['--file', join(root, 'schema.sql'), '--file', synthetic]), true);
    requireOwned(identity, state, secret);
    runTool(spawn, identity, secret, 'createdb', ['--host', identity.socketDir, '--port', String(TARGET_PORT), '--username', 'postgres', 'restaurado'], true);
    requireOwned(identity, state, secret);
    const dumpPath = join(root, 'ensayo.dump');
    runTool(spawn, identity, secret, 'pg_dump', ['--format=custom', '--no-owner', '--file', dumpPath, '--host', identity.socketDir, '--port', String(TARGET_PORT), '--username', 'postgres', '--dbname', 'ensayo'], true);
    const plain = readBounded(dumpPath, PLAINTEXT_MAX_BYTES);
    assertCustomDump(plain);
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
    const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    handle = await sealDumpFile(dumpPath, publicKey);
    const sealed = await readSealed(handle);
    rejectTampered(sealed, privateKey);
    const opened = openAuthenticatedDump(sealed, privateKey);
    const openedPath = join(root, 'abierto.dump');
    await writeExclusive(openedPath, opened, 0o600);
    requireOwned(identity, state, secret);
    runTool(spawn, identity, secret, 'pg_restore', ['--no-owner', '--exit-on-error', '--host', identity.socketDir, '--port', String(TARGET_PORT), '--username', 'postgres', '--dbname', 'restaurado', openedPath], true);
    requireOwned(identity, state, secret);
    const checked = runTool(spawn, identity, secret, 'psql', clientArgs(identity, 'restaurado', ['--no-align', '--tuples-only', '--file', integrity]), true);
    assertRestoredIntegrity(checked.stdout);
    return describeOutcome('execution', { clientInvoked: true, sealed: true, restored: true, integrity: true });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (handle) await discardSealed(handle).catch(() => {});
    discardInitdbPassword(identity);
    releaseCluster(spawn, identity, secret, state);
  }
}

function incident(message) {
  const err = new Error(message);
  err.incident = true;
  return err;
}

function sameBaseline(left, right) {
  return Boolean(
    left &&
    right &&
    left.pid === right.pid &&
    left.startEpoch === right.startEpoch &&
    left.dataDir === right.dataDir &&
    left.dataDev === right.dataDev &&
    left.dataIno === right.dataIno &&
    left.rootDev === right.rootDev &&
    left.rootIno === right.rootIno &&
    left.port === right.port &&
    left.socketDir === right.socketDir
  );
}

function noteCancel(state, identity, secret) {
  if (!state.cancel) return;
  const observed = liveInspect(identity, state.baseline?.pid);
  const decision = decideCancel(state.cancel, state.baseline, observed);
  if (decision.signal !== true) throw incident('backup ERROR: el clúster queda en incidente y se preserva.');
  stopOwned(realSpawn, identity, secret, decision);
  const done = confirmTermination(state.baseline, liveInspect(identity, state.baseline.pid), true);
  state.stopVerified = done.stopVerified === true;
  if (!state.stopVerified) throw incident('backup ERROR: el clúster queda en incidente y se preserva.');
  fail('backup ERROR: el ensayo fue cancelado.');
}

function requireOwned(identity, state, secret) {
  noteCancel(state, identity, secret);
  const verdict = classifyCluster(identity, liveInspect(identity, state.baseline?.pid));
  state.identityProven = verdict.identityProven === true && sameBaseline(state.baseline, verdict.baseline);
  if (!state.identityProven) throw incident('backup ERROR: el clúster queda en incidente y se preserva.');
}

function stopOwned(spawn, identity, secret, decision) {
  assertStopAuthorized(decision);
  runTool(spawn, identity, secret, 'pg_ctl', ['--pgdata', identity.dataDir, 'stop', '-m', 'fast'], true);
}

function removeIfConfirmed(identity) {
  try {
    removeRehearsalRoot(identity, {
      started: true,
      identityProven: true,
      processAlive: 'dead',
      stopVerified: true,
      pidFileExists: false,
      rootOwned: true,
    });
  } catch {
    /* El incidente conserva el directorio. */
  }
}

function releaseUnproven(identity, state) {
  let pidExists = false;
  try {
    const st = lstatSync(join(identity.dataDir, 'postmaster.pid'));
    if (st.isSymbolicLink()) return;
    pidExists = st.isFile();
  } catch {
    pidExists = false;
  }
  const decision = decideCleanup({
    started: state.started === true,
    identityProven: false,
    processAlive: state.started === true ? 'ambiguous' : 'dead',
    stopVerified: false,
    pidFileExists: pidExists,
    rootOwned: true,
  });
  if (decision.action !== 'remove-empty') return;
  try {
    removeRehearsalRoot(identity, {
      started: false,
      processAlive: 'dead',
      stopVerified: true,
      pidFileExists: false,
      rootOwned: true,
    });
  } catch {
    /* El incidente conserva el directorio. */
  }
}

function releaseCluster(spawn, identity, secret, state) {
  if (!state.started || !state.baseline) {
    releaseUnproven(identity, state);
    return;
  }
  const observed = liveInspect(identity, state.baseline.pid);
  const decision = authorizeStop(state.baseline, observed);
  if (decision.signal === true) {
    try {
      stopOwned(spawn, identity, secret, decision);
    } catch {
      /* La orden de parada no confirma por sí sola la terminación. */
    }
    const done = confirmTermination(state.baseline, liveInspect(identity, state.baseline.pid), true);
    state.stopVerified = done.stopVerified === true;
    if (done.action === 'remove') removeIfConfirmed(identity);
    return;
  }
  if (state.stopVerified === true) {
    const done = confirmTermination(state.baseline, observed, true);
    if (done.action === 'remove') removeIfConfirmed(identity);
  }
}

function realSpawn(command, args, env, cwd) {
  assertRehearsalAuthorized();
  const result = spawnSync(command, args, { encoding: 'utf8', env, cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: result.status, stdout: result.stdout ?? '', stderr: '' };
}

function liveBinaries() {
  return TOOLS.map((name) => {
    const path = join(PINNED_BIN, name);
    try {
      const st = lstatSync(path);
      const resolved = realpathSync(path);
      const within = resolved.startsWith(CELLAR_PREFIX) || resolved.startsWith(`${PINNED_BIN}/`);
      return {
        tool: name,
        path,
        escaped: !within,
        regular: st.isFile() && !st.isSymbolicLink(),
        symlinkWithinPin: st.isSymbolicLink() && within,
      };
    } catch {
      return { tool: name, path, escaped: true, regular: false, symlinkWithinPin: false };
    }
  });
}

function liveListeners() {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${TARGET_PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  if (result.error || (result.status !== 0 && result.status !== 1)) return null;
  return result.stdout
    .split('\n')
    .filter((line) => line.includes(`:${TARGET_PORT}`) && !line.startsWith('COMMAND'));
}

export function collectSurface(env = process.env) {
  const listeners = liveListeners();
  let defaultSocketExists = false;
  try {
    lstatSync(`/tmp/.s.PGSQL.${TARGET_PORT}`);
    defaultSocketExists = true;
  } catch (err) {
    if (err?.code !== 'ENOENT') return { ambiguous: true, env, listeners: null, binaries: [], defaultSocketExists: true };
  }
  if (listeners == null) return { ambiguous: true, env, listeners: null, binaries: liveBinaries(), defaultSocketExists };
  return { ambiguous: false, env, listeners, binaries: liveBinaries(), defaultSocketExists };
}

export function preflight(env = process.env) {
  assertSurface(collectSurface(env));
  return describeOutcome('preflight', { ok: true });
}

function main() {
  const mode = process.argv[2] ?? 'preflight';
  if (mode !== 'preflight') {
    console.error('backup ERROR: el ensayo integral no está autorizado.');
    process.exit(1);
  }
  try {
    preflight(process.env);
    console.log('preflight-only. No se abre ninguna conexión.');
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'backup ERROR');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
