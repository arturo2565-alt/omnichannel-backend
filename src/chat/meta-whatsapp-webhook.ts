/** Evento normalizado de webhook WhatsApp Cloud API (Meta). */
export type MetaWhatsAppInboundEvent = {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  field: string;
  /** wa_id / from del cliente — identificador estable del hilo. */
  threadWaId: string;
  contactName: string;
  messageId: string;
  text: string;
  /**
   * Payload / id del botón interactivo (si Meta lo envía aparte del título).
   * Vacío en mensajes de texto libre.
   */
  buttonPayload: string;
  /** URL directa si el payload ya trae enlace (p. ej. reenvío legacy). */
  imageUrl: string;
  /** true = webhook de entrega/lectura (sin mensaje entrante). */
  isStatusOnly?: boolean;
};

function pickTrimmed(...values: unknown[]): string {
  for (const v of values) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

/**
 * Webhook WhatsApp Cloud API: `object: "whatsapp_business_account"` + `entry[].changes[]`.
 */
export function isMetaWhatsAppWebhook(body: unknown): boolean {
  const b = body as Record<string, unknown> | null;
  if (!b || !Array.isArray(b.entry)) return false;
  if (b.object === 'whatsapp_business_account') return true;
  return b.entry.some(
    (e) =>
      e &&
      typeof e === 'object' &&
      Array.isArray((e as Record<string, unknown>).changes) &&
      ((e as Record<string, unknown>).changes as unknown[]).some((ch) => {
        if (!ch || typeof ch !== 'object') return false;
        const value = (ch as Record<string, unknown>).value;
        if (!value || typeof value !== 'object') return false;
        return (
          String((value as Record<string, unknown>).messaging_product ?? '')
            .toLowerCase()
            .trim() === 'whatsapp'
        );
      }),
  );
}

function contactNameFromMap(
  waId: string,
  contactByWaId: Map<string, string>,
): string {
  const fromContacts = contactByWaId.get(waId)?.trim();
  if (fromContacts) return fromContacts;
  if (/^\d{8,}$/.test(waId)) return `WhatsApp +${waId}`;
  return 'Cliente WhatsApp';
}

function parseWhatsAppMessageContent(msg: Record<string, unknown>): {
  text: string;
  imageUrl: string;
  buttonPayload: string;
} {
  const type = String(msg.type ?? 'text').toLowerCase().trim();
  if (type === 'text') {
    const body =
      msg.text &&
      typeof msg.text === 'object' &&
      (msg.text as Record<string, unknown>).body != null
        ? String((msg.text as Record<string, unknown>).body).trim()
        : '';
    return { text: body, imageUrl: '', buttonPayload: '' };
  }
  if (type === 'image') {
    const image =
      msg.image && typeof msg.image === 'object'
        ? (msg.image as Record<string, unknown>)
        : null;
    const link = pickTrimmed(image?.link, image?.url);
    const caption = pickTrimmed(image?.caption);
    return {
      text: caption,
      imageUrl: link,
      buttonPayload: '',
    };
  }
  if (type === 'button') {
    const button =
      msg.button && typeof msg.button === 'object'
        ? (msg.button as Record<string, unknown>)
        : null;
    const buttonPayload = pickTrimmed(button?.payload);
    return {
      text: pickTrimmed(button?.text, button?.payload),
      imageUrl: '',
      buttonPayload,
    };
  }
  if (type === 'interactive') {
    const interactive =
      msg.interactive && typeof msg.interactive === 'object'
        ? (msg.interactive as Record<string, unknown>)
        : null;
    const buttonReply =
      interactive?.button_reply &&
      typeof interactive.button_reply === 'object'
        ? (interactive.button_reply as Record<string, unknown>)
        : null;
    const listReply =
      interactive?.list_reply &&
      typeof interactive.list_reply === 'object'
        ? (interactive.list_reply as Record<string, unknown>)
        : null;
    const buttonPayload = pickTrimmed(buttonReply?.id, listReply?.id);
    return {
      text: pickTrimmed(
        buttonReply?.title,
        buttonReply?.id,
        listReply?.title,
        listReply?.id,
      ),
      imageUrl: '',
      buttonPayload,
    };
  }
  return { text: '', imageUrl: '', buttonPayload: '' };
}

/** Metadatos del primer change (validación de cuenta / número). */
export function extractWhatsAppWebhookMetadata(body: unknown): {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  hasMessages: boolean;
  hasStatuses: boolean;
} {
  const b = body as Record<string, unknown> | null;
  const empty = {
    wabaId: '',
    phoneNumberId: '',
    displayPhoneNumber: '',
    hasMessages: false,
    hasStatuses: false,
  };
  if (!b || !Array.isArray(b.entry)) return empty;

  for (const entry of b.entry) {
    if (!entry || typeof entry !== 'object') continue;
    const er = entry as Record<string, unknown>;
    const wabaId = pickTrimmed(er.id);
    const changes = Array.isArray(er.changes) ? er.changes : [];
    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const value =
        (change as Record<string, unknown>).value &&
        typeof (change as Record<string, unknown>).value === 'object'
          ? ((change as Record<string, unknown>).value as Record<string, unknown>)
          : null;
      if (!value) continue;
      const metadata =
        value.metadata && typeof value.metadata === 'object'
          ? (value.metadata as Record<string, unknown>)
          : {};
      const messages = Array.isArray(value.messages) ? value.messages : [];
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      return {
        wabaId,
        phoneNumberId: pickTrimmed(metadata.phone_number_id),
        displayPhoneNumber: pickTrimmed(metadata.display_phone_number),
        hasMessages: messages.length > 0,
        hasStatuses: statuses.length > 0,
      };
    }
  }
  return empty;
}

