import { composeModernClientQuoteMessage } from '../../chat/canonical-quote-narrative';
import type { ComposedClientQuote } from '../../chat/canonical-quote-narrative';
import {
  computeQuoteDelta,
  hasMaterialTechnicalChange,
  humanLabelsLeakPieceCodes,
  presentClientWarnings,
  selectWarningCodesForPresentation,
} from '../../chat/client-message-ux';
import { applyConfirmVehicleIdentity } from '../../chat/confirm-vehicle-identity';
import { resumePendingQuotePricing } from '../../chat/resume-pending-quote-pricing';
import {
  marketCacheKey,
  parseVehiclePartIdentity,
} from '../../chat/refaccion-market/parse-vehicle-part-identity';
import { applyCustomerMargin } from '../../chat/refaccion-market/compute-market-range';
import type { VehiclePartIdentity } from '../../chat/refaccion-market/refaccion-market.types';
import type { DetectedDamageItem } from '../../chat/entities/chat.entity';
import { formatQuoteMoney } from '../../domain/peritaje-v1/quote-narrative';
import { createQuoteLineId } from '../../domain/peritaje-v1';
import type { CanonicalPeritajeV1, CanonicalQuoteV1 } from '../../domain/peritaje-v1';
import type { QuoteSendSnapshot } from '../../chat/autofix-config';
import type { MatrixPricingSnapshot } from '../../catalog/matrix-pricing-snapshot';
import { remainderInventedAmounts } from './compare';
import type { ConversationUxActual, ConversationUxCheckId } from './types';
import {
  altimaPeritaje,
  correctedAltima2015Quote,
  partialAltimaQuote,
  resumedAltimaQuote,
  sendSnapshot,
  updatedAltimaQuote,
} from './fixtures';

const DIRTY_LLM = {
  intro: 'Hola Arturo, ya revisamos las fotografías. Se aprecia afectación.',
  technicalExplanation: 'Se observa el daño visible en fascia y tapa.',
  cta: '¿Quieres agendar?',
};

const CLEAN_TRANSITION = {
  intro: 'Perfecto, ya actualicé la cotización con los datos de tu vehículo.',
  technicalExplanation: '',
  cta: '',
};

function leak(message: string, peritaje?: CanonicalPeritajeV1 | null): boolean {
  return humanLabelsLeakPieceCodes(message, peritaje?.damages);
}

function toActual(
  checkId: ConversationUxCheckId,
  composed: ComposedClientQuote,
  quote: CanonicalQuoteV1,
  peritaje: CanonicalPeritajeV1,
  extra?: Partial<ConversationUxActual>,
): ConversationUxActual {
  const financialBlock = composed.financialBlock || '';
  const invented =
    composed.mode === 'APPOINTMENT_FOLLOWUP'
      ? remainderInventedAmounts(composed.finalMessage, '___none___')
      : remainderInventedAmounts(composed.finalMessage, financialBlock);
  const totalFmt = formatQuoteMoney(quote.total);
  return {
    checkId,
    mode: composed.mode,
    shouldGreet: composed.shouldGreet,
    fullQuoteRendered: composed.fullQuoteRendered,
    deltaRendered: composed.deltaRendered,
    technicalExplanationRendered:
      composed.mode === 'INITIAL_QUOTE' || composed.mode === 'QUOTE_FULL_REFRESH'
        ? Boolean(composed.parts.technicalExplanation)
        : false,
    greetingRendered: composed.shouldGreet,
    ctaType: composed.ctaType,
    finalMessage: composed.finalMessage,
    financialBlock,
    canonicalTotal: quote.total,
    displayedTotalMatches:
      composed.mode === 'APPOINTMENT_FOLLOWUP' ||
      composed.finalMessage.includes(totalFmt),
    inventedAmounts: invented,
    warningsRenderedCount: composed.shownWarnings.length,
    postFilterInterventions: composed.postFilterInterventionsCount ?? 0,
    preFilterClean: composed.preFilterClean !== false,
    humanLabelLeak: leak(composed.finalMessage, peritaje),
    financialBlockPresent: Boolean(
      financialBlock && composed.finalMessage.includes(financialBlock),
    ),
    ...extra,
  };
}

