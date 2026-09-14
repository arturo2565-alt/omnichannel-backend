import type {
  DetectedDamageItem,
  VehicleDamageAnalysis,
} from '../entities/chat.entity';
import type { VehicleIdentity } from '../../domain/peritaje-v1';
import { missingRefaccionVehicleFields } from '../../domain/peritaje-v1/pending-quote-requirement';
import {
  applyXorTreatmentsToInventory,
  resolveInventoryTreatment,
} from '../piece-treatment';
import { resolveMarketVehicleText } from '../vision-bpc-inventory';
import { applyAwaitingVehicleDataToItem } from './apply-awaiting-vehicle-data';
import { applyMarketEstimateToItem } from './apply-estimate-to-item';
import { parseVehiclePartIdentity } from './parse-vehicle-part-identity';
import type { RefaccionMarketService } from './refaccion-market.orchestrator';
import {
  logRefaccionMarketEvent,
  REFACCION_MARKET_EVENTS,
  type RefaccionMarketEventSink,
} from './refaccion-market-events';
import {
  DEFAULT_REFACCION_MARKET_POLICY,
  type RefaccionMarketEstimate,
} from './refaccion-market.types';

export type EnrichMarketOptions = {
  vehicles?: readonly VehicleIdentity[];
};

function emitEstimateOutcome(
  estimate: RefaccionMarketEstimate,
  emit: RefaccionMarketEventSink,
  item: DetectedDamageItem,
): void {
  const ids = {
    damageItemId: item.damageItemId,
    pieceCode: item.pieza,
  };
  if (estimate.pricingStatus === 'OK') {
    emit(REFACCION_MARKET_EVENTS.ESTIMATE_READY, {
      pieza: estimate.identity.piezaLabel,
      marca: estimate.identity.marca,
      modelo: estimate.identity.modelo,
      anio: estimate.identity.anio,
      sampleCount: estimate.cantidadMuestras,
      compatibleSampleCount: estimate.cantidadMuestras,
      priceSource: estimate.priceSource,
      pricingSource: estimate.priceSource,
      pricingStatus: estimate.pricingStatus,
      selectedPartType: estimate.partTypeGroup,
      partTypeGroup: estimate.partTypeGroup,
      priceRange: estimate.customerPriceRange ?? estimate.marketPriceRange,
      amount: estimate.customerPriceRange?.precioCentral,
      confidence: estimate.confidence,
      ...ids,
    });
    return;
  }
  emit(REFACCION_MARKET_EVENTS.INSUFFICIENT, {
    pieza: estimate.identity.piezaLabel,
    marca: estimate.identity.marca,
    modelo: estimate.identity.modelo,
    anio: estimate.identity.anio,
    confirmed: estimate.identity.confirmed,
    sampleCount: estimate.cantidadMuestras,
    ...ids,
  });
}

function resolveVehicleForItem(
  item: DetectedDamageItem,
  vehicles: readonly VehicleIdentity[] | undefined,
): VehicleIdentity | undefined {
  if (!vehicles?.length) return undefined;
  const id = String(item.vehicleId ?? '').trim();
  if (id) {
    const hit = vehicles.find((v) => v.vehicleId === id);
    if (hit) return hit;
  }
  return vehicles.length === 1 ? vehicles[0] : undefined;
}

/**
 * Única ruta CANONICAL para precio de REFACCION: investigación de mercado.
 * No lee refaccion_catalog. Un precio manual previo en el ítem se descarta.
 * No ejecuta búsqueda final si falta make/model/year.
 */
export async function enrichInventoryWithMarketRefacciones(
  analysis: VehicleDamageAnalysis,
  marketService: RefaccionMarketService,
  emit: RefaccionMarketEventSink = logRefaccionMarketEvent,
  opts?: EnrichMarketOptions,
): Promise<VehicleDamageAnalysis> {
  const collapsed = applyXorTreatmentsToInventory(analysis.inventory ?? []);
  if (!collapsed.length) return analysis;
  const vehiculoText = resolveMarketVehicleText(analysis);
  const next: DetectedDamageItem[] = [];
  for (const it of collapsed) {
    const tratamiento = resolveInventoryTreatment(it, collapsed).treatment;
    if (tratamiento !== 'SUSTITUIR') {
      next.push({ ...it, tratamiento });
      continue;
    }
    const vehicle = resolveVehicleForItem(it, opts?.vehicles);
    const identity = parseVehiclePartIdentity({
      vehiculoText: vehicle?.displayLabel || vehiculoText,
      marca: vehicle?.make,
      modelo: vehicle?.model,
      anio: vehicle?.year,
      version: vehicle?.version ?? vehicle?.variant,
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
      emit(REFACCION_MARKET_EVENTS.AWAITING_VEHICLE_DATA, {
        pieza: identity.piezaLabel,
        marca: identity.marca,
        modelo: identity.modelo,
        anio: identity.anio,
        confirmed: false,
        requiredFields: missing,
        damageItemId: it.damageItemId,
        pieceCode: it.pieza,
        pricingStatus: 'AWAITING_VEHICLE_DATA',
      });
      next.push(
        applyAwaitingVehicleDataToItem(
          { ...it, tratamiento: 'SUSTITUIR' },
          missing,
        ),
      );
      continue;
    }
    emit(REFACCION_MARKET_EVENTS.SEARCH_STARTED, {
      pieza: identity.piezaLabel,
      marca: identity.marca,
      modelo: identity.modelo,
      anio: identity.anio,
      confirmed: identity.confirmed,
      damageItemId: it.damageItemId,
      pieceCode: it.pieza,
      preferredPartTypes: DEFAULT_REFACCION_MARKET_POLICY.preferredPartTypes,
    });
    const estimate = await marketService.estimate(identity);
    emitEstimateOutcome(estimate, emit, it);
    next.push(
      applyMarketEstimateToItem(
        {
          ...it,
          tratamiento: 'SUSTITUIR',
          detallesRefaccion: it.detallesRefaccion,
          precioMx: undefined,
          priceSource: undefined,
        },
        estimate,
      ),
    );
  }
  return { ...analysis, inventory: next };
}
