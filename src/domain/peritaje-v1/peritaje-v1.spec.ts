import {
  PERITAJE_SCHEMA_VERSION,
  QUOTE_SCHEMA_VERSION,
  UNKNOWN_VEHICLE_ID,
  assumesIndexCorrespondence,
  createDamageItemId,
  createEvidenceId,
  createQuoteLineId,
  createVehicleId,
  damageItemFromLegacy,
  expectedServiceTypesForTreatment,
  normalizePhysicalPanelKey,
  peritajeFromLegacyAnalysis,
  physicalMergeKey,
  mergeLockedTreatments,
  rejectTextInferenceWhenLocked,
  resolveLockedTreatment,
  validateCanonicalPeritajeV1,
  validateCanonicalQuoteV1,
  vehicleIdentityFromLegacyLabel,
  type CanonicalPeritajeV1,
  type CanonicalQuoteV1,
  type DamageItem,
  type QuoteLine,
  type VehicleIdentity,
} from './index';

function vehicle(overrides: Partial<VehicleIdentity> = {}): VehicleIdentity {
  const displayLabel = overrides.displayLabel ?? 'Mazda 3 2020';
  const vehicleId =
    overrides.vehicleId ??
    createVehicleId({
      make: 'Mazda',
      model: '3',
      year: '2020',
      displayLabel,
    });
  return {
    vehicleId,
    make: 'Mazda',
    model: '3',
    year: '2020',
    displayLabel,
    confidence: 'MEDIUM',
    source: 'vision',
    confirmedByUser: false,
    ...overrides,
  };
}

function damage(
  v: VehicleIdentity,
  overrides: Partial<DamageItem> = {},
): DamageItem {
  const physicalPanelKey = overrides.physicalPanelKey ?? 'Cofre';
  return {
    damageItemId: createDamageItemId({
      vehicleId: v.vehicleId,
      physicalPanelKey,
    }),
    vehicleId: v.vehicleId,
    pieceCode: 'Cofre',
    pieceLabel: 'Cofre',
    physicalPanelKey,
    severity: 'DM',
    descriptionTechnical: 'Golpe con arrugamiento medio.',
    treatment: 'REPARAR',
    treatmentConfidence: 'MEDIUM',
    treatmentSource: 'vision',
    treatmentReason: 'vision_structured',
    requiresReplacement: false,
    possibleReplacement: false,
    evidence: [
      {
        evidenceId: createEvidenceId({ url: 'https://cdn/a.jpg' }),
        type: 'IMAGE',
        url: 'https://cdn/a.jpg',
        source: 'customer',
      },
    ],
    source: 'vision',
    ...overrides,
  };
}

function peritaje(
  overrides: Partial<CanonicalPeritajeV1> = {},
): CanonicalPeritajeV1 {
  const v = vehicle();
  const d = damage(v);
  return {
    schemaVersion: PERITAJE_SCHEMA_VERSION,
    peritajeId: 'per_test',
    conversationId: 'conv_test',
    tallerId: null,
    vehicles: [v],
    damages: [d],
    viability: { viable: true },
    createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
    ...overrides,
  };
}

function line(
  d: DamageItem,
  overrides: Partial<QuoteLine> = {},
): QuoteLine {
  const serviceType = overrides.serviceType ?? 'REPARACION_PINTURA';
  return {
    quoteLineId: createQuoteLineId({
      damageItemId: d.damageItemId,
      serviceType,
    }),
    damageItemId: d.damageItemId,
    vehicleId: d.vehicleId,
    serviceType,
    description: 'Reparar y pintar Cofre',
    billable: true,
    amount: 4000,
    pricingSource: 'AUTOFIX_CATALOG',
    pricingStatus: 'OK',
    confidence: 'MEDIUM',
    ...overrides,
  };
}

function quote(
  p: CanonicalPeritajeV1,
  lines: QuoteLine[],
  overrides: Partial<CanonicalQuoteV1> = {},
): CanonicalQuoteV1 {
  const subtotal = lines
    .filter((l) => l.billable)
    .reduce((acc, l) => acc + l.amount, 0);
  return {
    schemaVersion: QUOTE_SCHEMA_VERSION,
    quoteId: 'quo_test',
    peritajeId: p.peritajeId,
    lines,
    subtotal,
    total: subtotal,
    isPartial: false,
    warnings: [],
    generatedAt: '2026-09-11T00:00:00.000Z',
    ...overrides,
  };
}

