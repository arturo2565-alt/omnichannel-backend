import {
  INCOMING_MESSAGE_DEBOUNCE_MS,
  shouldExtendInboundDebounce,
  type IncomingBufferItem,
} from './incoming-message.constants';

function item(
  kind: IncomingBufferItem['kind'],
  receivedAt: string,
): IncomingBufferItem {
  return {
    kind,
    content: kind === 'image' ? 'https://cdn.example.com/a.jpg' : 'hola',
    messageId: 'm1',
    channel: 'messenger',
    tallerId: 't1',
    receivedAt,
  };
}

describe('shouldExtendInboundDebounce', () => {
  const now = Date.parse('2026-09-10T18:00:00.000Z');

  it('reprograma si la última foto es más reciente que la ventana', () => {
    const recent = new Date(now - 2_000).toISOString();
    expect(
      shouldExtendInboundDebounce([item('image', recent)], now),
    ).toBe(true);
  });

  it('drena si ya pasaron ~25s desde la última foto', () => {
    const old = new Date(now - INCOMING_MESSAGE_DEBOUNCE_MS).toISOString();
    expect(shouldExtendInboundDebounce([item('image', old)], now)).toBe(false);
  });

  it('no extiende si solo hay texto', () => {
    const recent = new Date(now - 1_000).toISOString();
    expect(shouldExtendInboundDebounce([item('text', recent)], now)).toBe(false);
  });
});
