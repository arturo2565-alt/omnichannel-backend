import type { DetectedDamageItem } from './entities/chat.entity';
import { isVisionBpcPiezaCode } from './vision-bpc-inventory';
import { mergeCartInventoryItem } from './quote-cart-analysis';

export type CartPricingMode = 'bpc' | 'piezas' | 'vacio';

export function isIndividualPanelPieza(pieza: string): boolean {
  const p = String(pieza ?? '').trim();
  if (!p) return false;
  return !isVisionBpcPiezaCode(p);
}

/** Modo activo según inventario actual. */
export function detectCartPricingMode(
  inventory: readonly DetectedDamageItem[],
): CartPricingMode {
  if (!inventory.length) return 'vacio';
  const hasBpc = inventory.some((it) => isVisionBpcPiezaCode(it.pieza));
  const hasPiezas = inventory.some((it) => isIndividualPanelPieza(it.pieza));
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
  const mode = detectCartPricingMode(inventory);
  if (mode === 'piezas') {
    return inventory
      .filter((it) => isIndividualPanelPieza(it.pieza))
      .map((it) => ({
        pieza: it.pieza,
        severidad: it.severidad,
        descripcionTecnica: it.descripcionTecnica,
        urls_origen: [...(it.urls_origen ?? [])],
        ...(it.vehiculoDetectado?.trim()
          ? { vehiculoDetectado: it.vehiculoDetectado.trim() }
          : {}),
      }));
  }
  if (mode === 'bpc') {
    const bpc = inventory.find((it) => isVisionBpcPiezaCode(it.pieza));
    return bpc
      ? [
          {
            pieza: bpc.pieza,
            severidad: bpc.severidad,
            descripcionTecnica: bpc.descripcionTecnica,
            urls_origen: [...(bpc.urls_origen ?? [])],
            ...(bpc.vehiculoDetectado?.trim()
              ? { vehiculoDetectado: bpc.vehiculoDetectado.trim() }
              : {}),
          },
        ]
      : [];
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
  return mergeCartInventoryItem(withoutBpc, incoming);
}
