import { QUOTE_SCHEMA_VERSION, PERITAJE_SCHEMA_VERSION } from '../domain/peritaje-v1';
import type {
  CanonicalPeritajeV1,
  CanonicalQuoteV1,
  DamageItem,
  QuoteLine,
} from '../domain/peritaje-v1';
import {
  REFACCION_AVAILABILITY_DISCLAIMER,
  extractMonetaryAmounts,
  formatQuoteMoney,
  validateFinalClientQuoteMessage,
} from '../domain/peritaje-v1/quote-narrative';
import { buildCanonicalFreeze } from './canonical-quote-engine';
import { composeModernClientQuoteMessage } from './canonical-quote-narrative';
import type { QuoteSendSnapshot } from './autofix-config';
import {
  computeQuoteDelta,
  presentClientWarnings,
  resolveClientMessageMode,
  userRequestsFullQuote,
} from './client-message-ux';

function line(
  partial: Partial<QuoteLine> & Pick<QuoteLine, 'serviceType' | 'amount'>,
): QuoteLine {
  return {
    quoteLineId: partial.quoteLineId ?? `ql_${partial.serviceType}`,
    damageItemId: partial.damageItemId ?? 'dmg_fascia',
    vehicleId: 'veh_1',
    description: partial.description ?? 'fascia delantera',
    billable: partial.billable ?? true,
    confidence: 'HIGH',
    ...partial,
  };
}

function quote(
  partial: Partial<CanonicalQuoteV1> & { lines: QuoteLine[] },
): CanonicalQuoteV1 {
  const chargeable = partial.lines
    .filter(
      (l) =>
        l.billable &&
        l.amount > 0 &&
        l.serviceType !== 'PENDIENTE' &&
        l.serviceType !== 'ADVERTENCIA' &&
        l.pricingStatus !== 'INSUFFICIENT_MARKET_SAMPLE' &&
        l.pricingStatus !== 'AWAITING_VEHICLE_DATA' &&
        l.pricingStatus !== 'UNCONFIGURED',
    )
    .reduce((s, l) => s + l.amount, 0);
  return {
    schemaVersion: QUOTE_SCHEMA_VERSION,
    quoteId: partial.quoteId ?? 'q_ux',
    peritajeId: 'per_1',
    subtotal: partial.subtotal ?? chargeable,
    total: partial.total ?? chargeable,
    isPartial: partial.isPartial ?? false,
    warnings: partial.warnings ?? [],
    generatedAt: '2026-09-14T00:00:00.000Z',
    lines: partial.lines,
  };
}

function damage(
  partial: Partial<DamageItem> & Pick<DamageItem, 'damageItemId' | 'pieceCode'>,
): DamageItem {
  return {
    vehicleId: 'veh_1',
    pieceLabel: partial.pieceLabel ?? partial.pieceCode,
    physicalPanelKey: partial.physicalPanelKey ?? partial.pieceCode,
    severity: 'DM',
    descriptionTechnical: 'Se aprecia afectación visible en la pieza.',
    treatment: 'REPARAR',
    treatmentConfidence: 'HIGH',
    treatmentSource: 'vision',
    treatmentReason: 'vision',
    requiresReplacement: false,
    possibleReplacement: false,
    evidence: [],
    source: 'vision',
    ...partial,
  };
}

function altimaPeritaje(year = '2014'): CanonicalPeritajeV1 {
  return {
    schemaVersion: PERITAJE_SCHEMA_VERSION,
    peritajeId: 'per_1',
    conversationId: 'c1',
    tallerId: 't1',
    vehicles: [
      {
        vehicleId: 'veh_1',
        make: 'Nissan',
        model: 'Altima',
        year,
        displayLabel: `Nissan Altima ${year}`,
        confidence: 'HIGH',
        source: 'user',
        confirmedByUser: true,
      },
    ],
    damages: [
      damage({
        damageItemId: 'dmg_fascia',
        pieceCode: 'FD',
        pieceLabel: 'Fascia delantera',
        treatment: 'REPARAR',
      }),
      damage({
        damageItemId: 'dmg_si',
        pieceCode: 'SI',
        pieceLabel: 'Salpicadera delantera izquierda',
        treatment: 'REPARAR',
      }),
      damage({
        damageItemId: 'dmg_tapa',
        pieceCode: 'Tapa Cajuela',
        pieceLabel: 'Tapa de cajuela',
        treatment: 'REPARAR',
      }),
      damage({
        damageItemId: 'dmg_cala',
        pieceCode: 'Calavera_Derecha',
        pieceLabel: 'Calavera derecha',
        treatment: 'SUSTITUIR',
        requiresReplacement: true,
        descriptionTechnical: 'Se aprecia afectación en la calavera derecha.',
      }),
    ],
    viability: { viable: true },
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
  };
}

