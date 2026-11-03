const MESSAGE_LIMIT = 180;

export const VISION_FAILURE_STAGE = 'vision_peritaje' as const;

export type VisionFailureDetails = {
  stage: typeof VISION_FAILURE_STAGE;
  errorName: string;
  status?: number;
  code?: string;
  errorType?: string;
  message: string;
};

function readStatus(record: object): number | undefined {
  const raw = (record as { status?: unknown; statusCode?: unknown }).status
    ?? (record as { statusCode?: unknown }).statusCode;
  const status = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(status) || status < 100 || status > 599) return undefined;
  return status;
}

function readNestedString(
  record: object,
  key: 'code' | 'type',
): string | undefined {
  const own = (record as Record<string, unknown>)[key];
  const nested = (record as { error?: Record<string, unknown> }).error?.[key];
  const raw = own ?? nested;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw !== 'string') return undefined;
  const clean = sanitizeVisionErrorMessage(raw);
  return clean && clean !== 'error sin mensaje' ? clean.slice(0, 64) : undefined;
}

/** Deja el motivo del proveedor y retira fotos, credenciales, URLs y textos largos. */
export function sanitizeVisionErrorMessage(raw: unknown): string {
  let text = String(raw ?? '');
  text = text.replace(
    /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]*/gi,
    '[data-url]',
  );
  text = text.replace(/bearer\s+[a-z0-9\-._~+/]+=*/gi, 'Bearer [redacted]');
  text = text.replace(
    /\b(authorization|api[-_ ]?key|access[-_ ]?token|x-api-key)\s*[:=]\s*\S+/gi,
    '$1 [redacted]',
  );
  text = text.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]');
  text = text.replace(/EAA[A-Za-z0-9]{8,}/g, '[redacted]');
  text = text.replace(
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    '[redacted]',
  );
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, '[url]');
  text = text.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '[base64]');
  text = text.replace(/\b\+?\d[\d\s-]{9,}\b/g, (match) => {
    const digits = match.replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 15 ? '[phone]' : match;
  });
  text = text.replace(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    '[email]',
  );
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > MESSAGE_LIMIT) {
    text = `${text.slice(0, MESSAGE_LIMIT - 1)}…`;
  }
  return text || 'error sin mensaje';
}

/**
 * Campos que pueden imprimirse cuando falla vision_peritaje.
 * No copia cabeceras, cuerpos ni la excepción completa.
 */
export function describeVisionFailure(err: unknown): VisionFailureDetails {
  const error = err instanceof Error ? err : undefined;
  const record = err !== null && typeof err === 'object' ? err : undefined;
  const status = record ? readStatus(record) : undefined;
  const code = record ? readNestedString(record, 'code') : undefined;
  const errorType = record ? readNestedString(record, 'type') : undefined;
  const rawMessage = error?.message || (typeof err === 'string' ? err : '');
  return {
    stage: VISION_FAILURE_STAGE,
    errorName: (error?.name || 'Error').slice(0, 80),
    ...(status != null ? { status } : {}),
    ...(code ? { code } : {}),
    ...(errorType ? { errorType } : {}),
    message: sanitizeVisionErrorMessage(rawMessage),
  };
}
