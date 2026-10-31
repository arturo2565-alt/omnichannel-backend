/**
 * Contrato del ensayo en contenedor. La cerradura no lee el entorno.
 * SIGINT y SIGTERM solo detienen el ID creado por esta corrida.
 * SIGKILL no permite limpieza dentro del proceso. No hay prune.
 * La imagen base está fijada. La imagen construida aún no tiene digest, así que no hay ejecución.
 */
import { randomBytes } from 'node:crypto';

export const CONTAINER_REHEARSAL_EXECUTION = 'preflight-only';
export const DOCKER_CONTEXT = 'colima-pegazuz-dr';
export const PLATFORM = 'linux/arm64';
export const POSTGRES_TAG = '18.6-bookworm';
export const POSTGRES_INDEX_DIGEST = 'sha256:5c4783a8cc3f0074912164f94dfa1be4e043438f0f707cf968d7af9a0d31a2c8';
export const POSTGRES_ARM64_DIGEST = 'sha256:a1ece8fa15f7b526a51ef47a22fb1f373d33de794dc26bf7bff99e61dcb52690';
export const NODE_TAG = '22-bookworm-slim';
export const NODE_INDEX_DIGEST = 'sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da';
export const NODE_ARM64_DIGEST = 'sha256:9a422d62743ffb1e6eb282549f4eae7ab89f7b926db1f136f4cba8be60e4ecbc';
export const BASE_IMAGE = `postgres:${POSTGRES_TAG}@${POSTGRES_INDEX_DIGEST}`;
export const NODE_IMAGE = `node:${NODE_TAG}@${NODE_INDEX_DIGEST}`;
export const BUILT_IMAGE_DIGEST = null;
export const PGDATA = '/var/lib/postgresql/18/docker';
export const VOLUME_TARGET = '/var/lib/postgresql';
export const CONTAINER_MEMORY = '1536m';
export const CONTAINER_CPUS = '1';
export const CONTAINER_PIDS = '128';
export const PLAINTEXT_MAX_BYTES = 32 * 1024 * 1024;
export const PHASES = Object.freeze([
  'init',
  'socket',
  'credentials',
  'createdb',
  'load',
  'dump',
  'seal',
  'tamper',
  'open',
  'header',
  'restore',
  'integrity',
]);

export const BUILD_ALLOWLIST = Object.freeze([
  'scripts/container-rehearsal/contract.mjs',
  'scripts/container-rehearsal/entrypoint.mjs',
  'scripts/container-rehearsal/synthetic-lab.mjs',
  'scripts/container-rehearsal/schema.sql',
  'scripts/staging-backup-seal.mjs',
  'scripts/staging-backup-crypto.mjs',
  'scripts/staging-backup-envelope.mjs',
  'scripts/staging-backup-put-contract.mjs',
  'scripts/staging-private-backup.mjs',
  'scripts/assert-staging-restore.mjs',
  'scripts/staging-synthetic.sql',
  'scripts/staging-backup-integrity.sql',
]);

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const VOLUME_NAME = /^pegazuz-cr-[a-f0-9]{22}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const HOST_MARKERS = [
  '/Library/PostgreSQL',
  '/opt/homebrew/var/postgresql',
  '/var/run/docker.sock',
  'docker.sock',
  '.env',
];

function fail(message) {
  throw new Error(message);
}

export function assertContainerAuthorized() {
  if (CONTAINER_REHEARSAL_EXECUTION !== 'execute') {
    fail('backup ERROR: el ensayo en contenedor no está autorizado.');
  }
}

export function assertDockerContext(context) {
  if (context !== DOCKER_CONTEXT) fail('backup ERROR: el contexto Docker del ensayo no es válido.');
}

export function assertImageReference(ref) {
  if (typeof ref !== 'string' || !ref.startsWith(`postgres:${POSTGRES_TAG}@`) || !DIGEST.test(ref.slice(ref.indexOf('@') + 1))) {
    fail('backup ERROR: la imagen no tiene un digest verificado.');
  }
  if (ref !== BASE_IMAGE) fail('backup ERROR: la imagen del ensayo está fijada.');
  if (!ref.endsWith(POSTGRES_ARM64_DIGEST) && !ref.endsWith(POSTGRES_INDEX_DIGEST)) {
    fail('backup ERROR: la imagen del ensayo está fijada.');
  }
}

export function assertBuiltImage() {
  if (!DIGEST.test(String(BUILT_IMAGE_DIGEST ?? ''))) {
    fail('backup ERROR: la imagen construida no tiene un digest verificado.');
  }
}

export function assertContainerId(id) {
  if (!CONTAINER_ID.test(String(id ?? ''))) fail('backup ERROR: el ID del contenedor no es válido.');
}

export function assertVolumeName(name) {
  if (!VOLUME_NAME.test(String(name ?? ''))) fail('backup ERROR: el volumen del ensayo no es válido.');
}

export function newVolumeName() {
  return `pegazuz-cr-${randomBytes(11).toString('hex')}`;
}

