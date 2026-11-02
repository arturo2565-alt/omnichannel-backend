/**
 * Observabilidad temporal del webhook de staging.
 * Solo emite con PEGAZUZ_ENV=staging. El payload admite únicamente
 * enumeraciones y un conteo: nunca el cuerpo, teléfonos, ids ni secretos.
 */
import { isStagingRuntime } from '../config/staging-guard';
import {
  evaluateStagingSandboxInbound,
  stagingAccountMismatchField,
  verifyMetaWebhookSignature,
  type StagingAccountField,
  type StagingSandboxConfig,
} from '../config/staging-sandbox';
import {
  extractWhatsAppWebhookMetadata,
  isMetaWhatsAppWebhook,
} from '../chat/meta-whatsapp-webhook';
import { pegLogger } from './pegazuz-logger';

export type StagingWebhookBodyKind = 'whatsapp' | 'other' | 'empty';
export type StagingWebhookSignatureState = 'valid' | 'invalid' | 'missing';
export type StagingWebhookPersistOutcome = 'saved' | 'skipped' | 'failed';

const BODY_KINDS = new Set<StagingWebhookBodyKind>(['whatsapp', 'other', 'empty']);
const SIGNATURES = new Set<StagingWebhookSignatureState>([
  'valid',
  'invalid',
  'missing',
]);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const ERROR_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,80}$/;

export function classifyStagingWebhookBody(body: unknown): StagingWebhookBodyKind {
  if (body == null) return 'empty';
  if (typeof body === 'string') return body.trim() ? 'other' : 'empty';
  if (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0) {
    return 'empty';
  }
  return isMetaWhatsAppWebhook(body) ? 'whatsapp' : 'other';
}

export function classifyStagingWebhookSignature(
  rawBody: Buffer | undefined,
  header: string | undefined,
  appSecret: string,
): StagingWebhookSignatureState {
  const provided = String(header ?? '').trim();
  if (!provided) return 'missing';
  if (!rawBody?.length || !verifyMetaWebhookSignature(rawBody, provided, appSecret)) {
    return 'invalid';
  }
  return 'valid';
}

function safeErrorName(name: string | undefined): string {
  const value = String(name ?? '').trim();
  return ERROR_NAME.test(value) ? value : 'Error';
}

export function logStagingWebhookHttpIn(input: {
  method: string;
  bodyKind: StagingWebhookBodyKind;
  signature: StagingWebhookSignatureState;
}): void {
  if (!isStagingRuntime()) return;
  pegLogger.info('WEBHOOK', {
    event: 'http_in',
    method: METHODS.has(input.method) ? input.method : 'POST',
    bodyKind: BODY_KINDS.has(input.bodyKind) ? input.bodyKind : 'other',
    signature: SIGNATURES.has(input.signature) ? input.signature : 'invalid',
  });
}

export function logStagingSandboxDecision(
  body: unknown,
  config: StagingSandboxConfig,
): void {
  if (!isStagingRuntime()) return;
  const decision = evaluateStagingSandboxInbound(body, config);
  if (decision.ok) {
    pegLogger.info('WEBHOOK', { event: 'decision', result: 'accepted' });
    return;
  }
  if (decision.reason === 'account') {
    const accountField: StagingAccountField | null = stagingAccountMismatchField(
      extractWhatsAppWebhookMetadata(body),
      config,
    );
    pegLogger.info('WEBHOOK', {
      event: 'decision',
      result: 'account',
      ...(accountField ? { accountField } : {}),
    });
    return;
  }
  pegLogger.info('WEBHOOK', { event: 'decision', result: decision.reason });
}

export function logStagingWebhookPersist(input: {
  processed: number;
  outcome: StagingWebhookPersistOutcome;
  errorName?: string;
}): void {
  if (!isStagingRuntime()) return;
  const processed =
    Number.isSafeInteger(input.processed) && input.processed >= 0
      ? input.processed
      : 0;
  const data: {
    event: 'persist';
    processed: number;
    outcome: StagingWebhookPersistOutcome;
    errorName?: string;
  } = {
    event: 'persist',
    processed,
    outcome: input.outcome,
  };
  if (input.outcome === 'failed') {
    data.errorName = safeErrorName(input.errorName);
  }
  pegLogger.info('WEBHOOK', data);
}
