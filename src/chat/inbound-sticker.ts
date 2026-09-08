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

/** Misma calcomanía con distintos `oh`/`oe`/`stp` de fbcdn. */
export function normalizeMediaUrlForDedup(raw: unknown): string {
  const url = String(raw ?? '').trim();
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.toLowerCase();
  } catch {
    return url.split('?')[0].split('#')[0].toLowerCase();
  }
}

export function uniqueUrlsByPath(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const trimmed = String(url ?? '').trim();
    if (!trimmed) continue;
    const key = normalizeMediaUrlForDedup(trimmed) || trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Meta manda el Like (y otros stickers) como `sticker_id` + imagen preview.
 * Un evento = una calcomanía; las fotos hermanas no se persisten.
 */
export function resolveMessengerInboundMedia(input: {
  attachments?: unknown[];
  text?: unknown;
  stickerId?: unknown;
}): { stickerUrls: string[]; imageUrls: string[] } {
  const stickerUrls: string[] = [];
  const imageUrls: string[] = [];
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  for (const a of attachments) {
    if (!a || typeof a !== 'object') continue;
    const url = String(
      (a as { payload?: { url?: unknown } }).payload?.url ?? '',
    ).trim();
    if (!url) continue;
    if (isMessengerStickerAttachment(a)) {
      stickerUrls.push(url);
      continue;
    }
    if (String((a as { type?: unknown }).type).toLowerCase() === 'image') {
      imageUrls.push(url);
    }
  }

  const text = String(input.text ?? '').trim();
  if (text && isFacebookStickerUrl(text)) {
    const textKey = normalizeMediaUrlForDedup(text);
    const already = stickerUrls.some(
      (u) => normalizeMediaUrlForDedup(u) === textKey,
    );
    if (!already && stickerUrls.length === 0) {
      stickerUrls.push(text);
    }
  }

  const hasRootSticker =
    input.stickerId != null && String(input.stickerId).trim() !== '';
  if (stickerUrls.length > 0 || hasRootSticker) {
    if (stickerUrls.length === 0 && imageUrls.length > 0) {
      stickerUrls.push(imageUrls[0]!);
    }
    return {
      stickerUrls: uniqueUrlsByPath(stickerUrls).slice(0, 1),
      imageUrls: [],
    };
  }

  return { stickerUrls: [], imageUrls: uniqueUrlsByPath(imageUrls) };
}
