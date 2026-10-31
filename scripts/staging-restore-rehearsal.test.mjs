import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { INTEGRITY_LINES, assertRestoredIntegrity } from './assert-staging-restore.mjs';
import * as rehearsal from './staging-restore-rehearsal.mjs';
import {
  assertCandidateRoot,
  assertInheritedEnv,
  assertRehearsalAuthorized,
  assertStopAuthorized,
  assessSize,
  authorizeStop,
  childProcessSpec,
  classifyCluster,
  commandOwnsDataDir,
  confirmTermination,
  DANGEROUS_ENV,
  decideCancel,
  decideCleanup,
  describeOutcome,
  epochFromDarwinLstart,
  formatDarwinLstart,
  discardInitdbPassword,
  HBA_TEXT,
  initdbArgs,
  interpretLiveness,
  parsePostmasterPid,
  parsePsIdentity,
  PINNED_BIN,
  placeCredentials,
  PLAINTEXT_MAX_BYTES,
  preflight,
  psInvocation,
  readBounded,
  REHEARSAL_EXECUTION,
  removeRehearsalRoot,
  renderPgpass,
  runRehearsal,
  SEALED_MAX_BYTES,
  serverConfig,
  stampDirectory,
  TARGET_PORT,
} from './staging-restore-rehearsal.mjs';

const SECRET = 'super-secret-railway';

function fileMeta(size, ino = 1) {
  return { size, isFile: true, isSymbolicLink: false, dev: 1, ino };
}

test('la CLI rechaza execute y el worker sigue en plan-only', () => {
  assert.equal(REHEARSAL_EXECUTION, 'preflight-only');
  assert.throws(() => assertRehearsalAuthorized(), /no está autorizado/);
  const source = readFileSync(new URL('./staging-restore-rehearsal.mjs', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('./staging-private-backup.mjs', import.meta.url), 'utf8');
  assert.match(source, /export const REHEARSAL_EXECUTION = 'preflight-only'/);
  assert.equal(source.includes('simulated'), false);
  assert.equal(source.includes('onSpawn'), false);
  assert.equal(source.includes('process.kill'), false);
  assert.equal(source.includes('ownProcessAlive'), false);
  assert.equal(rehearsal.realSpawn, undefined);
  assert.equal(rehearsal.executeLocked, undefined);
  assert.match(worker, /export const BUILD_EXECUTION = 'plan-only'/);
  assert.equal(worker.includes('staging-restore-rehearsal'), false);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(JSON.stringify(pkg.scripts).includes('staging-restore-rehearsal'), false);
  const workflows = join(import.meta.dirname, '../.github/workflows');
  for (const name of readdirSync(workflows)) {
    assert.equal(readFileSync(join(workflows, name), 'utf8').includes('staging-restore-rehearsal'), false);
  }
  const cwd = join(import.meta.dirname, '..');
  const base = { PATH: process.env.PATH ?? '', LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' };
  const closed = spawnSync(process.execPath, ['scripts/staging-restore-rehearsal.mjs', 'execute'], {
    cwd,
    encoding: 'utf8',
    env: base,
  });
  assert.equal(closed.status, 1);
  assert.match(closed.stderr, /no está autorizado/);
  const started = spawnSync(process.execPath, ['scripts/staging-private-backup.mjs', 'startup'], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, PEGAZUZ_INERT_HOLD_MS: '0' },
  });
  assert.equal(started.status, 1);
  assert.match(started.stdout, /plan-only\. No se abre ninguna conexión\./);
  const ready = preflight(base);
  assert.equal(ready.phase, 'preflight');
  assert.equal(ready.connects, false);
  assert.equal(ready.success, true);
  assert.equal(ready.port, TARGET_PORT);
});

