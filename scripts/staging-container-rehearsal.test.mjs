import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { INTEGRITY_LINES, assertPostgres18, assertRestoredIntegrity, assertServerVersionNum } from './assert-staging-restore.mjs';
import { openDump } from './staging-backup-envelope.mjs';
import { consumeSealed, discardSealed, sealBlocks } from './staging-backup-seal.mjs';
import {
  CONTEXT_PREFIX,
  CONTEXT_SOURCES,
  PROVISIONAL_TAG,
  contextCopySources,
  contextFileList,
  discardBuildContext,
  dockerignoreExcludes,
  futureBuildArgv,
  prepareBuildContext,
  renderDockerignore,
} from './container-rehearsal/build-context.mjs';
import { runInside } from './container-rehearsal/entrypoint.mjs';
import {
  LAB_PATH,
  LIMIT_MS,
  PENDING_LAB_TAG,
  SYNTHETIC_LAB_EXECUTION,
  SYNTHETIC_PHASES,
  acceptStart,
  classifyChild,
  createCtlLog,
  emitPhase,
  labMayStart,
  pgCtlStartArgs,
  phaseLine,
  postmasterPid,
  readinessArgs,
  rehearsalTrace,
  releaseCtlLog,
  runChild,
  runSynthetic,
  signalGroup,
  syntheticCleanupPlan,
  syntheticRunPlan,
} from './container-rehearsal/synthetic-lab.mjs';
import {
  BASE_IMAGE,
  BUILD_ALLOWLIST,
  NODE_IMAGE,
  CONTAINER_MEMORY,
  CONTAINER_REHEARSAL_EXECUTION,
  DOCKER_CONTEXT,
  PGDATA,
  PHASES,
  acceptCreateResult,
  assertArgv,
  assertBuiltImage,
  assertContainerAuthorized,
  assertContainerId,
  assertDockerContext,
  assertImageReference,
  assertVolumeName,
  cleanupPlan,
  dockerSpawnSpec,
  inertPlan,
  newVolumeName,
  previewIsolation,
  reportPhases,
} from './container-rehearsal/contract.mjs';

const root = join(import.meta.dirname, '..');

function ownRecord() {
  const volumeName = newVolumeName();
  const containerId = 'a'.repeat(64);
  return { containerId, volumeName };
}

