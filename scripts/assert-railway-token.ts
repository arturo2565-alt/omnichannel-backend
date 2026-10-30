/**
 * Compara la respuesta de projectToken con el proyecto y el entorno fijados.
 * No imprime el token ni los identificadores.
 */
import { readFileSync } from 'node:fs';
import { assertRailwayProjectToken } from '../src/config/staging-deploy-target';

const file = process.argv[2];
const raw = file ? readFileSync(file, 'utf8') : '';
let payload: unknown;
try {
  payload = JSON.parse(raw);
} catch {
  console.error('deploy ERROR: el token no es un project token limitado a staging.');
  process.exit(1);
}
try {
  assertRailwayProjectToken(payload, process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : 'deploy ERROR');
  process.exit(1);
}
console.log('OK: el token de Railway está limitado al entorno staging.');