async function compose(input: Parameters<typeof composeModernClientQuoteMessage>[0]) {
  return composeModernClientQuoteMessage(input);
}

export async function runConversationUxCheck(
  checkId: ConversationUxCheckId,
): Promise<ConversationUxActual> {
  const partial = partialAltimaQuote();
  const resumed = resumedAltimaQuote();
  const corrected = correctedAltima2015Quote();
  const updated = updatedAltimaQuote();
  const peritajeUnknown = altimaPeritaje();
  const peritaje2014 = altimaPeritaje('2014');
  const peritaje2015 = altimaPeritaje('2015');
  const partialSnap = sendSnapshot(partial);
  const resumedSnap = sendSnapshot(resumed, {
    finalMessage: '📅 ¿Quieres que agendemos una valoración en taller?',
  });

  switch (checkId) {
    case 'initial_quote_greeting': {
      const composed = await compose({
        canonicalQuote: partial,
        peritaje: peritajeUnknown,
        contactName: 'Arturo',
        hasActiveAppointment: false,
        llmParts: {
          intro: 'Hola Arturo, ya revisamos las fotografías de tu vehículo.',
          technicalExplanation: 'Golpe posterior derecho.',
          cta: '¿Me confirmas modelo y año?',
        },
      });
      return toActual(checkId, composed, partial, peritajeUnknown);
    }
    case 'resume_no_greeting':
    case 'resume_delta_only':
    case 'resume_no_technical_repeat':
    case 'human_labels':
    case 'financial_integrity': {
      const composed = await compose({
        canonicalQuote: resumed,
        peritaje: peritaje2014,
        previousPeritaje: peritajeUnknown,
        contactName: 'Arturo',
        hasActiveAppointment: false,
        previousSnapshot: partialSnap,
        messageSource: 'pending_requirement_resume',
        userText: 'Es un Nissan Altima 2014',
        llmParts:
          checkId === 'resume_no_technical_repeat' ? CLEAN_TRANSITION : DIRTY_LLM,
      });
      const delta = computeQuoteDelta(resumed, partialSnap);
      return toActual(checkId, composed, resumed, peritaje2014, {
        materialTechnicalChange: hasMaterialTechnicalChange({
          delta,
          previousPeritaje: peritajeUnknown,
          currentPeritaje: peritaje2014,
        }),
      });
    }
    case 'correction_delta': {
      const composed = await compose({
        canonicalQuote: corrected,
        peritaje: peritaje2015,
        previousPeritaje: peritaje2014,
        contactName: 'Arturo',
        hasActiveAppointment: false,
        previousSnapshot: sendSnapshot(resumed),
        messageSource: 'vehicle_identity_correction',
        userText: 'Perdón, es 2015',
        llmParts: DIRTY_LLM,
      });
      return toActual(checkId, composed, corrected, peritaje2015, {
        materialTechnicalChange: hasMaterialTechnicalChange({
          delta: computeQuoteDelta(corrected, sendSnapshot(resumed)),
          previousPeritaje: peritaje2014,
          currentPeritaje: peritaje2015,
        }),
      });
    }
    case 'update_delta': {
      const composed = await compose({
        canonicalQuote: updated,
        peritaje: peritaje2014,
        previousPeritaje: peritaje2014,
        contactName: 'Arturo',
        hasActiveAppointment: false,
        previousSnapshot: sendSnapshot(resumed),
        messageSource: 'cart_edit',
        userText: 'Agrega el espejo derecho',
        llmParts: CLEAN_TRANSITION,
      });
      return toActual(checkId, composed, updated, peritaje2014);
    }
    case 'full_refresh': {
      const composed = await compose({
        canonicalQuote: resumed,
        peritaje: peritaje2014,
        contactName: 'Arturo',
        hasActiveAppointment: false,
        previousSnapshot: resumedSnap,
        userText: '¿Me puedes mandar la cotización completa?',
        llmParts: {
          intro: 'Aquí está el desglose actualizado.',
          technicalExplanation: '',
          cta: '',
        },
      });
      return toActual(checkId, composed, resumed, peritaje2014);
    }
    case 'appointment_no_quote': {
      const composed = await compose({
        canonicalQuote: resumed,
        peritaje: peritaje2014,
        contactName: 'Arturo',
        hasActiveAppointment: false,
        previousSnapshot: resumedSnap,
        userText: 'Quiero mañana a las 10',
        llmParts: DIRTY_LLM,
      });
      return toActual(checkId, composed, resumed, peritaje2014);
    }
    case 'warning_ux': {
      const initialCodes = selectWarningCodesForPresentation({
        quote: partial,
        mode: 'INITIAL_QUOTE',
        previousSnapshot: null,
      });
      const initialPresented = presentClientWarnings(initialCodes);
      const resumeCodes = selectWarningCodesForPresentation({
        quote: resumed,
        mode: 'QUOTE_RESUME',
        previousSnapshot: partialSnap,
      });
      const resumePresented = presentClientWarnings(resumeCodes);
      const composed = await compose({
        canonicalQuote: partial,
        peritaje: peritajeUnknown,
        contactName: 'Arturo',
        hasActiveAppointment: false,
        llmParts: {
          intro: 'Arturo, ya revisamos las fotografías.',
          technicalExplanation: '',
          cta: '',
        },
      });
      return toActual(checkId, composed, partial, peritajeUnknown, {
        warningsRenderedCount: initialPresented.warningsRenderedCount,
        resumeWarningsRepeated:
          resumePresented.shownWarnings.includes('HIDDEN_DAMAGE') ||
          resumePresented.shownWarnings.includes('POSSIBLE_SUBSTITUTION'),
      });
    }
    case 'cta_state': {
      const initial = await compose({
        canonicalQuote: partial,
        peritaje: peritajeUnknown,
        contactName: 'Arturo',
        hasActiveAppointment: false,
        llmParts: { intro: 'Listo.', technicalExplanation: '', cta: '' },
      });
      const complete = await compose({
        canonicalQuote: resumed,
        peritaje: peritaje2014,
        contactName: 'Arturo',
        hasActiveAppointment: false,
        previousSnapshot: partialSnap,
        messageSource: 'pending_requirement_resume',
        userText: 'Es un Nissan Altima 2014',
        llmParts: CLEAN_TRANSITION,
      });
      const appointment = await compose({
        canonicalQuote: resumed,
        peritaje: peritaje2014,
        contactName: 'Arturo',
        hasActiveAppointment: false,
        previousSnapshot: resumedSnap,
        userText: 'Quiero mañana a las 10',
        llmParts: CLEAN_TRANSITION,
      });
      const booked = await compose({
        canonicalQuote: resumed,
        peritaje: peritaje2014,
        contactName: 'Arturo',
        hasActiveAppointment: true,
        appointmentFormatted: 'mañana a las 10:00',
        previousSnapshot: resumedSnap,
        messageSource: 'appointment_turn',
        userText: 'Confirma la cita',
        llmParts: CLEAN_TRANSITION,
      });
      const offerRe = /¿quieres (?:que )?agendar/i;
      return toActual(checkId, initial, partial, peritajeUnknown, {
        ctaSequence: [
          initial.ctaType!,
          complete.ctaType!,
          appointment.ctaType!,
          booked.ctaType!,
        ],
        appointmentCtaRepeated:
          offerRe.test(appointment.finalMessage) ||
          offerRe.test(booked.finalMessage),
      });
    }
    case 'full_refresh_emits_financial_block': {
      const composed = await compose({
        canonicalQuote: resumed,
        peritaje: peritaje2014,
        contactName: 'Arturo',
        hasActiveAppointment: false,
        previousSnapshot: resumedSnap,
        userText: 'Mándame toda la cotización otra vez',
        llmParts: {
          intro: 'Claro, Arturo. Te reenvío la cotización actualizada...',
          technicalExplanation: '',
          cta: '',
        },
      });
      return toActual(checkId, composed, resumed, peritaje2014);
    }
    case 'no_appointment_assumption': {
      const composed = await compose({
        canonicalQuote: corrected,
        peritaje: peritaje2015,
        previousPeritaje: peritaje2014,
        contactName: 'Arturo',
        hasActiveAppointment: false,
        previousSnapshot: resumedSnap,
        messageSource: 'vehicle_identity_correction',
        userText: 'Perdón, es 2015',
        llmParts: DIRTY_LLM,
      });
      return toActual(checkId, composed, corrected, peritaje2015);
    }
    case 'vehicle_correction_reruns_market': {
      const runtime = await runVehicleYearCorrectionMarketCheck();
      const composed = await compose({
        canonicalQuote: corrected,
        peritaje: peritaje2015,
        previousPeritaje: peritaje2014,
        contactName: 'Arturo',
        hasActiveAppointment: false,
        previousSnapshot: sendSnapshot(resumed),
        messageSource: 'vehicle_identity_correction',
        userText: 'Perdón, es 2015',
        llmParts: DIRTY_LLM,
      });
      return toActual(checkId, composed, corrected, peritaje2015, runtime);
    }
    default: {
      const composed = await compose({
        canonicalQuote: partial,
        peritaje: peritajeUnknown,
        contactName: 'Arturo',
        hasActiveAppointment: false,
        llmParts: { intro: 'Hola', technicalExplanation: '', cta: '' },
      });
      return toActual(checkId, composed, partial, peritajeUnknown);
    }
  }
}

