/**
 * Sellado PGZ2 por bloques hacia un archivo temporal.
 * No importa el arranque plan-only, no abre PostgreSQL y no crea un cliente S3.
 * Un error recuperable borra el parcial. SIGKILL deja el directorio.
 * Node no ofrece un cerrojo entre procesos, así que un barrido sin un pid ya terminado se niega.
 */
import { constants as cryptoConstants, createHash, publicEncrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants, fstatSync, lstatSync, readSync } from 'node:fs';
import { chmod, link, lstat, mkdtemp, open, readdir, rm, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { beginDumpCipher } from './staging-backup-crypto.mjs';
import { assertPublicOnly, assertSealedPrefix, encodeEnvelopePrefix } from './staging-backup-envelope.mjs';
import { UPLOAD_SIZE_LIMIT_BYTES } from './staging-backup-put-contract.mjs';

const SLICE = 64 * 1024;
const READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const WRITE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
const MARK_FLAGS = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
const MARK_NAME = 'seal.mark';
const MARK_BODY = Buffer.from('PGZSEAL1\n');
const SEAL_DIR_NAME = /^pegazuz-seal-[A-Za-z0-9]{6}$/;
const PARTIAL_NAME = /^partial-[0-9a-f]{32}\.part$/;
const FINAL_NAME = /^sealed-[0-9a-f]{32}\.dump\.enc$/;
const activeDirs = new Set();

function dirKey(dev, ino) {
  return `${dev}:${ino}`;
}

function fail(message) {
  throw new Error(message);
}

function genericSealError(err) {
  if (err instanceof Error && err.message.startsWith('backup ERROR:')) return err;
  const wrapped = new Error('backup ERROR: no se pudo sellar el archivo.');
  if (err?.code === 'ENOSPC') wrapped.code = 'ENOSPC';
  return wrapped;
}

function readOptions(options) {
  if (options == null) return { maxBytes: UPLOAD_SIZE_LIMIT_BYTES, fault: null, onPhase: null };
  if (typeof options !== 'object' || Array.isArray(options)) fail('backup ERROR: el sellado no acepta una ruta.');
  let maxBytes = UPLOAD_SIZE_LIMIT_BYTES;
  if (options.maxBytes != null) {
    if (typeof options.maxBytes !== 'number' || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
      fail('backup ERROR: el objeto cifrado no cabe en una sola carga.');
    }
    maxBytes = Math.min(options.maxBytes, UPLOAD_SIZE_LIMIT_BYTES);
  }
  const faults = new Set(['ENOSPC', 'before-publish', 'pause-before-cipher', 'pause-after-tag']);
  if (options.fault != null && !faults.has(options.fault)) fail('backup ERROR: el sellado no acepta una ruta.');
  if (options.onPhase != null && typeof options.onPhase !== 'function') {
    fail('backup ERROR: el sellado no acepta una ruta.');
  }
  if (
    (options.fault === 'pause-before-cipher' || options.fault === 'pause-after-tag') &&
    typeof options.onPhase !== 'function'
  ) {
    fail('backup ERROR: el sellado no acepta una ruta.');
  }
  for (const key of Object.keys(options)) {
    if (key !== 'maxBytes' && key !== 'fault' && key !== 'onPhase') fail('backup ERROR: el sellado no acepta una ruta.');
  }
  return { maxBytes, fault: options.fault ?? null, onPhase: options.onPhase ?? null };
}

function assertChunkSource(source) {
  if (
    source == null ||
    typeof source === 'string' ||
    Buffer.isBuffer(source) ||
    ArrayBuffer.isView(source) ||
    (typeof source[Symbol.asyncIterator] !== 'function' && typeof source[Symbol.iterator] !== 'function')
  ) {
    fail('backup ERROR: el sellado no acepta esa entrada.');
  }
}

function assertChunk(chunk) {
  if (!ArrayBuffer.isView(chunk) || chunk.BYTES_PER_ELEMENT !== 1) {
    fail('backup ERROR: el sellado no acepta esa entrada.');
  }
}

async function writeAt(fh, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await fh.write(buffer, offset, buffer.length - offset, position + offset);
    if (bytesWritten <= 0) fail('backup ERROR: no se pudo sellar el archivo.');
    offset += bytesWritten;
  }
}

