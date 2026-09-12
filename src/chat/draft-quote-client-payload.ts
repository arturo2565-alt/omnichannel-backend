import type { DraftQuote } from './autofix-config';

/**
 * `clientMessage` es el FINAL CLIENT MESSAGE (flujo moderno).
 * `formalNarrative` y `generatedMessage` se sincronizan para no divergir.
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