const fascia = line({
  quoteLineId: 'ql_fascia',
  damageItemId: 'dmg_fascia',
  serviceType: 'REPARACION_PINTURA',
  amount: 4500,
  description: 'fascia delantera',
});
const salpicadera = line({
  quoteLineId: 'ql_si',
  damageItemId: 'dmg_si',
  serviceType: 'REPARACION_PINTURA',
  amount: 3800,
  description: 'salpicadera delantera izquierda',
});
const tapa = line({
  quoteLineId: 'ql_tapa',
  damageItemId: 'dmg_tapa',
  serviceType: 'REPARACION_PINTURA',
  amount: 3200,
  description: 'tapa de cajuela',
});
const calaveraPending = line({
  quoteLineId: 'ql_cala_ref',
  damageItemId: 'dmg_cala',
  serviceType: 'REFACCION',
  amount: 0,
  billable: false,
  description: 'Calavera_Derecha',
  pricingStatus: 'AWAITING_VEHICLE_DATA',
  pricingSource: 'AWAITING_VEHICLE_DATA',
});
const calaveraPriced = line({
  quoteLineId: 'ql_cala_ref',
  damageItemId: 'dmg_cala',
  serviceType: 'REFACCION',
  amount: 3475,
  description: 'Calavera_Derecha',
  pricingSource: 'WEB_MARKET_ESTIMATE',
  pricingStatus: 'OK',
  priceRange: { min: 3300, max: 3650, central: 3475 },
});
const calaveraMontaje = line({
  quoteLineId: 'ql_cala_mon',
  damageItemId: 'dmg_cala',
  serviceType: 'MONTAJE',
  amount: 900,
  description: 'Calavera_Derecha',
});

function sendSnapshot(q: CanonicalQuoteV1, extra?: Partial<QuoteSendSnapshot>): QuoteSendSnapshot {
  return {
    sentAt: '2026-09-14T10:00:00.000Z',
    total: q.total,
    subtotal: q.subtotal,
    desglose: q.lines.map((l) => ({
      pieza: l.description,
      severidad: 'DM',
      precioMx: l.amount,
      precioMaximo: l.priceRange?.max,
      quoteLineId: l.quoteLineId,
      damageItemId: l.damageItemId,
      serviceType: l.serviceType,
    })),
    finalMessage: extra?.finalMessage ?? 'Hola Arturo, ya revisamos las fotografías.',
    canonicalFreeze: buildCanonicalFreeze(q),
    shownWarnings: [...q.warnings],
    ...extra,
  };
}

