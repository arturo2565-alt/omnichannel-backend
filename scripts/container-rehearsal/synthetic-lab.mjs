/**
 * Laboratorio sintético único. No abre la cerradura del entrypoint ni la del worker.
 * No lee variables para autorizarse. No acepta un ejecutor, una URL ni credenciales.
 * El entrypoint de la imagen sigue siendo entrypoint.mjs y sale sin recorrer este archivo.
 * La imagen ya construida no contiene esta instrumentación.
 * Un hijo puede dejar un postmaster fuera de su grupo: el cierre lo informa y no hace limpieza global.
 */
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { accessSync, chmodSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assertCustomDump, assertPostgres18, assertRestoredIntegrity, assertServerVersionNum } from '../assert-staging-restore.mjs';
import { openDump } from '../staging-backup-envelope.mjs';
import { consumeSealed, discardSealed, sealBlocks } from '../staging-backup-seal.mjs';
import {
  CONTAINER_CPUS,
  CONTAINER_MEMORY,
  CONTAINER_PIDS,
  DOCKER_CONTEXT,
  PGDATA,
  PLAINTEXT_MAX_BYTES,
  PLATFORM,
  reportPhases,
} from './contract.mjs';

export const SYNTHETIC_LAB_EXECUTION = 'synthetic-only';
export const PENDING_LAB_TAG = 'pegazuz-rehearsal:devops-005n21';
export const LAB_PATH = '/opt/pegazuz/scripts/container-rehearsal/synthetic-lab.mjs';
export const SYNTHETIC_PHASES = Object.freeze([
  'storage',
  'pgdata',
  'initdb',
  'socket',
  'credentials',
  'start',
  'version',
  'createdb',
  'load',
  'dump',
  'seal',
  'tamper',
  'open',
  'header',
  'restore',
  'integrity',
  'stop',
]);
export const LIMIT_MS = Object.freeze({
  initdb: 30_000,
  start: 30_000,
  ready: 10_000,
  stop: 20_000,
  createdb: 15_000,
  psql: 20_000,
  pg_dump_version: 10_000,
  pg_dump: 30_000,
  pg_restore: 30_000,
  seal: 20_000,
  total: 120_000,
  grace: 1_000,
});

const PHASE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const CODE_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const EVENTS = new Set(['PHASE_START', 'PHASE_OK', 'PHASE_FAIL', 'PHASE_TIMEOUT', 'INCIDENT', 'REHEARSAL_OK']);
let activePid = null;

const BIN = '/usr/lib/postgresql/18/bin';
const DATA_PARENT = '/var/lib/postgresql';
const SOCKET_DIR = '/run/postgresql';
const SCRATCH = '/tmp';
const PWFILE = `${DATA_PARENT}/initdb.pw`;
const FIXTURES = Object.freeze([
  new URL('./schema.sql', import.meta.url),
  new URL('../staging-synthetic.sql', import.meta.url),
]);
const INTEGRITY_SQL = new URL('../staging-backup-integrity.sql', import.meta.url);
const DENIED_ENV = /^(DATABASE_URL|PGPASSWORD|RAILWAY|AWS_|LOCAL_DATABASE_URL)/;

function fail(message) {
  throw new Error(message);
}

export function labMayStart(facts) {
  if (SYNTHETIC_LAB_EXECUTION !== 'synthetic-only') return false;
  if (facts?.platform !== 'linux' || facts?.uid !== 999) return false;
  const argv = facts?.argv;
  if (!Array.isArray(argv) || argv.length !== 2) return false;
  if (typeof argv[0] !== 'string' || !argv[0].endsWith('/node')) return false;
  if (argv[1] !== LAB_PATH) return false;
  const env = facts.env ?? {};
  if (Object.keys(env).some((key) => DENIED_ENV.test(key))) return false;
  return true;
}

function currentFacts() {
  return {
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    argv: process.argv,
    env: process.env,
  };
}