test('postgres puede leer el ensayo y PGDATA nace vacío', () => {
  const dockerfile = readFileSync(new URL('./container-rehearsal/Dockerfile', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('./container-rehearsal/entrypoint.mjs', import.meta.url), 'utf8');
  assert.match(dockerfile, /\nUSER postgres\n/);
  assert.equal(dockerfile.includes('USER root'), false);
  assert.equal(dockerfile.indexOf('\nUSER postgres\n') < dockerfile.indexOf('\nENTRYPOINT '), true);
  assert.equal(dockerfile.includes('--chmod'), false);
  const nodeLine = dockerfile.split('\n').find((line) => line.startsWith('COPY --from='));
  assert.equal(nodeLine.includes('--chown='), false);
  for (const file of BUILD_ALLOWLIST) {
    assert.equal(dockerfile.includes(`COPY --chown=postgres:postgres ${file} `), true);
    assert.equal(dockerfile.includes(`/opt/pegazuz/${file}`), true);
  }
  assert.equal(contextCopySources(dockerfile).length, BUILD_ALLOWLIST.length);
  assert.equal(contextFileList().length, 14);
  assert.equal(entry.includes('PGDATA}/initdb.pw'), false);
  assert.equal(entry.includes('mkdirSync(PGDATA'), false);
  assert.equal(entry.includes('const PWFILE = `${DATA_PARENT}/initdb.pw`'), true);
  assert.equal(entry.includes("tool('initdb', ['--username=postgres', '--auth-local=scram-sha-256', '--auth-host=reject', '--pwfile', PWFILE, '--pgdata', PGDATA, '--no-instructions'], env, DATA_PARENT);"), true);
  assert.match(entry, /--auth-local=scram-sha-256/);
  assert.match(entry, /--auth-host=reject/);
  assert.match(entry, /listen_addresses = ''/);
  assert.match(entry, /password_encryption = 'scram-sha-256'/);
  for (const marker of ['0.0.0.0', 'railway', 'amazonaws', 'apt-get', 'chown ', 'chmod 777']) {
    assert.equal(entry.includes(marker), false);
    assert.equal(dockerfile.includes(marker), false);
  }
  assert.equal(CONTAINER_REHEARSAL_EXECUTION, 'preflight-only');
});

test('la CLI rechaza execute y las cerraduras anteriores siguen cerradas', () => {
  assert.equal(CONTAINER_REHEARSAL_EXECUTION, 'preflight-only');
  assert.throws(() => assertContainerAuthorized(), /no está autorizado/);
  const rehearsal = readFileSync(new URL('./staging-restore-rehearsal.mjs', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('./staging-private-backup.mjs', import.meta.url), 'utf8');
  assert.match(rehearsal, /export const REHEARSAL_EXECUTION = 'preflight-only'/);
  assert.match(worker, /export const BUILD_EXECUTION = 'plan-only'/);
  assert.equal(worker.includes('container-rehearsal'), false);
  assert.equal(worker.includes('staging-container-rehearsal'), false);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(JSON.stringify(pkg.scripts).includes('container-rehearsal'), false);
  const workflows = join(root, '.github/workflows');
  for (const name of readdirSync(workflows)) {
    assert.equal(readFileSync(join(workflows, name), 'utf8').includes('container-rehearsal'), false);
  }
  const env = { PATH: process.env.PATH ?? '', CONTAINER_REHEARSAL_EXECUTION: 'execute' };
  const closed = spawnSync(process.execPath, ['scripts/staging-container-rehearsal.mjs', 'execute'], { cwd: root, encoding: 'utf8', env });
  assert.equal(closed.status, 1);
  assert.match(closed.stderr, /no está autorizado/);
  const planned = spawnSync(process.execPath, ['scripts/staging-container-rehearsal.mjs', 'plan'], { cwd: root, encoding: 'utf8', env });
  assert.equal(planned.status, 0);
  assert.match(planned.stdout, /preflight-only\. No se abre ninguna conexión\./);
  assert.equal(planned.stdout.includes('sha256:'), false);
  const inside = spawnSync(process.execPath, ['scripts/container-rehearsal/entrypoint.mjs'], { cwd: root, encoding: 'utf8', env });
  assert.equal(inside.status, 1);
  assert.match(inside.stderr, /no está autorizado/);
});

test('un ejecutor inyectado no cruza la cerradura', async () => {
  let hits = 0;
  const evil = () => { hits += 1; };
  await assert.rejects(() => runInside({ spawn: evil, onSpawn: evil }), /no está autorizado/);
  assert.equal(hits, 0);
});

test('el plan rechaza contexto, red, puertos, montajes, socket, digest e ID ajenos', () => {
  assert.throws(() => assertDockerContext('default'), /contexto Docker/);
  assert.throws(() => assertImageReference('postgres:18.6-bookworm'), /digest/);
  assert.throws(() => assertImageReference(`postgres:18@${'a'.repeat(64)}`), /digest/);
  assert.throws(() => assertImageReference(`${'postgres:18.6-bookworm@sha256:'}${'b'.repeat(64)}`), /fijada/);
  assert.throws(() => assertBuiltImage(), /imagen construida/);
  assert.throws(() => assertContainerId('postgres'), /ID del contenedor/);
  assert.throws(() => assertContainerId('abc'), /ID del contenedor/);
  assert.throws(() => acceptCreateResult('postgres\n'), /ID del contenedor/);
  const volumeName = newVolumeName();
  const preview = previewIsolation(volumeName);
  assert.equal(preview.executable, false);
  assert.equal(preview.blocked, true);
  assert.equal(preview.argv.at(-1), BASE_IMAGE);
  const bridged = preview.argv.map((arg) => (arg === 'none' ? 'bridge' : arg));
  assert.throws(() => assertArgv(bridged), /aislamiento/);
  const published = [...preview.argv.slice(0, -1), '-p', '5432:5432', preview.argv.at(-1)];
  assert.throws(() => assertArgv(published), /aislamiento/);
  const bound = preview.argv.map((arg) => (
    arg.startsWith('type=volume,') ? 'type=bind,source=/Library/PostgreSQL/18/data,target=/var/lib/postgresql' : arg
  ));
  assert.throws(() => assertArgv(bound), /aislamiento|volumen/);
  const socketed = preview.argv.map((arg) => (
    arg.startsWith('type=volume,') ? 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock' : arg
  ));
  assert.throws(() => assertArgv(socketed), /aislamiento/);
  const privileged = [...preview.argv.slice(0, -1), '--privileged', preview.argv.at(-1)];
  assert.throws(() => assertArgv(privileged), /aislamiento/);
  const hostPid = [...preview.argv.slice(0, -1), '--pid=host', preview.argv.at(-1)];
  assert.throws(() => assertArgv(hostPid), /aislamiento/);
  assert.equal(preview.argv[preview.argv.indexOf('--memory') + 1], CONTAINER_MEMORY);
  assert.equal(inertPlan().memory, CONTAINER_MEMORY);
  assert.equal(inertPlan().connects, false);
  assert.equal(inertPlan().context, DOCKER_CONTEXT);
  const spec = dockerSpawnSpec();
  assert.equal(spec.shell, false);
  assert.equal(spec.env.DOCKER_HOST, undefined);
  assert.equal(Object.values(spec.env).join('\n').includes('DATABASE_URL'), false);
});

test('la limpieza solo nombra el contenedor y el volumen propios', () => {
  const record = ownRecord();
  const foreign = cleanupPlan(record, { containerId: 'b'.repeat(64), volumeName: record.volumeName, signal: 'SIGINT' });
  assert.equal(foreign.action, 'preserve');
  assert.equal(foreign.commands.length, 0);
  const killed = cleanupPlan(record, { ...record, signal: 'SIGKILL', success: true });
  assert.equal(killed.action, 'preserve');
  assert.match(killed.reason, /SIGKILL/);
  const stopped = cleanupPlan(record, { ...record, signal: 'SIGTERM' });
  assert.equal(stopped.action, 'stop');
  assert.equal(stopped.commands[0].at(-1), record.containerId);
  assert.equal(stopped.commands.some((argv) => argv.includes('prune')), false);
  const failed = cleanupPlan(record, { ...record, success: false });
  assert.equal(failed.action, 'preserve');
  const done = cleanupPlan(record, { ...record, success: true });
  assert.equal(done.action, 'remove');
  assert.deepEqual(done.commands.map((argv) => argv.at(-1)), [record.containerId, record.volumeName]);
  assert.throws(() => assertVolumeName('postgres'), /volumen/);
});

test('el contexto de construcción excluye datos reales y el sobre exige las nueve líneas', async () => {
  const ignore = readFileSync(new URL('./container-rehearsal/.dockerignore', import.meta.url), 'utf8');
  const dockerfile = readFileSync(new URL('./container-rehearsal/Dockerfile', import.meta.url), 'utf8');
  assert.equal(ignore.includes('!.env'), false);
  assert.equal(ignore.includes('!scripts/'), false);
  assert.match(ignore, /(^|\n)\*(\n|$)/);
  assert.match(ignore, /(^|\n)\*\*(\n|$)/);
  assert.equal(dockerfile.includes('COPY . .'), false);
  assert.equal(dockerfile.includes('syntax='), false);
  for (const file of BUILD_ALLOWLIST) assert.equal(dockerfile.includes(file), true);
  assert.equal(BUILD_ALLOWLIST.some((file) => file.endsWith('.env') || file.endsWith('.dump')), false);
  const plain = Buffer.alloc(64);
  plain.write('PGDMP');
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  async function* source() { yield plain; }
  const handle = await sealBlocks(source(), publicKey, { maxBytes: 32 * 1024 * 1024 });
  try {
    const parts = [];
    await consumeSealed(handle, (chunk) => parts.push(Buffer.from(chunk)));
    const sealed = Buffer.concat(parts);
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] ^= 0xff;
    assert.throws(() => openDump(tampered, privateKey), /no se pudo abrir el sobre/);
    const wrong = generateKeyPairSync('rsa', { modulusLength: 2048 });
    assert.throws(() => openDump(sealed, wrong.privateKey.export({ type: 'pkcs8', format: 'pem' })), /no se pudo abrir el sobre/);
    const opened = openDump(sealed, privateKey);
    assert.equal(opened.subarray(0, 5).toString('utf8'), 'PGDMP');
  } finally {
    await discardSealed(handle);
  }
  assert.equal(INTEGRITY_LINES.length, 9);
  assert.doesNotThrow(() => assertRestoredIntegrity(INTEGRITY_LINES.join('\n')));
  assert.throws(() => assertRestoredIntegrity(INTEGRITY_LINES.slice(0, 8).join('\n')), /sintéticos/);
  const missing = reportPhases({ clientInvoked: true, init: true });
  assert.equal(missing.success, false);
  assert.equal(missing.failedPhase, 'socket');
  assert.equal(missing.connects, true);
  const pending = reportPhases({});
  assert.equal(pending.success, false);
  assert.equal(pending.connects, false);
  const facts = Object.fromEntries(PHASES.map((name) => [name, true]));
  const ready = reportPhases({ ...facts, clientInvoked: true, sealedBytes: 64 });
  assert.equal(ready.success, true);
  assert.equal(ready.sealedBytes, 64);
});

function contextNames(dir) {
  const found = [];
  function walk(current, prefix) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
      else found.push(rel);
    }
  }
  walk(dir, '');
  return found.sort();
}

