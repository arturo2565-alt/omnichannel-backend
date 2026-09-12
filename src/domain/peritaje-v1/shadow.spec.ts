import {
  UNKNOWN_VEHICLE_ID,
  buildVisionCanonicalShadow,
  compareLegacyVsCanonical,
  createDamageItemId,
  createEvidenceId,
  mergeDamageEvidence,
  physicalMergeKey,
  resolveShadowVehicleIdentity,
  selectCanonicalShadowToPersist,
  tryBuildVisionCanonicalShadow,
  validateCanonicalPeritajeV1,
  type CanonicalPeritajeV1,
  type LegacyDetectedDamageShape,
} from './index';
import {
  inventoryItemsToVehicleAnalysis,
} from '../../chat/quote-cart-analysis';
import { buildDraftQuoteLinesFromDamageInventory } from '../../chat/draft-quote-inventory-pricing';
import { parseVisionDamageItems } from '../../chat/vision-item-normalize';
import type { MatrixPricingSnapshot } from '../../catalog/matrix-pricing-snapshot';

function snap(): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: () => 4000,
    getAmount: () => 4000,
    getDiasEntregaForCanonical: () => 5,
    listSeveridadesForCanonical: () => ['DL', 'DM', 'DMFuerte'],
  } as MatrixPricingSnapshot;
}

const NOW = '2026-09-11T18:00:00.000Z';

function sustituirItem(
  overrides: Partial<LegacyDetectedDamageShape> = {},
): LegacyDetectedDamageShape {
  return {
    pieza: 'FD',
    severidad: 'DMFuerte',
    descripcionTecnica: 'Fascia delantera con daño severo',
    urls_origen: ['https://cdn.example/1.jpg'],
    vehiculoDetectado: 'Mazda 3 2020',
    tratamiento: 'SUSTITUIR',
    posibleReemplazoRefaccion: true,
    ...overrides,
  };
}

