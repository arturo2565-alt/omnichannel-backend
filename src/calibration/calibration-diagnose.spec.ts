import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertDiagnosticRequest,
  calibrationDiagnosticTarget,
  diagnoseCalibrationCloudinary,
  diagnoseCalibrationGithub,
} from './calibration-diagnose';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const token = 'ghs_installation_token_one';
const cloudSecret = 'cloudinary-test-secret';

function response(status: number, value: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
    arrayBuffer: async () => Buffer.from(JSON.stringify(value)),
  } as unknown as Response;
}

function githubEnv(): NodeJS.ProcessEnv {
  return {
    CALIBRATION_GITHUB_APP_ID: '12345',
    CALIBRATION_GITHUB_INSTALLATION_ID: '67890',
    CALIBRATION_GITHUB_APP_PRIVATE_KEY: `${pem}\u2028`,
  };
}

function tokenPayload(permissions: Record<string, string>, selection: 'selected' | 'all' = 'selected') {
  return {
    token,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    permissions,
    repository_selection: selection,
  };
}

const index = {
  schema_version: '1.0.0',
  cases: { 'AF-000001': 'data/cases/AF-000001.json' },
  source_keys: { 'seed-case-000001': 'AF-000001' },
};

function githubTransport(options?: {
  permissions?: Record<string, string>;
  selection?: 'selected' | 'all';
  repositories?: string[];
  totalCount?: number;
  indexStatus?: number;
  indexBody?: unknown;
  tokenStatus?: number;
}) {
  const calls: Array<{ method: string; url: string }> = [];
  const repositories = options?.repositories ?? ['arturo2565-alt/pegazuz-calibration-data'];
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({ method, url });
    if (method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      throw new Error('external write attempted');
    }
    if (url.endsWith('/access_tokens')) {
      return response(options?.tokenStatus ?? 201, tokenPayload(
        options?.permissions ?? { contents: 'write', metadata: 'read' },
        options?.selection,
      ));
    }
    if (url.includes('/installation/repositories')) {
      return response(200, {
        total_count: options?.totalCount ?? repositories.length,
        repositories: repositories.map((fullName) => ({ full_name: fullName, private: true })),
      });
    }
    return response(options?.indexStatus ?? 200, options?.indexBody ?? {
      sha: 'index-sha',
      content: Buffer.from(JSON.stringify(index)).toString('base64'),
    });
  }) as typeof fetch;
  return { calls, transport };
}