export function countGreetings(messages: readonly string[]): number {
  return messages.filter((m) => /\bhola\b|👋|¡\s*listo/i.test(m)).length;
}

export async function runGreetingSequence(): Promise<string[]> {
  const partial = partialAltimaQuote();
  const resumed = resumedAltimaQuote();
  const corrected = correctedAltima2015Quote();
  const snap = sendSnapshot(partial);
  const peritajeUnknown = altimaPeritaje();
  const peritaje2014 = altimaPeritaje('2014');
  const peritaje2015 = altimaPeritaje('2015');

  const initial = await compose({
    canonicalQuote: partial,
    peritaje: peritajeUnknown,
    contactName: 'Arturo',
    hasActiveAppointment: false,
    llmParts: {
      intro: 'Hola Arturo, ya revisamos las fotografías.',
      technicalExplanation: 'Golpe posterior.',
      cta: '',
    },
  });
  const resume = await compose({
    canonicalQuote: resumed,
    peritaje: peritaje2014,
    contactName: 'Arturo',
    hasActiveAppointment: false,
    previousSnapshot: snap,
    messageSource: 'pending_requirement_resume',
    userText: 'Es un Nissan Altima 2014',
    llmParts: DIRTY_LLM,
  });
  const correction = await compose({
    canonicalQuote: corrected,
    peritaje: peritaje2015,
    contactName: 'Arturo',
    hasActiveAppointment: false,
    previousSnapshot: sendSnapshot(resumed),
    userText: 'Perdón, es 2015',
    llmParts: DIRTY_LLM,
  });
  const appointment = await compose({
    canonicalQuote: corrected,
    peritaje: peritaje2015,
    contactName: 'Arturo',
    hasActiveAppointment: false,
    previousSnapshot: sendSnapshot(corrected, {
      finalMessage: '📅 ¿Quieres que agendemos una valoración en taller?',
    }),
    userText: 'Quiero mañana a las 10',
    llmParts: DIRTY_LLM,
  });
  return [
    initial.finalMessage,
    resume.finalMessage,
    correction.finalMessage,
    appointment.finalMessage,
  ];
}