export function syntheticRunPlan(containerName = 'pegazuz-syn-pending') {
  if (!/^pegazuz-syn-[a-z0-9-]{1,40}$/.test(containerName)) fail('backup ERROR: el contenedor del laboratorio no es válido.');
  return {
    argv: [
      'docker',
      '--context',
      DOCKER_CONTEXT,
      'create',
      '--name',
      containerName,
      '--platform',
      PLATFORM,
      '--user',
      'postgres',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--memory',
      CONTAINER_MEMORY,
      '--memory-swap',
      CONTAINER_MEMORY,
      '--cpus',
      CONTAINER_CPUS,
      '--pids-limit',
      String(CONTAINER_PIDS),
      '--tmpfs',
      '/var/lib/postgresql:rw,nosuid,nodev,noexec,size=256m,uid=999,gid=999,mode=0700',
      '--tmpfs',
      '/run/postgresql:rw,nosuid,nodev,noexec,size=16m,uid=999,gid=999,mode=0700',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,noexec,size=64m',
      '--entrypoint',
      '/usr/local/bin/node',
      PENDING_LAB_TAG,
      LAB_PATH,
    ],
    executable: false,
    blocked: true,
    imageBuilt: false,
    reason: 'la imagen construida no contiene esta instrumentación.',
  };
}

export function syntheticCleanupPlan(containerId) {
  if (!/^[a-f0-9]{64}$/.test(String(containerId ?? ''))) {
    return { action: 'preserve', commands: [], reason: 'identidad ambigua' };
  }
  return {
    action: 'remove',
    commands: [['docker', '--context', DOCKER_CONTEXT, 'rm', '-f', containerId]],
    reason: 'limpieza del contenedor propio',
  };
}

export function postmasterPid(text) {
  const line = String(text ?? '').split('\n')[0] ?? '';
  if (!/^[0-9]+$/.test(line)) return null;
  const pid = Number(line);
  if (!Number.isInteger(pid) || pid <= 1) return null;
  return pid;
}

export function signalGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export function phaseLine(event, phase, fields = {}) {
  if (!EVENTS.has(event)) fail('backup ERROR');
  if (event === 'INCIDENT') {
    if (!CODE_NAME.test(String(fields.code ?? ''))) fail('backup ERROR');
    return `INCIDENT code=${fields.code}\n`;
  }
  if (!Number.isInteger(fields.ms) || fields.ms < 0 || fields.ms > 3_600_000) fail('backup ERROR');
  if (event === 'REHEARSAL_OK') {
    if (!Number.isInteger(fields.sealedBytes) || fields.sealedBytes < 0) fail('backup ERROR');
    if (!Number.isInteger(fields.plainBytes) || fields.plainBytes < 0) fail('backup ERROR');
    return `REHEARSAL_OK ms=${fields.ms} plainBytes=${fields.plainBytes} sealedBytes=${fields.sealedBytes}\n`;
  }
  if (!PHASE_NAME.test(String(phase ?? ''))) fail('backup ERROR');
  const parts = [event, `phase=${phase}`, `ms=${fields.ms}`];
  if (fields.code != null) {
    if (!CODE_NAME.test(String(fields.code))) fail('backup ERROR');
    parts.push(`code=${fields.code}`);
  }
  return `${parts.join(' ')}\n`;
}

export function emitPhase(event, phase, fields = {}, fd = 1) {
  const line = phaseLine(event, phase, fields);
  writeSync(fd, line);
  return line;
}

export function classifyChild(result) {
  if (result?.unkillable) return { event: 'PHASE_TIMEOUT', code: 'child_unkillable', incident: 'child_unkillable' };
  if (result?.timedOut) return { event: 'PHASE_TIMEOUT', code: 'child_timeout', incident: 'direct_child_only' };
  if (!result?.ok) return { event: 'PHASE_FAIL', code: 'child_exit' };
  return { event: 'PHASE_OK' };
}

const CTL_LOG = /^\/tmp\/pg_ctl-[a-f0-9]{16}\.log$/;

export function pgCtlLogName(token) {
  if (!/^[a-f0-9]{16}$/.test(String(token ?? ''))) fail('backup ERROR');
  return `/tmp/pg_ctl-${token}.log`;
}

export function createCtlLog(token) {
  const path = pgCtlLogName(token);
  try {
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  } catch {
    fail('backup ERROR');
  }
  return path;
}

