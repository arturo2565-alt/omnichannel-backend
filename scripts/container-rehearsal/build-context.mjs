/**
 * Prepara un contexto de construcción fuera del árbol del backend.
 * Copia una lista cerrada. No recorre el repositorio y no llama a Docker.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  chmodSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BASE_IMAGE, BUILD_ALLOWLIST, DOCKER_CONTEXT, NODE_IMAGE, PLATFORM } from './contract.mjs';

export const CONTEXT_PREFIX = 'pegazuz-buildctx-';
export const CONTEXT_FILE_MODE = 0o600;
export const CONTEXT_DIR_MODE = 0o700;
export const MAX_CONTEXT_FILE_BYTES = 256 * 1024;
export const DOCKERFILE_SOURCE = 'scripts/container-rehearsal/Dockerfile';
export const PROVISIONAL_TAG = 'pegazuz-rehearsal:devops-005n15';

export const CONTEXT_SOURCES = Object.freeze([
  ...BUILD_ALLOWLIST,
  DOCKERFILE_SOURCE,
]);

const SENSITIVE_PATHS = Object.freeze([
  '.env',
  '.env.staging.example',
  '.git',
  '.git/config',
  'node_modules',
  'node_modules/left-pad/index.js',
  'scripts/.env',
  'scripts/container-rehearsal/.env',
  'scripts/evil.mjs',
  'scripts/container-rehearsal/build-context.mjs',
  'scripts/container-rehearsal/Dockerfile',
  'secrets/backup.dump',
  'src/main.ts',
  'credentials.json',
  'private.pem',
  'token.key',
]);

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertRel(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0') || rel.includes('\\')) {
    fail('backup ERROR: el contexto rechazó una ruta inesperada.');
  }
  if (isAbsolute(rel)) fail('backup ERROR: el contexto rechazó una ruta inesperada.');
  const parts = rel.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    fail('backup ERROR: el contexto rechazó una ruta inesperada.');
  }
}

function contained(root, rel) {
  assertRel(rel);
  const base = resolve(root);
  const abs = resolve(base, rel);
  if (abs !== base && !abs.startsWith(`${base}${sep}`)) {
    fail('backup ERROR: el contexto rechazó una ruta inesperada.');
  }
  return abs;
}

function assertRegularComponents(root, rel) {
  const parts = rel.split('/');
  let current = resolve(root);
  for (const part of parts) {
    current = join(current, part);
    let st;
    try {
      st = lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') fail('backup ERROR: el contexto no encontró un archivo permitido.');
      throw error;
    }
    if (st.isSymbolicLink()) fail('backup ERROR: el contexto rechazó un enlace simbólico.');
  }
  if (!lstatSync(current).isFile()) fail('backup ERROR: el contexto rechazó una ruta inesperada.');
}

function readRegular(abs) {
  let fd;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ELOOP' || error?.code === 'EMLINK') {
      fail('backup ERROR: el contexto rechazó un enlace simbólico.');
    }
    if (error?.code === 'ENOENT') fail('backup ERROR: el contexto no encontró un archivo permitido.');
    throw error;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) fail('backup ERROR: el contexto rechazó una ruta inesperada.');
    if (st.nlink !== 1) fail('backup ERROR: el contexto rechazó una ruta inesperada.');
    if (st.size > MAX_CONTEXT_FILE_BYTES) fail('backup ERROR: el contexto rechazó un archivo demasiado grande.');
    const bytes = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) fail('backup ERROR: el contexto no encontró un archivo permitido.');
      offset += read;
    }
    return {
      dev: st.dev,
      ino: st.ino,
      size: st.size,
      mtimeNs: st.mtimeNs,
      hash: sha256(bytes),
      bytes,
    };
  } finally {
    closeSync(fd);
  }
}

function snapshot(sourceRoot, source) {
  assertRegularComponents(sourceRoot, source);
  const opened = readRegular(contained(sourceRoot, source));
  return {
    source,
    dest: source === DOCKERFILE_SOURCE ? 'Dockerfile' : source,
    ...opened,
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.hash === right.hash
    && left.bytes.equals(right.bytes);
}

function rescan(sourceRoot, snap) {
  assertRegularComponents(sourceRoot, snap.source);
  const again = readRegular(contained(sourceRoot, snap.source));
  if (!sameIdentity(snap, again)) fail('backup ERROR: el contexto cambió durante la preparación.');
}

function assertDockerfile(bytes) {
  const text = bytes.toString('utf8');
  if (!text.includes(`FROM ${BASE_IMAGE}\n`)) {
    fail('backup ERROR: el Dockerfile del contexto no conserva los digests fijados.');
  }
  if (!text.includes(`COPY --from=${NODE_IMAGE} `)) {
    fail('backup ERROR: el Dockerfile del contexto no conserva los digests fijados.');
  }
  if (text.includes('syntax=') || text.includes('docker/dockerfile')) {
    fail('backup ERROR: el Dockerfile no puede traer un frontend sin fijar.');
  }
  if (text.includes('COPY . .') || /^ADD\s/m.test(text)) {
    fail('backup ERROR: el Dockerfile del contexto no es válido.');
  }
  assertPostgresUser(text);
  const copies = contextCopySources(text);
  const expected = [...BUILD_ALLOWLIST].sort();
  const found = [...copies].sort();
  if (found.length !== expected.length || found.some((rel, index) => rel !== expected[index])) {
    fail('backup ERROR: el Dockerfile del contexto no es válido.');
  }
}

function dockerfileLines(text) {
  return text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('#'));
}

function assertPostgresUser(text) {
  const lines = dockerfileLines(text);
  const runs = lines.filter((line) => line.startsWith('RUN '));
  if (runs.length !== 1 || !runs[0].startsWith('RUN chmod 0400 ')) {
    fail('backup ERROR: el Dockerfile del contexto no es válido.');
  }
  const paths = runs[0].slice('RUN chmod 0400 '.length).split(/\s+/).filter(Boolean).sort();
  const expected = BUILD_ALLOWLIST.map((rel) => `/opt/pegazuz/${rel}`).sort();
  if (paths.length !== expected.length || paths.some((rel, index) => rel !== expected[index])) {
    fail('backup ERROR: el Dockerfile del contexto no es válido.');
  }
  const userAt = lines.findIndex((line) => line === 'USER postgres');
  const entryAt = lines.findIndex((line) => line.startsWith('ENTRYPOINT '));
  if (userAt < 0 || entryAt < 0 || userAt > entryAt) fail('backup ERROR: el Dockerfile del contexto no es válido.');
  if (lines.some((line) => line.startsWith('USER ') && line !== 'USER postgres')) {
    fail('backup ERROR: el Dockerfile del contexto no es válido.');
  }
  const nodeCopy = lines.find((line) => line.startsWith('COPY --from='));
  if (!nodeCopy || nodeCopy.includes('--chown=')) fail('backup ERROR: el Dockerfile del contexto no es válido.');
}

export function contextCopySources(dockerfile) {
  const sources = [];
  for (const line of dockerfileLines(dockerfile)) {
    if (!line.startsWith('COPY ')) continue;
    if (line.startsWith('COPY --from=')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) fail('backup ERROR: el Dockerfile del contexto no es válido.');
    const flags = parts.slice(1, -2);
    if (flags.length !== 1 || flags[0] !== '--chown=postgres:postgres') {
      fail('backup ERROR: el Dockerfile del contexto no es válido.');
    }
    assertRel(parts[parts.length - 2]);
    sources.push(parts[parts.length - 2]);
  }
  return sources;
}

function assertRequested(files) {
  if (files == null) return;
  if (!Array.isArray(files) || files.length !== CONTEXT_SOURCES.length) {
    fail('backup ERROR: el contexto rechazó un archivo inesperado.');
  }
  for (let index = 0; index < CONTEXT_SOURCES.length; index += 1) {
    if (files[index] !== CONTEXT_SOURCES[index]) {
      fail('backup ERROR: el contexto rechazó un archivo inesperado.');
    }
  }
}

export function renderDockerignore() {
  const nested = BUILD_ALLOWLIST.filter((rel) => rel.startsWith('scripts/container-rehearsal/'));
  const top = BUILD_ALLOWLIST.filter((rel) => !rel.startsWith('scripts/container-rehearsal/'));
  const lines = [
    '*',
    '!Dockerfile',
    '!scripts',
    'scripts/**',
    ...top.map((rel) => `!${rel}`),
    '!scripts/container-rehearsal',
    'scripts/container-rehearsal/**',
    ...nested.map((rel) => `!${rel}`),
    '.env',
    '.env.*',
    '*/.env',
    '*/*/.env',
    'scripts/.env',
    'scripts/container-rehearsal/.env',
    '.git',
    'node_modules',
    '*.dump',
    '*/*.dump',
    '*/*/*.dump',
    '*.pem',
    '*.key',
    'credentials.json',
  ];
  return `${lines.join('\n')}\n`;
}

