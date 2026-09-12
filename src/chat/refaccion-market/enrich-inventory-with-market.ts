import type {
  DetectedDamageItem,
  VehicleDamageAnalysis,
} from '../entities/chat.entity';
import {
  applyXorTreatmentsToInventory,
  resolveInventoryTreatment,
} from '../piece-treatment';
import { resolveMarketVehicleText } from '../vision-bpc-inventory';
import { applyMarketEstimateToItem } from './apply-estimate-to-item';
import { parseVehiclePartIdentity } from './parse-vehicle-part-identity';
import type { RefaccionMarketService } from './refaccion-market.orchestrator';
import {
  logRefaccionMarketEvent,
  REFACCION_MARKET_EVENTS,
  type RefaccionMarketEventSink,
} from './refaccion-market-events';
import type { RefaccionMarketEstimate } from './refaccion-market.types';

function emitEstimateOutcome(
  estimate: RefaccionMarketEstimate,
  emit: RefaccionMarketEventSink,
): void {
  if (estimate.pricingStatus === 'OK') {
    emit(REFACCION_MARKET_EVENTS.ESTIMATE_READY, {
      pieza: estimate.identity.piezaLabel,
      marca: estimate.identity.marca,
      modelo: estimate.identity.modelo,
      anio: estimate.identity.anio,
      sampleCount: estimate.cantidadMuestras,
      priceSource: estimate.priceSource,
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
  });
}

/**
 * Única ruta CANONICAL para precio de REFACCION: investigación de mercado.
 * No lee refaccion_catalog. Un precio manual previo en el ítem se descarta.
 */
export async function enrichInventoryWithMarketRefacciones(
  analysis: VehicleDamageAnalysis,
  marketService: RefaccionMarketService,
  emit: RefaccionMarketEventSink = logRefaccionMarketEvent,
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
    const identity = parseVehiclePartIdentity({
      vehiculoText,
      pieza: it.pieza,
    });
    emit(REFACCION_MARKET_EVENTS.SEARCH_STARTED, {
      pieza: identity.piezaLabel,
      marca: identity.marca,
      modelo: identity.modelo,
      anio: identity.anio,
      confirmed: identity.confirmed,
    });
    const estimate = await marketService.estimate(identity);
    emitEstimateOutcome(estimate, emit);
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