export function releaseCtlLog(path) {
  if (!CTL_LOG.test(String(path ?? ''))) return false;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    unlinkSync(path);
    return true;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

export function pgCtlStartArgs(logFile) {
  if (!CTL_LOG.test(String(logFile ?? ''))) fail('backup ERROR');
  return ['--pgdata', PGDATA, '-l', logFile, '-t', '15', '-w', 'start'];
}

export function readinessArgs() {
  return ['--host', SOCKET_DIR, '--username', 'postgres', '--dbname', 'postgres', '--no-align', '--tuples-only', '-c', 'SELECT 1'];
}

export function acceptStart({ pgCtl, probe } = {}) {
  if (pgCtl?.unkillable || probe?.unkillable) return { ok: false, code: 'child_unkillable' };
  if (pgCtl?.timedOut || probe?.timedOut) return { ok: false, code: 'child_timeout' };
  if (pgCtl?.status !== 0) return { ok: false, code: 'child_exit' };
  if (probe?.status !== 0 || String(probe?.stdout ?? '').trim() !== '1') return { ok: false, code: 'not_ready' };
  return { ok: true };
}

export function rehearsalTrace(failAt) {
  const lines = [];
  for (const phase of SYNTHETIC_PHASES) {
    lines.push(phaseLine('PHASE_START', phase, { ms: 0 }));
    if (phase === failAt) {
      lines.push(phaseLine('PHASE_FAIL', phase, { ms: 5, code: 'child_exit' }));
      return lines;
    }
    lines.push(phaseLine('PHASE_OK', phase, { ms: 5 }));
  }
  lines.push(phaseLine('REHEARSAL_OK', '', { ms: 10, plainBytes: 4, sealedBytes: 8 }));
  return lines;
}

export function runChild(command, args, options) {
  const timeoutMs = options.timeoutMs;
  const graceMs = options.graceMs ?? LIMIT_MS.grace;
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activePid = child.pid ?? null;
    let stdout = '';
    let timedOut = false;
    let done = false;
    const timers = [];
    const later = (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timers.push(timer);
    };
    const finish = (status, signal, unkillable = false) => {
      if (done) return;
      done = true;
      for (const timer of timers) clearTimeout(timer);
      if (activePid === child.pid) activePid = null;
      resolve({
        ok: status === 0 && !timedOut && !unkillable,
        timedOut,
        unkillable,
        status,
        signal,
        ms: Date.now() - started,
        stdout: timedOut || unkillable ? '' : stdout,
      });
    };
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 65536) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', () => {});
    const releasePipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const finishAndRelease = (status, signal, unkillable = false) => {
      finish(status, signal, unkillable);
      releasePipes();
    };
    child.on('error', () => finishAndRelease(null, null));
    child.on('exit', (status, signal) => {
      const drain = () => finishAndRelease(status, signal);
      if (child.stdout && !child.stdout.readableEnded) {
        child.stdout.once('end', drain);
        later(drain, 50);
        return;
      }
      drain();
    });
    later(() => {
      timedOut = true;
      if (child.pid) signalGroup(child.pid, 'SIGTERM');
      later(() => {
        if (!done && child.pid) signalGroup(child.pid, 'SIGKILL');
      }, graceMs);
      later(() => finishAndRelease(null, 'SIGKILL', true), graceMs + 1000);
    }, timeoutMs);
  });
}

async function tool(name, args, env, cwd, timeoutMs) {
  const result = await runChild(`${BIN}/${name}`, args, {
    cwd,
    env,
    timeoutMs,
    graceMs: LIMIT_MS.grace,
  });
  if (!result.ok) {
    const error = new Error('backup ERROR');
    error.child = classifyChild(result);
    error.code = error.child.code;
    throw error;
  }
  return result.stdout ?? '';
}

