/**
 * Sandbox de WhatsApp y OpenAI para el taller de ensayo.
 * Permanece inerte salvo que PEGAZUZ_ENV=staging y STAGING_SANDBOX sea exactamente `on`
 * con el conjunto completo de variables exclusivas. No lee credenciales de producción
 * y no calcula precios: CanonicalQuoteV1 sigue siendo la autoridad financiera.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingMessage } from 'http';
import { STAGING_EXTERNAL_BLOCKED, isStagingRuntime } from './staging-guard';
import { STAGING_TALLER_ID } from './staging-synthetic';
import {
  extractMetaWhatsAppInboundEvents,
  extractWhatsAppWebhookMetadata,
  isMetaWhatsAppWebhook,
} from '../chat/meta-whatsapp-webhook';
import {
  normalizeWhatsAppDigits,
  normalizeWhatsAppRecipientWaId,
} from '../chat/whatsapp-config';

export const STAGING_SANDBOX_ON = 'on';

const DEFAULT_MEDIA_MAX_BYTES = 5_242_880;
const DEFAULT_MEDIA_TIMEOUT_MS = 8_000;
const ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const MEDIA_ID_PATTERN = /^[0-9]{6,32}$/;

const PRODUCTION_COLLISIONS: ReadonlyArray<readonly [string, string]> = [
  ['STAGING_WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_PHONE_NUMBER_ID'],
  ['STAGING_WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID'],
  ['STAGING_WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_ACCESS_TOKEN'],
  ['STAGING_WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_VERIFY_TOKEN'],
  ['STAGING_WHATSAPP_NUMBER', 'WHATSAPP_NUMBER'],
  ['STAGING_OPENAI_API_KEY', 'OPENAI_API_KEY'],
];

export type StagingSandboxConfig = {
  tallerId: typeof STAGING_TALLER_ID;
  phoneNumberId: string;
  businessAccountId: string;
  accessToken: string;
  verifyToken: string;
  appSecret: string;
  displayNumber: string;
  allowlist: readonly string[];
  openAiApiKey: string;
  maxRequests: number;
  maxTotalTokens: number;
  mediaMaxBytes: number;
  mediaTimeoutMs: number;
  allowedMediaTypes: readonly string[];
};

export type StagingSandboxState =
  | { active: false; reason: 'not_staging' | 'off' | 'incomplete' }
  | { active: true; config: StagingSandboxConfig };

export type SandboxInboundEvent = {
  tallerId: typeof STAGING_TALLER_ID;
  threadWaId: string;
  contactName: string;
  messageId: string;
  text: string;
  mediaId: string;
  buttonPayload: string;
};

export type SandboxInboundDecision =
  | {
      ok: false;
      reason: 'not_whatsapp' | 'identity' | 'account' | 'sender' | 'media';
    }
  | { ok: true; events: SandboxInboundEvent[] };

export type StagingOutboundDecision =
  | { send: false }
  | { send: true; accessToken: string; phoneNumberId: string };

export type StagingMediaResult =
  | { dataUrl: string }
  | { error: 'invalid' | 'type' | 'too_large' | 'timeout' | 'failed' };

type OpenAiBudget = {
  maxRequests: number;
  maxTotalTokens: number;
  requests: number;
  tokens: number;
};

let openAiBudget: OpenAiBudget | null = null;

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function positiveInt(value: unknown): number | null {
  const raw = trim(value);
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return parsed;
}

function optionalBoundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number | null {
  const raw = trim(value);
  if (!raw) return fallback;
  const parsed = positiveInt(raw);
  if (parsed == null || parsed < min || parsed > max) return null;
  return parsed;
}

function parseAllowlist(value: unknown): readonly string[] | null {
  const parts = trim(value)
    .split(',')
    .map((part) => normalizeWhatsAppDigits(part))
    .filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((part) => part.length < 8 || part.length > 15)) return null;
  return [...new Set(parts)];
}

function collidesWithProduction(env: NodeJS.ProcessEnv): boolean {
  return PRODUCTION_COLLISIONS.some(([stagingKey, productionKey]) => {
    const stagingValue = trim(env[stagingKey]);
    const productionValue = trim(env[productionKey]);
    return Boolean(stagingValue && productionValue && stagingValue === productionValue);
  });
}

function allowlistHitsProductionNumber(
  allowlist: readonly string[],
  env: NodeJS.ProcessEnv,
): boolean {
  const productionNumber = normalizeWhatsAppDigits(trim(env.WHATSAPP_NUMBER));
  return Boolean(productionNumber && allowlist.includes(productionNumber));
}

export function readStagingSandbox(
  env: NodeJS.ProcessEnv = process.env,
): StagingSandboxState {
  if (!isStagingRuntime(env)) return { active: false, reason: 'not_staging' };
  if (trim(env.STAGING_SANDBOX) !== STAGING_SANDBOX_ON) {
    return { active: false, reason: 'off' };
  }

  const phoneNumberId = trim(env.STAGING_WHATSAPP_PHONE_NUMBER_ID);
  const businessAccountId = trim(env.STAGING_WHATSAPP_BUSINESS_ACCOUNT_ID);
  const accessToken = trim(env.STAGING_WHATSAPP_ACCESS_TOKEN);
  const verifyToken = trim(env.STAGING_WHATSAPP_VERIFY_TOKEN);
  const appSecret = trim(env.STAGING_WHATSAPP_APP_SECRET);
  const displayNumber = normalizeWhatsAppDigits(trim(env.STAGING_WHATSAPP_NUMBER));
  const openAiApiKey = trim(env.STAGING_OPENAI_API_KEY);
  const allowlist = parseAllowlist(env.STAGING_WHATSAPP_ALLOWLIST);
  const maxRequests = positiveInt(env.STAGING_OPENAI_MAX_REQUESTS);
  const maxTotalTokens = positiveInt(env.STAGING_OPENAI_MAX_TOTAL_TOKENS);
  const mediaMaxBytes = optionalBoundedInt(
    env.STAGING_MEDIA_MAX_BYTES,
    DEFAULT_MEDIA_MAX_BYTES,
    1,
    DEFAULT_MEDIA_MAX_BYTES,
  );
  const mediaTimeoutMs = optionalBoundedInt(
    env.STAGING_MEDIA_TIMEOUT_MS,
    DEFAULT_MEDIA_TIMEOUT_MS,
    1_000,
    15_000,
  );

  const secretsLookReal =
    phoneNumberId.length >= 4 &&
    businessAccountId.length >= 4 &&
    accessToken.length >= 12 &&
    verifyToken.length >= 8 &&
    appSecret.length >= 12 &&
    displayNumber.length >= 8 &&
    openAiApiKey.length >= 12;

  if (
    !secretsLookReal ||
    !allowlist ||
    maxRequests == null ||
    maxTotalTokens == null ||
    mediaMaxBytes == null ||
    mediaTimeoutMs == null ||
    collidesWithProduction(env) ||
    allowlistHitsProductionNumber(allowlist, env)
  ) {
    return { active: false, reason: 'incomplete' };
  }

  return {
    active: true,
    config: {
      tallerId: STAGING_TALLER_ID,
      phoneNumberId,
      businessAccountId,
      accessToken,
      verifyToken,
      appSecret,
      displayNumber,
      allowlist,
      openAiApiKey,
      maxRequests,
      maxTotalTokens,
      mediaMaxBytes,
      mediaTimeoutMs,
      allowedMediaTypes: ALLOWED_MEDIA_TYPES,
    },
  };
}

export function rememberRawBody(
  req: IncomingMessage,
  _res: unknown,
  buf: Buffer,
): void {
  if (buf?.length) {
    (req as IncomingMessage & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
  }
}

export function verifyMetaWebhookSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  const provided = trim(header);
  const prefix = 'sha256=';
  if (!provided.startsWith(prefix) || !appSecret) return false;
  const got = provided.slice(prefix.length);
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  if (!/^[0-9a-f]+$/i.test(got) || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
}

function accountMatches(
  fields: {
    phoneNumberId?: string;
    wabaId?: string;
    displayPhoneNumber?: string;
  },
  config: StagingSandboxConfig,
): boolean {
  const phoneNumberId = trim(fields.phoneNumberId);
  const wabaId = trim(fields.wabaId);
  const display = normalizeWhatsAppDigits(trim(fields.displayPhoneNumber));
  if (!phoneNumberId || !wabaId || !display) return false;
  return (
    phoneNumberId === config.phoneNumberId &&
    wabaId === config.businessAccountId &&
    display === config.displayNumber
  );
}

export type StagingAccountField = 'phone_number_id' | 'waba' | 'display';

/**
 * Primer campo que impide `accountMatches`, en el mismo orden de la conjunción.
 * Null si la cuenta coincide o si falta identidad. No altera la decisión.
 */
