export const SOCKET_UNAUTHORIZED = 'unauthorized';

export type SocketHandshake = {
  auth?: { token?: unknown; tallerId?: unknown };
  query?: Record<string, unknown>;
};

export type SocketAuthDecision =
  | { ok: true; tallerId: string }
  | { ok: false; reason: 'missing' | 'invalid' };

type VerifiedWorkshop = { tallerId?: string };

/**
 * La sala sale solo del JWT en handshake.auth.
 * Un tallerId o un token en la query no eligen el taller.
 */
export async function authorizeSocketHandshake(
  handshake: SocketHandshake,
  verify: (token: string) => Promise<VerifiedWorkshop>,
): Promise<SocketAuthDecision> {
  const token = handshake.auth?.token;
  if (typeof token !== 'string' || !token.trim()) {
    return { ok: false, reason: 'missing' };
  }
  try {
    const payload = await verify(token.trim());
    const tallerId = String(payload?.tallerId ?? '').trim();
    if (!tallerId) return { ok: false, reason: 'invalid' };
    return { ok: true, tallerId };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

export function createSocketAuthMiddleware(
  verify: (token: string) => Promise<VerifiedWorkshop>,
) {
  return async (
    socket: { handshake: SocketHandshake; data: { tallerId?: string } },
    next: (err?: Error) => void,
  ) => {
    const decision = await authorizeSocketHandshake(socket.handshake, verify);
    if (!decision.ok) {
      next(new Error(SOCKET_UNAUTHORIZED));
      return;
    }
    socket.data.tallerId = decision.tallerId;
    next();
  };
}
