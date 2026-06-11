import type { QuoteRowInput } from './draft-quote-inventory-pricing';

/** Fila de inventario enviada por el panel o PATCH del carrito. */
export type PatchCartInventoryLineDto = QuoteRowInput & {
  descripcionTecnica?: string;
  /** @deprecated usar descripcionTecnica */
  descripcion?: string;
  detallesRefaccion?: string;
  urls_origen?: string[];
  /** @deprecated usar urls_origen */
  urls_asociadas?: string[];
};

export type PatchConversationCartBody = {
  inventoryLines: PatchCartInventoryLineDto[];
};

export type QuoteCartEstado =
  | 'vacio'
  | 'pendiente_aprobacion'
  | 'complemento_pendiente'
  | 'aprobado';