export function stagingAccountMismatchField(
  fields: {
    phoneNumberId?: string;
    wabaId?: string;
    displayPhoneNumber?: string;
  },
  config: StagingSandboxConfig,
): StagingAccountField | null {
  if (accountMatches(fields, config)) return null;
  const phoneNumberId = trim(fields.phoneNumberId);
  const wabaId = trim(fields.wabaId);
  const display = normalizeWhatsAppDigits(trim(fields.displayPhoneNumber));
  if (!phoneNumberId || !wabaId || !display) return null;
  if (phoneNumberId !== config.phoneNumberId) return 'phone_number_id';
  if (wabaId !== config.businessAccountId) return 'waba';
  if (display !== config.displayNumber) return 'display';
  return null;
}

export function evaluateStagingSandboxInbound(
  body: unknown,
  config: StagingSandboxConfig,
): SandboxInboundDecision {
  if (!isMetaWhatsAppWebhook(body)) return { ok: false, reason: 'not_whatsapp' };
  const meta = extractWhatsAppWebhookMetadata(body);
  if (!meta.phoneNumberId || !meta.wabaId || !meta.displayPhoneNumber) {
    return { ok: false, reason: 'identity' };
  }
  if (!accountMatches(meta, config)) return { ok: false, reason: 'account' };

  const accepted: SandboxInboundEvent[] = [];
  let sawUnauthorizedSender = false;
  let sawUnusableMedia = false;
  for (const evt of extractMetaWhatsAppInboundEvents(body)) {
    if (
      !accountMatches(
        {
          phoneNumberId: evt.phoneNumberId,
          wabaId: evt.wabaId,
          displayPhoneNumber: evt.displayPhoneNumber,
        },
        config,
      )
    ) {
      continue;
    }
    const sender = normalizeWhatsAppDigits(evt.threadWaId);
    if (!config.allowlist.includes(sender)) {
      sawUnauthorizedSender = true;
      continue;
    }
    if (!evt.text && !evt.mediaId) {
      sawUnusableMedia = true;
      continue;
    }
    accepted.push({
      tallerId: STAGING_TALLER_ID,
      threadWaId: sender,
      contactName: evt.contactName,
      messageId: evt.messageId,
      text: evt.text,
      mediaId: evt.mediaId,
      buttonPayload: evt.buttonPayload,
    });
  }

  if (accepted.length) return { ok: true, events: accepted };
  if (sawUnauthorizedSender) return { ok: false, reason: 'sender' };
  if (sawUnusableMedia) return { ok: false, reason: 'media' };
  return { ok: false, reason: 'identity' };
}

