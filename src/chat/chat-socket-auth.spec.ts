import { JwtService } from '@nestjs/jwt';
import { ChatGateway } from './chat.gateway';
import {
  authorizeSocketHandshake,
  createSocketAuthMiddleware,
  SOCKET_UNAUTHORIZED,
} from './chat-socket-auth';

type Handshake = {
  auth?: { token?: unknown; tallerId?: unknown };
  query?: Record<string, unknown>;
};

function verify(token: string): Promise<{ tallerId?: string }> {
  if (token === 'token-a') return Promise.resolve({ tallerId: 'taller-a' });
  if (token === 'token-b') return Promise.resolve({ tallerId: 'taller-b' });
  if (token === 'token-sin-taller') return Promise.resolve({});
  if (token === 'caducado') return Promise.reject(new Error('jwt expired'));
  return Promise.reject(new Error('jwt malformed'));
}

describe('authorizeSocketHandshake', () => {
  it('rechaza una conexión sin token', async () => {
    const decision = await authorizeSocketHandshake(
      { auth: { tallerId: 'taller-a' }, query: { token: 'token-a', tallerId: 'taller-b' } },
      verify,
    );
    expect(decision).toEqual({ ok: false, reason: 'missing' });
  });

  it('rechaza un token inválido o caducado', async () => {
    await expect(
      authorizeSocketHandshake({ auth: { token: 'caducado' } }, verify),
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(
      authorizeSocketHandshake({ auth: { token: 'basura' } }, verify),
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(
      authorizeSocketHandshake({ auth: { token: 'token-sin-taller' } }, verify),
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('ignora el taller enviado por el cliente y usa el del JWT', async () => {
    const decision = await authorizeSocketHandshake(
      {
        auth: { token: 'token-a', tallerId: 'taller-b' },
        query: { token: 'token-b', tallerId: 'taller-b' },
      },
      verify,
    );
    expect(decision).toEqual({ ok: true, tallerId: 'taller-a' });
  });
});

describe('ChatGateway', () => {
  type Client = {
    handshake: Handshake;
    data: { tallerId?: string };
    rooms: Set<string>;
    events: Array<{ event: string; payload: unknown }>;
    disconnected: boolean;
    join: (room: string) => Promise<void>;
    disconnect: (close?: boolean) => void;
  };

  function client(handshake: Handshake): Client {
    const row: Client = {
      handshake,
      data: {},
      rooms: new Set<string>(),
      events: [],
      disconnected: false,
      join: async (room: string) => {
        row.rooms.add(room);
      },
      disconnect: () => {
        row.disconnected = true;
      },
    };
    return row;
  }

  function gatewayWith(clients: Client[]) {
    const globalEmits: string[] = [];
    const gateway = new ChatGateway({ verifyAsync: verify } as unknown as JwtService);
    const server = {
      use: () => undefined,
      emit: (event: string) => {
        globalEmits.push(event);
      },
      to: (room: string) => ({
        emit: (event: string, payload: unknown) => {
          for (const row of clients) {
            if (row.rooms.has(room)) row.events.push({ event, payload });
          }
        },
      }),
    };
    gateway.server = server as unknown as ChatGateway['server'];
    return { gateway, globalEmits };
  }

  async function connect(row: Client) {
    const middleware = createSocketAuthMiddleware(verify);
    let rejected: Error | undefined;
    await middleware(row, (err) => {
      rejected = err;
    });
    return rejected;
  }

  it('no une a un socket sin token y el middleware lo rechaza', async () => {
    const row = client({ query: { tallerId: 'taller-a' } });
    const rejected = await connect(row);
    expect(rejected?.message).toBe(SOCKET_UNAUTHORIZED);
    expect(row.data.tallerId).toBeUndefined();
  });

  it('al reconectar con un JWT válido vuelve a entrar solo a su sala', async () => {
    const row = client({
      auth: { token: 'token-a', tallerId: 'taller-b' },
      query: { tallerId: 'taller-b' },
    });
    const { gateway } = gatewayWith([row]);
    expect(await connect(row)).toBeUndefined();
    await gateway.handleConnection(row as never);
    expect([...row.rooms]).toEqual(['taller:taller-a']);

    row.rooms.clear();
    row.data = {};
    expect(await connect(row)).toBeUndefined();
    await gateway.handleConnection(row as never);
    expect(row.data.tallerId).toBe('taller-a');
    expect([...row.rooms]).toEqual(['taller:taller-a']);
    expect(row.disconnected).toBe(false);
  });

  it('cada taller recibe solo sus eventos privados', async () => {
    const tallerA = client({ auth: { token: 'token-a' } });
    const tallerB = client({ auth: { token: 'token-b' } });
    expect(await connect(tallerA)).toBeUndefined();
    expect(await connect(tallerB)).toBeUndefined();
    const { gateway, globalEmits } = gatewayWith([tallerA, tallerB]);
    await gateway.handleConnection(tallerA as never);
    await gateway.handleConnection(tallerB as never);

    gateway.emitNewMessage('taller-a', { id: 'm-a' });
    gateway.emitNewMessage('taller-b', { id: 'm-b' });
    gateway.emitImageDamageAnalysis('taller-a', {
      messageId: '1',
      conversationId: 'c-a',
      damageAnalysis: { pieza: 'cofre' },
    });
    gateway.emitDraftQuoteReady('taller-b', {
      draftQuoteId: 'd-b',
      conversationId: 'c-b',
      messageId: '2',
      damageAnalysis: {},
      draftQuote: { total: 100 },
      estimateAmount: 100,
    });
    gateway.emitDraftPeritajeAwaitingVehicle('taller-a', {
      draftQuoteId: 'd-a',
      conversationId: 'c-a',
      messageId: '3',
      damageAnalysis: {},
    });
    gateway.emitConversationLeadUpdated('taller-b', {
      conversationId: 'c-b',
      status: 'cotizado',
      contactName: 'Ana',
    });
    gateway.emitAiSuggestion('taller-a', {
      conversationId: 'c-a',
      suggestion: 'hola',
    });
    gateway.emitAppointmentCreated('taller-a', {
      id: 'apt-a',
      conversationId: null,
      clientName: 'Cliente A',
      vehicle: null,
      phone: '5511111111',
      quoteSummary: null,
      scheduledAt: '2026-05-26T16:00:00.000Z',
      status: 'confirmada',
      visitStatus: 'agendada',
      tallerId: 'taller-a',
      source: 'manual',
    });
    gateway.emitAppointmentUpdated('taller-b', {
      id: 'apt-b',
      conversationId: null,
      clientName: 'Cliente B',
      vehicle: null,
      phone: '5522222222',
      quoteSummary: null,
      scheduledAt: '2026-05-26T17:00:00.000Z',
      status: 'confirmada',
      visitStatus: 'agendada',
      tallerId: 'taller-b',
      source: 'manual',
    });

    expect(globalEmits).toEqual([]);
    expect(tallerA.events.map((item) => item.event)).toEqual([
      'newMessage',
      'imageDamageAnalysis',
      'draftPeritajeAwaitingVehicle',
      'aiSuggestion',
      'appointmentCreated',
    ]);
    expect(tallerB.events.map((item) => item.event)).toEqual([
      'newMessage',
      'draftQuoteReady',
      'conversationLeadUpdated',
      'appointmentUpdated',
    ]);
    expect(tallerA.events.some((item) => item.event === 'conversationLeadUpdated')).toBe(
      false,
    );
    expect(JSON.stringify(tallerA.events)).not.toContain('Cliente B');
    expect(JSON.stringify(tallerB.events)).not.toContain('Cliente A');
    expect(JSON.stringify(tallerB.events)).toContain('contactName":"Ana"');
  });

  it('no emite a nadie si el taller de origen está vacío', () => {
    const row = client({ auth: { token: 'token-a' } });
    row.rooms.add('taller:taller-a');
    const { gateway, globalEmits } = gatewayWith([row]);
    gateway.emitNewMessage('', { id: 'oculto' });
    gateway.emitConversationLeadUpdated('   ', {
      conversationId: 'c',
      status: 'nuevo',
      contactName: 'Nadie',
    });
    expect(row.events).toEqual([]);
    expect(globalEmits).toEqual([]);
  });

  it('al arrancar registra el middleware y sigue ignorando el token de la query', async () => {
    const gateway = new ChatGateway({
      verifyAsync: verify,
    } as unknown as JwtService);
    let used:
      | ((
          socket: Client,
          next: (err?: Error) => void,
        ) => Promise<void>)
      | undefined;
    gateway.afterInit({
      use: (fn: NonNullable<typeof used>) => {
        used = fn;
      },
    } as never);
    const row = client({
      query: { token: 'token-a', tallerId: 'taller-b' },
    });
    let rejected: Error | undefined;
    await used?.(row, (err) => {
      rejected = err;
    });
    expect(rejected?.message).toBe(SOCKET_UNAUTHORIZED);
    expect(row.data.tallerId).toBeUndefined();
  });

  it('desconecta si el handshake no dejó un taller', async () => {
    const row = client({});
    const { gateway } = gatewayWith([row]);
    await gateway.handleConnection(row as never);
    expect(row.disconnected).toBe(true);
    expect(row.rooms.size).toBe(0);
  });
});
