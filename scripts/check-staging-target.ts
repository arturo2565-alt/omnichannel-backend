/**
 * Sale 0 si DATABASE_URL es el host de staging fijado.
 * No imprime la URL.
 */
import { assertCrmMigrationAllowed } from '../src/config/migration-target';

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error('check:staging-target ERROR: falta DATABASE_URL.');
  process.exit(1);
}
try {
  assertCrmMigrationAllowed(url, process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : 'check:staging-target ERROR');
  process.exit(1);
}
console.log('OK: el destino es el host de staging fijado.');