export function assertArgv(argv) {
  if (!Array.isArray(argv) || argv[0] !== 'docker') fail('backup ERROR: el aislamiento del contenedor no es válido.');
  assertDockerContext(argv[argv.indexOf('--context') + 1]);
  if (argv.includes('prune')) fail('backup ERROR: el aislamiento del contenedor no es válido.');
  if (!argv.includes('--read-only')) fail('backup ERROR: el aislamiento del contenedor no es válido.');
  if (argv.includes('--privileged') || argv.includes('--pid=host')) fail('backup ERROR: el aislamiento del contenedor no es válido.');
  const pidFlag = argv.indexOf('--pid');
  if (pidFlag >= 0 && argv[pidFlag + 1] === 'host') fail('backup ERROR: el aislamiento del contenedor no es válido.');
  if (argv.includes('--publish') || argv.includes('-p')) fail('backup ERROR: el aislamiento del contenedor no es válido.');
  const network = argv.indexOf('--network');
  if (network < 0 || argv[network + 1] !== 'none') fail('backup ERROR: el aislamiento del contenedor no es válido.');
  const cap = argv.indexOf('--cap-drop');
  if (cap < 0 || argv[cap + 1] !== 'ALL') fail('backup ERROR: el aislamiento del contenedor no es válido.');
  if (!argv.includes('no-new-privileges')) fail('backup ERROR: el aislamiento del contenedor no es válido.');
  if (argv[argv.indexOf('--memory') + 1] !== CONTAINER_MEMORY) fail('backup ERROR: el aislamiento del contenedor no es válido.');
  if (argv[argv.indexOf('--cpus') + 1] !== CONTAINER_CPUS) fail('backup ERROR: el aislamiento del contenedor no es válido.');
  if (argv[argv.indexOf('--pids-limit') + 1] !== CONTAINER_PIDS) fail('backup ERROR: el aislamiento del contenedor no es válido.');
  if (argv[argv.indexOf('--platform') + 1] !== PLATFORM) fail('backup ERROR: el aislamiento del contenedor no es válido.');
  let volumeMount = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--mount' && argv[i] !== '-v' && argv[i] !== '--volume') continue;
    const spec = String(argv[i + 1] ?? '');
    if (argv[i] !== '--mount' || !spec.startsWith('type=volume,') || spec.includes('bind') || spec.includes('..')) {
      fail('backup ERROR: el aislamiento del contenedor no es válido.');
    }
    if (spec.includes('target=/var/lib/postgresql/data') || !spec.includes(`target=${VOLUME_TARGET}`)) {
      fail('backup ERROR: el volumen del ensayo no es válido.');
    }
    volumeMount = true;
  }
  if (!volumeMount) fail('backup ERROR: el volumen del ensayo no es válido.');
  const flat = argv.join('\n');
  if (HOST_MARKERS.some((marker) => flat.includes(marker))) fail('backup ERROR: el aislamiento del contenedor no es válido.');
  assertImageReference(argv.at(-1));
}

export function previewIsolation(volumeName) {
  assertVolumeName(volumeName);
  assertImageReference(BASE_IMAGE);
  const argv = [
    'docker',
    '--context',
    DOCKER_CONTEXT,
    'create',
    '--platform',
    PLATFORM,
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
    CONTAINER_PIDS,
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--tmpfs',
    '/run:rw,noexec,nosuid,size=16m',
    '--mount',
    `type=volume,source=${volumeName},target=${VOLUME_TARGET}`,
    '--env',
    `PGDATA=${PGDATA}`,
    BASE_IMAGE,
  ];
  assertArgv(argv);
  return {
    argv,
    executable: false,
    blocked: true,
    reason: 'la imagen construida no tiene un digest verificado.',
  };
}

export function inertPlan() {
  return {
    execution: CONTAINER_REHEARSAL_EXECUTION,
    connects: false,
    blocked: true,
    reason: 'la imagen construida no tiene un digest verificado.',
    context: DOCKER_CONTEXT,
    baseImage: BASE_IMAGE,
    nodeImage: NODE_IMAGE,
    platform: PLATFORM,
    network: 'none',
    publishes: false,
    hostMounts: false,
    memory: CONTAINER_MEMORY,
    cpus: CONTAINER_CPUS,
    pids: CONTAINER_PIDS,
    pgdata: PGDATA,
    volumeTarget: VOLUME_TARGET,
    plaintextMaxBytes: PLAINTEXT_MAX_BYTES,
  };
}

export function acceptCreateResult(stdout) {
  const id = String(stdout ?? '').trim();
  assertContainerId(id);
  return id;
}

export function cleanupPlan(record, outcome = {}) {
  const preserve = { action: 'preserve', commands: [], reason: outcome.reason ?? 'identidad ambigua' };
  if (outcome.signal === 'SIGKILL') {
    return { action: 'preserve', commands: [], reason: 'SIGKILL no permite limpieza dentro del proceso.' };
  }
  try {
    assertContainerId(record?.containerId);
    assertVolumeName(record?.volumeName);
  } catch {
    return preserve;
  }
  if (outcome.containerId !== record.containerId || outcome.volumeName !== record.volumeName) return preserve;
  if (outcome.signal === 'SIGINT' || outcome.signal === 'SIGTERM') {
    return {
      action: 'stop',
      commands: [['docker', '--context', DOCKER_CONTEXT, 'stop', record.containerId]],
      reason: 'parada del contenedor propio',
    };
  }
  if (outcome.success !== true) return { action: 'preserve', commands: [], reason: 'la corrida no terminó' };
  return {
    action: 'remove',
    commands: [
      ['docker', '--context', DOCKER_CONTEXT, 'rm', '-f', record.containerId],
      ['docker', '--context', DOCKER_CONTEXT, 'volume', 'rm', record.volumeName],
    ],
    reason: 'limpieza del ensayo propio',
  };
}

export function dockerSpawnSpec() {
  return {
    shell: false,
    cwd: '/',
    env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin' },
  };
}

export function reportPhases(done = {}) {
  const failedPhase = PHASES.find((name) => done[name] !== true) ?? null;
  const success = failedPhase == null;
  return {
    success,
    completed: success,
    failedPhase,
    connects: done.clientInvoked === true,
    sealedBytes: success ? done.sealedBytes ?? null : null,
  };
}