export function assertStagingWhatsAppRecipient(
  rawTo: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const sandbox = readStagingSandbox(env);
  if (!sandbox.active) return false;
  const to = normalizeWhatsAppDigits(normalizeWhatsAppRecipientWaId(rawTo));
  if (!to) return false;
  return sandbox.config.allowlist.includes(to);
}

export function decideStagingOutbound(
  input: {
    channel: string;
    tallerId: string;
    metaPayload?: Record<string, unknown> | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): StagingOutboundDecision {
  const sandbox = readStagingSandbox(env);
  if (!sandbox.active) return { send: false };
  if (trim(input.channel).toLowerCase() !== 'whatsapp') return { send: false };
  if (trim(input.tallerId) !== STAGING_TALLER_ID) return { send: false };
  const to = trim(input.metaPayload?.to);
  if (!assertStagingWhatsAppRecipient(to, env)) return { send: false };
  return {
    send: true,
    accessToken: sandbox.config.accessToken,
    phoneNumberId: sandbox.config.phoneNumberId,
  };
}

export function decideStagingInboundJob(
  input: { tallerId: string; channel: string },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const sandbox = readStagingSandbox(env);
  if (!sandbox.active) return false;
  return (
    trim(input.tallerId) === STAGING_TALLER_ID &&
    trim(input.channel).toLowerCase() === 'whatsapp'
  );
}

function mediaHostAllowed(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'graph.facebook.com' ||
      host === 'lookaside.fbsbx.com' ||
      host === 'fbcdn.net' ||
      host.endsWith('.fbcdn.net')
    );
  } catch {
    return false;
  }
}