function leftovers() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(CONTEXT_PREFIX));
}

function writeTree(dir, dockerfile) {
  for (const source of CONTEXT_SOURCES) {
    const abs = join(dir, source);
    mkdirSync(dirname(abs), { recursive: true });
    const body = source === 'scripts/container-rehearsal/Dockerfile' ? dockerfile : `fixture ${source}\n`;
    writeFileSync(abs, body);
  }
  writeFileSync(join(dir, '.env'), 'SECRET=no\n');
  mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n');
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'config'), '[core]\n');
  mkdirSync(join(dir, 'secrets'), { recursive: true });
  writeFileSync(join(dir, 'secrets', 'backup.dump'), 'PGDMP-falso');
  writeFileSync(join(dir, 'scripts', 'evil.mjs'), 'evil\n');
  writeFileSync(join(dir, 'credentials.json'), '{"key":"no"}\n');
}

test('el contexto mínimo contiene exactamente la lista cerrada', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'pegazuz-fixture-'));
  const before = new Set(leftovers());
  let prepared;
  try {
    writeTree(fixture, readFileSync(new URL('./container-rehearsal/Dockerfile', import.meta.url)));
    prepared = prepareBuildContext(fixture);
    assert.equal(prepared.ready, true);
    assert.deepEqual(prepared.files.map((file) => file.path), contextFileList());
    assert.deepEqual(contextNames(prepared.root), contextFileList());
    const ignore = readFileSync(join(prepared.root, '.dockerignore'), 'utf8');
    assert.equal(ignore.includes('SECRET'), false);
    assert.equal(dockerignoreExcludes(ignore, '.env'), true);
    assert.equal(dockerignoreExcludes(ignore, 'node_modules/left-pad/index.js'), true);
    assert.equal(dockerignoreExcludes(ignore, '.git/config'), true);
    assert.equal(dockerignoreExcludes(ignore, 'secrets/backup.dump'), true);
    assert.equal(dockerignoreExcludes(ignore, 'scripts/evil.mjs'), true);
    for (const rel of BUILD_ALLOWLIST) {
      assert.equal(dockerignoreExcludes(ignore, rel), false);
      const copy = readFileSync(join(prepared.root, rel));
      assert.equal(copy.includes('SECRET'), false);
      assert.equal(createHash('sha256').update(copy).digest('hex'), prepared.files.find((file) => file.path === rel).sha256);
    }
    const dockerfile = readFileSync(join(prepared.root, 'Dockerfile'), 'utf8');
    assert.equal(dockerfile.includes(`FROM ${BASE_IMAGE}`), true);
    assert.equal(dockerfile.includes(`COPY --from=${NODE_IMAGE} `), true);
    for (const source of contextCopySources(dockerfile)) {
      assert.equal(prepared.files.some((file) => file.path === source), true);
    }
    const plan = futureBuildArgv(prepared.root);
    assert.equal(plan.executable, false);
    assert.equal(plan.argv.at(-1), prepared.root);
    assert.equal(plan.argv.includes(PROVISIONAL_TAG), true);
    assert.equal(plan.argv.includes('--secret'), false);
    assert.equal(plan.argv.includes('run'), false);
    assert.equal(plan.argv.includes('push'), false);
    assert.equal(plan.argv.includes(fixture), false);
  } finally {
    if (prepared) discardBuildContext(prepared.root);
    rmSync(fixture, { recursive: true });
    assert.deepEqual(leftovers().filter((name) => !before.has(name)), []);
  }
});