describe('Conversation UX / Client Message Composer v2', () => {
  const partialQuote = quote({
    lines: [fascia, salpicadera, tapa, calaveraPending],
    isPartial: true,
    warnings: ['AWAITING_VEHICLE_DATA', 'HIDDEN_DAMAGE', 'POSSIBLE_SUBSTITUTION'],
  });
  const resumedQuote = quote({
    lines: [fascia, salpicadera, tapa, calaveraPriced, calaveraMontaje],
    warnings: ['HIDDEN_DAMAGE', 'POSSIBLE_SUBSTITUTION'],
  });
  const snapshot = sendSnapshot(partialQuote);

  it('1. initial quote saluda una sola vez', async () => {
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: partialQuote,
      peritaje: altimaPeritaje(),
      contactName: 'Arturo',
      hasActiveAppointment: false,
      llmParts: {
        intro: 'Arturo, ya revisamos las fotografías de tu vehículo.',
        technicalExplanation: 'Golpe lateral derecho.',
        cta: '¿Me confirmas modelo y año?',
      },
    });
    expect(composed.mode).toBe('INITIAL_QUOTE');
    expect(composed.shouldGreet).toBe(true);
    expect(composed.finalMessage).toMatch(/Cotización preliminar/);
    expect(composed.finalMessage).toMatch(/ya revisamos las fotografías/i);
    expect(composed.finalMessage).toContain(formatQuoteMoney(partialQuote.total));
  });

  it('2. resume no saluda', async () => {
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: resumedQuote,
      peritaje: altimaPeritaje('2014'),
      contactName: 'Arturo',
      hasActiveAppointment: false,
      previousSnapshot: snapshot,
      messageSource: 'pending_requirement_resume',
      userText: 'Es un Nissan Altima 2014',
      llmParts: {
        intro: 'Hola Arturo, ya revisamos las fotografías otra vez.',
        technicalExplanation: 'Se aprecia afectación en fascia y tapa.',
        cta: '¿Agendamos?',
      },
    });
    expect(composed.mode).toBe('QUOTE_RESUME');
    expect(composed.shouldGreet).toBe(false);
    expect(composed.finalMessage).not.toMatch(/Hola Arturo/i);
    expect(composed.finalMessage).toMatch(/Cotización actualizada/);
  });

  it('3. resume no repite explicación técnica', async () => {
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: resumedQuote,
      peritaje: altimaPeritaje('2014'),
      contactName: 'Arturo',
      hasActiveAppointment: false,
      previousSnapshot: snapshot,
      messageSource: 'pending_requirement_resume',
      userText: 'Nissan Altima 2014',
      llmParts: {
        intro: 'Hola Arturo',
        technicalExplanation: 'Se aprecia afectación visible. El daño visible es fuerte.',
        cta: 'ok',
      },
    });
    expect(composed.finalMessage).not.toMatch(/ya revisamos las fotografías/i);
    expect(composed.finalMessage).not.toMatch(/Se aprecia afectación/i);
    expect(composed.finalMessage).not.toMatch(/El daño visible/i);
  });

  it('4. resume muestra únicamente delta', async () => {
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: resumedQuote,
      peritaje: altimaPeritaje('2014'),
      contactName: 'Arturo',
      hasActiveAppointment: false,
      previousSnapshot: snapshot,
      messageSource: 'pending_requirement_resume',
      userText: 'Nissan Altima 2014',
      llmParts: {
        intro: 'Confirmado el Altima.',
        technicalExplanation: '',
        cta: '',
      },
    });
    expect(composed.finalMessage).toMatch(/Calavera derecha/);
    expect(composed.finalMessage).not.toMatch(/fascia/i);
    expect(composed.finalMessage).not.toMatch(/salpicadera/i);
    expect(composed.finalMessage).not.toMatch(/tapa de cajuela/i);
    expect(composed.finalMessage).toMatch(/permanece sin cambios/i);
  });

  it('5. total actualizado es CanonicalQuote.total', async () => {
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: resumedQuote,
      peritaje: altimaPeritaje('2014'),
      contactName: 'Arturo',
      hasActiveAppointment: false,
      previousSnapshot: snapshot,
      messageSource: 'pending_requirement_resume',
      userText: 'Nissan Altima 2014',
      llmParts: { intro: 'ok', technicalExplanation: '', cta: '' },
    });
    expect(composed.finalMessage).toContain(formatQuoteMoney(resumedQuote.total));
    expect(resumedQuote.total).toBe(4500 + 3800 + 3200 + 3475 + 900);
    const remainder = composed.finalMessage.replace(composed.financialBlock, '');
    expect(extractMonetaryAmounts(remainder)).toEqual([]);
  });

  it('6. correction no saluda', async () => {
    const after2015 = quote({
      lines: [
        fascia,
        salpicadera,
        tapa,
        { ...calaveraPriced, amount: 3600, priceRange: { min: 3400, max: 3800, central: 3600 } },
        calaveraMontaje,
      ],
      warnings: ['HIDDEN_DAMAGE'],
    });
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: after2015,
      peritaje: altimaPeritaje('2015'),
      contactName: 'Arturo',
      hasActiveAppointment: false,
      previousSnapshot: sendSnapshot(resumedQuote),
      messageSource: 'vehicle_identity_correction',
      userText: 'Perdón, es 2015',
      llmParts: {
        intro: 'Hola Arturo, ya revisamos las fotografías',
        technicalExplanation: 'Se observa el daño visible',
        cta: '¿Agendamos?',
      },
    });
    expect(composed.mode).toBe('QUOTE_CORRECTION');
    expect(composed.shouldGreet).toBe(false);
    expect(composed.finalMessage).not.toMatch(/Hola Arturo/i);
    expect(composed.finalMessage).toMatch(/Nissan Altima 2015/);
  });

  it('7. correction delta correcto', async () => {
    const after2015 = quote({
      lines: [
        fascia,
        salpicadera,
        tapa,
        { ...calaveraPriced, amount: 3600, priceRange: { min: 3400, max: 3800, central: 3600 } },
        calaveraMontaje,
      ],
    });
    const delta = computeQuoteDelta(after2015, sendSnapshot(resumedQuote));
    expect(delta.updatedLines.map((u) => u.quoteLineId)).toEqual(['ql_cala_ref']);
    expect(delta.unchangedLineIds).toEqual(
      expect.arrayContaining(['ql_fascia', 'ql_si', 'ql_tapa', 'ql_cala_mon']),
    );
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: after2015,
      peritaje: altimaPeritaje('2015'),
      contactName: 'Arturo',
      hasActiveAppointment: false,
      previousSnapshot: sendSnapshot(resumedQuote),
      userText: 'Perdón, es 2015',
      llmParts: { intro: '', technicalExplanation: '', cta: '' },
    });
    expect(composed.finalMessage).toContain('$3,400–$3,800');
    expect(composed.finalMessage).not.toMatch(/fascia/i);
  });

  it('8. full refresh sí puede mostrar quote completa', async () => {
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: resumedQuote,
      peritaje: altimaPeritaje('2014'),
      contactName: 'Arturo',
      hasActiveAppointment: false,
      previousSnapshot: snapshot,
      messageSource: 'user_requested_full_quote',
      userText: 'mándame la cotización completa',
      llmParts: { intro: 'Aquí va el desglose.', technicalExplanation: '', cta: '' },
    });
    expect(composed.mode).toBe('QUOTE_FULL_REFRESH');
    expect(composed.finalMessage).toMatch(/Reparación y pintura Fascia delantera/);
    expect(composed.finalMessage).toMatch(/Calavera derecha/);
  });

  it('9. usuario pide cotización completa → full refresh', () => {
    expect(userRequestsFullQuote('mándame la cotización completa')).toBe(true);
    expect(userRequestsFullQuote('cuánto sería todo')).toBe(true);
    expect(
      resolveClientMessageMode({
        quote: resumedQuote,
        previousSnapshot: snapshot,
        userText: 'cuánto sería todo',
      }).mode,
    ).toBe('QUOTE_FULL_REFRESH');
  });

  it('10. cita no vuelve a mandar quote', async () => {
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: resumedQuote,
      peritaje: altimaPeritaje('2014'),
      contactName: 'Arturo',
      hasActiveAppointment: false,
      previousSnapshot: sendSnapshot(resumedQuote, {
        finalMessage: '📅 ¿Quieres que agendemos una valoración en taller?',
      }),
      userText: 'Quiero mañana a las 10',
      llmParts: { intro: 'Hola', technicalExplanation: 'Se observa daño', cta: '¿quieres agendar?' },
    });
    expect(composed.mode).toBe('APPOINTMENT_FOLLOWUP');
    expect(composed.finalMessage).not.toMatch(/Inversión Total Estimada/i);
    expect(composed.finalMessage).not.toMatch(/fascia/i);
    expect(composed.finalMessage).not.toMatch(/¿Quieres que agendemos/i);
    expect(composed.financialBlock).toBe('');
  });

  it('11. warnings deduplicados en presentation layer', () => {
    const presented = presentClientWarnings([
      'HIDDEN_DAMAGE',
      'POSSIBLE_SUBSTITUTION',
      'AWAITING_VEHICLE_DATA',
    ]);
    expect(presented.warningsRenderedCount).toBe(2);
    expect(presented.text.match(/⚠️/g)?.length).toBe(2);
    expect(presented.shownWarnings).toEqual(
      expect.arrayContaining(['HIDDEN_DAMAGE', 'POSSIBLE_SUBSTITUTION', 'AWAITING_VEHICLE_DATA']),
    );
  });

  it('12. labels humanos', async () => {
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: resumedQuote,
      peritaje: altimaPeritaje('2014'),
      contactName: 'Arturo',
      hasActiveAppointment: false,
      previousSnapshot: snapshot,
      messageSource: 'pending_requirement_resume',
      userText: 'Nissan Altima 2014',
      llmParts: { intro: 'ok', technicalExplanation: '', cta: '' },
    });
    expect(composed.finalMessage).toContain('Calavera derecha');
    expect(composed.finalMessage).not.toContain('Calavera_Derecha');
    expect(composed.finalMessage).not.toContain('Faro_Izquierdo');
  });

  it('13. disclaimer de REFACCION permanece', async () => {
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: resumedQuote,
      peritaje: altimaPeritaje('2014'),
      contactName: 'Arturo',
      hasActiveAppointment: false,
      previousSnapshot: snapshot,
      messageSource: 'pending_requirement_resume',
      userText: 'Nissan Altima 2014',
      llmParts: { intro: 'ok', technicalExplanation: '', cta: '' },
    });
    expect(composed.finalMessage).toContain(REFACCION_AVAILABILITY_DISCLAIMER);
  });

  it('14. MONTAJE se presenta después de REFACCION', async () => {
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: resumedQuote,
      peritaje: altimaPeritaje('2014'),
      contactName: 'Arturo',
      hasActiveAppointment: false,
      previousSnapshot: snapshot,
      messageSource: 'pending_requirement_resume',
      userText: 'Nissan Altima 2014',
      llmParts: { intro: 'ok', technicalExplanation: '', cta: '' },
    });
    const refIdx = composed.finalMessage.indexOf('Refacción Calavera derecha');
    const monIdx = composed.finalMessage.indexOf('Montaje Calavera derecha');
    expect(refIdx).toBeGreaterThan(-1);
    expect(monIdx).toBeGreaterThan(refIdx);
  });

  it('15. LLM no puede alterar montos', async () => {
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: resumedQuote,
      peritaje: altimaPeritaje('2014'),
      contactName: 'Arturo',
      hasActiveAppointment: false,
      previousSnapshot: snapshot,
      messageSource: 'pending_requirement_resume',
      userText: 'Nissan Altima 2014',
      llmParts: {
        intro: 'El total queda en $99,000 y la calavera en $12,000',
        technicalExplanation: '',
        cta: 'ok',
      },
    });
    expect(composed.finalMessage).not.toContain('$99,000');
    expect(composed.finalMessage).not.toContain('$12,000');
    expect(composed.finalMessage).toContain(formatQuoteMoney(resumedQuote.total));
    expect(composed.fallbackUsed).toBe(true);
  });

  it('16. financial integrity 100%', async () => {
    const composed = await composeModernClientQuoteMessage({
      canonicalQuote: resumedQuote,
      peritaje: altimaPeritaje('2014'),
      contactName: 'Arturo',
      hasActiveAppointment: false,
      previousSnapshot: snapshot,
      messageSource: 'pending_requirement_resume',
      userText: 'Nissan Altima 2014',
      llmParts: { intro: 'Perfecto.', technicalExplanation: '', cta: '' },
    });
    const validation = validateFinalClientQuoteMessage({
      canonicalQuote: resumedQuote,
      renderedFinancialBlock: composed.financialBlock,
      finalMessage: composed.finalMessage,
      warningsBlock: composed.warningsBlock,
      peritaje: altimaPeritaje('2014'),
      scope: {
        presentation: 'DELTA',
        requiredQuoteLineIds: ['ql_cala_ref', 'ql_cala_mon'],
      },
    });
    expect(validation.ok).toBe(true);
    expect(composed.finalMessage).toContain(formatQuoteMoney(resumedQuote.total));
  });
});