/**
 * Extrae mensajes entrantes del payload bruto de Meta WhatsApp.
 * Ignora `statuses`, plantillas y cambios sin `messages`.
 */
export function extractMetaWhatsAppInboundEvents(
  body: unknown,
): MetaWhatsAppInboundEvent[] {
  const b = body as Record<string, unknown> | null;
  if (!b || !Array.isArray(b.entry)) return [];

  const out: MetaWhatsAppInboundEvent[] = [];

  for (const entry of b.entry) {
    if (!entry || typeof entry !== 'object') continue;
    const er = entry as Record<string, unknown>;
    const wabaId = pickTrimmed(er.id);
    const changes = Array.isArray(er.changes) ? er.changes : [];

    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const cr = change as Record<string, unknown>;
      const field = pickTrimmed(cr.field);
      const value =
        cr.value && typeof cr.value === 'object'
          ? (cr.value as Record<string, unknown>)
          : null;
      if (!value) continue;

      const product = String(value.messaging_product ?? '')
        .toLowerCase()
        .trim();
      if (product && product !== 'whatsapp') continue;

      const metadata =
        value.metadata && typeof value.metadata === 'object'
          ? (value.metadata as Record<string, unknown>)
          : {};
      const displayPhoneNumber = pickTrimmed(metadata.display_phone_number);
      const phoneNumberId = pickTrimmed(metadata.phone_number_id);

      const contactByWaId = new Map<string, string>();
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      for (const c of contacts) {
        if (!c || typeof c !== 'object') continue;
        const cr2 = c as Record<string, unknown>;
        const waId = pickTrimmed(cr2.wa_id);
        if (!waId) continue;
        const profile =
          cr2.profile && typeof cr2.profile === 'object'
            ? (cr2.profile as Record<string, unknown>)
            : null;
        const name = pickTrimmed(profile?.name);
        if (name) contactByWaId.set(waId, name);
      }

      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const rawMsg of messages) {
        if (!rawMsg || typeof rawMsg !== 'object') continue;
        const msg = rawMsg as Record<string, unknown>;
        const threadWaId = pickTrimmed(msg.from);
        if (!threadWaId) continue;

        const messageId = pickTrimmed(msg.id);
        const { text, imageUrl, buttonPayload } =
          parseWhatsAppMessageContent(msg);
        if (!text && !imageUrl) continue;

        out.push({
          wabaId,
          phoneNumberId,
          displayPhoneNumber,
          field: field || 'messages',
          threadWaId,
          contactName: contactNameFromMap(threadWaId, contactByWaId),
          messageId,
          text,
          buttonPayload,
          imageUrl,
        });
      }
    }
  }

  return out;
}

/** Fallback si el payload WhatsApp llegó sin normalizar al modo legacy. */
export function extractWaIdFromRawWhatsAppPayload(body: unknown): string {
  const events = extractMetaWhatsAppInboundEvents(body);
  if (events[0]?.threadWaId) return events[0].threadWaId;

  const b = body as Record<string, unknown> | null;
  if (!b) return '';

  const direct = pickTrimmed(b.wa_id, b.waId, b.from);
  if (direct) return direct;

  if (!Array.isArray(b.entry)) return '';
  for (const entry of b.entry) {
    if (!entry || typeof entry !== 'object') continue;
    const changes = Array.isArray((entry as Record<string, unknown>).changes)
      ? ((entry as Record<string, unknown>).changes as unknown[])
      : [];
    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const value = (change as Record<string, unknown>).value;
      if (!value || typeof value !== 'object') continue;
      const vr = value as Record<string, unknown>;
      const contacts = Array.isArray(vr.contacts) ? vr.contacts : [];
      for (const c of contacts) {
        if (!c || typeof c !== 'object') continue;
        const waId = pickTrimmed((c as Record<string, unknown>).wa_id);
        if (waId) return waId;
      }
    }
  }
  return '';
}
