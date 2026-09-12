import {
  buildVisionShadowSafe,
  commitVisionShadowToDraft,
} from './canonical-shadow-write';
import type { DraftQuoteEntity } from './entities/draft-quote.entity';
import type { VehicleDamageAnalysis } from './entities/chat.entity';
import { buildVisionCanonicalShadow } from '../domain/peritaje-v1';

function analysis(): VehicleDamageAnalysis {
  return {
    pieza: 'FD',
    severidad: 'DMFuerte',
    descripcionTecnica: 'Fascia',
    justificacion: 'test',
    partesAfectadas: ['FD'],
    severidadDelDano: 'DMFuerte',
    vehiculoDetectado: 'Mazda 3 2020',
    inventory: [
      {
        pieza: 'FD',
        severidad: 'DMFuerte',
        descripcionTecnica: 'Fascia',
        urls_origen: ['https://cdn.example/1.jpg'],
        tratamiento: 'SUSTITUIR',
        vehiculoDetectado: 'Mazda 3 2020',
      },
    ],
  };
}

describe('canonical-shadow-write', () => {
  it('no muta damageAnalysis ni quotePayload al persistir shadow', () => {
    const draft = {
      id: 'dq-1',
      conversationId: 'c1',
      tallerId: 't1',
      damageAnalysis: analysis(),
      quotePayload: {
        status: 'PENDING_APPROVAL',
        currency: 'MXN',
        reference: 'COT-1',
        generatedAt: '2026-09-11T00:00:00.000Z',
        lines: [
          {
            priceItemId: 'x',
            description: 'Refacción',
            quantity: 1,
            unitPrice: 100,
            subtotal: 100,
            tratamiento: 'SUSTITUIR',
          },
        ],
        subtotal: 100,
        total: 100,
        formalNarrative: 'hola',
        analysisBasis: {
          pieza: 'FD',
          severidad: 'DMFuerte',
          partesAfectadas: ['FD'],
          severidadDelDano: 'DMFuerte',
          descripcionTecnica: 'Fascia',
          justificacion: 'test',
          inventory: [
            {
              pieza: 'FD',
              severidad: 'DMFuerte',
              descripcionTecnica: 'Fascia',
              urls_origen: ['https://cdn.example/1.jpg'],
            },
          ],
        },
      },
      estimateAmount: 100,
      canonicalPeritajeV1: null,
    } as unknown as DraftQuoteEntity;

    const analysisSnap = JSON.stringify(draft.damageAnalysis);
    const quoteSnap = JSON.stringify(draft.quotePayload);
    const estimate = draft.estimateAmount;

    const incoming = buildVisionCanonicalShadow({
      conversationId: 'c1',
      incomingInventory: draft.damageAnalysis.inventory ?? [],
      visionVehicleLabel: 'Mazda 3 2020',
      now: '2026-09-11T00:00:00.000Z',
    });

    commitVisionShadowToDraft({
      draft,
      incoming,
      analysis: draft.damageAnalysis,
      quotePayload: draft.quotePayload,
    });

    expect(JSON.stringify(draft.damageAnalysis)).toBe(analysisSnap);
    expect(JSON.stringify(draft.quotePayload)).toBe(quoteSnap);
    expect(draft.estimateAmount).toBe(estimate);
    expect(draft.canonicalPeritajeV1?.damages[0]?.treatment).toBe('SUSTITUIR');
  });

  it('buildVisionShadowSafe no lanza con inventario vacío', () => {
    expect(
      buildVisionShadowSafe({
        conversationId: 'c1',
        incomingInventory: [],
      }),
    ).toBeTruthy();
  });
});
