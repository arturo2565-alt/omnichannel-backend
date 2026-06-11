/**
 * ¿Bloquear autopilot de texto por un borrador PENDING_APPROVAL?
 *
 * - Visión → operador apaga autopilot → bloquear (revisión humana).
 * - Carrito progresivo chat/express → autopilot ON → no bloquear (sigue con tools).
 */
export function shouldSuppressAutopilotForPendingDraft(
  hasPendingDraft: boolean,
  isAutoPilotActive: boolean,
): boolean {
  if (!hasPendingDraft) return false;
  return !isAutoPilotActive;
}