test('el contexto rechaza secretos, enlaces, rutas ajenas y cambios', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'pegazuz-fixture-'));
  const before = new Set(leftovers());
  try {
    const dockerfile = readFileSync(new URL('./container-rehearsal/Dockerfile', import.meta.url));
    writeTree(fixture, dockerfile);
    assert.throws(() => prepareBuildContext(fixture, { files: ['.env'] }), /archivo inesperado/);
    assert.throws(() => prepareBuildContext(fixture, { files: [...CONTEXT_SOURCES, 'secrets/backup.dump'] }), /archivo inesperado/);
    const linked = mkdtempSync(join(tmpdir(), 'pegazuz-fixture-'));
    try {
      writeTree(linked, dockerfile);
      unlinkSync(join(linked, 'scripts', 'staging-synthetic.sql'));
      symlinkSync(join(linked, 'scripts', 'evil.mjs'), join(linked, 'scripts', 'staging-synthetic.sql'));
      assert.throws(() => prepareBuildContext(linked), /enlace simbólico/);
    } finally {
      rmSync(linked, { recursive: true });
    }
    assert.throws(() => prepareBuildContext(fixture, {
      beforeSeal() {
        appendFileSync(join(fixture, 'scripts', 'staging-synthetic.sql'), '\n');
      },
    }), /cambió durante la preparación/);
    assert.throws(() => prepareBuildContext(fixture, {
      afterWrite(dir) {
        writeFileSync(join(dir, '.env'), 'SECRET=no\n');
      },
    }), (error) => {
      assert.equal(error.message.includes('SECRET'), false);
      assert.match(error.message, /archivo inesperado/);
      return true;
    });
    assert.throws(() => futureBuildArgv(root), /no es válido/);
    assert.throws(() => discardBuildContext(root), /no es válido/);
  } finally {
    rmSync(fixture, { recursive: true });
    assert.deepEqual(leftovers().filter((name) => !before.has(name)), []);
  }
});

