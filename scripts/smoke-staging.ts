/**
 * Comprueba /api/health del backend de staging.
 * Reintenta porque Railway puede tardar en publicar el proceso.
 */
import { assertSmokeTarget } from '../src/config/smoke-target';

async function main() {
  const url = String(process.env.SMOKE_URL ?? '').trim();
  assertSmokeTarget(url, process.env);
  let detail = 'sin respuesta';
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const body = (await response.json()) as { ok?: boolean; staging?: boolean };
      if (response.ok && body.ok === true && body.staging === true) {
        console.log('OK: humo de staging');
        return;
      }
      detail = `estado ${response.status}`;
    } catch {
      detail = 'sin respuesta';
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  console.error(`smoke ERROR: ${detail}`);
  process.exit(1);
}

void main();
