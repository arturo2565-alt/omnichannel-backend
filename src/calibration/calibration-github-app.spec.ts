import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
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
