/** Detección de stickers WhatsApp/Messenger para no mandarlos a visión. */

export function isWhatsAppStickerType(type: unknown): boolean {
  return String(type ?? '').toLowerCase().trim() === 'sticker';
}

export function isStickerMimeType(mime: unknown): boolean {
  const m = String(mime ?? '').toLowerCase().trim();
  return m === 'image/webp' || m === 'image/webp; charset=utf-8';
}

/**
 * Stickers de Messenger suelen ser image/png en fbcdn con thumb chico
 * (`stp=dst-jpg_s100x100`) y sin `sticker_id`.
 */
export function isFacebookStickerUrl(raw: unknown): boolean {
  const url = String(raw ?? '').trim();
  if (!url || !/^https?:\/\//i.test(url)) return false;
  const lower = url.toLowerCase();
  if (/\bsticker\b/.test(lower)) return true;
  if (/\/stickers?\//i.test(url)) return true;
  if (/[?&]stp=[^&]*s1(?:00|20)x1(?:00|20)/i.test(url)) return true;
  if (/_s1(?:00|20)x1(?:00|20)/i.test(url)) return true;
  if (
    /fbcdn\.net|scontent\./i.test(lower) &&
    /s1(?:00|20)x1(?:00|20)/i.test(url)
  ) {
    return true;
  }
  return false;
}

/** Messenger: type sticker, sticker_id, webp, o URL típica de calcomanía fbcdn. */
export function isMessengerStickerAttachment(attachment: unknown): boolean {
  if (!attachment || typeof attachment !== 'object') return false;
  const a = attachment as {
    type?: unknown;
    payload?: { sticker_id?: unknown; url?: unknown; mime_type?: unknown };
  };
  const type = String(a.type ?? '').toLowerCase().trim();
  if (type === 'sticker') return true;
  const url = String(a.payload?.url ?? '').trim();
  if (a.payload?.sticker_id != null && String(a.payload.sticker_id).trim()) {
    return true;
  }
  if (isFacebookStickerUrl(url)) return true;
  if (type !== 'image') return false;
  return isStickerMimeType(a.payload?.mime_type);
}

export function looksLikeInboundStickerFlag(data: {
  skipVisionAnalysis?: unknown;
  inboundMediaKind?: unknown;
  messageType?: unknown;
  type?: unknown;
  mimeType?: unknown;
  mime_type?: unknown;
  isSticker?: unknown;
  sticker?: unknown;
  message?: unknown;
}): boolean {
  if (data.skipVisionAnalysis === true) return true;
  if (data.isSticker === true) return true;
  const kind = String(data.inboundMediaKind ?? '').toLowerCase().trim();
  if (kind === 'sticker') return true;
  if (isWhatsAppStickerType(data.messageType) || isWhatsAppStickerType(data.type)) {
    return true;
  }
  if (data.sticker != null && typeof data.sticker === 'object') return true;
  if (isFacebookStickerUrl(data.message)) return true;
  const mime = data.mimeType ?? data.mime_type;
  if (isStickerMimeType(mime) && (kind === 'sticker' || data.isSticker === true)) {
    return true;
  }
  return false;
}

export const STICKER_FALLBACK_TEXT = '[Sticker]';