test('el árbol real no entra al contexto y las tres cerraduras siguen cerradas', () => {
  const before = new Set(leftovers());
  let prepared;
  try {
    prepared = prepareBuildContext(root);
    assert.equal(prepared.ready, true);
    assert.deepEqual(prepared.files.map((file) => file.path), contextFileList());
    assert.equal(prepared.files.some((file) => file.path.includes('.env')), false);
    assert.equal(contextNames(prepared.root).includes('.env'), false);
    assert.equal(contextNames(prepared.root).includes('.git'), false);
    assert.equal(contextNames(prepared.root).includes('node_modules'), false);
    for (const source of CONTEXT_SOURCES) {
      const dest = source === 'scripts/container-rehearsal/Dockerfile' ? 'Dockerfile' : source;
      const origin = createHash('sha256').update(readFileSync(join(root, source))).digest('hex');
      assert.equal(prepared.files.find((file) => file.path === dest).sha256, origin);
    }
    const builder = readFileSync(new URL('./container-rehearsal/build-context.mjs', import.meta.url), 'utf8');
    assert.equal(builder.includes('child_process'), false);
    assert.equal(builder.includes('cpSync'), false);
    const rehearsal = readFileSync(new URL('./staging-restore-rehearsal.mjs', import.meta.url), 'utf8');
    const worker = readFileSync(new URL('./staging-private-backup.mjs', import.meta.url), 'utf8');
    assert.match(rehearsal, /export const REHEARSAL_EXECUTION = 'preflight-only'/);
    assert.match(worker, /export const BUILD_EXECUTION = 'plan-only'/);
    assert.equal(CONTAINER_REHEARSAL_EXECUTION, 'preflight-only');
    assert.equal(worker.includes('build-context.mjs'), false);
    const plan = futureBuildArgv(prepared.root);
    assert.equal(plan.executable, false);
    assert.equal(plan.argv[0], 'docker');
    assert.equal(plan.argv[2], DOCKER_CONTEXT);
    assert.notEqual(plan.argv.at(-1), root);
    assert.equal(renderDockerignore().includes('!.env'), false);
  } finally {
    if (prepared) discardBuildContext(prepared.root);
    assert.deepEqual(leftovers().filter((name) => !before.has(name)), []);
  }
});

test('el laboratorio sintético queda preparado y no arranca fuera del contenedor', async () => {
  const lab = readFileSync(new URL('./container-rehearsal/synthetic-lab.mjs', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('./container-rehearsal/entrypoint.mjs', import.meta.url), 'utf8');
  const dockerfile = readFileSync(new URL('./container-rehearsal/Dockerfile', import.meta.url), 'utf8');
  assert.equal(SYNTHETIC_LAB_EXECUTION, 'synthetic-only');
  assert.equal(CONTAINER_REHEARSAL_EXECUTION, 'preflight-only');
  assert.equal(lab.includes('process.env.SYNTHETIC_LAB_EXECUTION'), false);
  assert.equal(lab.includes('process.env.CONTAINER_REHEARSAL_EXECUTION'), false);
  assert.equal(lab.includes('stageExternalObject'), false);
  assert.equal(entry.includes('synthetic-lab'), false);
  assert.equal(entry.includes('runSynthetic'), false);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/node", "\/opt\/pegazuz\/scripts\/container-rehearsal\/entrypoint\.mjs"\]/);
  assert.equal(dockerfile.includes(`COPY --chown=postgres:postgres scripts/container-rehearsal/synthetic-lab.mjs ${LAB_PATH}`), true);
  const initAt = lab.indexOf("tool('initdb'");
  const dumpAt = lab.indexOf("'--format=custom'");
  const sealAt = lab.indexOf('sealBlocks(');
  const tamperAt = lab.indexOf('tampered[tampered.length - 1]');
  const wrongAt = lab.indexOf('una clave ajena');
  const openedAt = lab.indexOf('const opened = openDump(sealed, privateKey)');
  const restoreDbAt = lab.indexOf("tool('createdb', [...client, 'restaurado']");
  const restoreAt = lab.indexOf("tool('pg_restore'");
  const integrityAt = lab.indexOf('assertRestoredIntegrity(');
  assert.equal(initAt < dumpAt && dumpAt < sealAt && sealAt < tamperAt, true);
  assert.equal(tamperAt < wrongAt && wrongAt < openedAt && openedAt < restoreDbAt, true);
  assert.equal(restoreDbAt < restoreAt && restoreAt < integrityAt, true);
  assert.equal(lab.includes('mkdirSync(PGDATA'), false);
  assert.equal(lab.includes('existsSync(PGDATA)'), true);
  assert.equal(lab.includes('const PWFILE = `${DATA_PARENT}/initdb.pw`'), true);
  assert.equal(lab.includes('--auth-local=scram-sha-256'), true);
  assert.equal(lab.includes('PLAINTEXT_MAX_BYTES'), true);
  assert.equal(lab.includes('./schema.sql'), true);
  assert.equal(lab.includes('../staging-synthetic.sql'), true);
  assert.equal(lab.includes('0.0.0.0'), false);
  assert.equal(lab.includes('railway'), false);
  assert.equal(lab.includes('amazonaws'), false);
  assert.equal(INTEGRITY_LINES.length, 9);
  const allowed = { platform: 'linux', uid: 999, argv: ['/usr/local/bin/node', LAB_PATH], env: {} };
  assert.equal(labMayStart(allowed), true);
  assert.equal(labMayStart({ ...allowed, platform: 'darwin' }), false);
  assert.equal(labMayStart({ ...allowed, uid: 501 }), false);
  assert.equal(labMayStart({ ...allowed, argv: ['/usr/local/bin/node', LAB_PATH, 'execute'] }), false);
  assert.equal(labMayStart({ ...allowed, argv: ['/bin/sh', LAB_PATH] }), false);
  assert.equal(labMayStart({ ...allowed, env: { DATABASE_URL: 'postgres://local/no' } }), false);
  assert.equal(labMayStart({ ...allowed, env: { AWS_ACCESS_KEY_ID: 'no' } }), false);
  assert.equal(labMayStart({ ...allowed, env: { RAILWAY_TOKEN: 'no' } }), false);
  assert.equal(labMayStart({ ...allowed, env: { SYNTHETIC_LAB_EXECUTION: 'execute' } }), true);
  let hits = 0;
  await assert.rejects(() => runSynthetic({ spawn() { hits += 1; } }), /laboratorio sintético/);
  assert.equal(hits, 0);
  const marker = 'postgres://user:should-not-appear@example/db';
  const host = spawnSync(process.execPath, ['scripts/container-rehearsal/synthetic-lab.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', SYNTHETIC_LAB_EXECUTION: 'execute', DATABASE_URL: marker },
  });
  assert.equal(host.status, 1);
  assert.match(host.stderr, /laboratorio sintético/);
  assert.match(host.stdout, /PHASE_FAIL phase=gate ms=0 code=unauthorized/);
  assert.equal(host.stdout.includes('REHEARSAL_OK'), false);
  assert.equal(`${host.stdout}${host.stderr}`.includes(marker), false);
  const plan = syntheticRunPlan();
  assert.equal(plan.executable, false);
  assert.equal(plan.blocked, true);
  assert.equal(plan.imageBuilt, false);
  assert.equal(plan.argv.at(-2), PENDING_LAB_TAG);
  assert.equal(plan.argv.at(-1), LAB_PATH);
  assert.equal(plan.argv.includes('sha256:e8405f226aaa5c933224c151e8117eeb1e92fe3902a4edf8547128d30035a1c6'), false);
  assert.equal(plan.argv[plan.argv.indexOf('--network') + 1], 'none');
  assert.equal(plan.argv[plan.argv.indexOf('--user') + 1], 'postgres');
  assert.equal(plan.argv[plan.argv.indexOf('--cap-drop') + 1], 'ALL');
  assert.equal(plan.argv.includes('--read-only'), true);
  assert.equal(plan.argv.includes('no-new-privileges'), true);
  assert.equal(plan.argv.filter((arg) => arg.startsWith('--tmpfs')).length, 3);
  for (const absent of ['prune', '-p', '--publish', '--volume', '--mount', 'run', 'push']) {
    assert.equal(plan.argv.includes(absent), false);
  }
  const foreign = syntheticCleanupPlan('postgres');
  assert.equal(foreign.action, 'preserve');
  assert.equal(foreign.commands.length, 0);
  const own = syntheticCleanupPlan('a'.repeat(64));
  assert.equal(own.action, 'remove');
  assert.deepEqual(own.commands, [['docker', '--context', DOCKER_CONTEXT, 'rm', '-f', 'a'.repeat(64)]]);
  assert.equal(own.commands.some((argv) => argv.includes('prune') || argv.includes('volume')), false);
});