describe('Contrato Canónico de Peritaje v1', () => {
  describe('invariante 1 — DamageItem pertenece a vehicleId', () => {
    it('rechaza un daño sin vehicleId conocido', () => {
      const p = peritaje({
        damages: [
          damage(vehicle(), { vehicleId: 'veh_otro' }),
        ],
      });
      const errors = validateCanonicalPeritajeV1(p);
      expect(errors.map((e) => e.code)).toContain('unknown_vehicle');
    });

    it('acepta daño ligado al vehículo del documento', () => {
      expect(validateCanonicalPeritajeV1(peritaje())).toEqual([]);
    });
  });

  describe('invariante 2 — merge key = vehicleId + physicalPanelKey', () => {
    it('el mismo panel en dos vehículos no colisiona', () => {
      const a = createVehicleId({ displayLabel: 'Mazda 3 2020' });
      const b = createVehicleId({ displayLabel: 'Nissan Versa 2018' });
      expect(physicalMergeKey({ vehicleId: a, physicalPanelKey: 'Cofre' })).not.toBe(
        physicalMergeKey({ vehicleId: b, physicalPanelKey: 'Cofre' }),
      );
    });

    it('rechaza dos daños con la misma identidad física', () => {
      const v = vehicle();
      const p = peritaje({
        vehicles: [v],
        damages: [
          damage(v, { physicalPanelKey: 'Cofre' }),
          damage(v, {
            physicalPanelKey: 'Cofre',
            descriptionTechnical: 'Segundo golpe',
          }),
        ],
      });
      expect(validateCanonicalPeritajeV1(p).map((e) => e.code)).toContain(
        'duplicate_physical_identity',
      );
    });

    it('normalizePhysicalPanelKey une Cofre y REFACCION:Cofre', () => {
      expect(normalizePhysicalPanelKey('REFACCION:Cofre')).toBe('Cofre');
      expect(normalizePhysicalPanelKey('Cofre')).toBe('Cofre');
    });
  });

  describe('invariante 3 — treatment ≠ serviceType', () => {
    it('SUSTITUIR produce servicios económicos distintos al tratamiento', () => {
      const services = expectedServiceTypesForTreatment('SUSTITUIR');
      expect(services).toEqual(['REFACCION', 'MONTAJE_PINTURA']);
      expect(services).not.toContain('SUSTITUIR');
    });

    it('REPARAR / INCIERTO producen REPARACION_PINTURA, no el enum de tratamiento', () => {
      expect(expectedServiceTypesForTreatment('REPARAR')).toEqual([
        'REPARACION_PINTURA',
      ]);
      expect(expectedServiceTypesForTreatment('INCIERTO')).toEqual([
        'REPARACION_PINTURA',
      ]);
    });
  });

  describe('invariante 4 y 5 — SUSTITUIR 1:N y nada por índice', () => {
    it('una pieza SUSTITUIR emite REFACCION + MONTAJE_PINTURA ligadas al mismo damageItemId', () => {
      const v = vehicle();
      const d = damage(v, {
        treatment: 'SUSTITUIR',
        requiresReplacement: true,
      });
      const p = peritaje({ vehicles: [v], damages: [d] });
      const lines = [
        line(d, { serviceType: 'REFACCION', amount: 8500, description: 'Refacción' }),
        line(d, {
          serviceType: 'MONTAJE_PINTURA',
          amount: 3200,
          description: 'Montar y pintar',
        }),
      ];
      const q = quote(p, lines);
      expect(q.lines).toHaveLength(2);
      expect(q.lines[0]!.damageItemId).toBe(d.damageItemId);
      expect(q.lines[1]!.damageItemId).toBe(d.damageItemId);
      expect(q.lines[0]!.quoteLineId).not.toBe(q.lines[1]!.quoteLineId);
      expect(validateCanonicalQuoteV1(q, p)).toEqual([]);
      expect(assumesIndexCorrespondence(p.damages, q.lines)).toBe(false);
    });

    it('detecta emparejamiento ciego por índice', () => {
      const v = vehicle();
      const d = damage(v);
      expect(
        assumesIndexCorrespondence(
          [d],
          [
            {
              quoteLineId: 'ql_x',
              damageItemId: 'no-existe',
              vehicleId: v.vehicleId,
              serviceType: 'REPARACION_PINTURA',
              description: 'x',
              billable: true,
              amount: 1,
              confidence: 'UNKNOWN',
            },
          ],
        ),
      ).toBe(true);
    });
  });

  describe('invariante 6 — importes fuera de la decisión visual', () => {
    it('un DamageItem con precioMx filtrado en runtime viola el contrato', () => {
      const v = vehicle();
      const leaked = {
        ...damage(v),
        precioMx: 8500,
      } as DamageItem;
      const errors = validateCanonicalPeritajeV1(
        peritaje({ vehicles: [v], damages: [leaked] }),
      );
      expect(errors.map((e) => e.code)).toContain('money_on_damage');
    });

    it('el adaptador legacy no copia precioMx al DamageItem', () => {
      const v = vehicleIdentityFromLegacyLabel('Mazda 3 2020');
      const item = damageItemFromLegacy(
        {
          pieza: 'Cofre',
          severidad: 'DF',
          descripcionTecnica: 'Colapsado',
          urls_origen: [],
          tratamiento: 'SUSTITUIR',
          precioMx: 9900,
        } as { pieza: string; severidad: string; descripcionTecnica: string; urls_origen: string[]; tratamiento: string },
        { vehicleId: v.vehicleId },
      );
      expect(item).not.toHaveProperty('precioMx');
      expect(item).not.toHaveProperty('amount');
      expect(item.treatment).toBe('SUSTITUIR');
    });
  });

  describe('invariante 7 — la narrativa no es verdad financiera', () => {
    it('subtotal debe cuadrar con líneas billable, no con un texto', () => {
      const p = peritaje();
      const q = quote(p, [line(p.damages[0]!)], {
        subtotal: 0,
        total: 0,
        formalNarrative: 'Total $4,000 MXN',
      } as CanonicalQuoteV1);
      const codes = validateCanonicalQuoteV1(q, p).map((e) => e.code);
      expect(codes).toEqual(
        expect.arrayContaining(['subtotal_mismatch', 'narrative_is_not_truth']),
      );
    });
  });

  describe('invariante 8 — IDs estables evidencia → daño → línea', () => {
    it('vehicleId / damageItemId / quoteLineId / evidenceId son deterministas', () => {
      const a = createVehicleId({
        make: 'Mazda',
        model: '3',
        year: '2020',
        displayLabel: 'Mazda 3 2020',
      });
      const b = createVehicleId({
        make: 'Mazda',
        model: '3',
        year: '2020',
        displayLabel: 'Mazda 3 2020',
      });
      expect(a).toBe(b);

      const dmgA = createDamageItemId({
        vehicleId: a,
        physicalPanelKey: 'Cofre',
      });
      const dmgB = createDamageItemId({
        vehicleId: a,
        physicalPanelKey: 'Cofre',
      });
      expect(dmgA).toBe(dmgB);
      expect(
        createDamageItemId({
          vehicleId: a,
          physicalPanelKey: 'FD',
          damageHint: 'rayon',
        }),
      ).toBe(
        createDamageItemId({
          vehicleId: a,
          physicalPanelKey: 'FD',
          damageHint: 'fractura',
        }),
      );

      expect(
        createQuoteLineId({ damageItemId: dmgA, serviceType: 'REFACCION' }),
      ).toBe(
        createQuoteLineId({ damageItemId: dmgA, serviceType: 'REFACCION' }),
      );
      expect(
        createQuoteLineId({ damageItemId: dmgA, serviceType: 'REFACCION' }),
      ).not.toBe(
        createQuoteLineId({
          damageItemId: dmgA,
          serviceType: 'MONTAJE_PINTURA',
        }),
      );

      expect(
        createEvidenceId({ imageUrls: ['https://b', 'https://a'] }),
      ).toBe(createEvidenceId({ imageUrls: ['https://a', 'https://b'] }));
    });
  });

  describe('invariante 9 — persistible sin OpenAI', () => {
    it('el documento se serializa a JSON plano', () => {
      const p = peritaje();
      const json = JSON.parse(JSON.stringify(p)) as CanonicalPeritajeV1;
      expect(json.schemaVersion).toBe(PERITAJE_SCHEMA_VERSION);
      expect(json.damages[0]!.treatment).toBe('REPARAR');
      expect(validateCanonicalPeritajeV1(json)).toEqual([]);
    });
  });

  describe('regla de lock de tratamiento', () => {
    it('no reinfiere desde texto cuando ya hay tratamiento estructurado', () => {
      expect(
        rejectTextInferenceWhenLocked({
          existing: 'REPARAR',
          inferredFromText: 'SUSTITUIR',
        }),
      ).toBe('REPARAR');
    });

    it('preserve conserva el lock', () => {
      const r = resolveLockedTreatment({
        existing: 'REPARAR',
        incoming: 'SUSTITUIR',
        mode: 'preserve',
      });
      expect(r.treatment).toBe('REPARAR');
      expect(r.locked).toBe(true);
    });

    it('validate con conflicto degrada explícitamente a INCIERTO', () => {
      const r = resolveLockedTreatment({
        existing: 'REPARAR',
        incoming: 'SUSTITUIR',
        mode: 'validate',
      });
      expect(r.treatment).toBe('INCIERTO');
      expect(r.source).toBe('degraded');
    });

    it('mergeLockedTreatments: REPARAR vs SUSTITUIR → INCIERTO', () => {
      const r = mergeLockedTreatments('REPARAR', 'SUSTITUIR');
      expect(r.treatment).toBe('INCIERTO');
      expect(r.source).toBe('degraded');
      expect(r.reason).toBe('conflicting_structured_treatments');
    });

    it('mergeLockedTreatments: mismo treatment se conserva', () => {
      const r = mergeLockedTreatments('REPARAR', 'REPARAR');
      expect(r.treatment).toBe('REPARAR');
      expect(r.reason).toBe('preserved_locked_treatment');
    });

    it('mergeLockedTreatments: PENDIENTE vs REPARAR → INCIERTO (sin precedencia implícita)', () => {
      const r = mergeLockedTreatments('PENDIENTE', 'REPARAR');
      expect(r.treatment).toBe('INCIERTO');
      expect(r.reason).toBe('conflicting_structured_treatments');
    });

    it('combine_stronger es una regla explícita, no inferencia textual', () => {
      const r = resolveLockedTreatment({
        existing: 'REPARAR',
        incoming: 'SUSTITUIR',
        mode: 'combine_stronger',
      });
      expect(r.treatment).toBe('SUSTITUIR');
      expect(r.source).toBe('merge_rule');
    });

    it('degrade_incierto es explícito', () => {
      const r = resolveLockedTreatment({
        existing: 'SUSTITUIR',
        mode: 'degrade_incierto',
      });
      expect(r.treatment).toBe('INCIERTO');
      expect(r.reason).toBe('degraded_from_SUSTITUIR');
    });

    it('sin tratamiento estructurado no inventa REPARAR desde el texto', () => {
      const r = resolveLockedTreatment({
        incoming: undefined,
        mode: 'preserve',
      });
      expect(r.treatment).toBe('PENDIENTE');
      expect(r.reason).toBe('missing_structured_treatment');
      expect(r.locked).toBe(false);
    });
  });

  describe('adaptador legacy (solo lectura, no cableado)', () => {
    it('mapea vehiculoDetectado + tratamiento sin copiar dinero', () => {
      const doc = peritajeFromLegacyAnalysis({
        conversationId: 'c1',
        tallerId: 't1',
        peritajeId: 'per_fixed',
        now: '2026-09-11T12:00:00.000Z',
        analysis: {
          vehiculoDetectado: 'Mazda 3 2020',
          inventory: [
            {
              pieza: 'REFACCION:Cofre',
              severidad: 'DF',
              descripcionTecnica: 'Pieza colapsada',
              urls_origen: ['https://cdn/x.jpg'],
              tratamiento: 'SUSTITUIR',
              posibleReemplazoRefaccion: false,
            },
          ],
        },
      });

      expect(doc.schemaVersion).toBe(PERITAJE_SCHEMA_VERSION);
      expect(doc.vehicles[0]!.make).toBe('Mazda');
      expect(doc.vehicles[0]!.year).toBe('2020');
      expect(doc.damages[0]!.vehicleId).toBe(doc.vehicles[0]!.vehicleId);
      expect(doc.damages[0]!.physicalPanelKey).toBe('Cofre');
      expect(doc.damages[0]!.treatment).toBe('SUSTITUIR');
      expect(doc.damages[0]!.treatmentSource).toBe('vision');
      expect(doc.damages[0]!.requiresReplacement).toBe(true);
      expect(validateCanonicalPeritajeV1(doc)).toEqual([]);
    });

    it('sin tratamiento legacy no reinfiere: queda PENDIENTE', () => {
      const item = damageItemFromLegacy(
        {
          pieza: 'Fascia',
          severidad: 'DF',
          descripcionTecnica: 'rota y hecha pedazos',
          urls_origen: [],
        },
        { vehicleId: UNKNOWN_VEHICLE_ID },
      );
      expect(item.treatment).toBe('PENDIENTE');
      expect(item.treatmentReason).toBe('missing_structured_treatment');
    });
  });
});
