/**
 * Controlador del ensayo en contenedor. No llama a Docker.
 * La constante del módulo decide. Una variable de entorno no la cambia.
 */
import { pathToFileURL } from 'node:url';
import { CONTAINER_REHEARSAL_EXECUTION, inertPlan } from './container-rehearsal/contract.mjs';

export { CONTAINER_REHEARSAL_EXECUTION, inertPlan };

function main() {
  const mode = process.argv[2] ?? 'plan';
  if (mode !== 'plan' && mode !== 'preflight') {
    console.error('backup ERROR: el ensayo en contenedor no está autorizado.');
    process.exit(1);
  }
  const plan = inertPlan();
  if (plan.execution !== CONTAINER_REHEARSAL_EXECUTION || plan.connects !== false || plan.blocked !== true) {
    console.error('backup ERROR: el ensayo en contenedor no está autorizado.');
    process.exit(1);
  }
  console.log(`${plan.execution}. No se abre ninguna conexión.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
