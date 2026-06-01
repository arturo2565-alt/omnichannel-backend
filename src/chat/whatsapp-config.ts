/** Configuración WhatsApp Cloud API desde variables de entorno. */
export type WhatsAppEnvConfig = {
  businessAccountId: string;
  phoneNumberId: string;
  displayNumber: string;
  accessToken: string;
};

export function getWhatsAppEnvConfig(): WhatsAppEnvConfig {
  return {
    businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID?.trim() ?? '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? '',
    displayNumber: process.env.WHATSAPP_NUMBER?.trim() ?? '',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN?.trim() ?? '',
  };
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
