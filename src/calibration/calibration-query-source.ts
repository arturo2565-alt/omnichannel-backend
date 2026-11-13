import { createHash, createSign } from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import { readGithubAppConfig } from './calibration-github-app';
import {
  calibrationPathAllowed,
  type CalibrationArchive,
  type PhotoLocator,
} from './calibration-query';

/**
 * Lector del repositorio privado. Solo emite GET y pide contents:read.
 * La URL firmada de Cloudinary se consume aquí y no se devuelve.
 */

const REPOSITORY = 'arturo2565-alt/pegazuz-calibration-data';

export class CalibrationQueryGithub implements Pick<CalibrationArchive, 'read'> {
  constructor(
    private readonly authorization: () => Promise<string>,
    private readonly transport: typeof fetch,
  ) {}

  async read(path: string): Promise<string | null> {
    if (!calibrationPathAllowed(path)) throw new Error('Calibration path is not readable');
    const response = await this.transport(
      `https://api.github.com/repos/${REPOSITORY}/contents/${path}?ref=main`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${await this.authorization()}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Calibration archive could not be read');
    const payload = await response.json() as { content?: unknown };
    if (typeof payload.content !== 'string') throw new Error('Calibration archive could not be read');
    return Buffer.from(payload.content.replace(/\s/g, ''), 'base64').toString('utf8');
  }
}

const RENEW_BEFORE_MS = 60_000;

type ReadGrant = { token: string; expiresAtMs: number };

export async function mintCalibrationReadToken(env: NodeJS.ProcessEnv, transport: typeof fetch): Promise<string> {
  return (await mintCalibrationReadGrant(env, transport)).token;
}

async function mintCalibrationReadGrant(env: NodeJS.ProcessEnv, transport: typeof fetch): Promise<ReadGrant> {
  const config = readGithubAppConfig(env);
  if (!config) throw new Error('Calibration archive is not configured');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 8 * 60, iss: config.appId })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(config.privateKeyPem).toString('base64url')}`;
  const response = await transport(
    `https://api.github.com/app/installations/${config.installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${assertion}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        repositories: ['pegazuz-calibration-data'],
        permissions: { contents: 'read' },
      }),
    },
  );
  if (!response.ok) throw new Error('Calibration archive could not be read');
  const grant = readGrant(await response.json());
  if (!grant) throw new Error('Calibration archive could not be read');
  return grant;
}

function readGrant(value: unknown): ReadGrant | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.token !== 'string' || !body.token.startsWith('ghs_') || body.token.length > 1024) return null;
  const permissions = body.permissions;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return null;
  const granted = permissions as Record<string, unknown>;
  const keys = Object.keys(granted);
  if (granted.contents !== 'read') return null;
  if (!keys.every((key) => key === 'contents' || key === 'metadata')) return null;
  if (granted.metadata != null && granted.metadata !== 'read') return null;
  if (body.repository_selection !== 'selected' || !Array.isArray(body.repositories) || body.repositories.length !== 1) {
    return null;
  }
  const repo = body.repositories[0] as { name?: unknown; full_name?: unknown } | null;
  if (!repo || repo.name !== 'pegazuz-calibration-data' || repo.full_name !== REPOSITORY) return null;
  const expiresAtMs = Date.parse(typeof body.expires_at === 'string' ? body.expires_at : '');
  if (!Number.isFinite(expiresAtMs) || expiresAtMs - RENEW_BEFORE_MS <= Date.now()) return null;
  return { token: body.token, expiresAtMs };
}

export async function fetchPrivatePhoto(
  locator: PhotoLocator,
  transport: typeof fetch,
  sign: (locator: PhotoLocator) => string,
): Promise<Buffer> {
  const url = sign(locator);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Calibration photo could not be read');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'res.cloudinary.com') {
    throw new Error('Calibration photo could not be read');
  }
  if (!parsed.pathname.includes('/image/authenticated/')) {
    throw new Error('Calibration photo could not be read');
  }
  const response = await transport(url, { method: 'GET' });
  if (!response.ok) throw new Error('Calibration photo could not be read');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== locator.sha256) {
    throw new Error('Calibration photo could not be read');
  }
  return bytes;
}

export function signAuthenticatedDelivery(env: NodeJS.ProcessEnv, locator: PhotoLocator): string {
  const cloudName = String(env.CLOUDINARY_CLOUD_NAME ?? '').trim();
  const apiKey = String(env.CLOUDINARY_API_KEY ?? '').trim();
  const apiSecret = String(env.CLOUDINARY_API_SECRET ?? '').trim();
  if (!cloudName || !apiKey || !apiSecret) throw new Error('Calibration photo could not be read');
  if (apiSecret && locator.publicId.includes(apiSecret)) throw new Error('Calibration photo could not be read');
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
  const url = cloudinary.url(locator.publicId, {
    type: 'authenticated',
    resource_type: 'image',
    format: locator.format,
    version: locator.version,
    sign_url: true,
    secure: true,
    expires_at: Math.floor(Date.now() / 1000) + 60,
  });
  if (typeof url !== 'string' || url.includes(apiSecret)) throw new Error('Calibration photo could not be read');
  return url;
}

export function liveCalibrationArchive(env: NodeJS.ProcessEnv, transport: typeof fetch = fetch): CalibrationArchive {
  let cached: ReadGrant | null = null;
  const github = new CalibrationQueryGithub(async () => {
    if (cached && cached.expiresAtMs - RENEW_BEFORE_MS > Date.now()) return cached.token;
    cached = await mintCalibrationReadGrant(env, transport);
    return cached.token;
  }, transport);
  return {
    read: (path) => github.read(path),
    photo: (locator) => fetchPrivatePhoto(locator, transport, (item) => signAuthenticatedDelivery(env, item)),
  };
}