function cleanPattern(pattern) {
  const parts = pattern.split('/');
  const kept = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') fail('backup ERROR: el contexto rechazó una ruta inesperada.');
    kept.push(part);
  }
  return kept.join('/');
}

function compilePattern(cleaned) {
  let regStr = '^';
  let matchType = 'exact';
  const chars = [...cleaned];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch === '*') {
      if (chars[i + 1] === '*') {
        const starAt = i;
        i += 1;
        if (chars[i + 1] === '/') i += 1;
        if (i + 1 >= chars.length) {
          matchType = matchType === 'exact' ? 'prefix' : 'regexp';
          if (matchType === 'regexp') regStr += '.*';
        } else {
          regStr += '(?:.*/)?';
          matchType = 'regexp';
        }
        if (starAt === 0) matchType = 'suffix';
      } else {
        regStr += '[^/]*';
        matchType = 'regexp';
      }
    } else if (ch === '?') {
      regStr += '[^/]';
      matchType = 'regexp';
    } else if ('.+()|{}$'.includes(ch)) {
      regStr += `\\${ch}`;
    } else {
      regStr += ch;
    }
  }
  if (matchType === 'regexp') {
    return { matchType, cleaned, regexp: new RegExp(`${regStr}$`) };
  }
  return { matchType, cleaned, regexp: null };
}

