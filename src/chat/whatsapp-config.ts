/** Configuración WhatsApp Cloud API desde variables de entorno. */
export type WhatsAppEnvConfig = {
  businessAccountId: string;
  phoneNumberId: string;
  displayNumber: string;
  accessToken: string;
};

/** Versión Graph API para WhatsApp Cloud. */
export const WHATSAPP_GRAPH_API_VERSION = 'v21.0';

export function getWhatsAppEnvConfig(): WhatsAppEnvConfig {
  return {
    businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID?.trim() ?? '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? '',
    displayNumber: process.env.WHATSAPP_NUMBER?.trim() ?? '',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN?.trim() ?? '',
  };
}

/** Token de verificación GET del webhook WhatsApp (`hub.verify_token` ↔ WHATSAPP_VERIFY_TOKEN). */
export function getWhatsAppVerifyToken(): string {
  return process.env.WHATSAPP_VERIFY_TOKEN?.trim() ?? '';
}

/** Access token permanente de WhatsApp Cloud API (Railway: WHATSAPP_ACCESS_TOKEN). */
export function getWhatsAppAccessToken(): string {
  return process.env.WHATSAPP_ACCESS_TOKEN?.trim() ?? '';
}

/** Phone Number ID de la línea de WhatsApp (Railway: WHATSAPP_PHONE_NUMBER_ID). */
export function getWhatsAppPhoneNumberId(): string {
  return process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? '';
}

/**
 * URL de envío de mensajes WhatsApp Cloud API.
 * POST …/{WHATSAPP_PHONE_NUMBER_ID}/messages con Authorization: Bearer.
 */
export function buildWhatsAppMessagesUrl(phoneNumberId?: string): string {
  const id = String(phoneNumberId ?? getWhatsAppPhoneNumberId()).trim();
  if (!id) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID no está configurado en el entorno.');
  }
  return `https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/${encodeURIComponent(id)}/messages`;
}

export function whatsAppEnvConfigured(cfg: WhatsAppEnvConfig = getWhatsAppEnvConfig()): boolean {
  return Boolean(
    cfg.businessAccountId ||
      cfg.phoneNumberId ||
      cfg.displayNumber ||
      cfg.accessToken,
  );
}

/** Solo dígitos (E.164 sin +). */
export function normalizeWhatsAppDigits(raw: string): string {
  return String(raw ?? '').replace(/\D/g, '');
}

/**
 * Normaliza wa_id / teléfono destino para envío WhatsApp Cloud API.
 * México: Meta a veces entrega 521XXXXXXXXXX (13 dígitos); la API espera 52XXXXXXXXXX (12).
 */
export function normalizeWhatsAppRecipientWaId(raw: string): string {
  let digits = normalizeWhatsAppDigits(raw);
  if (digits.startsWith('521') && digits.length === 13) {
    digits = `52${digits.slice(3)}`;
  }
  return digits;
}

export type WhatsAppOwnershipFields = {
  wabaId?: string;
  phoneNumberId?: string;
  displayPhoneNumber?: string;
};

/**
 * Valida que el webhook pertenezca a nuestra cuenta/número configurado.
 * Si no hay variables de entorno, acepta todo (modo desarrollo).
 */
export function isWhatsAppPayloadForOurAccount(
  fields: WhatsAppOwnershipFields,
  cfg: WhatsAppEnvConfig = getWhatsAppEnvConfig(),
): boolean {
  const wabaId = String(fields.wabaId ?? '').trim();
  const phoneNumberId = String(fields.phoneNumberId ?? '').trim();
  const displayPhoneNumber = String(fields.displayPhoneNumber ?? '').trim();

  const expectWaba = Boolean(cfg.businessAccountId);
  const expectPhoneId = Boolean(cfg.phoneNumberId);
  const expectDisplay = Boolean(cfg.displayNumber);

  if (!expectWaba && !expectPhoneId && !expectDisplay) {
    return true;
  }

  if (expectPhoneId && phoneNumberId && phoneNumberId === cfg.phoneNumberId) {
    return true;
  }
  if (expectWaba && wabaId && wabaId === cfg.businessAccountId) {
    return true;
  }
  if (expectDisplay && displayPhoneNumber) {
    const incoming = normalizeWhatsAppDigits(displayPhoneNumber);
    const ours = normalizeWhatsAppDigits(cfg.displayNumber);
    if (incoming && ours && (incoming === ours || incoming.endsWith(ours) || ours.endsWith(incoming))) {
      return true;
    }
  }

  return false;
}

/** Extrae metadatos de propiedad del primer change del payload WhatsApp. */
export function extractWhatsAppOwnershipFromBody(body: unknown): WhatsAppOwnershipFields {
  const b = body as Record<string, unknown> | null;
  if (!b || !Array.isArray(b.entry) || !b.entry[0]) return {};
  const entry = b.entry[0] as Record<string, unknown>;
  const wabaId = String(entry.id ?? '').trim();
  const changes = Array.isArray(entry.changes) ? entry.changes : [];
  for (const change of changes) {
    if (!change || typeof change !== 'object') continue;
    const value = (change as Record<string, unknown>).value;
    if (!value || typeof value !== 'object') continue;
    const metadata =
      (value as Record<string, unknown>).metadata &&
      typeof (value as Record<string, unknown>).metadata === 'object'
        ? ((value as Record<string, unknown>).metadata as Record<string, unknown>)
        : {};
    return {
      wabaId,
      phoneNumberId: String(metadata.phone_number_id ?? '').trim(),
      displayPhoneNumber: String(metadata.display_phone_number ?? '').trim(),
    };
  }
  return { wabaId };
}