test('un ejecutor inyectado no alcanza los binarios reales', async () => {
  let hits = 0;
  const evil = () => {
    hits += 1;
    throw new Error('el ejecutor inyectado no debe correr');
  };
  await assert.rejects(() => runRehearsal({ simulated: true, onSpawn: evil, spawn: evil }), /no está autorizado/);
  await assert.rejects(() => runRehearsal(evil), /no está autorizado/);
  assert.equal(hits, 0);
  const forbidden = ['initdb', 'pg_ctl', 'createdb', 'psql', 'pg_dump', 'pg_restore', 'postgres'];
  for (const value of Object.values(rehearsal)) {
    if (typeof value !== 'function') continue;
    try {
      await value({ simulated: true, onSpawn: evil, spawn: evil });
    } catch {
      /* Las funciones puras rechazan el objeto o no lo ejecutan. */
    }
  }
  assert.equal(hits, 0);
  assert.equal(forbidden.every((name) => rehearsal[name] === undefined), true);
});

test('initdb y pgpass no comparten formato y el secreto no sale en el error', async () => {
  const secret = randomBytes(24).toString('base64url');
  const socket = '/var/folders/ensayo/socket';
  const initdb = rehearsal.renderInitdbPassword(secret);
  const pass = renderPgpass(socket, secret);
  assert.equal(initdb.includes(':'), false);
  assert.equal(pass.split(':').length, 5);
  assert.equal(pass.split(':')[0], socket);
  assert.equal(pass.split(':')[1], String(TARGET_PORT));
  assert.equal(pass.split(':')[2], '*');
  assert.equal(pass.split(':')[3], 'postgres');
  assert.equal(initdb.trim() === pass.split(':')[4].trim(), true);
  assert.equal(initdb.trim() === pass.trim(), false);
  assert.throws(
    () => renderPgpass('/tmp/has:colon', secret),
    (err) => {
      assert.equal(err.message.includes(secret), false);
      assert.equal(err.message.includes(SECRET), false);
      return true;
    },
  );
  const root = mkdtempSync(join(tmpdir(), 'pegazuz-cred-'));
  try {
    const files = await placeCredentials(root, socket, secret);
    assert.equal(lstatSync(files.pwfile).mode & 0o777, 0o600);
    assert.equal(lstatSync(files.pgpass).mode & 0o777, 0o600);
    assert.equal(readFileSync(files.pwfile, 'utf8').includes(':'), false);
    discardInitdbPassword({ root, pwfile: files.pwfile });
    assert.equal(existsSync(files.pwfile), false);
    assert.equal(existsSync(files.pgpass), true);
    const args = initdbArgs({ pwfile: files.pwfile, dataDir: join(root, 'data') });
    assert.equal(args.includes('--auth-local=scram-sha-256'), true);
    assert.equal(args.includes('--auth-host=reject'), true);
    assert.equal(args.includes(files.pwfile), true);
    assert.equal(args.join('\n').includes(secret), false);
    assert.equal(HBA_TEXT, 'local all all scram-sha-256\n');
    assert.match(serverConfig(socket), /listen_addresses = ''/);
    const spec = childProcessSpec(
      { root, dataDir: join(root, 'data'), pgpass: files.pgpass, serviceFile: join(root, 'svc') },
      true,
    );
    assert.equal(spec.cwd, root);
    assert.equal(spec.shell, false);
    assert.equal(Object.values(spec.env).join('\n').includes(secret), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('una identidad incompatible no recibe señal y un proceso vivo no se borra', () => {
  assert.equal(commandOwnsDataDir('postgres -D /tmp/data', '/tmp/data'), 'owned');
  assert.equal(commandOwnsDataDir('postgres -D /tmp/data-extra', '/tmp/data'), 'foreign');
  assert.equal(commandOwnsDataDir(`${'x'.repeat(4096)}`, '/tmp/data'), 'ambiguous');
  assert.deepEqual(psInvocation(424242), ['/bin/ps', '-ww', '-p', '424242', '-o', 'pid=,lstart=,command=']);
  const foreign = classifyCluster(
    { dataDir: '/var/folders/ensayo/data', socketDir: '/var/folders/ensayo/socket', dataDev: 1, dataIno: 2 },
    {
      pidText: '531\n/Library/PostgreSQL/18/data\n1\n5432\n/tmp\n127.0.0.1\n1\n',
      pid: 531,
      command: '/Library/PostgreSQL/18/bin/postgres -D /Library/PostgreSQL/18/data',
      dataDev: 9,
      dataIno: 9,
      tcpListeners: [],
      socketIsSymlink: false,
      socketIsSocket: true,
      defaultSocketExists: true,
      truncated: false,
    },
  );
  assert.equal(foreign.identityProven, false);
  assert.equal(foreign.signal, false);
  assert.equal(foreign.action, 'preserve');
  const afterStart = decideCleanup({
    started: true,
    identityProven: false,
    processAlive: 'ambiguous',
    stopVerified: false,
    pidFileExists: true,
    rootOwned: true,
  });
  assert.equal(afterStart.action, 'preserve');
  assert.equal(afterStart.incident, true);
  assert.equal(afterStart.signal, false);
  const stopFailed = decideCleanup({
    started: true,
    identityProven: true,
    processAlive: 'alive',
    stopVerified: false,
    pidFileExists: true,
    rootOwned: true,
  });
  assert.equal(stopFailed.action, 'preserve');
  assert.equal(stopFailed.signal, false);
  assert.equal(interpretLiveness('ESRCH'), 'dead');
  assert.equal(interpretLiveness(null), 'alive');
  assert.equal(interpretLiveness('EPERM'), 'ambiguous');
  const sentinel = mkdtempSync(join(tmpdir(), 'pegazuz-sentinel-'));
  const own = mkdtempSync(join(tmpdir(), 'pegazuz-restore-'));
  const linkTarget = mkdtempSync(join(tmpdir(), 'pegazuz-target-'));
  writeFileSync(join(linkTarget, 'conservar.txt'), 'sigue');
  const link = join(tmpdir(), 'pegazuz-restore-link');
  symlinkSync(linkTarget, link);
  const previous = mkdtempSync(join(tmpdir(), 'pegazuz-prev-'));
  writeFileSync(join(previous, 'PG_VERSION'), '18\n');
  try {
    const st = lstatSync(own);
    const identity = { root: own, name: basename(own), dev: st.dev, ino: st.ino, dataDir: join(own, 'data') };
    assert.throws(() => removeRehearsalRoot(identity, stopFailed), /incidente/);
    assert.equal(existsSync(own), true);
    assert.equal(existsSync(sentinel), true);
    assert.throws(() => removeRehearsalRoot({ root: link, name: basename(link), dev: st.dev, ino: st.ino, dataDir: linkTarget }, {
      started: false,
      processAlive: 'dead',
      pidFileExists: false,
      rootOwned: true,
    }), /incidente/);
    assert.equal(readFileSync(join(linkTarget, 'conservar.txt'), 'utf8'), 'sigue');
    assert.throws(() => assertCandidateRoot(previous), /no es exclusivo/);
    assert.equal(existsSync(join(previous, 'PG_VERSION')), true);
  } finally {
    rmSync(sentinel, { recursive: true, force: true });
    rmSync(own, { recursive: true, force: true });
    rmSync(linkTarget, { recursive: true, force: true });
    rmSync(link, { force: true });
    rmSync(previous, { recursive: true, force: true });
  }
});

test('SIGINT y SIGTERM piden parada solo con identidad, y SIGKILL no limpia', () => {
  const aliveOnly = { identityProven: true, processAlive: 'alive' };
  const stop = decideCancel('SIGINT', aliveOnly, aliveOnly);
  assert.equal(stop.action, 'preserve');
  assert.equal(stop.signal, false);
  const term = decideCancel('SIGTERM', null, { inspection: 'failed', processPresent: 'ambiguous' });
  assert.equal(term.action, 'preserve');
  assert.equal(term.signal, false);
  const killed = decideCancel('SIGKILL', aliveOnly, aliveOnly);
  assert.equal(killed.action, 'preserve');
  assert.equal(killed.signal, false);
  assert.match(killed.reason, /SIGKILL no permite limpieza/);
  const stillAlive = decideCleanup({
    started: true,
    identityProven: true,
    processAlive: 'alive',
    stopVerified: false,
    pidFileExists: true,
    rootOwned: true,
  });
  assert.equal(stillAlive.action, 'preserve');
});

test('el tope se decide con el tamaño declarado y la integridad exige nueve líneas', () => {
  const over = fileMeta(PLAINTEXT_MAX_BYTES + 1);
  assert.equal(assessSize(over, over, PLAINTEXT_MAX_BYTES), 'reject');
  const moved = fileMeta(64);
  assert.equal(assessSize(moved, fileMeta(65), PLAINTEXT_MAX_BYTES), 'ambiguous');
  const bounded = fileMeta(64);
  assert.equal(assessSize(bounded, bounded, PLAINTEXT_MAX_BYTES), 'ok');
  const sealedOver = fileMeta(SEALED_MAX_BYTES + 1, 2);
  assert.equal(assessSize(sealedOver, sealedOver, SEALED_MAX_BYTES), 'reject');
  const root = mkdtempSync(join(tmpdir(), 'pegazuz-read-'));
  const dump = join(root, 'ensayo.dump');
  const payload = Buffer.alloc(64);
  payload.write('PGDMP');
  writeFileSync(dump, payload);
  const target = join(root, 'otro');
  writeFileSync(target, payload);
  const link = join(root, 'enlace');
  symlinkSync(target, link);
  try {
    assert.equal(readBounded(dump, PLAINTEXT_MAX_BYTES).length, 64);
    assert.throws(() => readBounded(link, PLAINTEXT_MAX_BYTES), /no es válido/);
    assert.equal(existsSync(target), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const exact = INTEGRITY_LINES.join('\n');
  assert.doesNotThrow(() => assertRestoredIntegrity(exact));
  assert.throws(() => assertRestoredIntegrity(`${exact}\nextra|1`), /sintéticos/);
  assert.throws(() => assertRestoredIntegrity(`${exact}\n${INTEGRITY_LINES[0]}`), /sintéticos/);
  assert.throws(() => assertRestoredIntegrity(INTEGRITY_LINES.slice(1).join('\n')), /sintéticos/);
  assert.equal(INTEGRITY_LINES.length, 9);
  const simulation = describeOutcome('simulation', { clientInvoked: true, integrity: true, restored: true, sealed: true });
  assert.equal(simulation.connects, false);
  assert.equal(simulation.success, false);
  const pending = describeOutcome('execution', { clientInvoked: false });
  assert.equal(pending.connects, false);
  assert.equal(pending.success, false);
  const connected = describeOutcome('execution', { clientInvoked: true, sealed: true, restored: true, integrity: false });
  assert.equal(connected.connects, true);
  assert.equal(connected.success, false);
  const done = describeOutcome('execution', { clientInvoked: true, sealed: true, restored: true, integrity: true });
  assert.equal(done.connects, true);
  assert.equal(done.success, true);
});

test('las variables heredadas siguen cerrando el preflight sin revelar el valor', () => {
  for (const name of DANGEROUS_ENV) {
    assert.throws(
      () => assertInheritedEnv({ [name]: SECRET }),
      (err) => {
        assert.match(err.message, new RegExp(name));
        assert.equal(err.message.includes(SECRET), false);
        return true;
      },
    );
  }
  assert.throws(() => assertInheritedEnv({ PG18_BIN: '/tmp/postgres/bin' }), /PG18_BIN/);
  const redirected = spawnSync(process.execPath, ['scripts/staging-restore-rehearsal.mjs', 'preflight'], {
    cwd: join(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      PGHOST: SECRET,
      DATABASE_URL: `postgres://user:${SECRET}@postgres.railway.internal:5432/app`,
    },
  });
  assert.equal(redirected.status, 1);
  assert.match(redirected.stderr, /PGHOST/);
  assert.equal(redirected.stderr.includes(SECRET), false);
  assert.equal(redirected.stderr.includes('railway'), false);
});

const EPOCH = Math.floor(new Date(2026, 9, 31, 14, 38, 23).getTime() / 1000);
const DATA = '/var/folders/ensayo/data';
const SOCKET = '/var/folders/ensayo/socket';
const PID = 424242;

function ownedBaseline() {
  return {
    pid: PID,
    startEpoch: EPOCH,
    dataDir: DATA,
    dataDev: 7,
    dataIno: 8,
    rootDev: 7,
    rootIno: 3,
    port: TARGET_PORT,
    socketDir: SOCKET,
    listenAddress: '',
  };
}

function ownedObservation(overrides = {}) {
  return {
    inspection: 'ok',
    truncated: false,
    processPresent: 'alive',
    pid: PID,
    startEpoch: EPOCH,
    processStartEpoch: EPOCH,
    dataDir: DATA,
    dataDev: 7,
    dataIno: 8,
    rootDev: 7,
    rootIno: 3,
    dataIsSymlink: false,
    rootIsSymlink: false,
    port: TARGET_PORT,
    socketDir: SOCKET,
    listenAddress: '',
    command: `/opt/homebrew/opt/postgresql@18/bin/postgres -D ${DATA}`,
    tcpListenersEmpty: true,
    defaultSocketExists: false,
    socketIsSocket: true,
    socketIsSymlink: false,
    pidFilePresent: true,
    ...overrides,
  };
}

function signalsFor(observed) {
  const decision = authorizeStop(ownedBaseline(), observed);
  let signals = 0;
  try {
    assertStopAuthorized(decision);
    signals += 1;
  } catch {
    signals += 0;
  }
  return { decision, signals };
}

test('la parada rechaza época distinta, pid reutilizado, symlink, inodo, -D ajeno y ps truncado', () => {
  const shown = formatDarwinLstart(EPOCH);
  assert.equal(epochFromDarwinLstart(shown), EPOCH);
  const parsed = parsePsIdentity(`${PID} ${shown} postgres -D ${DATA}\n`, PID);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.startEpoch, EPOCH);
  assert.equal(parsePsIdentity(`${'x'.repeat(4096)}`, PID).ok, false);
  assert.equal(parsePsIdentity(`${PID} ${shown} postgres -D ${DATA}...\n`, PID).ok, false);
  assert.throws(() => parsePostmasterPid(`${PID}\n${DATA}\n1\n${TARGET_PORT}\n${SOCKET}\n\n`), /ambigua/);
  const epoch = signalsFor(ownedObservation({ processStartEpoch: EPOCH + 5, startEpoch: EPOCH + 5 }));
  assert.equal(epoch.decision.signal, false);
  assert.equal(epoch.signals, 0);
  const reused = signalsFor(ownedObservation({
    processStartEpoch: EPOCH + 90,
    command: '/usr/sbin/nginx',
  }));
  assert.equal(reused.decision.signal, false);
  assert.equal(reused.signals, 0);
  const linked = signalsFor(ownedObservation({ dataIsSymlink: true }));
  assert.equal(linked.decision.signal, false);
  const inode = signalsFor(ownedObservation({ dataDev: 9, dataIno: 9 }));
  assert.equal(inode.decision.signal, false);
  const otherDir = signalsFor(ownedObservation({
    command: '/Library/PostgreSQL/18/bin/postgres -D /Library/PostgreSQL/18/data',
    dataDir: '/Library/PostgreSQL/18/data',
  }));
  assert.equal(otherDir.decision.signal, false);
  assert.equal(otherDir.signals, 0);
  const truncated = signalsFor(ownedObservation({ truncated: true, inspection: 'failed' }));
  assert.equal(truncated.decision.signal, false);
  assert.throws(
    () => assertStopAuthorized({ signal: true, action: 'stop', processAlive: 'alive' }),
    /vigente/,
  );
  const root = mkdtempSync(join(tmpdir(), 'pegazuz-link-'));
  const target = mkdtempSync(join(tmpdir(), 'pegazuz-link-target-'));
  const link = join(root, 'data');
  symlinkSync(target, link);
  try {
    assert.equal(stampDirectory(link).symlink, true);
    assert.equal(stampDirectory(target).symlink, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('una inspección fallida o un proceso distinto no autorizan la parada', () => {
  const disappeared = ownedObservation({ processPresent: 'dead', command: undefined });
  const gone = signalsFor(disappeared);
  assert.equal(gone.decision.signal, false);
  assert.equal(gone.signals, 0);
  assert.equal(confirmTermination(ownedBaseline(), disappeared, false).action, 'preserve');
  const appeared = signalsFor(ownedObservation({ pid: 531, startEpoch: EPOCH + 10, processStartEpoch: EPOCH + 10 }));
  assert.equal(appeared.decision.signal, false);
  assert.equal(appeared.signals, 0);
  const failed = signalsFor({ inspection: 'failed', processPresent: 'ambiguous' });
  assert.equal(failed.decision.signal, false);
  assert.equal(failed.decision.reason, 'inspección ambigua');
  const current = signalsFor(ownedObservation());
  assert.equal(current.decision.signal, true);
  assert.equal(current.signals, 1);
  const deadAfter = ownedObservation({ processPresent: 'dead', pidFilePresent: false, command: undefined });
  assert.equal(confirmTermination(ownedBaseline(), deadAfter, true).action, 'remove');
  assert.equal(confirmTermination(ownedBaseline(), deadAfter, true).stopVerified, true);
  const stillThere = confirmTermination(ownedBaseline(), ownedObservation(), true);
  assert.equal(stillThere.action, 'preserve');
  assert.equal(stillThere.stopVerified, false);
  const kept = mkdtempSync(join(tmpdir(), 'pegazuz-restore-'));
  try {
    const st = lstatSync(kept);
    assert.throws(() => removeRehearsalRoot(
      { root: kept, name: basename(kept), dev: st.dev, ino: st.ino, dataDir: join(kept, 'data') },
      stillThere,
    ), /incidente/);
    assert.equal(existsSync(kept), true);
  } finally {
    rmSync(kept, { recursive: true, force: true });
  }
});

test('SIGINT y SIGTERM ambiguos no señalan y los clústeres ajenos quedan fuera', () => {
  const foreignDirs = ['/Library/PostgreSQL/18/data', '/opt/homebrew/var/postgresql@18'];
  for (const dataDir of foreignDirs) {
    const decision = authorizeStop(ownedBaseline(), ownedObservation({
      dataDir,
      command: `postgres -D ${dataDir}`,
      dataDev: 4,
      dataIno: 5,
    }));
    assert.equal(decision.signal, false);
    assert.equal(decideCancel('SIGINT', ownedBaseline(), ownedObservation({ dataDir, command: `postgres -D ${dataDir}` })).signal, false);
    assert.equal(decideCancel('SIGTERM', ownedBaseline(), ownedObservation({ inspection: 'failed' })).signal, false);
  }
  const ready = ownedObservation();
  assert.equal(decideCancel('SIGINT', ownedBaseline(), ready).signal, true);
  assert.equal(decideCancel('SIGTERM', ownedBaseline(), ready).signal, true);
  assert.equal(decideCancel('SIGKILL', ownedBaseline(), ready).signal, false);
  const pidText = `${PID}\n${DATA}\n${EPOCH}\n${TARGET_PORT}\n${SOCKET}\n\n`;
  const proven = classifyCluster(
    { dataDir: DATA, socketDir: SOCKET, dataDev: 7, dataIno: 8, dev: 7, ino: 3 },
    {
      ...ready,
      pidText,
      tcpListeners: [],
      rootDev: 7,
      rootIno: 3,
    },
  );
  assert.equal(proven.identityProven, true);
  assert.equal(proven.signal, false);
  assert.equal(proven.baseline.startEpoch, EPOCH);
});
