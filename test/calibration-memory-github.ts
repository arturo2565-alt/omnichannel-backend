function response(status: number, value: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => value } as Response;
}

/** In-memory Contents API. It never contacts GitHub. */
export function memoryGithub(options?: {
  failIndexWrites?: number;
  failAll?: boolean;
  rejectCaseCreate?: 'validation' | 'forbidden';
  rateLimitCaseCreates?: number;
  failArchivedUpdates?: number;
}) {
  const files = new Map<string, { sha: string; text: string }>();
  let seq = 0;
  let indexFailures = options?.failIndexWrites ?? 0;
  let rateLimits = options?.rateLimitCaseCreates ?? 0;
  let archivedFailures = options?.failArchivedUpdates ?? 0;
  files.set(
    'data/index.json',
    {
      sha: 'index-0',
      text: JSON.stringify({
        schema_version: '1.0.0',
        cases: { 'AF-000001': 'data/cases/AF-000001.json' },
        source_keys: { 'seed-case-000001': 'AF-000001' },
      }),
    },
  );
  const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (options?.failAll) throw new Error('github unavailable');
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, '');
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      const file = files.get(path);
      if (!file) return response(404, { message: 'Not Found' });
      return response(200, {
        sha: file.sha,
        content: Buffer.from(file.text).toString('base64'),
      });
    }
    const body = JSON.parse(String(init?.body)) as { content: string; sha?: string };
    const text = Buffer.from(body.content, 'base64').toString('utf8');
    const current = files.get(path);
    const creatingCase = method === 'PUT' && path.startsWith('data/cases/') && !body.sha;
    if (creatingCase && rateLimits > 0) {
      rateLimits -= 1;
      return response(429, { message: 'API rate limit exceeded' });
    }
    if (creatingCase && options?.rejectCaseCreate === 'validation') {
      return response(422, { message: 'Validation Failed' });
    }
    if (creatingCase && options?.rejectCaseCreate === 'forbidden') {
      return response(403, { message: 'Resource not accessible by integration' });
    }
    if (
      method === 'PUT' &&
      path.startsWith('data/cases/') &&
      body.sha &&
      text.includes('archived_private') &&
      archivedFailures > 0
    ) {
      archivedFailures -= 1;
      return response(500, { message: 'unavailable' });
    }
    if (!body.sha && current) {
      return response(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
    }
    if (body.sha && (!current || current.sha !== body.sha)) return response(409, { message: 'Conflict' });
    if (
      body.sha &&
      (path === 'data/index.json' || path === 'data/probes/index.json') &&
      indexFailures > 0
    ) {
      indexFailures -= 1;
      return response(409, { message: 'Conflict' });
    }
    seq += 1;
    files.set(path, { sha: `sha-${seq}`, text });
    return response(201, { commit: { sha: `sha-${seq}` } });
  };
  return { transport: transport as typeof fetch, files };
}