describe('CAL-007B.1 calibration diagnostics', () => {
  it('keeps the probes out of the application module', () => {
    const app = readFileSync(join(__dirname, '../app.module.ts'), 'utf8');
    expect(app).not.toContain('CalibrationModule');
    expect(app).not.toContain('calibration-diagnose');
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['diagnose:calibration-github']).toBe(
      'node dist/calibration/calibration-diagnose-github.js',
    );
    expect(pkg.scripts['diagnose:calibration-cloudinary']).toBe(
      'node dist/calibration/calibration-diagnose-cloudinary.js',
    );
    expect(pkg.scripts['diagnose:calibration-github']).not.toContain('ts-node');
    const main = readFileSync(join(__dirname, 'calibration-diagnose-main.ts'), 'utf8');
    expect(main).toContain('calibrationDiagnosticTarget');
    expect(readFileSync(join(__dirname, 'calibration-diagnose-github.ts'), 'utf8')).not.toContain('@Controller');
    expect(readFileSync(join(__dirname, 'calibration-diagnose-cloudinary.ts'), 'utf8')).not.toContain('@Controller');
    expect(calibrationDiagnosticTarget({
      RAILWAY_ENVIRONMENT_NAME: 'staging',
      RAILWAY_SERVICE_NAME: 'pegazuz-backend-staging',
      RAILWAY_PROJECT_ID: 'db653a25-d8c0-4026-9026-b8f74fb9f1fb',
      RAILWAY_ENVIRONMENT_ID: 'faf009cb-88a2-4ac8-80bd-7e3f60bbca8b',
      RAILWAY_SERVICE_ID: 'b40bff1c-2da4-4460-b5f4-507d9d994d0a',
    })).toBe(true);
    expect(calibrationDiagnosticTarget({})).toBe(false);
    expect(calibrationDiagnosticTarget({
      RAILWAY_ENVIRONMENT_NAME: 'production',
      RAILWAY_SERVICE_NAME: 'omnichannel-backend',
      RAILWAY_PROJECT_ID: 'db653a25-d8c0-4026-9026-b8f74fb9f1fb',
      RAILWAY_ENVIRONMENT_ID: 'faf009cb-88a2-4ac8-80bd-7e3f60bbca8b',
      RAILWAY_SERVICE_ID: 'b40bff1c-2da4-4460-b5f4-507d9d994d0a',
    })).toBe(false);
  });

  it('does not call GitHub when the app credential is absent', async () => {
    const github = githubTransport();
    await expect(diagnoseCalibrationGithub({}, github.transport)).resolves.toEqual({
      service: 'github',
      result: 'error',
      category: 'missing',
    });
    expect(github.calls).toEqual([]);
  });

  it('requires a real index read before reporting success', async () => {
    const github = githubTransport();
    const report = await diagnoseCalibrationGithub(githubEnv(), github.transport);
    expect(report).toEqual({ service: 'github', result: 'ok', caseCount: 1 });
    expect(github.calls.map((call) => call.method)).toEqual(['POST', 'GET', 'GET']);
    expect(github.calls.some((call) => call.method === 'PUT')).toBe(false);
    expect(JSON.stringify(report)).not.toContain(token);
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
    expect(() => assertDiagnosticRequest('PUT', github.calls[2]!.url)).toThrow(
      'Calibration diagnostic refused a write',
    );
  });

  it('does not treat a minted token as success when the index cannot be read', async () => {
    const github = githubTransport({ indexStatus: 500, indexBody: { message: 'unavailable' } });
    await expect(diagnoseCalibrationGithub(githubEnv(), github.transport)).resolves.toEqual({
      service: 'github',
      result: 'error',
      category: 'read_failed',
    });
    expect(github.calls.some((call) => call.url.includes('data/index.json'))).toBe(true);
  });

  it('rejects an installation token with an extra permission before reading the index', async () => {
    const github = githubTransport({
      permissions: { contents: 'write', metadata: 'read', pull_requests: 'write' },
    });
    const report = await diagnoseCalibrationGithub(githubEnv(), github.transport);
    expect(report).toEqual({ service: 'github', result: 'error', category: 'scope' });
    expect(github.calls.map((call) => call.url).some((url) => url.includes('index.json'))).toBe(false);
    expect(JSON.stringify(report)).not.toContain('pull_requests');
  });

  it('rejects a token that can see another repository and does not name it', async () => {
    const github = githubTransport({
      repositories: ['arturo2565-alt/pegazuz-calibration-data', 'arturo2565-alt/secret-repo'],
    });
    const report = await diagnoseCalibrationGithub(githubEnv(), github.transport);
    expect(report).toEqual({ service: 'github', result: 'error', category: 'scope' });
    expect(JSON.stringify(report)).not.toContain('secret-repo');
    expect(github.calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('reports forbidden permissions and an invalid index without the document', async () => {
    const forbidden = githubTransport({ tokenStatus: 403 });
    await expect(diagnoseCalibrationGithub(githubEnv(), forbidden.transport)).resolves.toEqual({
      service: 'github',
      result: 'error',
      category: 'forbidden',
    });
    const invalid = githubTransport({
      indexBody: { sha: 'index-sha', content: Buffer.from('{"schema_version":"9.9.9"}').toString('base64') },
    });
    const report = await diagnoseCalibrationGithub(githubEnv(), invalid.transport);
    expect(report).toEqual({ service: 'github', result: 'error', category: 'invalid_index' });
    expect(JSON.stringify(report)).not.toContain('9.9.9');
  });

  it('checks Cloudinary with a read and omits the credential and the response', async () => {
    const calls: string[] = [];
    const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      if ((init?.method ?? 'GET') !== 'GET') throw new Error('external write attempted');
      return response(200, { api_secret: cloudSecret, secure_url: 'https://res.cloudinary.com/private' });
    }) as typeof fetch;
    const report = await diagnoseCalibrationCloudinary({
      CLOUDINARY_CLOUD_NAME: 'pegazuz-test',
      CLOUDINARY_API_KEY: 'cloudinary-test-key',
      CLOUDINARY_API_SECRET: `${cloudSecret}\u2028`,
    }, transport);
    expect(report).toEqual({ service: 'cloudinary', result: 'ok' });
    expect(calls).toEqual(['GET https://api.cloudinary.com/v1_1/pegazuz-test/usage']);
    expect(JSON.stringify(report)).not.toContain(cloudSecret);
    expect(JSON.stringify(report)).not.toContain('secure_url');
  });

  it('categories a missing credential and a rejected Cloudinary login', async () => {
    const transport = jest.fn();
    await expect(diagnoseCalibrationCloudinary({}, transport)).resolves.toEqual({
      service: 'cloudinary',
      result: 'error',
      category: 'missing',
    });
    await expect(diagnoseCalibrationCloudinary({
      CLOUDINARY_CLOUD_NAME: 'pegazuz-test',
    }, transport)).resolves.toEqual({
      service: 'cloudinary',
      result: 'error',
      category: 'incomplete',
    });
    expect(transport).not.toHaveBeenCalled();
    const denied = (async () => response(401, { error: { message: cloudSecret } })) as typeof fetch;
    await expect(diagnoseCalibrationCloudinary({
      CLOUDINARY_CLOUD_NAME: 'pegazuz-test',
      CLOUDINARY_API_KEY: 'cloudinary-test-key',
      CLOUDINARY_API_SECRET: cloudSecret,
    }, denied)).resolves.toEqual({
      service: 'cloudinary',
      result: 'error',
      category: 'forbidden',
    });
  });
});
