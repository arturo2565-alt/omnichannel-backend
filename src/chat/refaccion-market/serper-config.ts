/** Shared SERPER env gate. Does not change retrieval, queries, or ranking. */
export function isSerperConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(String(env.SERPER_API_KEY ?? '').trim());
}
