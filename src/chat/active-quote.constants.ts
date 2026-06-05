/** Borrador progresivo armado en chat (express / ítems acumulados). */
export const DRAFT_QUOTE_STATUS_ACTIVE = 'ACTIVE';

/** Estados que pueden recibir ítems progresivos vía tools. */
export const PROGRESSIVE_QUOTE_STATUSES = [
  DRAFT_QUOTE_STATUS_ACTIVE,
  'PENDING_APPROVAL',
  'APPROVED',
] as const;

export type ProgressiveQuoteStatus = (typeof PROGRESSIVE_QUOTE_STATUSES)[number];