async function stopServer(env, timeoutMs) {
  const stopped = await runChild(`${BIN}/pg_ctl`, ['--pgdata', PGDATA, '-t', '10', 'stop', '-m', 'fast'], {
    cwd: DATA_PARENT,
    env,
    timeoutMs,
    graceMs: LIMIT_MS.grace,
  });
  if (stopped.ok) return stopped;
  let pid = null;
  try {
    pid = postmasterPid(readFileSync(`${PGDATA}/postmaster.pid`, 'utf8'));
  } catch {
    pid = null;
  }
  if (pid) {
    signalGroup(pid, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 200));
    signalGroup(pid, 'SIGKILL');
  }
  return stopped;
}

function assertRejected(blob, key, successMessage) {
  try {
    openDump(blob, key);
    fail(successMessage);
  } catch (error) {
    if (error instanceof Error && error.message === successMessage) throw error;
  }
}

async function readSealed(handle) {
  const parts = [];
  await consumeSealed(handle, (chunk) => parts.push(Buffer.from(chunk)));
  return Buffer.concat(parts);
}

function assertWritable(dir) {
  try {
    accessSync(dir, fsConstants.W_OK);
  } catch {
    throw coded('not_writable');
  }
}

function coded(code) {
  const error = new Error('backup ERROR');
  error.code = code;
  return error;
}