function readExactSync(fd, target, position) {
  let offset = 0;
  while (offset < target.length) {
    const n = readSync(fd, target, offset, target.length - offset, position + offset);
    if (n <= 0) fail('backup ERROR: el archivo cifrado no es válido.');
    offset += n;
  }
}

function hashFdSync(fd, size) {
  const hash = createHash('sha256');
  const buf = Buffer.alloc(SLICE);
  let offset = 0;
  while (offset < size) {
    const n = readSync(fd, buf, 0, Math.min(buf.length, size - offset), offset);
    if (n <= 0) fail('backup ERROR: el archivo cifrado no es válido.');
    hash.update(buf.subarray(0, n));
    offset += n;
  }
  return hash.digest();
}

async function closeQuiet(fh) {
  if (fh == null) return;
  await fh.close().catch(() => {});
}

async function destroyScratch(scratch) {
  if (scratch.dev != null) activeDirs.delete(dirKey(scratch.dev, scratch.ino));
  await closeQuiet(scratch.readFh);
  await closeQuiet(scratch.writeFh);
  await closeQuiet(scratch.markFh);
  await closeQuiet(scratch.dirFh);
  scratch.readFh = null;
  scratch.writeFh = null;
  scratch.markFh = null;
  scratch.dirFh = null;
  if (scratch.dir) await rm(scratch.dir, { recursive: true, force: true }).catch(() => {});
}

async function reach(settings, phase) {
  if (settings.fault !== phase) return;
  await settings.onPhase(phase);
}

class SealedFile {
  #readFh;
  #dirFh;
  #markFh;
  #dev;
  #ino;
  #size;
  #sha;
  #dir;
  #name;
  #dirDev;
  #dirIno;
  #alive;
  #closed;
  #pins;

  constructor(state) {
    this.#readFh = state.readFh;
    this.#dirFh = state.dirFh;
    this.#markFh = state.markFh;
    this.#dev = state.dev;
    this.#ino = state.ino;
    this.#size = state.size;
    this.#sha = state.sha;
    this.#dir = state.dir;
    this.#name = state.name;
    this.#dirDev = state.dirDev;
    this.#dirIno = state.dirIno;
    this.#alive = true;
    this.#closed = false;
    this.#pins = 0;
  }