function patternMatches(compiled, path) {
  if (compiled.matchType === 'exact') return path === compiled.cleaned;
  if (compiled.matchType === 'prefix') return path.startsWith(compiled.cleaned.slice(0, -2));
  if (compiled.matchType === 'suffix') {
    const suffix = compiled.cleaned.slice(2);
    if (path.endsWith(suffix)) return true;
    return suffix.startsWith('/') && path === suffix.slice(1);
  }
  return compiled.regexp.test(path);
}

function parseIgnore(text) {
  const patterns = [];
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    let body = trimmed;
    let exclusion = false;
    if (body.startsWith('!')) {
      exclusion = true;
      body = body.slice(1);
      if (body.length === 0) fail('backup ERROR: el contexto rechazó una ruta inesperada.');
    }
    const cleaned = cleanPattern(body);
    patterns.push({ exclusion, ...compilePattern(cleaned) });
  }
  return patterns;
}

export function dockerignoreExcludes(dockerignoreText, relPath) {
  assertRel(relPath);
  const patterns = parseIgnore(dockerignoreText);
  let matched = false;
  const parent = dirname(relPath);
  const parents = parent === '.' ? [] : parent.split('/');
  for (const pattern of patterns) {
    if (pattern.exclusion !== matched) continue;
    let match = patternMatches(pattern, relPath);
    if (!match) {
      for (let i = 0; i < parents.length; i += 1) {
        if (patternMatches(pattern, parents.slice(0, i + 1).join('/'))) {
          match = true;
          break;
        }
      }
    }
    if (match) matched = !pattern.exclusion;
  }
  return matched;
}

function assertIgnorePolicy(text) {
  for (const rel of BUILD_ALLOWLIST) {
    if (dockerignoreExcludes(text, rel)) fail('backup ERROR: el Dockerfile del contexto no es válido.');
  }
  if (dockerignoreExcludes(text, 'Dockerfile')) fail('backup ERROR: el Dockerfile del contexto no es válido.');
  for (const rel of SENSITIVE_PATHS) {
    if (!dockerignoreExcludes(text, rel)) fail('backup ERROR: el contexto rechazó un archivo inesperado.');
  }
}

function writeBytes(dir, rel, bytes) {
  const abs = contained(dir, rel);
  let cursor = dir;
  const parents = dirname(rel) === '.' ? [] : dirname(rel).split('/');
  for (const part of parents) {
    cursor = join(cursor, part);
    let st;
    try {
      st = lstatSync(cursor);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      mkdirSync(cursor, { mode: CONTEXT_DIR_MODE });
      st = lstatSync(cursor);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) fail('backup ERROR: el contexto rechazó un enlace simbólico.');
    chmodSync(cursor, CONTEXT_DIR_MODE);
  }
  const fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, CONTEXT_FILE_MODE);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const wrote = writeSync(fd, bytes, offset, bytes.length - offset);
      if (wrote <= 0) fail('backup ERROR: el contexto no encontró un archivo permitido.');
      offset += wrote;
    }
    fchmodSync(fd, CONTEXT_FILE_MODE);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size !== bytes.length) fail('backup ERROR: el contexto rechazó una ruta inesperada.');
  } finally {
    closeSync(fd);
  }
}

function ownedContext(dir) {
  const tmp = realpathSync(tmpdir());
  let resolved;
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory()) return null;
    resolved = realpathSync(dir);
  } catch {
    return null;
  }
  const rel = relative(tmp, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  if (!basename(resolved).startsWith(CONTEXT_PREFIX)) return null;
  return resolved;
}

