/** Origen de una línea de cotización. */
export type QuoteLineSource =
  | 'texto_cliente'
  | 'vision'
  | 'manual'
  | 'ai_suggestion';

export type QuoteLineReviewStatus =
  | 'pendiente_revision_fisica'
  | 'requiere_revision_manual';

/** Pieza extraída del mensaje del cliente (antes de catálogo). */
export type ExtractedClientPiece = {
  textoOriginal: string;
  panelCode?: string;
  nombreVisible?: string;
  severidadHint?: string;
  accion?: string;
  confidence: number;
};

/** Pieza resuelta contra catálogo del taller. */
export type ResolvedTextQuoteLine = {
  panelCode: string;
  nombreVisible: string;
  catalogServicio: string | null;
  severidad: string;
  precioOficial: number;
  precioFinal: number;
  fuente: QuoteLineSource;
  evidencia: string;
  confidence: number;
  notasInternas: string;
  estadoRevision: QuoteLineReviewStatus;
  unresolvedReason?: string;
};

export type TextQuoteProcessResult = {
  handled: boolean;
  clientMessage?: string;
  extractedPieces: ExtractedClientPiece[];
  resolvedLines: ResolvedTextQuoteLine[];
  unresolvedPieces: ExtractedClientPiece[];
  addedPanelCodes: string[];
  totalGuardado: number;
};
