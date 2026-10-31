/**
 * Proceso sintético para interrumpir un sellado. No abre servicios externos.
 * La fase solo puede ser una de las tres permitidas.
 */
import { generateKeyPairSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sealBlocks } from './staging-backup-seal.mjs';

export const HOLD_MARKER = 'PLAINTEXT-NO-DEBE-SALIR-7f3c';

const FAULTS = {
  'before-cipher': 'pause-before-cipher',
  'after-tag': 'pause-after-tag',
  abandon: null,
};

async function hang(phase) {
  const fault = FAULTS[phase];
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const options = fault
    ? {
        fault,
        onPhase: async (reached) => {
          if (reached !== fault) return;
          process.stdout.write('READY\n');
          await new Promise(() => {});
        },
      }
    : {};
  const handle = await sealBlocks([Buffer.from(HOLD_MARKER)], publicPem, options);
  process.stdout.write('READY\n', () => {
    if (phase === 'abandon') process.exit(0);
  });
  if (phase === 'abandon') return handle;
  await new Promise(() => {});
  return handle;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const phase = process.argv[2];
  if (phase !== 'before-cipher' && phase !== 'after-tag' && phase !== 'after-publish' && phase !== 'abandon') {
    process.stderr.write('backup ERROR: fase desconocida.\n');
    process.exit(1);
  }
  hang(phase).catch(() => {
    process.stderr.write('backup ERROR: no se pudo sellar el archivo.\n');
    process.exit(1);
  });
}