test('el laboratorio informa la fase y no declara éxito si falla', async () => {
  const lab = readFileSync(new URL('./container-rehearsal/synthetic-lab.mjs', import.meta.url), 'utf8');
  const steps = [...lab.matchAll(/step\('([a-z0-9-]+)'/g)].map((match) => match[1]);
  assert.deepEqual(steps, [...SYNTHETIC_PHASES]);
  assert.equal(LIMIT_MS.total, 120_000);
  assert.equal(LIMIT_MS.total < 180_000, true);
  assert.equal(Math.max(...Object.values(LIMIT_MS).filter((value) => value !== LIMIT_MS.total)) <= 30_000, true);
  assert.equal(lab.includes('process.exit(0)'), false);
  assert.match(lab, /process\.exit\(result\?\.ok === true \? 0 : 1\)/);
  const summaryAt = lab.indexOf("emitPhase('REHEARSAL_OK'");
  const successAt = lab.lastIndexOf('return { ok: true');
  assert.equal(summaryAt > 0 && summaryAt < successAt, true);
  const failed = rehearsalTrace('dump');
  assert.equal(failed[0], 'PHASE_START phase=storage ms=0\n');
  assert.equal(failed.some((line) => line.startsWith('PHASE_FAIL phase=dump ')), true);
  assert.equal(failed.some((line) => line.startsWith('PHASE_START phase=restore ')), false);
  assert.equal(failed.some((line) => line.startsWith('REHEARSAL_OK ')), false);
  const complete = rehearsalTrace(null);
  assert.equal(complete.at(-1), 'REHEARSAL_OK ms=10 plainBytes=4 sealedBytes=8\n');
  assert.throws(() => phaseLine('PHASE_FAIL', 'initdb SECRET', { ms: 1, code: 'child_exit' }));
  assert.throws(() => phaseLine('PHASE_FAIL', 'initdb', { ms: 1, code: 'child exit' }));
  const hidden = phaseLine('PHASE_FAIL', 'initdb', { ms: 3, code: 'child_exit', note: 'PRIVATE KEY plaintext PGDMP' });
  assert.equal(hidden.includes('PRIVATE'), false);
  assert.equal(hidden.includes('PGDMP'), false);
  assert.equal(classifyChild({ timedOut: true, ok: false }).incident, 'direct_child_only');
  assert.equal(classifyChild({ unkillable: true, timedOut: true }).code, 'child_unkillable');
  assert.equal(postmasterPid('97\n/tmp\n'), 97);
  assert.equal(postmasterPid('1\n'), null);
  assert.equal(postmasterPid('0\n'), null);
  assert.equal(postmasterPid('abc\n'), null);
  assert.equal(signalGroup(0, 'SIGTERM'), false);
  assert.equal(signalGroup(1, 'SIGKILL'), false);
  const dir = mkdtempSync(join(tmpdir(), 'pegazuz-phase-'));
  const fd = openSync(join(dir, 'phase'), 'w');
  try {
    const line = emitPhase('PHASE_START', 'initdb', { ms: 0 }, fd);
    assert.equal(readFileSync(join(dir, 'phase'), 'utf8'), line);
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true });
  }
  const hung = await runChild(process.execPath, ['-e', 'setInterval(() => {}, 100000)'], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 200,
    graceMs: 300,
  });
  assert.equal(hung.timedOut, true);
  assert.equal(hung.ok, false);
  assert.equal(hung.stdout, '');
  const stubborn = await runChild(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 100000)"], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 200,
    graceMs: 300,
  });
  assert.equal(stubborn.timedOut, true);
  assert.equal(stubborn.unkillable, false);
  const entry = spawnSync(process.execPath, ['scripts/container-rehearsal/entrypoint.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', CONTAINER_REHEARSAL_EXECUTION: 'execute' },
  });
  assert.equal(entry.status, 1);
  assert.equal(CONTAINER_REHEARSAL_EXECUTION, 'preflight-only');
  const worker = readFileSync(new URL('./staging-private-backup.mjs', import.meta.url), 'utf8');
  const rehearsal = readFileSync(new URL('./staging-restore-rehearsal.mjs', import.meta.url), 'utf8');
  assert.match(worker, /export const BUILD_EXECUTION = 'plan-only'/);
  assert.match(rehearsal, /export const REHEARSAL_EXECUTION = 'preflight-only'/);
});

