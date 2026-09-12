import {
  CANONICAL_LLM_TOOL_INSTRUCTION,
  isCanonicalToolContext,
  sanitizeToolResultForLlm,
  shouldPreferCanonicalOnCartMutation,
  toolResultHasExposedMoney,
} from './llm-tool-result-sanitize';

describe('Fase 8 — tool result expuesto al LLM', () => {
  it('una tool moderna actualiza la cotización sin entregar importes al modelo', () => {
    const internal = {
      success: true,
      totalMx: 9900,
      subtotalMx: 9900,
      expressTotalMx: 9900,
      totalGlobal: 9900,
      desglose: [{ pieza: 'Fascia', precioMx: 6500 }],
      canonicalQuoteV1: { total: 9900 },
      quoteFlowMode: 'CANONICAL',
      vehicleDisplayLabel: 'Mazda 3 2020',
      diasEntrega: 5,
    };

    const exposed = sanitizeToolResultForLlm(internal, {
      toolName: 'obtenerCotizacionExpress',
    });

    expect(exposed).toMatchObject({
      success: true,
      quoteUpdated: true,
      quoteMode: 'CANONICAL',
      requiresCanonicalComposition: true,
    });
    expect(exposed.vehicleDisplayLabel).toBe('Mazda 3 2020');
    expect(exposed.diasEntrega).toBe(5);
    expect(exposed.instruccionParaModelo).toBe(CANONICAL_LLM_TOOL_INSTRUCTION);
    expect(toolResultHasExposedMoney(exposed)).toBe(false);
    expect(internal.totalMx).toBe(9900);
    expect(internal.canonicalQuoteV1).toEqual({ total: 9900 });
  });

  it('no sanitiza un carrito LEGACY histórico', () => {
    const internal = {
      success: true,
      quoteFlowMode: 'LEGACY',
      totalGlobal: 4500,
      desglose: [{ pieza: 'Puerta', precioMx: 4500 }],
    };
    const exposed = sanitizeToolResultForLlm(internal, {
      toolName: 'obtenerCarritoActual',
    });
    expect(exposed.totalGlobal).toBe(4500);
    expect(exposed.desglose).toEqual(internal.desglose);
  });

  it('express exitoso se trata como CANONICAL aunque falte quoteFlowMode', () => {
    expect(
      isCanonicalToolContext('obtenerCotizacionExpress', { success: true, totalMx: 1 }),
    ).toBe(true);
  });

  it('agregarAlCarrito en carrito vacío nuevo prefiere CANONICAL', () => {
    expect(shouldPreferCanonicalOnCartMutation({ quotePayload: undefined })).toBe(
      true,
    );
    expect(shouldPreferCanonicalOnCartMutation({ quotePayload: {} })).toBe(true);
    expect(
      shouldPreferCanonicalOnCartMutation({
        quotePayload: { quoteFlowMode: 'LEGACY' },
      }),
    ).toBe(false);
  });

  it('elimina totalCombinadoMx del agregado multi-vehículo', () => {
    const exposed = sanitizeToolResultForLlm(
      {
        success: true,
        quoteFlowMode: 'CANONICAL',
        cotizacionMultiVehiculo: {
          totalCombinadoMx: 40000,
          vehiculos: [
            { modeloVehiculo: 'Aveo 2015', totalMx: 15000 },
            { modeloVehiculo: 'Jetta 2019', totalMx: 25000 },
          ],
        },
      },
      { toolName: 'obtenerCotizacionExpress' },
    );
    expect(exposed.cotizacionMultiVehiculo).toBeUndefined();
    expect(exposed.vehicleLabels).toEqual(['Aveo 2015', 'Jetta 2019']);
    expect(exposed.vehicleCount).toBe(2);
    expect(toolResultHasExposedMoney(exposed)).toBe(false);
  });
});
