import { Logger } from '@nestjs/common';
import type { DraftQuote } from './autofix-config';
import type { DetectedDamageItem, VehicleDamageAnalysis } from './entities/chat.entity';
import type { DraftQuoteEntity } from './entities/draft-quote.entity';
import { canonicalPhysicalPanelKey } from './piece-treatment';
import {
  compareLegacyVsCanonical,
  formatShadowLogPayload,
  isCanonicalPeritajeV1,
  selectCanonicalShadowToPersist,
  tryBuildVisionCanonicalShadow,
  type CanonicalPeritajeV1,
  type CanonicalShadowComparison,
} from '../domain/peritaje-v1';
import { isBanioPinturaCompletoVisionInventory } from './vision-bpc-inventory';
import {
  adaptCalculatedRowsToCanonicalQuoteV1,
  draftLinesToCalculatedRows,
} from './quote-line-identity';

const logger = new Logger('CanonicalShadow');

export type VisionShadowInput = {
  conversationId: string;
  tallerId?: string | null;
  messageId?: string;
  incomingInventory: readonly DetectedDamageItem[];
  priorInventory?: readonly DetectedDamageItem[];
  existingCart?: Pick<DraftQuoteEntity, 'canonicalPeritajeV1' | 'damageAnalysis'> | null;
  analysis?: Pick<VehicleDamageAnalysis, 'vehiculoDetectado' | 'quoteCartMeta'>;
  visionVehicleLabel?: string | null;
  userConfirmedVehicleLabel?: string | null;
  viability?: {
    peritajeViable?: boolean;
    motivoInviable?: string;
    mensajeClienteAclaracion?: string;
  };
};

export function priorCanonicalFromCart(
  cart: Pick<DraftQuoteEntity, 'canonicalPeritajeV1'> | null | undefined,
): CanonicalPeritajeV1 | null {
  const raw = cart?.canonicalPeritajeV1;
  return isCanonicalPeritajeV1(raw) ? raw : null;
}

/** Construye shadow. Nunca lanza. No muta inventario legacy. */
export function buildVisionShadowSafe(
  input: VisionShadowInput,
): CanonicalPeritajeV1 | null {
  try {
    const cartProfile = input.existingCart?.damageAnalysis?.quoteCartMeta
      ?.vehiclePricingProfile;
    return tryBuildVisionCanonicalShadow({
      conversationId: input.conversationId,
      tallerId: input.tallerId,
      messageId: input.messageId,
      incomingInventory: input.incomingInventory,
      priorInventory: input.priorInventory,
      priorCanonical: priorCanonicalFromCart(input.existingCart),
      visionVehicleLabel: input.visionVehicleLabel,
      analysisVehicleLabel: input.analysis?.vehiculoDetectado,
      cartVehicleLabel:
        cartProfile?.vehicleLabel ??
        input.existingCart?.damageAnalysis?.vehiculoDetectado,
      cartVehicleSource: cartProfile?.tierSource,
      userConfirmedVehicleLabel: input.userConfirmedVehicleLabel,
      pricingProfileLabel: cartProfile?.vehicleLabel,
      replaceInventory: isBanioPinturaCompletoVisionInventory(
        input.incomingInventory,
      ),
      canonicalizePanel: canonicalPhysicalPanelKey,
      viability: input.viability,
    });
  } catch (err) {
    logger.warn(
      formatShadowLogPayload({
        conversationId: input.conversationId,
        peritajeId: 'n/a',
        tallerId: input.tallerId,
        status: 'CANONICAL_INVALID',
        differences: [],
      }),
    );
    logger.warn(
      `shadow_build_failed conversationId=${input.conversationId} err=${
        err instanceof Error ? err.message : 'unknown'
      }`,
    );
    return null;
  }
}

export function commitVisionShadowToDraft(input: {
  draft: DraftQuoteEntity;
  incoming: CanonicalPeritajeV1 | null | undefined;
  analysis: VehicleDamageAnalysis;
  quotePayload?: DraftQuote | null;
}): CanonicalShadowComparison | null {
  try {
    const prior = priorCanonicalFromCart(input.draft);
    const decision = selectCanonicalShadowToPersist({
      prior,
      incoming: input.incoming ?? null,
    });
    if (decision.persisted) {
      input.draft.canonicalPeritajeV1 = decision.persisted;
    }

    commitCanonicalQuoteShadow({
      draft: input.draft,
      quotePayload: input.quotePayload,
    });

    const canonical = decision.persisted ?? input.incoming;
    if (!canonical) return null;

    const comparison = compareLegacyVsCanonical({
      canonical,
      conversationId: input.draft.conversationId,
      draftQuoteId: input.draft.id,
      tallerId: input.draft.tallerId,
      status:
        decision.status === 'CANONICAL_SKIPPED'
          ? 'CANONICAL_INVALID'
          : decision.status,
      canonicalizePanel: canonicalPhysicalPanelKey,
      legacy: {
        inventory: input.analysis.inventory,
        vehiculoDetectado: input.analysis.vehiculoDetectado,
        lines: input.quotePayload?.lines,
        analysisBasisInventory: input.quotePayload?.analysisBasis?.inventory,
      },
    });
    const payload = formatShadowLogPayload(comparison, {
      violationCodes: decision.violations.map((v) => v.code),
    });

    if (decision.status === 'CANONICAL_INVALID') {
      logger.warn(payload);
    } else if (comparison.differences.length) {
      logger.log(payload);
    }
    return comparison;
  } catch (err) {
    logger.warn(
      `shadow_commit_failed conversationId=${input.draft.conversationId} err=${
        err instanceof Error ? err.message : 'unknown'
      }`,
    );
    return null;
  }
}

/** Adapta líneas ya calculadas. No re-preciar. No autoridad productiva. */
export function commitCanonicalQuoteShadow(input: {
  draft: DraftQuoteEntity;
  quotePayload?: DraftQuote | null;
}): void {
  try {
    if (input.draft.canonicalQuoteV1?.lines?.length) return;
    const lines = input.quotePayload?.lines ?? [];
    const peritajeId = input.draft.canonicalPeritajeV1?.peritajeId;
    if (!lines.length || !peritajeId) return;
    if (!lines.some((l) => l.damageItemId && l.quoteLineId)) return;
    const shadow = adaptCalculatedRowsToCanonicalQuoteV1({
      rows: draftLinesToCalculatedRows(lines),
      peritajeId,
      quoteId: input.draft.canonicalQuoteV1?.quoteId,
      generatedAt: input.quotePayload?.generatedAt,
    });
    if (shadow) input.draft.canonicalQuoteV1 = shadow;
  } catch (err) {
    logger.warn(
      `quote_shadow_failed conversationId=${input.draft.conversationId} err=${
        err instanceof Error ? err.message : 'unknown'
      }`,
    );
  }
}
