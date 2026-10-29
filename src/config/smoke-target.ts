/** El humo solo pega al host público fijado para staging. */
export function assertSmokeTarget(url: string, env: NodeJS.ProcessEnv): void {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error('smoke ERROR: la URL de humo no es válida.');
  }
  if (!host || host.includes('production')) {
    throw new Error('smoke ERROR: el destino no puede ser producción.');
  }
  const pinned = String(env.STAGING_PUBLIC_HOST ?? '').trim().toLowerCase();
  if (!pinned || pinned.includes('production') || host !== pinned) {
    throw new Error(
      'smoke ERROR: el destino no coincide con STAGING_PUBLIC_HOST.',
    );
  }
}
