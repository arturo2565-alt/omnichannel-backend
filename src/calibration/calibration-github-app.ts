import { createSign } from 'node:crypto';
import type { CalibrationAccessToken } from './calibration-github-writer';

/**
 * CAL-007A. Mints a short-lived installation token for the private calibration
 * repository. The token stays in memory and is not written to logs or fixtures.
 */
export const CALIBRATION_GITHUB_REPOSITORY = 'arturo2565-alt/pegazuz-calibration-data';
const REPOSITORY_NAME = 'pegazuz-calibration-data';
const TOKEN_PATTERN = /^[A-Za-z0-9_]{20,255}$/;
const RENEW_BEFORE_MS = 60_000;

export class CalibrationCredentialError extends Error {
  readonly kind: 'missing' | 'incomplete' | 'forbidden' | 'rejected';

  constructor(kind: CalibrationCredentialError['kind'], message: string) {
    super(message);
    this.name = 'CalibrationCredentialError';
    this.kind = kind;
  }
}

export type GithubAppConfig = {
  appId: string;
  installationId: string;
  privateKeyPem: string;
};

export function readGithubAppConfig(env: NodeJS.ProcessEnv): GithubAppConfig | null {
  const appId = env.CALIBRATION_GITHUB_APP_ID?.trim() ?? '';
  const installationId = env.CALIBRATION_GITHUB_INSTALLATION_ID?.trim() ?? '';
  const privateKey = env.CALIBRATION_GITHUB_APP_PRIVATE_KEY?.trim() ?? '';
  const repository = env.CALIBRATION_GITHUB_REPOSITORY?.trim() || CALIBRATION_GITHUB_REPOSITORY;
  if (!appId && !installationId && !privateKey) return null;
  if (!appId || !installationId || !privateKey) {
    throw new CalibrationCredentialError('incomplete', 'Calibration GitHub App configuration is incomplete');
  }
  if (!/^\d{1,12}$/.test(appId) || !/^\d{1,12}$/.test(installationId)) {
    throw new CalibrationCredentialError('incomplete', 'Calibration GitHub App configuration is incomplete');
  }
  if (repository !== CALIBRATION_GITHUB_REPOSITORY) {
    throw new CalibrationCredentialError('rejected', 'Calibration GitHub repository is not allowed');
  }
  return {
    appId,
    installationId,
    privateKeyPem: privateKey.replace(/\\n/g, '\n'),
  };
}

type CachedToken = { token: string; expiresAtMs: number };

export type GithubInstallationGrant = {
  permissions: Record<string, string>;
  repositorySelection: 'selected' | 'all' | null;
};

export class CalibrationGithubApp implements CalibrationAccessToken {
  private cached: CachedToken | null = null;
  private grant: GithubInstallationGrant | null = null;
  private generation = 0;

  constructor(
    private readonly config: GithubAppConfig,
    private readonly transport: typeof fetch,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  invalidate(): void {
    this.generation += 1;
    this.cached = null;
    this.grant = null;
  }

  /** Permissions returned with the token. The token itself stays private. */
  installationGrant(): GithubInstallationGrant | null {
    if (!this.grant) return null;
    return {
      permissions: { ...this.grant.permissions },
      repositorySelection: this.grant.repositorySelection,
    };
  }

  async authorization(): Promise<string> {
    const cached = this.cached;
    if (cached && cached.expiresAtMs - RENEW_BEFORE_MS > this.clock()) return cached.token;
    const generation = this.generation;
    const minted = await this.mint();
    if (this.generation === generation) this.cached = minted;
    return minted.token;
  }

  private async mint(): Promise<CachedToken> {
    let assertion = '';
    try {
      assertion = signAppJwt(this.config.appId, this.config.privateKeyPem, Math.floor(this.clock() / 1000));
    } catch {
      throw new CalibrationCredentialError('rejected', 'Calibration GitHub App key was rejected');
    }
    const response = await this.transport(
      `https://api.github.com/app/installations/${this.config.installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${assertion}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repositories: [REPOSITORY_NAME],
          permissions: { contents: 'write' },
        }),
      },
    );
    if (response.status === 401 || response.status === 403) {
      throw new CalibrationCredentialError('forbidden', 'Calibration GitHub App permissions were rejected');
    }
    if (!response.ok) {
      throw new CalibrationCredentialError('rejected', 'Calibration GitHub App token was not issued');
    }
    const payload = await response.json() as {
      token?: unknown;
      expires_at?: unknown;
      permissions?: unknown;
      repository_selection?: unknown;
    };
    if (typeof payload.token !== 'string' || !TOKEN_PATTERN.test(payload.token)) {
      throw new CalibrationCredentialError('rejected', 'Calibration GitHub App token was not issued');
    }
    const expiresAtMs = Date.parse(typeof payload.expires_at === 'string' ? payload.expires_at : '');
    if (!Number.isFinite(expiresAtMs) || expiresAtMs - RENEW_BEFORE_MS <= this.clock()) {
      throw new CalibrationCredentialError('rejected', 'Calibration GitHub App token was not issued');
    }
    this.grant = readInstallationGrant(payload);
    return { token: payload.token, expiresAtMs };
  }
}

function readInstallationGrant(payload: {
  permissions?: unknown;
  repository_selection?: unknown;
}): GithubInstallationGrant {
  const permissions: Record<string, string> = {};
  if (payload.permissions && typeof payload.permissions === 'object' && !Array.isArray(payload.permissions)) {
    for (const [key, value] of Object.entries(payload.permissions)) {
      if (/^[a-z_]{1,40}$/.test(key) && (value === 'read' || value === 'write')) {
        permissions[key] = value;
      }
    }
  }
  const repositorySelection = payload.repository_selection === 'selected' || payload.repository_selection === 'all'
    ? payload.repository_selection
    : null;
  return { permissions, repositorySelection };
}

function signAppJwt(appId: string, privateKeyPem: string, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iat: nowSeconds - 60,
    exp: nowSeconds + 8 * 60,
    iss: appId,
  }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKeyPem).toString('base64url')}`;
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
