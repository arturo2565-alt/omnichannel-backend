const SENSITIVE_KEY =
  /^(phone|telefono|tel|mobile|whatsapp|waid|waId|psid|senderId|recipientId|fullName|nombre|nombreCompleto|customerName|contactName|displayName|jwt|authorization|token|apiKey|apikey|api_key|access_token|accessToken|pageAccessToken|appSecret|app_secret|verify_token|verifyToken|cookie|password|secret|prompt|systemPrompt|conversationTurns|messages|history|rawHits|samples|pages)$/i;

const MAX_STRING = 240;
const MAX_ARRAY = 40;
const MAX_DEPTH = 6;

export function redactEvidenceRefForTrace(url: string): string {
  const s = String(url ?? '').trim();
  if (!s) return '';
  if (/^data:image\//i.test(s)) return '[data-url]';
  try {
    const u = new URL(s);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    const tail = last.length > 16 ? `…${last.slice(-12)}` : last;
    return tail ? `${u.hostname}/${tail}` : u.hostname;
  } catch {
    return '[redacted-url]';
  }
}

function looksLikeUrl(value: string): boolean {
  return (
    /^https?:\/\//i.test(value) ||
    /^data:image\//i.test(value) ||
    /X-Amz-|Signature=|X-Goog-Signature|token=/i.test(value)
  );
}

function looksLikeJwt(value: string): boolean {
  return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value);
}

function looksLikePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return (
    /^\+?\d[\d\s-]{9,}$/.test(value.trim()) &&
    digits.length >= 10 &&
    digits.length <= 15
  );
}

function redactSecretPatterns(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [redacted]')
    .replace(/EAA[A-Za-z0-9]{10,}/g, '[redacted]');
}

export function sanitizeTracePayload(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (value == null) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (looksLikeJwt(value) || looksLikePhone(value)) return '[redacted]';
    const withoutSecrets = redactSecretPatterns(value);
    if (looksLikeUrl(withoutSecrets)) return redactEvidenceRefForTrace(withoutSecrets);
    if (withoutSecrets.length > MAX_STRING) return `${withoutSecrets.slice(0, 120)}…`;
    return withoutSecrets;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY)
      .map((item) => sanitizeTracePayload(item, depth + 1));
  }
  if (typeof value !== 'object') return String(value);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      if (typeof child === 'string' && !/samples|rawHits|pages|history|messages/i.test(key)) {
        continue;
      }
      if (typeof child !== 'string') continue;
    }
    if (/url/i.test(key) && typeof child === 'string') {
      out[key] = redactEvidenceRefForTrace(child);
      continue;
    }
    out[key] = sanitizeTracePayload(child, depth + 1);
  }
  return out;
}

export function dropEmpty(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return out;
}
