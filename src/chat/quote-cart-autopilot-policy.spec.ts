import { shouldSuppressAutopilotForPendingDraft } from './quote-cart-autopilot-policy';

describe('quote-cart-autopilot-policy', () => {
  it('no bloquea si autopilot activo con borrador pendiente (carrito chat)', () => {
    expect(shouldSuppressAutopilotForPendingDraft(true, true)).toBe(false);
  });

  it('bloquea si hay borrador pendiente y autopilot apagado (visión en revisión)', () => {
    expect(shouldSuppressAutopilotForPendingDraft(true, false)).toBe(true);
  });

  it('no bloquea sin borrador pendiente', () => {
    expect(shouldSuppressAutopilotForPendingDraft(false, true)).toBe(false);
    expect(shouldSuppressAutopilotForPendingDraft(false, false)).toBe(false);
  });
});