export async function runSynthetic() {
  if (!labMayStart(currentFacts())) fail('backup ERROR: el laboratorio sintético no está en el contenedor autorizado.');
  process.env.TMPDIR = SCRATCH;
  process.env.HOME = DATA_PARENT;
  const started = Date.now();
  const deadline = started + LIMIT_MS.total;
  const phases = {};
  let serverMaybe = false;
  let plainBytes = 0;
  let sealedBytes = 0;
  const env = {
    PATH: BIN,
    LC_ALL: 'C',
    LANG: 'C',
    PGDATA,
    HOME: DATA_PARENT,
    TMPDIR: SCRATCH,
  };
  const pgpass = `${PGDATA}/pgpass`;
  const onSignal = () => {
    emitPhase('PHASE_FAIL', 'signal', { ms: Date.now() - started, code: 'signal_stop' });
    if (activePid) signalGroup(activePid, 'SIGKILL');
    emitPhase('INCIDENT', '', { code: 'direct_child_only' });
    process.exit(1);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  async function step(phase, limit, fn) {
    const mark = Date.now();
    const left = deadline - mark;
    emitPhase('PHASE_START', phase, { ms: 0 });
    if (left <= 0) {
      emitPhase('PHASE_TIMEOUT', phase, { ms: mark - started, code: 'total_timeout' });
      throw coded('total_timeout');
    }
    try {
      const value = await fn(Math.min(limit, left));
      emitPhase('PHASE_OK', phase, { ms: Date.now() - mark });
      return value;
    } catch (error) {
      const ms = Date.now() - mark;
      if (error?.child?.event === 'PHASE_TIMEOUT') {
        emitPhase('PHASE_TIMEOUT', phase, { ms, code: error.child.code });
        emitPhase('INCIDENT', '', { code: error.child.incident });
      } else if (!error?.emitted) {
        const code = CODE_NAME.test(String(error?.code ?? '')) ? error.code : 'child_exit';
        emitPhase('PHASE_FAIL', phase, { ms, code });
      }
      error.emitted = true;
      throw error;
    }
  }
  try {
    await step('storage', 1_000, async () => {
      for (const dir of [DATA_PARENT, SOCKET_DIR, SCRATCH]) assertWritable(dir);
    });
    await step('pgdata', 1_000, async () => {
      if (existsSync(PGDATA)) throw coded('pgdata_not_empty');
      mkdirSync(`${DATA_PARENT}/18`, { recursive: true, mode: 0o700 });
      mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 });
      if (existsSync(PGDATA)) throw coded('pgdata_not_empty');
    });
    const secret = randomBytes(24).toString('base64url');
    await step('initdb', LIMIT_MS.initdb, async (timeoutMs) => {
      writeFileSync(PWFILE, `${secret}\n`, { mode: 0o600 });
      chmodSync(PWFILE, 0o600);
      try {
        await tool('initdb', ['--username=postgres', '--auth-local=scram-sha-256', '--auth-host=reject', '--pwfile', PWFILE, '--pgdata', PGDATA, '--no-instructions'], env, DATA_PARENT, timeoutMs);
      } finally {
        try {
          unlinkSync(PWFILE);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      phases.init = true;
    });
    await step('socket', 1_000, async () => {
      writeFileSync(`${PGDATA}/pg_hba.conf`, 'local all all scram-sha-256\n', { mode: 0o600 });
      writeFileSync(`${PGDATA}/postgresql.auto.conf`, [
        "listen_addresses = ''",
        `unix_socket_directories = '${SOCKET_DIR}'`,
        "unix_socket_permissions = '0700'",
        "password_encryption = 'scram-sha-256'",
        '',
      ].join('\n'), { mode: 0o600 });
      phases.socket = true;
    });
    await step('credentials', 1_000, async () => {
      writeFileSync(pgpass, `${SOCKET_DIR}:5432:*:postgres:${secret}\n`, { mode: 0o600 });
      chmodSync(pgpass, 0o600);
      phases.credentials = true;
    });
    const clientEnv = { ...env, PGPASSFILE: pgpass };
    const client = ['--host', SOCKET_DIR, '--username', 'postgres'];
    serverMaybe = true;
    await step('start', LIMIT_MS.start, async (timeoutMs) => {
      const logFile = createCtlLog(randomBytes(8).toString('hex'));
      try {
        await tool('pg_ctl', pgCtlStartArgs(logFile), clientEnv, DATA_PARENT, timeoutMs);
        let probeText = '';
        try {
          probeText = await tool('psql', readinessArgs(), clientEnv, PGDATA, LIMIT_MS.ready);
        } catch (error) {
          if (error?.child?.event === 'PHASE_TIMEOUT') throw error;
          throw coded('not_ready');
        }
        const decision = acceptStart({ pgCtl: { status: 0 }, probe: { status: 0, stdout: probeText } });
        if (!decision.ok) throw coded(decision.code);
      } finally {
        releaseCtlLog(logFile);
      }
    });
    await step('version', LIMIT_MS.psql, async (timeoutMs) => {
      try {
        assertServerVersionNum(await tool('psql', [...client, '--dbname', 'postgres', '--no-align', '--tuples-only', '-c', 'SHOW server_version_num'], clientEnv, PGDATA, timeoutMs));
        assertPostgres18(await tool('pg_dump', ['--version'], env, DATA_PARENT, Math.min(timeoutMs, LIMIT_MS.pg_dump_version)), 'pg_dump');
      } catch (error) {
        if (error?.child) throw error;
        throw coded('version');
      }
    });
    await step('createdb', LIMIT_MS.createdb, async (timeoutMs) => {
      await tool('createdb', [...client, 'ensayo'], clientEnv, PGDATA, timeoutMs);
      phases.createdb = true;
    });
    await step('load', LIMIT_MS.psql, async (timeoutMs) => {
      await tool('psql', [...client, '--dbname', 'ensayo', ...FIXTURES.flatMap((file) => ['--file', file.pathname])], clientEnv, PGDATA, timeoutMs);
      phases.load = true;
    });
    let plain;
    await step('dump', LIMIT_MS.pg_dump, async (timeoutMs) => {
      const dumpPath = `${PGDATA}/ensayo.dump`;
      await tool('pg_dump', ['--format=custom', '--no-owner', '--file', dumpPath, ...client, '--dbname', 'ensayo'], clientEnv, PGDATA, timeoutMs);
      plain = readFileSync(dumpPath);
      plainBytes = plain.length;
      if (plain.length > PLAINTEXT_MAX_BYTES) throw coded('oversize');
      assertCustomDump(plain);
      phases.dump = true;
    });
    let sealed;
    let privateKey;
    await step('seal', LIMIT_MS.seal, async (timeoutMs) => {
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
      privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
      async function* chunks() { yield plain; }
      let timer;
      try {
        const handle = await Promise.race([
          sealBlocks(chunks(), publicKey, { maxBytes: PLAINTEXT_MAX_BYTES }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(coded('child_timeout'), { child: { event: 'PHASE_TIMEOUT', code: 'child_timeout', incident: 'seal_not_cancelable' } })), timeoutMs);
          }),
        ]);
        sealed = await readSealed(handle);
        await discardSealed(handle);
      } finally {
        clearTimeout(timer);
      }
      sealedBytes = sealed.length;
      phases.seal = true;
    });
    await step('tamper', LIMIT_MS.seal, async () => {
      const tampered = Buffer.from(sealed);
      tampered[tampered.length - 1] ^= 0xff;
      try {
        assertRejected(tampered, privateKey, 'backup ERROR: el sobre alterado fue aceptado.');
      } catch (error) {
        if (error?.message === 'backup ERROR: el sobre alterado fue aceptado.') throw coded('tamper_accepted');
        throw error;
      }
      const wrong = generateKeyPairSync('rsa', { modulusLength: 2048 });
      try {
        assertRejected(sealed, wrong.privateKey.export({ type: 'pkcs8', format: 'pem' }), 'backup ERROR: una clave ajena abrió el sobre.');
      } catch (error) {
        if (error?.message === 'backup ERROR: una clave ajena abrió el sobre.') throw coded('wrong_key_accepted');
        throw error;
      }
      phases.tamper = true;
    });
    let openedDump;
    await step('open', 5_000, async () => {
      const opened = openDump(sealed, privateKey);
      openedDump = opened;
      phases.open = true;
    });
    await step('header', 1_000, async () => {
      assertCustomDump(openedDump);
      phases.header = true;
    });
    await step('restore', LIMIT_MS.pg_restore, async (timeoutMs) => {
      const openedPath = `${PGDATA}/abierto.dump`;
      writeFileSync(openedPath, openedDump, { mode: 0o600 });
      await tool('createdb', [...client, 'restaurado'], clientEnv, PGDATA, Math.min(timeoutMs, LIMIT_MS.createdb));
      await tool('pg_restore', ['--no-owner', '--exit-on-error', ...client, '--dbname', 'restaurado', openedPath], clientEnv, PGDATA, timeoutMs);
      phases.restore = true;
    });
    await step('integrity', LIMIT_MS.psql, async (timeoutMs) => {
      const checked = await tool('psql', [...client, '--dbname', 'restaurado', '--no-align', '--tuples-only', '--file', INTEGRITY_SQL.pathname], clientEnv, PGDATA, timeoutMs);
      try {
        assertRestoredIntegrity(checked);
      } catch {
        throw coded('integrity');
      }
      phases.integrity = true;
    });
    await step('stop', LIMIT_MS.stop, async (timeoutMs) => {
      const stopped = await stopServer(clientEnv, timeoutMs);
      if (!stopped.ok) {
        const error = coded(classifyChild(stopped).code);
        error.child = classifyChild(stopped);
        throw error;
      }
      serverMaybe = false;
    });
    const report = reportPhases({ ...phases, clientInvoked: true, sealedBytes });
    if (report.success !== true) throw coded('child_exit');
    emitPhase('REHEARSAL_OK', '', { ms: Date.now() - started, plainBytes, sealedBytes });
    return { ok: true, ...report, plainBytes, sealedBytes };
  } catch (error) {
    if (!error?.emitted) {
      const code = CODE_NAME.test(String(error?.code ?? '')) ? error.code : 'child_exit';
      emitPhase('PHASE_FAIL', 'run', { ms: Date.now() - started, code });
      error.emitted = true;
    }
    return { ok: false };
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    if (serverMaybe) {
      const stopped = await stopServer(env, LIMIT_MS.stop);
      serverMaybe = false;
      if (!stopped.ok) emitPhase('INCIDENT', '', { code: 'direct_child_only' });
    }
    try {
      unlinkSync(pgpass);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function main() {
  if (!labMayStart(currentFacts())) {
    emitPhase('PHASE_FAIL', 'gate', { ms: 0, code: 'unauthorized' });
    console.error('backup ERROR: el laboratorio sintético no está en el contenedor autorizado.');
    process.exit(1);
  }
  runSynthetic().then((result) => {
    process.exit(result?.ok === true ? 0 : 1);
  }).catch(() => {
    emitPhase('PHASE_FAIL', 'run', { ms: 0, code: 'child_exit' });
    console.error('backup ERROR');
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
