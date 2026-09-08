/** Detección de stickers WhatsApp/Messenger para no mandarlos a visión. */

export function isWhatsAppStickerType(type: unknown): boolean {
  return String(type ?? '').toLowerCase().trim() === 'sticker';
}

export function isStickerMimeType(mime: unknown): boolean {
  const m = String(mime ?? '').toLowerCase().trim();
  return m === 'image/webp' || m === 'image/webp; charset=utf-8';
}

/** Messenger: attachment de imagen con sticker_id, o type sticker. */
export function isMessengerStickerAttachment(attachment: unknown): boolean {
  if (!attachment || typeof attachment !== 'object') return false;
  const a = attachment as {
    type?: unknown;
    payload?: { sticker_id?: unknown; url?: unknown; mime_type?: unknown };
  };
  const type = String(a.type ?? '').toLowerCase().trim();
  if (type === 'sticker') return true;
  if (type !== 'image') return false;
  if (a.payload?.sticker_id != null && String(a.payload.sticker_id).trim()) {
    return true;
  }
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
}): boolean {
  if (data.skipVisionAnalysis === true) return true;
  if (data.isSticker === true) return true;
  const kind = String(data.inboundMediaKind ?? '').toLowerCase().trim();
  if (kind === 'sticker') return true;
  if (isWhatsAppStickerType(data.messageType) || isWhatsAppStickerType(data.type)) {
    return true;
  }
  if (data.sticker != null && typeof data.sticker === 'object') return true;
  const mime = data.mimeType ?? data.mime_type;
  if (isStickerMimeType(mime) && (kind === 'sticker' || data.isSticker === true)) {
    return true;
  }
  return false;
}