export async function downloadStagingWhatsAppMedia(
  mediaId: string,
  config: StagingSandboxConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<StagingMediaResult> {
  if (!MEDIA_ID_PATTERN.test(mediaId)) return { error: 'invalid' };
  const signal = AbortSignal.timeout(config.mediaTimeoutMs);
  try {
    const metaResponse = await fetchImpl(
      `https://graph.facebook.com/v21.0/${mediaId}`,
      {
        headers: { Authorization: `Bearer ${config.accessToken}` },
        redirect: 'manual',
        signal,
      },
    );
    if (!metaResponse.ok) return { error: 'failed' };
    const meta = (await metaResponse.json()) as {
      url?: unknown;
      mime_type?: unknown;
      file_size?: unknown;
    };
    const mime = trim(meta.mime_type);
    if (!config.allowedMediaTypes.includes(mime)) return { error: 'type' };
    const declaredSize = Number(meta.file_size ?? 0);
    if (Number.isFinite(declaredSize) && declaredSize > config.mediaMaxBytes) {
      return { error: 'too_large' };
    }
    const mediaUrl = trim(meta.url);
    if (!mediaUrl.startsWith('https://') || !mediaHostAllowed(mediaUrl)) {
      return { error: 'invalid' };
    }
    const binary = await fetchImpl(mediaUrl, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
      redirect: 'manual',
      signal,
    });
    if (!binary.ok) return { error: 'failed' };
    const advertised = Number(binary.headers.get('content-length') ?? 0);
    if (Number.isFinite(advertised) && advertised > config.mediaMaxBytes) {
      return { error: 'too_large' };
    }
    const bytes = Buffer.from(await binary.arrayBuffer());
    if (!bytes.length || bytes.length > config.mediaMaxBytes) {
      return { error: 'too_large' };
    }
    return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') return { error: 'timeout' };
    return { error: 'failed' };
  }
}

function blockedOpenAiResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: STAGING_EXTERNAL_BLOCKED,
        type: 'staging_sandbox_budget',
      },
    }),
    { status: 503, headers: { 'content-type': 'application/json' } },
  );
}

export function resetStagingOpenAiBudgetForTests(): void {
  openAiBudget = null;
}

export function stagingOpenAiFetch(
  config: Pick<StagingSandboxConfig, 'maxRequests' | 'maxTotalTokens'>,
  inner: typeof fetch = globalThis.fetch,
): typeof fetch {
  if (
    !openAiBudget ||
    openAiBudget.maxRequests !== config.maxRequests ||
    openAiBudget.maxTotalTokens !== config.maxTotalTokens
  ) {
    openAiBudget = {
      maxRequests: config.maxRequests,
      maxTotalTokens: config.maxTotalTokens,
      requests: 0,
      tokens: 0,
    };
  }
  const budget = openAiBudget;
  return async (input, init) => {
    if (budget.requests >= budget.maxRequests || budget.tokens >= budget.maxTotalTokens) {
      return blockedOpenAiResponse();
    }
    budget.requests += 1;
    const response = await inner(input, init);
    try {
      const usage = Number((await response.clone().json())?.usage?.total_tokens ?? 0);
      if (Number.isFinite(usage) && usage > 0) budget.tokens += usage;
    } catch {
      /* La respuesta no trae usage. El tope de solicitudes sigue vigente. */
    }
    return response;
  };
}