export function snapshotFromQuote(
  quote: CanonicalQuoteV1,
): QuoteSendSnapshot {
  return sendSnapshot(quote);
}

function paintSnap(): MatrixPricingSnapshot {
  return {
    matchServicio: (s: string) => s,
    getPriceForCanonical: () => 0,
    getAmount: () => 0,
    getDiasEntregaForCanonical: () => 5,
    listSeveridadesForCanonical: () => ['DL', 'MONTAJE_PINTURA'],
  } as unknown as MatrixPricingSnapshot;
}

async function runVehicleYearCorrectionMarketCheck(): Promise<
  Partial<ConversationUxActual>
> {
  const peritaje2014 = altimaPeritaje('2014');
  const vehicle = peritaje2014.vehicles[0]!;
  const identity2014 = parseVehiclePartIdentity({
    vehiculoText: vehicle.displayLabel,
    marca: vehicle.make,
    modelo: vehicle.model,
    anio: vehicle.year,
    pieza: 'Calavera_Derecha',
  });
  const oldKey = marketCacheKey(identity2014);
  const inventory: DetectedDamageItem[] = [
    {
      pieza: 'Calavera_Derecha',
      tratamiento: 'SUSTITUIR',
      damageItemId: 'dmg_cala',
      vehicleId: 'veh_1',
      vehiculoDetectado: 'Nissan Altima 2014',
      pricingStatus: 'OK',
      priceSource: 'WEB_MARKET_ESTIMATE',
      precioMx: 3650,
      marketIdentityKey: oldKey,
      severidad: 'DMFuerte',
      descripcionTecnica: 'quebrada',
      urls_origen: ['https://cdn.example/cala.jpg'],
    },
  ];
  const corrected = applyConfirmVehicleIdentity({
    peritaje: peritaje2014,
    inventory,
    args: { year: '2015' },
  });
  if (!corrected.ok) {
    return { marketLookupCount: 0, idsPreserved: false, visionCalled: false };
  }
  let marketLookupCount = 0;
  const resumed = await resumePendingQuotePricing({
    conversationId: 'c_ux_cert',
    peritaje: corrected.result.peritaje,
    inventory: corrected.result.inventory,
    existingQuote: resumedAltimaQuote(),
    draft: {
      status: 'PENDING_APPROVAL',
      currency: 'MXN',
      reference: 'AF-UX',
      generatedAt: '2026-09-14T00:00:00.000Z',
      lines: [],
      formalNarrative: '',
      subtotal: 0,
      total: 0,
      analysisBasis: {
        pieza: 'Calavera_Derecha',
        severidad: 'DMFuerte',
        partesAfectadas: ['Calavera_Derecha'],
        severidadDelDano: 'DMFuerte',
        descripcionTecnica: '',
        justificacion: '',
      },
    },
    vehicle: corrected.result.vehicle,
    forceMarketRefresh:
      corrected.result.marketIdentityChange.invalidateAffectedMarketPricing,
    marketService: {
      estimate: async (identity: VehiclePartIdentity) => {
        marketLookupCount += 1;
        const market = {
          precioMinEstimado: 3500,
          precioMaxEstimado: 4100,
          precioCentral: 3800,
        };
        return {
          pricingType: 'RANGE',
          pricingStatus: 'OK',
          marketPriceRange: market,
          customerPriceRange: applyCustomerMargin(market),
          cantidadMuestras: 5,
          cantidadDominios: 3,
          providersUsed: ['SERPER_SHOPPING'],
          priceSource: 'WEB_MARKET_ESTIMATE',
          confidence: 'MEDIUM',
          partTypeGroup: 'AFTERMARKET_NEW',
          samples: [],
          identity,
          query: `${identity.piezaLabel} ${identity.marca} ${identity.modelo} ${identity.anio}`,
        };
      },
    } as never,
    snap: paintSnap(),
  });
  const newKey = resumed.inventory[0]?.marketIdentityKey;
  const refaccion = resumed.quote.lines.find((l) => l.serviceType === 'REFACCION');
  const expectedRefId = createQuoteLineId({
    damageItemId: 'dmg_cala',
    serviceType: 'REFACCION',
  });
  const expectedMonId = createQuoteLineId({
    damageItemId: 'dmg_cala',
    serviceType: 'MONTAJE',
  });
  const montaje = resumed.quote.lines.find((l) => l.serviceType === 'MONTAJE');
  return {
    marketLookupCount,
    oldMarketIdentityKey: oldKey,
    newMarketIdentityKey: newKey,
    visionCalled: resumed.visionCalled,
    idsPreserved:
      corrected.result.vehicle.vehicleId === 'veh_1' &&
      corrected.result.inventory[0]?.damageItemId === 'dmg_cala' &&
      refaccion?.quoteLineId === expectedRefId &&
      (!montaje || montaje.quoteLineId === expectedMonId),
  };
}
