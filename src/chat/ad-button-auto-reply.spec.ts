import {
  AD_BUTTON_AUTO_REPLIES,
  matchAdButtonAutoReply,
  matchAdButtonAutoReplyForBatch,
  normalizeAdButtonKey,
} from './ad-button-auto-reply';

describe('ad-button-auto-reply', () => {
  it('normaliza etiquetas con emojis y acentos', () => {
    expect(normalizeAdButtonKey('Reparación golpe 🛠️')).toBe('reparacion golpe');
    expect(normalizeAdButtonKey('Baño de pintura 🎨')).toBe('bano de pintura');
    expect(normalizeAdButtonKey('Ubicación 📍')).toBe('ubicacion');
    expect(normalizeAdButtonKey('Agendar Cita 🏁')).toBe('agendar cita');
  });

  it('matchea los cuatro botones del anuncio por texto', () => {
    expect(matchAdButtonAutoReply({ text: 'Reparación golpe 🛠️' })?.intent).toBe(
      'reparacion_golpe',
    );
    expect(matchAdButtonAutoReply({ text: 'Baño de pintura' })?.intent).toBe(
      'banio_pintura',
    );
    expect(matchAdButtonAutoReply({ text: 'Ubicación' })?.intent).toBe('ubicacion');
    expect(matchAdButtonAutoReply({ text: 'Agendar Cita' })?.intent).toBe(
      'agendar_cita',
    );
  });

  it('prioriza payload estable', () => {
    const hit = matchAdButtonAutoReply({
      text: 'otra cosa',
      payload: 'BTN_UBICACION',
    });
    expect(hit?.intent).toBe('ubicacion');
    expect(hit?.matchedVia).toBe('payload');
  });

  it('no matchea mensajes con contexto extra (no es botón puro)', () => {
    expect(
      matchAdButtonAutoReply({
        text: 'Baño de pintura para un Jetta 2018',
      }),
    ).toBeNull();
    expect(
      matchAdButtonAutoReply({ text: 'quiero agendar cita mañana' }),
    ).toBeNull();
  });

  it('devuelve el copy fijo del anuncio', () => {
    const hit = matchAdButtonAutoReply({ text: 'Ubicación 📍' });
    expect(hit?.reply).toBe(AD_BUTTON_AUTO_REPLIES.ubicacion);
    expect(hit?.reply).toContain('Av. Aztecas 368');
  });

  it('matchAdButtonAutoReplyForBatch exige misma intención', () => {
    expect(
      matchAdButtonAutoReplyForBatch(['Ubicación', 'Ubicación 📍'])?.intent,
    ).toBe('ubicacion');
    expect(
      matchAdButtonAutoReplyForBatch(['Ubicación', 'Agendar Cita']),
    ).toBeNull();
    expect(
      matchAdButtonAutoReplyForBatch(['Ubicación', 'hola']),
    ).toBeNull();
  });
});
