/**
 * Lee el id que devolvió esta subida y solo acepta SUCCESS de ese despliegue.
 * Un SUCCESS más nuevo, o el health del proceso anterior, no cuenta.
 */
import { pathToFileURL } from 'node:url';

const FAILURES = new Set(['FAILED', 'CRASHED', 'REMOVED', 'REMOVING', 'SKIPPED']);

export function deploymentIdFromUp(text) {
  const matches = String(text ?? '').match(/\{[^{}]*"deploymentId"\s*:\s*"[^"]+"[^{}]*\}/g);
  if (!matches) {
    throw new Error('deploy ERROR: la subida no devolvió el id de esta ejecución.');
  }
  let id = '';
  try {
    id = String(JSON.parse(matches[matches.length - 1]).deploymentId ?? '').trim();
  } catch {
    id = '';
  }
  if (!id) {
    throw new Error('deploy ERROR: la subida no devolvió el id de esta ejecución.');
  }
  return id;
}

export function verdictForDeployment(list, deploymentId) {
  const rows = normalize(list);
  const wanted = String(deploymentId ?? '').trim();
  if (!wanted) return 'fail';
  const row = rows.find((item) => String(item?.id ?? item?.deploymentId ?? '') === wanted);
  if (!row) return 'wait';
  const status = String(row.status ?? '').toUpperCase();
  if (status === 'SUCCESS') return 'success';
  if (FAILURES.has(status)) return 'fail';
  return 'wait';
}

function normalize(list) {
  const parsed = typeof list === 'string' ? JSON.parse(list) : list;
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.deployments)) return parsed.deployments;
  throw new Error('deploy ERROR: la lista de despliegues no es legible.');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  const input = await readStdin();
  try {
    if (mode === 'id') {
      process.stdout.write(deploymentIdFromUp(input));
    } else if (mode === 'check') {
      const verdict = verdictForDeployment(input, process.argv[3]);
      if (verdict === 'success') process.exit(0);
      if (verdict === 'wait') process.exit(10);
      console.error('deploy ERROR: el despliegue de esta ejecución no llegó a SUCCESS.');
      process.exit(1);
    } else {
      console.error('deploy ERROR: falta el modo de comprobación.');
      process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'deploy ERROR');
    process.exit(1);
  }
}
