import * as Sentry from '@sentry/node';
import { getLlmAuditContext } from '../chat/llm-audit-context';
import { isSentryEnabled } from './sentry.init';

export type SentryAlsTags = {
  tallerId?: string | null;
  conversationId?: string | null;
  source?: string | null;
};

/** Aplica tags desde ALS y/o overrides explícitos al scope actual. */
export function applySentryAlsTags(extra?: SentryAlsTags): void {
  if (!isSentryEnabled()) return;
  const als = getLlmAuditContext();
  const tallerId = String(
    extra?.tallerId ?? als?.tallerId ?? '',
  ).trim();
  const conversationId = String(
    extra?.conversationId ?? als?.conversationId ?? '',
  ).trim();
  const source = String(extra?.source ?? '').trim();

  if (tallerId) Sentry.setTag('tallerId', tallerId);
  if (conversationId) Sentry.setTag('conversationId', conversationId);
  if (source) Sentry.setTag('source', source);
}

/** Captura excepción enriquecida con ALS (no-op si Sentry está off). */
export function captureExceptionWithAls(
  exception: unknown,
  extra?: SentryAlsTags,
): void {
  if (!isSentryEnabled()) return;
  Sentry.withScope((scope) => {
    const als = getLlmAuditContext();
    const tallerId = String(
      extra?.tallerId ?? als?.tallerId ?? '',
    ).trim();
    const conversationId = String(
      extra?.conversationId ?? als?.conversationId ?? '',
    ).trim();
    const source = String(extra?.source ?? '').trim();
    if (tallerId) scope.setTag('tallerId', tallerId);
    if (conversationId) scope.setTag('conversationId', conversationId);
    if (source) scope.setTag('source', source);
    Sentry.captureException(exception);
  });
}
