import type { CatalogPricingRules } from '../catalog/catalog-pricing-rules';
import type { MatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';
import type { VehiclePricingProfile } from '../catalog/vehicle-pricing-profile';
import type {
  CanonicalPeritajeV1,
  CanonicalQuoteV1,
  PendingQuoteRequirement,
  VehicleIdentity,
} from '../domain/peritaje-v1';
import { vehicleIdentityVersion } from '../domain/peritaje-v1/vehicle-identity-enrich';
import { missingRefaccionVehicleFields } from '../domain/peritaje-v1/pending-quote-requirement';
import { syncPendingQuoteRequirements } from '../domain/peritaje-v1/pending-quote-requirement';
import type { DraftQuote } from './autofix-config';
import {
  CANONICAL_TRACE_EVENTS,
  tracePendingQuoteLifecycle,
} from './canonical-trace';
import { buildCanonicalQuoteV1 } from './canonical-quote-engine';
import type { DetectedDamageItem } from './entities/chat.entity';
import {
  applyXorTreatmentsToInventory,
  resolveInventoryTreatment,
} from './piece-treatment';
import { applyAwaitingVehicleDataToItem } from './refaccion-market/apply-awaiting-vehicle-data';
import { applyMarketEstimateToItem } from './refaccion-market/apply-estimate-to-item';
import {
  marketCacheKey,
  parseVehiclePartIdentity,
} from './refaccion-market/parse-vehicle-part-identity';
import type { RefaccionMarketService } from './refaccion-market/refaccion-market.orchestrator';
import type { VehiclePartIdentity } from './refaccion-market/refaccion-market.types';

const marketInflight = new Map<string, Promise<unknown>>();
const resumeInflight = new Map<string, Promise<ResumePendingQuotePricingResult>>();

export type ResumePendingQuotePricingInput = {
  conversationId: string;
  peritaje: CanonicalPeritajeV1;
  inventory: readonly DetectedDamageItem[];
  existingQuote: CanonicalQuoteV1;
  draft: DraftQuote;
  requirements?: readonly PendingQuoteRequirement[];
  vehicle?: VehicleIdentity;
  marketService: RefaccionMarketService;
  snap: MatrixPricingSnapshot;
  vehicleProfile?: VehiclePricingProfile | null;
  pricingRules?: CatalogPricingRules | null;
  vehiculoText?: string;
};

export type ResumePendingQuotePricingResult = {
  quote: CanonicalQuoteV1;
  inventory: DetectedDamageItem[];
  peritaje: CanonicalPeritajeV1;
  requirements: PendingQuoteRequirement[];
  createdRequirements: PendingQuoteRequirement[];
  marketSearches: number;
  repricedDamageItemIds: string[];
  visionCalled: false;
  quoteChanged: boolean;
};

function marketLockKey(
  damageItemId: string,
  identity: VehiclePartIdentity,
): string {
  return `${damageItemId}|${marketCacheKey(identity)}|REFACCION`;
}

function shouldSkipMarket(
  item: DetectedDamageItem,
  identity: VehiclePartIdentity,
): boolean {
  const key = marketCacheKey(identity);
  if (item.marketIdentityKey !== key) return false;
  return (
    item.pricingStatus === 'OK' ||
    item.pricingStatus === 'INSUFFICIENT_MARKET_SAMPLE'
  );
}

async function estimateLocked(
  marketService: RefaccionMarketService,
  damageItemId: string,
  identity: VehiclePartIdentity,
): Promise<Awaited<ReturnType<RefaccionMarketService['estimate']>>> {
  const key = marketLockKey(damageItemId || 'dmg_unknown', identity);
  const existing = marketInflight.get(key);
  if (existing) {
    return existing as Promise<
      Awaited<ReturnType<RefaccionMarketService['estimate']>>
    >;
  }
  const pending = marketService.estimate(identity).finally(() => {
    marketInflight.delete(key);
  });
  marketInflight.set(key, pending);
  return pending;
}

function vehicleForItem(
  item: DetectedDamageItem,
  peritaje: CanonicalPeritajeV1,
  preferred?: VehicleIdentity,
): VehicleIdentity | undefined {
  if (preferred && (!item.vehicleId || item.vehicleId === preferred.vehicleId)) {
    return preferred;
  }
  if (item.vehicleId) {
    return peritaje.vehicles?.find((v) => v.vehicleId === item.vehicleId);
  }
  return preferred ?? peritaje.vehicles?.[0];
}

/**
 * Reanuda solo el pricing pendiente. No Vision, no treatments, no carrito nuevo.
 */
export async function resumePendingQuotePricing(
  input: ResumePendingQuotePricingInput,
): Promise<ResumePendingQuotePricingResult> {
  const vehicle = input.vehicle ?? input.peritaje.vehicles[0];
  const identityVersion = vehicle ? vehicleIdentityVersion(vehicle) : '';
  const lockKey = `${input.existingQuote.quoteId}|${identityVersion}`;
  const running = resumeInflight.get(lockKey);
  if (running) return running;
  const pending = runResume(input).finally(() => {
    resumeInflight.delete(lockKey);
  });
  resumeInflight.set(lockKey, pending);
  return pending;
}

async function runResume(
  input: ResumePendingQuotePricingInput,
): Promise<ResumePendingQuotePricingResult> {
  const vehicle = input.vehicle ?? input.peritaje.vehicles[0];
  tracePendingQuoteLifecycle(CANONICAL_TRACE_EVENTS.QUOTE_RESUME_STARTED, {
    conversationId: input.conversationId,
    quoteId: input.existingQuote.quoteId,
    vehicleId: vehicle?.vehicleId,
  });

  const collapsed = applyXorTreatmentsToInventory([...input.inventory]);
  const next: DetectedDamageItem[] = [];
  let marketSearches = 0;
  const repricedDamageItemIds: string[] = [];

  for (const it of collapsed) {
    const tratamiento = resolveInventoryTreatment(it, collapsed).treatment;
    if (tratamiento !== 'SUSTITUIR') {
      next.push({ ...it, tratamiento });
      continue;
    }
    const itemVehicle = vehicleForItem(it, input.peritaje, vehicle);
    if (
      vehicle &&
      it.vehicleId &&
      it.vehicleId !== vehicle.vehicleId
    ) {
      next.push({ ...it, tratamiento: 'SUSTITUIR' });
      continue;
    }
    const identity = parseVehiclePartIdentity({
      vehiculoText:
        itemVehicle?.displayLabel ||
        input.vehiculoText ||
        it.vehiculoDetectado,
      marca: itemVehicle?.make,
      modelo: itemVehicle?.model,
      anio: itemVehicle?.year,
      version: itemVehicle?.version ?? itemVehicle?.variant,
      pieza: it.pieza,
      moldingPosition: it.moldingPosition,
      finishType: it.finishType,
    });
    const missing = missingRefaccionVehicleFields({
      make: identity.marca,
      model: identity.modelo,
      year: identity.anio,
    });
    if (missing.length) {
      next.push(
        applyAwaitingVehicleDataToItem(
          { ...it, tratamiento: 'SUSTITUIR' },
          missing,
        ),
      );
      continue;
    }
    if (shouldSkipMarket(it, identity)) {
      next.push({ ...it, tratamiento: 'SUSTITUIR' });
      continue;
    }
    const damageItemId = String(it.damageItemId ?? '');
    tracePendingQuoteLifecycle(CANONICAL_TRACE_EVENTS.REFACCION_REPRICE_STARTED, {
      conversationId: input.conversationId,
      quoteId: input.existingQuote.quoteId,
      vehicleId: itemVehicle?.vehicleId ?? it.vehicleId,
      damageItemId,
    });
    const estimate = await estimateLocked(
      input.marketService,
      damageItemId,
      identity,
    );
    marketSearches += 1;
    if (damageItemId) repricedDamageItemIds.push(damageItemId);
    const priced = applyMarketEstimateToItem(
      {
        ...it,
        tratamiento: 'SUSTITUIR',
        detallesRefaccion: it.detallesRefaccion,
        precioMx: undefined,
        priceSource: undefined,
      },
      estimate,
    );
    tracePendingQuoteLifecycle(CANONICAL_TRACE_EVENTS.REFACCION_REPRICE_RESULT, {
      conversationId: input.conversationId,
      quoteId: input.existingQuote.quoteId,
      vehicleId: itemVehicle?.vehicleId ?? it.vehicleId,
      damageItemId,
      pricingStatus: priced.pricingStatus,
    });
    next.push(priced);
  }

  const built = buildCanonicalQuoteV1({
    peritaje: input.peritaje,
    pricedInventory: next,
    snap: input.snap,
    vehicleProfile: input.vehicleProfile,
    pricingRules: input.pricingRules,
    quoteId: input.existingQuote.quoteId,
    generatedAt: new Date().toISOString(),
  });
  if (!built.ok) {
    return {
      quote: input.existingQuote,
      inventory: next,
      peritaje: input.peritaje,
      requirements: [...(input.requirements ?? [])],
      createdRequirements: [],
      marketSearches,
      repricedDamageItemIds,
      visionCalled: false,
      quoteChanged: false,
    };
  }

  const synced = syncPendingQuoteRequirements({
    existing: input.requirements,
    conversationId: input.conversationId,
    quoteId: built.quote.quoteId,
    peritaje: input.peritaje,
    quote: built.quote,
  });

  const quoteChanged =
    built.quote.total !== input.existingQuote.total ||
    built.quote.isPartial !== input.existingQuote.isPartial ||
    JSON.stringify(
      built.quote.lines.map((l) => [
        l.quoteLineId,
        l.amount,
        l.billable,
        l.pricingStatus,
      ]),
    ) !==
      JSON.stringify(
        input.existingQuote.lines.map((l) => [
          l.quoteLineId,
          l.amount,
          l.billable,
          l.pricingStatus,
        ]),
      );

  tracePendingQuoteLifecycle(CANONICAL_TRACE_EVENTS.CANONICAL_QUOTE_RESUMED, {
    conversationId: input.conversationId,
    quoteId: built.quote.quoteId,
    vehicleId: vehicle?.vehicleId,
    pricingStatus: built.quote.lines.find((l) => l.serviceType === 'REFACCION')
      ?.pricingStatus,
  });

  return {
    quote: built.quote,
    inventory: next,
    peritaje: input.peritaje,
    requirements: synced.requirements,
    createdRequirements: synced.created,
    marketSearches,
    repricedDamageItemIds,
    visionCalled: false,
    quoteChanged,
  };
}

export function attachPendingRequirementsToDraft(
  draft: DraftQuote,
  requirements: readonly PendingQuoteRequirement[],
): DraftQuote {
  return {
    ...draft,
    pendingRequirements: [...requirements],
  };
}

export function stampPendingRequirementsAfterQuote(input: {
  draft: DraftQuote;
  peritaje: CanonicalPeritajeV1;
  quote: CanonicalQuoteV1;
  conversationId: string;
}): {
  draft: DraftQuote;
  created: PendingQuoteRequirement[];
  requirements: PendingQuoteRequirement[];
} {
  const synced = syncPendingQuoteRequirements({
    existing: input.draft.pendingRequirements,
    conversationId: input.conversationId,
    quoteId: input.quote.quoteId,
    peritaje: input.peritaje,
    quote: input.quote,
  });
  return {
    draft: attachPendingRequirementsToDraft(input.draft, synced.requirements),
    created: synced.created,
    requirements: synced.requirements,
  };
}