  begin() {
    if (this.#closed || !this.#alive) fail('backup ERROR: el archivo sellado no es válido.');
    this.#pins += 1;
  }

  end() {
    this.#pins = Math.max(0, this.#pins - 1);
  }

  revalidate() {
    this.begin();
    try {
      return this.#inspect();
    } finally {
      this.end();
    }
  }

  #inspect() {
    try {
      if (!this.#alive || this.#closed) fail('backup ERROR: el archivo sellado no es válido.');
      const st = fstatSync(this.#readFh.fd);
      const dirSt = fstatSync(this.#dirFh.fd);
      if (
        !st.isFile() ||
        st.dev !== this.#dev ||
        st.ino !== this.#ino ||
        st.size !== this.#size ||
        st.nlink < 1 ||
        (st.mode & 0o777) !== 0o600 ||
        !dirSt.isDirectory() ||
        (dirSt.mode & 0o777) !== 0o700
      ) {
        fail('backup ERROR: el archivo sellado no es válido.');
      }
      const listed = lstatSync(join(this.#dir, this.#name));
      if (
        listed.isSymbolicLink() ||
        !listed.isFile() ||
        listed.dev !== this.#dev ||
        listed.ino !== this.#ino ||
        listed.size !== this.#size
      ) {
        fail('backup ERROR: el archivo sellado no es válido.');
      }
      const digest = hashFdSync(this.#readFh.fd, this.#size);
      if (digest.length !== this.#sha.length || !timingSafeEqual(digest, this.#sha)) {
        fail('backup ERROR: el archivo sellado no es válido.');
      }
      const headLen = Math.min(this.#size, 7 + 512 + 32);
      const head = Buffer.alloc(headLen);
      readExactSync(this.#readFh.fd, head, 0);
      assertSealedPrefix(head, this.#size);
      return { byteLength: this.#size, sha256: this.#sha.toString('base64') };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('backup ERROR:')) throw err;
      fail('backup ERROR: el archivo sellado no es válido.');
    }
  }

  location() {
    this.revalidate();
    return { dir: this.#dir, name: this.#name };
  }

  modes() {
    this.revalidate();
    return {
      fileMode: fstatSync(this.#readFh.fd).mode & 0o777,
      dirMode: fstatSync(this.#dirFh.fd).mode & 0o777,
    };
  }

  async consume(onChunk) {
    this.begin();
    try {
      const meta = this.#inspect();
      const hash = createHash('sha256');
      const buf = Buffer.alloc(SLICE);
      let offset = 0;
      while (offset < this.#size) {
        if (!this.#alive || this.#closed) fail('backup ERROR: el archivo sellado no es válido.');
        const n = readSync(this.#readFh.fd, buf, 0, Math.min(buf.length, this.#size - offset), offset);
        if (n <= 0) fail('backup ERROR: el archivo sellado no es válido.');
        const slice = Buffer.from(buf.subarray(0, n));
        hash.update(slice);
        await onChunk(slice);
        offset += n;
      }
      const digest = hash.digest();
      if (digest.length !== this.#sha.length || !timingSafeEqual(digest, this.#sha)) {
        fail('backup ERROR: el archivo sellado no es válido.');
      }
      const st = fstatSync(this.#readFh.fd);
      if (st.dev !== this.#dev || st.ino !== this.#ino || st.size !== this.#size || st.nlink < 1) {
        fail('backup ERROR: el archivo sellado no es válido.');
      }
      return { byteLength: meta.byteLength, sha256: meta.sha256 };
    } finally {
      this.end();
    }
  }

  async discard() {
    if (this.#closed) return;
    if (this.#pins > 0) fail('backup ERROR: el archivo sellado sigue en uso.');
    this.#alive = false;
    this.#closed = true;
    activeDirs.delete(dirKey(this.#dirDev, this.#dirIno));
    await this.#readFh.close().catch(() => {});
    await this.#markFh.close().catch(() => {});
    await this.#dirFh.close().catch(() => {});
    await rm(this.#dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function assertSealedFile(value) {
  if (!(value instanceof SealedFile)) fail('backup ERROR: el identificador sellado no es válido.');
  try {
    return value.revalidate();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('backup ERROR:')) throw err;
    fail('backup ERROR: el identificador sellado no es válido.');
  }
}

export function sealedLocation(value) {
  if (!(value instanceof SealedFile)) fail('backup ERROR: el identificador sellado no es válido.');
  return value.location();
}

export function sealedModes(value) {
  if (!(value instanceof SealedFile)) fail('backup ERROR: el identificador sellado no es válido.');
  return value.modes();
}

export async function discardSealed(value) {
  if (!(value instanceof SealedFile)) fail('backup ERROR: el identificador sellado no es válido.');
  await value.discard();
}

export async function consumeSealed(value, onChunk) {
  if (!(value instanceof SealedFile)) fail('backup ERROR: el identificador sellado no es válido.');
  if (typeof onChunk !== 'function') fail('backup ERROR: la carga solo acepta un archivo sellado.');
  try {
    return await value.consume(onChunk);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('backup ERROR:')) throw err;
    fail('backup ERROR: el archivo sellado no es válido.');
  }
}

function processIsDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err?.code === 'ESRCH';
  }
}

export async function reapAbandonedSeals(proof) {
  if (proof == null) fail('backup ERROR: la limpieza automática no está disponible.');
  if (typeof proof !== 'object' || Array.isArray(proof)) fail('backup ERROR: la limpieza no acepta una ruta.');
  for (const key of Object.keys(proof)) {
    if (key !== 'pid' && key !== 'directory') fail('backup ERROR: la limpieza no acepta una ruta.');
  }
  if (!Number.isInteger(proof.pid) || proof.pid <= 0) fail('backup ERROR: la limpieza no acepta una ruta.');
  if (typeof proof.directory !== 'string') fail('backup ERROR: la limpieza no acepta una ruta.');
  const name = basename(proof.directory);
  if (!SEAL_DIR_NAME.test(name) || join(tmpdir(), name) !== proof.directory) {
    fail('backup ERROR: la limpieza no acepta una ruta.');
  }
  if (!processIsDead(proof.pid)) return { removed: 0, keptActive: 1, rejected: 0 };
  return considerDeadSeal(proof.directory);
}

async function considerDeadSeal(dir) {
  const blank = { removed: 0, keptActive: 0, rejected: 1 };
  let st;
  try {
    st = await lstat(dir);
  } catch {
    return blank;
  }
  if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o777) !== 0o700) return blank;
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return blank;
  if (activeDirs.has(dirKey(st.dev, st.ino))) return { removed: 0, keptActive: 1, rejected: 0 };
  let children;
  try {
    children = await readdir(dir, { withFileTypes: true });
  } catch {
    return blank;
  }
  let partial = null;
  let finalName = null;
  let sawMark = false;
  for (const child of children) {
    if (child.isSymbolicLink() || !child.isFile()) return blank;
    if (child.name === MARK_NAME) {
      if (sawMark) return blank;
      sawMark = true;
    } else if (PARTIAL_NAME.test(child.name)) {
      if (partial) return blank;
      partial = child.name;
    } else if (FINAL_NAME.test(child.name)) {
      if (finalName) return blank;
      finalName = child.name;
    } else {
      return blank;
    }
  }
  if (!sawMark) return blank;
  const paths = [join(dir, MARK_NAME)];
  if (partial) paths.push(join(dir, partial));
  if (finalName) paths.push(join(dir, finalName));
  for (const file of paths) {
    let info;
    try {
      info = await lstat(file);
    } catch {
      return blank;
    }
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600) return blank;
  }
  let markFh = null;
  try {
    markFh = await open(join(dir, MARK_NAME), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const body = Buffer.alloc(MARK_BODY.length + 1);
    const { bytesRead } = await markFh.read(body, 0, body.length, 0);
    if (bytesRead !== MARK_BODY.length || !body.subarray(0, bytesRead).equals(MARK_BODY)) return blank;
    const again = await lstat(dir);
    if (again.isSymbolicLink() || again.dev !== st.dev || again.ino !== st.ino) return blank;
    if (activeDirs.has(dirKey(again.dev, again.ino))) return { removed: 0, keptActive: 1, rejected: 0 };
    if (partial) await unlink(join(dir, partial));
    if (finalName) await unlink(join(dir, finalName));
    await unlink(join(dir, MARK_NAME));
    await rmdir(dir);
    return { removed: 1, keptActive: 0, rejected: 0 };
  } catch {
    return blank;
  } finally {
    await closeQuiet(markFh);
  }
}

export async function sealBlocks(source, publicPem, options) {
  const pem = assertPublicOnly(publicPem);
  const settings = readOptions(options);
  assertChunkSource(source);
  const scratch = {
    dir: null,
    dirFh: null,
    writeFh: null,
    readFh: null,
    markFh: null,
    dev: null,
    ino: null,
    published: false,
  };
  try {
    const handle = await writeSealed(scratch, source, pem, settings);
    scratch.published = true;
    scratch.readFh = null;
    scratch.dirFh = null;
    scratch.markFh = null;
    return handle;
  } catch (err) {
    throw genericSealError(err);
  } finally {
    if (!scratch.published) await destroyScratch(scratch);
  }
}

async function writeSealed(scratch, source, pem, settings) {
  scratch.dir = await mkdtemp(join(tmpdir(), 'pegazuz-seal-'));
  await chmod(scratch.dir, 0o700);
  scratch.dirFh = await open(scratch.dir, 'r');
  await scratch.dirFh.chmod(0o700);
  const dirStat = await scratch.dirFh.stat();
  scratch.dev = dirStat.dev;
  scratch.ino = dirStat.ino;
  activeDirs.add(dirKey(scratch.dev, scratch.ino));
  const markPath = join(scratch.dir, MARK_NAME);
  scratch.markFh = await open(markPath, MARK_FLAGS, 0o600);
  await scratch.markFh.chmod(0o600);
  await writeAt(scratch.markFh, MARK_BODY, 0);
  const partial = join(scratch.dir, `partial-${randomBytes(16).toString('hex')}.part`);
  scratch.writeFh = await open(partial, WRITE_FLAGS, 0o600);
  await scratch.writeFh.chmod(0o600);

  const key = randomBytes(32);
  const { cipher, iv } = beginDumpCipher(key);
  const wrapped = publicEncrypt(
    { key: pem, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    key,
  );
  key.fill(0);
  const { prefix, tagOffset } = encodeEnvelopePrefix(wrapped, iv);
  if (prefix.length >= settings.maxBytes) fail('backup ERROR: el objeto cifrado no cabe en una sola carga.');
  await writeAt(scratch.writeFh, prefix, 0);
  await reach(settings, 'pause-before-cipher');

  if (settings.fault === 'ENOSPC') {
    const fault = new Error('ENOSPC');
    fault.code = 'ENOSPC';
    throw fault;
  }

  let cursor = prefix.length;
  let cipherBytes = 0;
  for await (const chunk of source) {
    assertChunk(chunk);
    for (let offset = 0; offset < chunk.length; offset += SLICE) {
      const end = Math.min(offset + SLICE, chunk.length);
      const out = cipher.update(chunk.subarray(offset, end));
      cipherBytes += out.length;
      if (prefix.length + cipherBytes >= settings.maxBytes) {
        fail('backup ERROR: el objeto cifrado no cabe en una sola carga.');
      }
      if (out.length > 0) {
        await writeAt(scratch.writeFh, out, cursor);
        cursor += out.length;
      }
    }
  }
  const tail = cipher.final();
  cipherBytes += tail.length;
  if (cipherBytes < 1 || prefix.length + cipherBytes >= settings.maxBytes) {
    fail(
      cipherBytes < 1
        ? 'backup ERROR: el archivo cifrado no es válido.'
        : 'backup ERROR: el objeto cifrado no cabe en una sola carga.',
    );
  }
  if (tail.length > 0) {
    await writeAt(scratch.writeFh, tail, cursor);
    cursor += tail.length;
  }
  const tag = cipher.getAuthTag();
  if (tag.length !== 16) fail('backup ERROR: el archivo cifrado no es válido.');
  await writeAt(scratch.writeFh, tag, tagOffset);
  await scratch.writeFh.sync();
  await scratch.dirFh.sync();
  await reach(settings, 'pause-after-tag');

  if (settings.fault === 'before-publish') fail('backup ERROR: no se pudo publicar el archivo sellado.');

  const finalName = `sealed-${randomBytes(16).toString('hex')}.dump.enc`;
  const finalPath = join(scratch.dir, finalName);
  await link(partial, finalPath);
  await rm(partial, { force: true });
  await scratch.dirFh.sync();
  await scratch.writeFh.close();
  scratch.writeFh = null;

  scratch.readFh = await open(finalPath, READ_FLAGS);
  await scratch.readFh.chmod(0o600);
  const st = await scratch.readFh.stat();
  if (!st.isFile() || st.size !== cursor || (st.mode & 0o777) !== 0o600 || st.nlink < 1) {
    fail('backup ERROR: el archivo cifrado no es válido.');
  }
  const digest = hashFdSync(scratch.readFh.fd, st.size);
  const head = Buffer.alloc(Math.min(st.size, 7 + 512 + 32));
  readExactSync(scratch.readFh.fd, head, 0);
  assertSealedPrefix(head, st.size);
  const listed = lstatSync(finalPath);
  if (listed.isSymbolicLink() || listed.ino !== st.ino || listed.dev !== st.dev) {
    fail('backup ERROR: el archivo cifrado no es válido.');
  }
  return new SealedFile({
    readFh: scratch.readFh,
    dirFh: scratch.dirFh,
    markFh: scratch.markFh,
    dev: st.dev,
    ino: st.ino,
    size: st.size,
    sha: digest,
    dir: scratch.dir,
    name: finalName,
    dirDev: scratch.dev,
    dirIno: scratch.ino,
  });
}