function discardQuiet(dir) {
  const resolved = ownedContext(dir);
  if (resolved == null) return;
  rmSync(resolved, { recursive: true });
}

export function discardBuildContext(contextRoot) {
  const resolved = ownedContext(contextRoot);
  if (resolved == null) fail('backup ERROR: el contexto de construcción no es válido.');
  rmSync(resolved, { recursive: true });
}

function sealInventory(destination, snapshots, ignoreText) {
  const expected = new Map(snapshots.map((snap) => [snap.dest, snap.hash]));
  expected.set('.dockerignore', sha256(Buffer.from(ignoreText)));
  const found = [];
  function walk(dir, prefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) fail('backup ERROR: el contexto rechazó un enlace simbólico.');
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) fail('backup ERROR: el contexto rechazó una ruta inesperada.');
      found.push(rel);
    }
  }
  const rootStat = lstatSync(destination);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('backup ERROR: el contexto rechazó un enlace simbólico.');
  if ((rootStat.mode & 0o777) !== CONTEXT_DIR_MODE) fail('backup ERROR: el contexto rechazó una ruta inesperada.');
  walk(destination, '');
  found.sort();
  const names = [...expected.keys()].sort();
  if (found.length !== names.length || found.some((rel, index) => rel !== names[index])) {
    fail('backup ERROR: el contexto rechazó un archivo inesperado.');
  }
  function assertMode(rel, expectedMode, directory) {
    const st = lstatSync(contained(destination, rel));
    if (st.isSymbolicLink()) fail('backup ERROR: el contexto rechazó un enlace simbólico.');
    if (directory ? !st.isDirectory() : !st.isFile()) fail('backup ERROR: el contexto rechazó una ruta inesperada.');
    if ((st.mode & 0o777) !== expectedMode) fail('backup ERROR: el contexto rechazó una ruta inesperada.');
  }
  const seenDirs = new Set();
  for (const rel of names) {
    const parts = dirname(rel) === '.' ? [] : dirname(rel).split('/');
    let prefix = '';
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      if (seenDirs.has(prefix)) continue;
      seenDirs.add(prefix);
      assertMode(prefix, CONTEXT_DIR_MODE, true);
    }
  }
  const files = [];
  for (const rel of names) {
    assertMode(rel, CONTEXT_FILE_MODE, false);
    const opened = readRegular(contained(destination, rel));
    if (opened.hash !== expected.get(rel)) fail('backup ERROR: el contexto cambió durante la preparación.');
    files.push({ path: rel, sha256: opened.hash, bytes: opened.size });
  }
  return files;
}

export function prepareBuildContext(sourceRoot, options = {}) {
  assertRequested(options.files);
  const snapshots = CONTEXT_SOURCES.map((source) => snapshot(sourceRoot, source));
  const dockerfile = snapshots.find((snap) => snap.dest === 'Dockerfile');
  assertDockerfile(dockerfile.bytes);
  if (typeof options.beforeSeal === 'function') options.beforeSeal();
  for (const snap of snapshots) rescan(sourceRoot, snap);
  const destination = mkdtempSync(join(realpathSync(tmpdir()), CONTEXT_PREFIX));
  chmodSync(destination, CONTEXT_DIR_MODE);
  try {
    const ignoreText = renderDockerignore();
    assertIgnorePolicy(ignoreText);
    for (const snap of snapshots) writeBytes(destination, snap.dest, snap.bytes);
    writeBytes(destination, '.dockerignore', Buffer.from(ignoreText));
    if (typeof options.afterWrite === 'function') options.afterWrite(destination);
    for (const snap of snapshots) rescan(sourceRoot, snap);
    const files = sealInventory(destination, snapshots, ignoreText);
    return { ready: true, root: destination, files };
  } catch (error) {
    discardQuiet(destination);
    throw error;
  }
}

export function futureBuildArgv(contextRoot) {
  const root = ownedContext(contextRoot);
  if (root == null) fail('backup ERROR: el contexto de construcción no es válido.');
  const dockerfile = join(root, 'Dockerfile');
  if (!lstatSync(dockerfile).isFile()) fail('backup ERROR: el contexto de construcción no es válido.');
  return {
    executable: false,
    argv: [
      'docker',
      '--context',
      DOCKER_CONTEXT,
      'build',
      '--platform',
      PLATFORM,
      '--tag',
      PROVISIONAL_TAG,
      '--file',
      dockerfile,
      root,
    ],
  };
}

export function contextFileList() {
  return Object.freeze(['.dockerignore', 'Dockerfile', ...BUILD_ALLOWLIST].sort());
}
