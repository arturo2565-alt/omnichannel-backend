import type { DetectedDamageItem } from './entities/chat.entity';
import { isVisionBpcPiezaCode } from './vision-bpc-inventory';
import { isRefaccionPieza } from '../catalog/panel-pieza-catalog';
import { mergeCartInventoryItem } from './quote-cart-analysis';
import {
  applyXorTreatmentsToInventory,
  cloneDetectedDamageItem,
} from './piece-treatment';

export type CartPricingMode = 'bpc' | 'piezas' | 'vacio';

export function isIndividualPanelPieza(pieza: string): boolean {
  const p = String(pieza ?? '').trim();
  if (!p) return false;
  if (isVisionBpcPiezaCode(p) || isRefaccionPieza(p)) return false;
  return true;
}

/** Modo activo según inventario actual. */
export function detectCartPricingMode(
  inventory: readonly DetectedDamageItem[],
): CartPricingMode {
  if (!inventory.length) return 'vacio';
  const hasBpc = inventory.some((it) => isVisionBpcPiezaCode(it.pieza));
  const hasPiezas = inventory.some(
    (it) =>
      isIndividualPanelPieza(it.pieza) ||
      isRefaccionPieza(it.pieza) ||
      it.tratamiento === 'PENDIENTE' ||
      it.tratamiento === 'SUSTITUIR',
  );
  if (hasBpc && !hasPiezas) return 'bpc';
  if (hasPiezas) return 'piezas';
  return 'vacio';
}

/**
 * Elimina BPC si hay piezas sueltas (el cliente pasó de baño completo a ítems).
 * Elimina líneas a precio cero sin sentido operativo.
 */
export function sanitizeCartInventoryForPricing(
  inventory: readonly DetectedDamageItem[],
): DetectedDamageItem[] {
  const collapsed = applyXorTreatmentsToInventory(inventory);
  const mode = detectCartPricingMode(collapsed);
  if (mode === 'piezas') {
    return collapsed.filter(
      (it) =>
        isIndividualPanelPieza(it.pieza) ||
        isRefaccionPieza(it.pieza) ||
        it.tratamiento === 'PENDIENTE' ||
        it.tratamiento === 'SUSTITUIR',
    );
  }
  if (mode === 'bpc') {
    return inventory
      .filter((it) => isVisionBpcPiezaCode(it.pieza) || isRefaccionPieza(it.pieza))
      .map((it) => cloneDetectedDamageItem(it));
  }
  return [];
}

/**
 * Fusiona ítem en carrito respetando exclusión BPC ↔ piezas sueltas.
 */
export function mergeCartInventoryWithPricingMode(
  inventory: readonly DetectedDamageItem[],
  incoming: DetectedDamageItem,
): DetectedDamageItem[] {
  if (isRefaccionPieza(incoming.pieza)) {
    const stamped: DetectedDamageItem = {
      ...incoming,
      tratamiento: incoming.tratamiento ?? 'SUSTITUIR',
    };
    return applyXorTreatmentsToInventory(
      mergeCartInventoryItem(inventory, stamped),
    );
  }
  if (isVisionBpcPiezaCode(incoming.pieza)) {
    return [
      {
        pieza: incoming.pieza,
        severidad: incoming.severidad,
        descripcionTecnica: incoming.descripcionTecnica,
        urls_origen: [...(incoming.urls_origen ?? [])],
        ...(incoming.vehiculoDetectado?.trim()
          ? { vehiculoDetectado: incoming.vehiculoDetectado.trim() }
          : {}),
      },
    ];
  }

  const withoutBpc = inventory.filter((it) => !isVisionBpcPiezaCode(it.pieza));
  return applyXorTreatmentsToInventory(
    mergeCartInventoryItem(withoutBpc, incoming),
  );
}