describe('Fase 2 — dual-write shadow CanonicalPeritajeV1', () => {
  it('1. visión legacy con SUSTITUIR → canónico conserva SUSTITUIR', () => {
    const doc = buildVisionCanonicalShadow({
      conversationId: 'c1',
      incomingInventory: [sustituirItem()],
      visionVehicleLabel: 'Mazda 3 2020',
      now: NOW,
    });
    expect(doc.damages[0]!.treatment).toBe('SUSTITUIR');
    expect(doc.damages[0]!.treatmentReason).not.toBe(
      'missing_structured_treatment',
    );
    expect(validateCanonicalPeritajeV1(doc)).toEqual([]);
  });

  it('2. “rota/hecha pedazos” sin tratamiento → PENDIENTE, no SUSTITUIR inferido', () => {
    const doc = buildVisionCanonicalShadow({
      conversationId: 'c1',
      incomingInventory: [
        {
          pieza: 'Cofre',
          severidad: 'DF',
          descripcionTecnica: 'rota y hecha pedazos',
          urls_origen: ['https://cdn.example/2.jpg'],
        },
      ],
      now: NOW,
    });
    expect(doc.damages[0]!.treatment).toBe('PENDIENTE');
    expect(doc.damages[0]!.treatmentReason).toBe(
      'missing_structured_treatment',
    );
  });

  it('3. mismo daño reconstruido conserva damageItemId', () => {
    const input = {
      conversationId: 'c1',
      incomingInventory: [sustituirItem()],
      visionVehicleLabel: 'Mazda 3 2020',
      now: NOW,
    };
    const first = buildVisionCanonicalShadow(input);
    const second = buildVisionCanonicalShadow({
      ...input,
      priorCanonical: first,
      now: '2026-09-11T19:00:00.000Z',
    });
    expect(second.damages[0]!.damageItemId).toBe(first.damages[0]!.damageItemId);
    expect(second.peritajeId).toBe(first.peritajeId);
  });

  it('4. misma URL reconstruida conserva evidenceId y no duplica', () => {
    const first = buildVisionCanonicalShadow({
      conversationId: 'c1',
      incomingInventory: [sustituirItem()],
      visionVehicleLabel: 'Mazda 3 2020',
      now: NOW,
    });
    const second = buildVisionCanonicalShadow({
      conversationId: 'c1',
      incomingInventory: [sustituirItem()],
      priorCanonical: first,
      visionVehicleLabel: 'Mazda 3 2020',
      now: NOW,
    });
    expect(second.damages[0]!.evidence).toHaveLength(1);
    expect(second.damages[0]!.evidence[0]!.evidenceId).toBe(
      first.damages[0]!.evidence[0]!.evidenceId,
    );
    expect(second.damages[0]!.evidence[0]!.evidenceId).toBe(
      createEvidenceId({ url: 'https://cdn.example/1.jpg' }),
    );
  });

  it('5. nueva URL se añade como evidencia nueva', () => {
    const first = buildVisionCanonicalShadow({
      conversationId: 'c1',
      incomingInventory: [sustituirItem()],
      visionVehicleLabel: 'Mazda 3 2020',
      now: NOW,
    });
    const second = buildVisionCanonicalShadow({
      conversationId: 'c1',
      incomingInventory: [
        sustituirItem({
          urls_origen: ['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg'],
        }),
      ],
      priorCanonical: first,
      visionVehicleLabel: 'Mazda 3 2020',
      now: NOW,
    });
    expect(second.damages[0]!.evidence).toHaveLength(2);
    expect(second.damages[0]!.evidence.map((e) => e.url).sort()).toEqual([
      'https://cdn.example/1.jpg',
      'https://cdn.example/2.jpg',
    ]);
  });

  it('6. mismo physicalPanelKey, distinto vehicleId → NO merge', () => {
    const mazda = resolveShadowVehicleIdentity({
      visionDetectedLabel: 'Mazda 3 2020',
    });
    const versa = resolveShadowVehicleIdentity({
      visionDetectedLabel: 'Nissan Versa 2018',
    });
    expect(
      physicalMergeKey({
        vehicleId: mazda.vehicleId,
        physicalPanelKey: 'Cofre',
      }),
    ).not.toBe(
      physicalMergeKey({
        vehicleId: versa.vehicleId,
        physicalPanelKey: 'Cofre',
      }),
    );
    const doc = buildVisionCanonicalShadow({
      conversationId: 'c1',
      incomingInventory: [
        {
          pieza: 'Cofre',
          severidad: 'DM',
          descripcionTecnica: 'golpe',
          urls_origen: ['https://a'],
          vehiculoDetectado: 'Mazda 3 2020',
          tratamiento: 'REPARAR',
        },
        {
          pieza: 'Cofre',
          severidad: 'DM',
          descripcionTecnica: 'golpe',
          urls_origen: ['https://b'],
          vehiculoDetectado: 'Nissan Versa 2018',
          tratamiento: 'REPARAR',
        },
      ],
      now: NOW,
    });
    expect(doc.damages).toHaveLength(2);
    expect(new Set(doc.damages.map((d) => d.vehicleId)).size).toBe(2);
    expect(
      doc.vehicles.filter((v) => v.vehicleId !== UNKNOWN_VEHICLE_ID),
    ).toHaveLength(2);
  });

  it('7. mismo vehicleId + physicalPanelKey → mismo identity target', () => {
    const v = resolveShadowVehicleIdentity({
      visionDetectedLabel: 'Mazda 3 2020',
    });
    expect(
      createDamageItemId({
        vehicleId: v.vehicleId,
        physicalPanelKey: 'FD',
      }),
    ).toBe(
      createDamageItemId({
        vehicleId: v.vehicleId,
        physicalPanelKey: 'FD',
      }),
    );
  });

  it('8. possibleHiddenDamage se conserva', () => {
    const doc = buildVisionCanonicalShadow({
      conversationId: 'c1',
      incomingInventory: [
        sustituirItem({
          possibleHiddenDamage: {
            detected: true,
            areas: ['radiador'],
            requiresDisassembly: true,
          },
        }),
      ],
      visionVehicleLabel: 'Mazda 3 2020',
      now: NOW,
    });
    expect(doc.damages[0]!.possibleHiddenDamage).toEqual({
      detected: true,
      areas: ['radiador'],
      requiresDisassembly: true,
    });
  });

  it('9. vehículo de visión → source vision y confirmedByUser false', () => {
    const v = resolveShadowVehicleIdentity({
      visionDetectedLabel: 'Mazda 3 2020',
    });
    expect(v.source).toBe('vision');
    expect(v.confirmedByUser).toBe(false);
    expect(v.make).toBe('Mazda');
    expect(v.model).toBe('3');
    expect(v.year).toBe('2020');
    expect(v.vehicleId).not.toBe(UNKNOWN_VEHICLE_ID);

    const yearAndModelIsNotConfirmation = resolveShadowVehicleIdentity({
      visionDetectedLabel: 'Mazda 3 2020',
    });
    expect(yearAndModelIsNotConfirmation.confirmedByUser).toBe(false);
  });

  it('10. peritaje inválido no tumba el flujo (tryBuild + select)', () => {
    expect(
      tryBuildVisionCanonicalShadow({
        conversationId: '',
        incomingInventory: [
          {
            get pieza(): string {
              throw new Error('boom');
            },
            severidad: 'DL',
          } as unknown as LegacyDetectedDamageShape,
        ],
      }),
    ).toBeNull();

    const prior = buildVisionCanonicalShadow({
      conversationId: 'c1',
      incomingInventory: [sustituirItem()],
      visionVehicleLabel: 'Mazda 3 2020',
      now: NOW,
    });
    const garbage = {
      ...prior,
      damages: [
        {
          ...prior.damages[0]!,
          vehicleId: 'veh_inexistente',
        },
      ],
    };
    const decision = selectCanonicalShadowToPersist({
      prior,
      incoming: garbage,
    });
    expect(decision.status).toBe('CANONICAL_INVALID');
    expect(decision.persisted?.peritajeId).toBe(prior.peritajeId);
    expect(decision.persisted?.damages[0]!.vehicleId).toBe(
      prior.damages[0]!.vehicleId,
    );
  });

  it('11. DraftQuote viejo sin canonical → dual-write crea canonical', () => {
    const decision = selectCanonicalShadowToPersist({
      prior: null,
      incoming: buildVisionCanonicalShadow({
        conversationId: 'c1',
        incomingInventory: [sustituirItem()],
        visionVehicleLabel: 'Mazda 3 2020',
        now: NOW,
      }),
    });
    expect(decision.status).toBe('CANONICAL_VALID');
    expect(decision.persisted?.schemaVersion).toBe('peritaje.v1');
  });

  it('12. canonical previo válido + nuevo shadow inválido → no destruir previo', () => {
    const prior = buildVisionCanonicalShadow({
      conversationId: 'c1',
      incomingInventory: [sustituirItem()],
      visionVehicleLabel: 'Mazda 3 2020',
      now: NOW,
    });
    const invalid: CanonicalPeritajeV1 = {
      ...prior,
      damages: [],
      vehicles: [],
    };
    invalid.damages = [
      { ...prior.damages[0]!, vehicleId: '', damageItemId: '' },
    ];
    const decision = selectCanonicalShadowToPersist({
      prior,
      incoming: invalid,
    });
    expect(decision.status).toBe('CANONICAL_INVALID');
    expect(decision.persisted).toBe(prior);
  });

  it('13. no copia precioMx al DamageItem', () => {
    const doc = buildVisionCanonicalShadow({
      conversationId: 'c1',
      incomingInventory: [
        {
          ...sustituirItem(),
          precioMx: 9900,
        } as LegacyDetectedDamageShape,
      ],
      visionVehicleLabel: 'Mazda 3 2020',
      now: NOW,
    });
    expect(doc.damages[0]!).not.toHaveProperty('precioMx');
    expect(doc.damages[0]!).not.toHaveProperty('amount');
  });

  it('14. dual-write no cambia el resultado legacy observable', () => {
    const visionItems = parseVisionDamageItems({
      items: [
        {
          pieza: 'FD',
          severidad: 'DMFuerte',
          descripcionTecnica: 'Fascia delantera con daño severo',
          tipo_dano: 'SUSTITUCION',
          requiere_refaccion: true,
          urls_origen: ['https://cdn.example/1.jpg'],
        },
      ],
    });
    const analysisBefore = inventoryItemsToVehicleAnalysis(
      visionItems,
      ['https://cdn.example/1.jpg'],
      'Mazda 3 2020',
    );
    const linesBefore = buildDraftQuoteLinesFromDamageInventory(
      analysisBefore.inventory ?? [],
      snap(),
    );
    const snapshot = JSON.stringify({
      analysis: analysisBefore,
      lines: linesBefore,
    });

    const shadow = buildVisionCanonicalShadow({
      conversationId: 'c1',
      incomingInventory: visionItems,
      visionVehicleLabel: 'Mazda 3 2020',
      now: NOW,
    });
    const persisted = selectCanonicalShadowToPersist({
      incoming: shadow,
    }).persisted;

    const analysisAfter = inventoryItemsToVehicleAnalysis(
      visionItems,
      ['https://cdn.example/1.jpg'],
      'Mazda 3 2020',
    );
    const linesAfter = buildDraftQuoteLinesFromDamageInventory(
      analysisAfter.inventory ?? [],
      snap(),
    );

    expect(JSON.stringify({ analysis: analysisAfter, lines: linesAfter })).toBe(
      snapshot,
    );
    expect(persisted?.damages[0]!.treatment).toBe('SUSTITUIR');
  });

  it('mergeDamageEvidence no duplica la misma URL', () => {
    const first = mergeDamageEvidence(
      [],
      ['https://cdn.example/1.jpg'],
      'msg-1',
    );
    const second = mergeDamageEvidence(first, ['https://cdn.example/1.jpg'], 'msg-2');
    expect(second).toHaveLength(1);
    expect(second[0]!.evidenceId).toBe(first[0]!.evidenceId);
  });

  it('observabilidad: TREATMENT_DIFFERENCE y VEHICLE_MISSING', () => {
    const canonical = buildVisionCanonicalShadow({
      conversationId: 'c1',
      incomingInventory: [sustituirItem()],
      visionVehicleLabel: 'Mazda 3 2020',
      now: NOW,
    });
    const cmp = compareLegacyVsCanonical({
      canonical,
      conversationId: 'c1',
      status: 'CANONICAL_VALID',
      legacy: {
        inventory: [
          {
            pieza: 'FD',
            tratamiento: 'REPARAR',
            urls_origen: ['https://cdn.example/1.jpg'],
          },
        ],
      },
    });
    expect(cmp.differences.map((d) => d.type)).toEqual(
      expect.arrayContaining(['TREATMENT_DIFFERENCE', 'VEHICLE_MISSING']),
    );
  });
});
