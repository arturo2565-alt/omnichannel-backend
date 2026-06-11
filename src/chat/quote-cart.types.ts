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
  /** Carrito activo editable (express + visión + chat). */
  | 'activo'
  /** Enviado al cliente y modificado desde entonces. */
  | 'activo_modificado'
  /** @deprecated usar activo */
  | 'pendiente_aprobacion'
  /** @deprecated complemento post-aprobación */
  | 'complemento_pendiente'
  /** @deprecated carrito ya no se congela al enviar */
  | 'aprobado';
