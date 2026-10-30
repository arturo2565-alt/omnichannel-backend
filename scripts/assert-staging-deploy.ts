/**
 * Sale 0 si el job de publicación apunta a staging y no va a migrar.
 * No imprime servicios, hosts ni tokens.
 */
import { assertStagingDeployTarget } from '../src/config/staging-deploy-target';

try {
  assertStagingDeployTarget(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : 'deploy ERROR');
  process.exit(1);
}
console.log('OK: el destino de publicación es staging.');
