/**
 * Sale 0 si el volcado puede salir de GitHub hacia el host público fijado.
 * Rechaza la red privada. No imprime la URL.
 */
import { assertStagingBackupUrl } from '../src/config/staging-deploy-target';

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error('backup ERROR: falta DATABASE_URL.');
  process.exit(1);
}
try {
  assertStagingBackupUrl(url, process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : 'backup ERROR');
  process.exit(1);
}
console.log('OK: el volcado no usa la red privada.');
