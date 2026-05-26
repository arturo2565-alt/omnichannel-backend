import type { DraftQuote } from './autofix-config';

/**
 * Mensaje listo para copiar/enviar al cliente (misma fuente que `formalNarrative`).
 * El frontend también lee `generatedMessage` y `clientMessage` por compatibilidad.
 */
export function normalizeDraftQuoteForClient(
  draft: DraftQuote | null | undefined,
): DraftQuote | null {
  if (!draft) return null;
  const extended = draft as DraftQuote & {
    generatedMessage?: string;
    clientMessage?: string;
  };
  const clientMessage = String(
    extended.clientMessage ??
      extended.generatedMessage ??
      draft.formalNarrative ??
      '',
  ).trim();
  return {
    ...draft,
    formalNarrative: clientMessage,
    generatedMessage: clientMessage,
    clientMessage,
  };
}
