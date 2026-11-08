import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  CALIBRATION_GITHUB_INSTALLATION_TOKEN_MAX_LENGTH,
  CalibrationCredentialError,
  CalibrationGithubApp,
  readGithubAppConfig,
} from './calibration-github-app';
import { createCalibrationRecorder } from './calibration-ingest.service';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function response(status: number, value: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => value } as Response;
}

function fictionalInstallationToken(length: number): string {
  const prefix = 'ghs_app.';
  const suffix = '-x';
  const fill = length - prefix.length - suffix.length;
  return `${prefix}${'a'.repeat(fill)}${suffix}`;
}

function config(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CALIBRATION_GITHUB_APP_ID: '12345',
    CALIBRATION_GITHUB_INSTALLATION_ID: '67890',
    CALIBRATION_GITHUB_APP_PRIVATE_KEY: pem,
    ...overrides,
  };
}

describe('CAL-007A GitHub App credential', () => {
  it('does not call GitHub when the credential is absent or incomplete', async () => {
    const transport = jest.fn();
    expect(readGithubAppConfig({})).toBeNull();
    expect(() => createCalibrationRecorder({}, transport)).toThrow(
      expect.objectContaining({ response: { error: 'archive_not_configured' } }),
    );
    expect(() => readGithubAppConfig({ CALIBRATION_GITHUB_APP_ID: '12345' })).toThrow(
      CalibrationCredentialError,
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses a repository outside the private calibration archive', () => {
    expect(() => readGithubAppConfig(config({
      CALIBRATION_GITHUB_REPOSITORY: 'arturo2565-alt/omnichannel-backend',
    }))).toThrow(CalibrationCredentialError);
  });

  it('mints a contents token for pegazuz-calibration-data and renews it after expiry', async () => {
    let now = Date.parse('2026-11-06T18:00:00.000Z');
    const transport = jest.fn()
      .mockResolvedValueOnce(response(201, {
        token: 'ghs_installation_token_one',
        expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
      }))
      .mockResolvedValueOnce(response(201, {
        token: 'ghs_installation_token_two',
        expires_at: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
      }));
    const app = new CalibrationGithubApp(readGithubAppConfig(config())!, transport, () => now);
    await expect(app.authorization()).resolves.toBe('ghs_installation_token_one');
    await expect(app.authorization()).resolves.toBe('ghs_installation_token_one');
    expect(transport).toHaveBeenCalledTimes(1);

    const [url, init] = transport.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/app/installations/67890/access_tokens');
    expect(JSON.parse(String(init.body))).toEqual({
      repositories: ['pegazuz-calibration-data'],
      permissions: { contents: 'write' },
    });
    const jwt = String((init.headers as { Authorization: string }).Authorization).slice('Bearer '.length);
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toMatchObject({ alg: 'RS256' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      iss: string;
      iat: number;
      exp: number;
    };
    expect(claims.iss).toBe('12345');
    expect(claims.exp - claims.iat).toBe(9 * 60);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(verifier.verify(publicPem, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(jwt).not.toContain('PRIVATE KEY');
    expect(String(init.body)).not.toContain('PRIVATE KEY');

    now += 60 * 60 * 1000 - 30_000;
    await expect(app.authorization()).resolves.toBe('ghs_installation_token_two');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('accepts real installation token lengths and still records the grant', async () => {
    const now = Date.parse('2026-11-08T18:00:00.000Z');
    for (const length of [255, 390, 512]) {
      const transport = jest.fn().mockResolvedValue(response(201, {
        token: fictionalInstallationToken(length),
        expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
        permissions: { contents: 'write', metadata: 'read' },
        repository_selection: 'selected',
      }));
      const app = new CalibrationGithubApp(readGithubAppConfig(config())!, transport, () => now);
      const accepted = await app.authorization();
      expect(accepted).toHaveLength(length);
      expect(accepted.startsWith('ghs_')).toBe(true);
      expect(accepted).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(app.installationGrant()).toEqual({
        permissions: { contents: 'write', metadata: 'read' },
        repositorySelection: 'selected',
      });
      expect(JSON.stringify(app.installationGrant())).not.toContain(accepted);
    }
  });

  it('rejects empty, malformed, and oversized installation tokens', async () => {
    const now = Date.parse('2026-11-08T18:00:00.000Z');
    const expiresAt = new Date(now + 60 * 60 * 1000).toISOString();
    const rejected = [
      '',
      'ghs_short',
      fictionalInstallationToken(19),
      `github_pat_${'a'.repeat(40)}`,
      fictionalInstallationToken(80).replace('a', ' '),
      fictionalInstallationToken(CALIBRATION_GITHUB_INSTALLATION_TOKEN_MAX_LENGTH + 1),
    ];
    for (const token of rejected) {
      const transport = jest.fn().mockResolvedValue(response(201, { token, expires_at: expiresAt }));
      const app = new CalibrationGithubApp(readGithubAppConfig(config())!, transport, () => now);
      await expect(app.authorization()).rejects.toMatchObject({
        kind: 'rejected',
        message: 'Calibration GitHub App token was not issued',
      });
      expect(app.installationGrant()).toBeNull();
    }
    const missing = new CalibrationGithubApp(
      readGithubAppConfig(config())!,
      jest.fn().mockResolvedValue(response(201, { expires_at: expiresAt })),
      () => now,
    );
    await expect(missing.authorization()).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('stops when GitHub rejects the installation permissions', async () => {
    const transport = jest.fn().mockResolvedValue(response(403, {
      message: 'Resource not accessible by integration',
      token: 'ghs_must_not_surface_this_token',
    }));
    const app = new CalibrationGithubApp(readGithubAppConfig(config())!, transport, () => Date.now());
    await expect(app.authorization()).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(app.authorization()).rejects.toThrow('Calibration GitHub App permissions were rejected');
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
