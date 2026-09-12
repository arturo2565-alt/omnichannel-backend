/**
 * Adapters explícitos: el harness nunca toca canales, citas ni BD productiva.
 */
export type AutonomySideEffects = {
  sendWhatsApp: (payload: unknown) => Promise<void>;
  sendMessenger: (payload: unknown) => Promise<void>;
  callTwilio: (payload: unknown) => Promise<void>;
  createAppointment: (payload: unknown) => Promise<void>;
  writeProductionConversation: (payload: unknown) => Promise<void>;
  writeProductionCatalog: (payload: unknown) => Promise<void>;
};

export function createAutonomySideEffectMocks(): AutonomySideEffects & {
  calls: string[];
} {
  const calls: string[] = [];
  const blocked = (name: string) => async () => {
    calls.push(name);
    throw new Error(`Autonomy harness blocked side effect: ${name}`);
  };
  return {
    calls,
    sendWhatsApp: blocked('whatsapp'),
    sendMessenger: blocked('messenger'),
    callTwilio: blocked('twilio'),
    createAppointment: blocked('createAppointment'),
    writeProductionConversation: blocked('productionConversation'),
    writeProductionCatalog: blocked('productionCatalog'),
  };
}
