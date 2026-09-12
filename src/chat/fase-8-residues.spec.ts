import { resolveAuthoritativeDraftFinance } from './canonical-quote-engine';
import { quoteRowsFromDamageInventory } from './draft-quote-inventory-pricing';
import { shouldPreferCanonicalOnCartMutation } from './llm-tool-result-sanitize';
import { QUOTE_FLOW_MODE, resolveQuoteFlowMode } from '../domain/peritaje-v1/quote-flow-mode';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import type { DraftQuote } from './autofix-config';
import type { DetectedDamageItem } from './entities/chat.entity';

function snap(): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: () => 4000,
    getAmount: () => 4000,
    getDiasEntregaForCanonical: () => 5,
    listSeveridadesForCanonical: () => ['DL'],
  } as unknown as MatrixPricingSnapshot;
}

function emptyDraft(): DraftQuote {
  return {
    status: 'PENDING_APPROVAL',
    currency: 'MXN',
    reference: 't',
    generatedAt: '2026-09-11T00:00:00.000Z',
    lines: [],
    subtotal: 0,
    total: 0,
    formalNarrative: '',
    analysisBasis: {
      pieza: 'x',
      severidad: 'DL',
      partesAfectadas: [],
      severidadDelDano: 'DL',
      descripcionTecnica: '',
      justificacion: '',
    },
  };
}

describe('Fase 8 — residuos', () => {
  it('carrito vacío nuevo → agregarAlCarrito → quoteFlowMode CANONICAL', () => {
    const pricing = snap();
    const item: DetectedDamageItem = {
      pieza: 'Puerta',
      severidad: 'DL',
      descripcionTecnica: 'Agregado por chat',
      urls_origen: [],
    };
    expect(shouldPreferCanonicalOnCartMutation({ quotePayload: undefined })).toBe(
      true,
    );
    expect(
      resolveQuoteFlowMode({ preferCanonical: true }).mode,
    ).toBe(QUOTE_FLOW_MODE.CANONICAL);

    const rows = quoteRowsFromDamageInventory([item], pricing);
    const finance = resolveAuthoritativeDraftFinance({
      pricedInventory: [item],
      snap: pricing,
      priorDraft: emptyDraft(),
      legacyDraft: { ...emptyDraft(), total: 4000, subtotal: 4000 },
      legacyEstimate: 4000,
      preferCanonical: true,
      pricedRows: rows,
    });
    expect(finance.mode).toBe('canonical');
    expect(finance.draft.quoteFlowMode).toBe('CANONICAL');
  });

  it('registro LEGACY histórico no se fuerza a CANONICAL', () => {
    expect(
      shouldPreferCanonicalOnCartMutation({
        quotePayload: { quoteFlowMode: 'LEGACY' },
      }),
    ).toBe(false);
    expect(
      resolveQuoteFlowMode({ lockedMode: QUOTE_FLOW_MODE.LEGACY }).mode,
    ).toBe(QUOTE_FLOW_MODE.LEGACY);
  });
});