test('el arranque no espera descriptores heredados ni declara listo a pg_ctl', async () => {
  const lab = readFileSync(new URL('./container-rehearsal/synthetic-lab.mjs', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('./staging-private-backup.mjs', import.meta.url), 'utf8');
  const rehearsal = readFileSync(new URL('./staging-restore-rehearsal.mjs', import.meta.url), 'utf8');
  assert.equal(lab.includes('spawnSync'), false);
  assert.equal(lab.includes("child.on('close'"), false);
  assert.match(lab, /child\.on\('exit'/);
  assert.match(lab, /pgCtlStartArgs\(logFile\)/);
  assert.match(lab, /acceptStart\(/);
  assert.match(lab, /listen_addresses = ''/);
  assert.equal(LIMIT_MS.start, 30_000);
  assert.equal(LIMIT_MS.ready, 10_000);
  assert.equal(CONTAINER_REHEARSAL_EXECUTION, 'preflight-only');
  assert.match(worker, /export const BUILD_EXECUTION = 'plan-only'/);
  assert.match(rehearsal, /export const REHEARSAL_EXECUTION = 'preflight-only'/);

  const secret = 'PASSWORD=should-not-appear';
  const held = await runChild(process.execPath, ['-e', `setInterval(() => process.stdout.write('${secret}\\n'), 20)`], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 200,
    graceMs: 300,
  });
  assert.equal(held.ok, false);
  assert.equal(held.timedOut, true);
  assert.equal(held.stdout, '');
  assert.equal(JSON.stringify(held).includes(secret), false);
  assert.equal(acceptStart({ pgCtl: held, probe: { status: 0, stdout: '1\n' } }).ok, false);

  const failed = await runChild(process.execPath, ['-e', 'process.exit(1)'], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 2_000,
    graceMs: 200,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 1);
  assert.equal(failed.timedOut, false);
  assert.equal(classifyChild(failed).event, 'PHASE_FAIL');

  const dir = mkdtempSync(join(tmpdir(), 'pegazuz-start-'));
  const pidFile = join(dir, 'pid');
  const script = join(dir, 'hold.mjs');
  const target = join(dir, 'target');
  writeFileSync(target, secret);
  writeFileSync(script, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000)'], { detached: true, stdio: 'inherit' });
writeFileSync(process.argv[2], String(child.pid));
child.unref();
process.exit(0);
`);
  const logFile = createCtlLog(randomBytes(8).toString('hex'));
  const link = `/tmp/pg_ctl-${randomBytes(8).toString('hex')}.log`;
  symlinkSync(target, link);
  try {
    const descendant = await runChild(process.execPath, [script, pidFile], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 2_500,
      graceMs: 200,
    });
    assert.equal(descendant.status, 0);
    assert.equal(descendant.timedOut, false);
    assert.equal(descendant.unkillable, false);
    assert.equal(descendant.ms < 1_000, true);
    assert.equal(acceptStart({ pgCtl: descendant, probe: { status: 2, stdout: '' } }).code, 'not_ready');
    assert.equal(acceptStart({ pgCtl: descendant, probe: { status: 0, stdout: '1\n' } }).ok, true);
    const dirty = acceptStart({ pgCtl: { status: 0 }, probe: { status: 0, stdout: secret } });
    assert.equal(dirty.ok, false);
    assert.equal(dirty.code, 'not_ready');
    assert.equal(JSON.stringify(dirty).includes(secret), false);
    assert.equal(acceptStart({ pgCtl: { status: 0, timedOut: true }, probe: { status: 0, stdout: '1\n' } }).code, 'child_timeout');
    assert.deepEqual(pgCtlStartArgs(logFile), ['--pgdata', PGDATA, '-l', logFile, '-t', '15', '-w', 'start']);
    assert.equal(pgCtlStartArgs(logFile).some((arg) => arg.includes('PASSWORD')), false);
    assert.deepEqual(readinessArgs(), ['--host', '/run/postgresql', '--username', 'postgres', '--dbname', 'postgres', '--no-align', '--tuples-only', '-c', 'SELECT 1']);
    assert.equal(readinessArgs().some((arg) => arg.includes('PASSWORD') || arg.includes('postgres://')), false);
    assert.equal(statSync(logFile).mode & 0o777, 0o600);
    writeFileSync(logFile, secret);
    assert.equal(releaseCtlLog(logFile), true);
    assert.equal(releaseCtlLog(logFile), true);
    assert.throws(() => readFileSync(logFile, 'utf8'));
    assert.equal(releaseCtlLog(link), false);
    assert.equal(readFileSync(target, 'utf8'), secret);
    assert.throws(() => pgCtlStartArgs(`/tmp/${secret}.log`));
  } finally {
    try {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGKILL');
    } catch {
      // the descendant was already gone
    }
    try {
      unlinkSync(link);
    } catch {
      // the symlink was already gone
    }
    releaseCtlLog(logFile);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('la versión 18 se lee por número y el ejecutable conserva su cartel', () => {
  const lab = readFileSync(new URL('./container-rehearsal/synthetic-lab.mjs', import.meta.url), 'utf8');
  const serverBanner = 'PostgreSQL 18.6 (Debian 18.6-1.pgdg12+2) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 12.2.0-14) 12.2.0, 64-bit\n';
  assert.doesNotThrow(() => assertServerVersionNum('180006\n'));
  assert.doesNotThrow(() => assertServerVersionNum('180000'));
  assert.throws(() => assertServerVersionNum(serverBanner));
  assert.throws(() => assertServerVersionNum(''));
  assert.throws(() => assertServerVersionNum('18'));
  assert.throws(() => assertServerVersionNum('170006\n'));
  assert.throws(() => assertServerVersionNum('190000\n'));
  assert.throws(() => assertServerVersionNum('180006\n180006\n'));
  assert.throws(() => assertServerVersionNum('180006 extra\n'));
  assert.throws(() => assertServerVersionNum('pg_dump (PostgreSQL) 18.6\n'));
  assert.doesNotThrow(() => assertPostgres18('pg_dump (PostgreSQL) 18.6\n', 'pg_dump'));
  assert.doesNotThrow(() => assertPostgres18('pg_dump (PostgreSQL) 18.6 (Debian 18.6-1.pgdg12+2)\n', 'pg_dump'));
  assert.doesNotThrow(() => assertPostgres18('pg_restore (PostgreSQL) 18.6 (Homebrew)\n', 'pg_restore'));
  assert.throws(() => assertPostgres18('pg_dump (PostgreSQL) 17.6\n', 'pg_dump'), /PostgreSQL 18/);
  assert.throws(() => assertPostgres18('pg_dump (PostgreSQL) 19.0\n', 'pg_dump'), /PostgreSQL 18/);
  assert.throws(() => assertPostgres18('', 'pg_dump'), /PostgreSQL 18/);
  assert.throws(() => assertPostgres18(serverBanner, 'psql'), /PostgreSQL 18/);
  assert.throws(() => assertPostgres18('pg_dump (PostgreSQL) 18.6 extra\n', 'pg_dump'), /PostgreSQL 18/);
  assert.throws(() => assertPostgres18('pg_restore (PostgreSQL) 18.6\n', 'pg_dump'), /PostgreSQL 18/);
  assert.match(lab, /-c', 'SHOW server_version_num'/);
  assert.equal(lab.includes('SELECT version()'), false);
  assert.match(lab, /assertPostgres18\(await tool\('pg_dump', \['--version'\]/);
  assert.match(lab, /throw coded\('version'\)/);
  assert.equal(LIMIT_MS.psql, 20_000);
  assert.equal(LIMIT_MS.pg_dump_version, 10_000);
  assert.equal(CONTAINER_REHEARSAL_EXECUTION, 'preflight-only');
});
