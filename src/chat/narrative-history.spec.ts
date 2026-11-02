import type OpenAI from 'openai';
import { QUOTE_SCHEMA_VERSION } from '../domain/peritaje-v1';
import type { CanonicalQuoteV1, QuoteLine } from '../domain/peritaje-v1';
import {
  composeCanonicalLlmNarrativeParts,
  composeModernClientQuoteMessage,
} from './canonical-quote-narrative';
import {
  NARRATIVE_HISTORY_CHAR_BUDGET,
  projectNarrativeHistory,
  projectNarrativeText,
} from './narrative-history';

function line(partial: Partial<QuoteLine> & Pick<QuoteLine, 'serviceType' | 'amount'>): QuoteLine {
  return {
    quoteLineId: partial.quoteLineId ?? `ql_${partial.serviceType}`,
    damageItemId: partial.damageItemId ?? 'dmg_fascia',
    vehicleId: 'veh_1',
    description: partial.description ?? 'fascia delantera',
    billable: partial.billable ?? true,
    confidence: 'HIGH',
    ...partial,
  };
}

function quote(): CanonicalQuoteV1 {
  const lines = [line({ serviceType: 'REPARACION_PINTURA', amount: 3400, description: 'fascia delantera' })];
  return {
    schemaVersion: QUOTE_SCHEMA_VERSION,
    quoteId: 'q_narrative_history',
    peritajeId: 'per_1',
    subtotal: 3400,
    total: 3400,
    isPartial: false,
    warnings: [],
    generatedAt: '2026-11-02T00:00:00.000Z',
    lines,
  };
}

function photo(index: number): string {
  return `data:image/jpeg;base64,${'A'.repeat(80_000)}${index}`;
}

describe('proyección del historial de narrativa', () => {
  const log = console.log;
  const info = console.info;
  const debug = console.debug;
  const warn = console.warn;
  const error = console.error;

  afterEach(() => {
    console.log = log;
    console.info = info;
    console.debug = debug;
    console.warn = warn;
    console.error = error;
  });

  it('deja fuera cinco fotografías y conserva el texto comercial', () => {
    const calls: string[] = [];
    console.log = (...args: unknown[]) => calls.push(args.map(String).join(' '));
    console.info = console.log;
    console.debug = console.log;
    console.warn = console.log;
    console.error = console.log;

    const turns = [
      { role: 'user' as const, content: 'Es un Kia K3 2023. La fascia quedó estrellada y quiero repararla.' },
      { role: 'assistant' as const, content: 'Recibido. Reviso el tratamiento de la fascia.' },
      { role: 'user' as const, content: `Te mando las fotos del golpe ${photo(1)}` },
      { role: 'user' as const, content: photo(2) },
      { role: 'user' as const, content: photo(3) },
      { role: 'user' as const, content: photo(4) },
      { role: 'user' as const, content: photo(5) },
      { role: 'user' as const, content: 'https://lookaside.fbsbx.com/whatsapp/media/foto.jpg' },
      { role: 'user' as const, content: 'https://res.cloudinary.com/demo/image/upload/golpe.png' },
    ];
    const beforeChars = turns.reduce((sum, turn) => sum + turn.content.length, 0);
    const started = performance.now();
    const projected = projectNarrativeHistory(turns);
    const elapsedMs = performance.now() - started;
    const serialized = JSON.stringify(projected);
    const afterChars = projected.reduce((sum, turn) => sum + String(turn.content).length, 0);

    expect(serialized.includes('data:image')).toBe(false);
    expect(serialized.includes('base64')).toBe(false);
    expect(serialized.includes('AAAA')).toBe(false);
    expect(serialized.includes('lookaside')).toBe(false);
    expect(serialized.includes('cloudinary')).toBe(false);
    expect(serialized).toContain('Es un Kia K3 2023');
    expect(serialized).toContain('fascia quedó estrellada');
    expect(serialized).toContain('Te mando las fotos del golpe');
    expect(serialized).toContain('Reviso el tratamiento de la fascia');
    expect(afterChars).toBeLessThan(NARRATIVE_HISTORY_CHAR_BUDGET);
    expect(beforeChars).toBeGreaterThan(400_000);
    expect(elapsedMs).toBeLessThan(100);
    expect(calls.join('\n').includes('data:image')).toBe(false);
    expect(calls.join('\n').includes('AAAA')).toBe(false);

    const metrics = {
      beforeChars,
      afterChars,
      beforeTokensEstimate: Math.ceil(beforeChars / 4),
      afterTokensEstimate: Math.ceil(afterChars / 4),
      projectionMs: Math.round(elapsedMs * 100) / 100,
    };
    expect(metrics.afterTokensEstimate).toBeLessThan(metrics.beforeTokensEstimate / 50);
  });

  it('conserva el vehículo declarado aunque el recorte se quede con los mensajes recientes', () => {
    const fillers = Array.from({ length: 20 }, (_, index) => ({
      role: 'user' as const,
      content: `Aclaración ${index}: la entrega puede ser esta semana.`,
    }));
    const projected = projectNarrativeHistory([
      { role: 'user', content: 'Es un Kia K3 2023, color gris.' },
      ...fillers,
    ]);
    const serialized = JSON.stringify(projected);
    expect(serialized).toContain('Kia K3 2023');
    expect(projected.length).toBeLessThanOrEqual(12);
  });

  it('no envía las fotografías al prompt de narrative_canonical_parts', async () => {
    let prompt = '';
    const openai = {
      chat: {
        completions: {
          create: async (params: { messages: Array<{ content?: unknown }> }) => {
            prompt = JSON.stringify(params.messages);
            return {
              id: 'cmpl',
              model: 'gpt-test',
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      intro: 'Revisé la fascia del Kia K3 2023.',
                      technicalExplanation: 'El tratamiento indicado es reparar.',
                      cta: '¿Agendamos la visita?',
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 180, completion_tokens: 130, total_tokens: 310 },
            };
          },
        },
      },
    } as unknown as OpenAI;
    const original = await composeCanonicalLlmNarrativeParts(
      openai,
      'Eres el asesor del taller.',
      {
        contactName: 'Cliente',
        hasActiveAppointment: false,
        vehicleModel: 'Kia K3 2023',
        damageIntro: 'Fascia delantera',
      },
      [
        { role: 'user', content: 'Es un Kia K3 2023. Quiero reparar la fascia.' },
        { role: 'user', content: photo(1) },
        { role: 'user', content: photo(2) },
        { role: 'user', content: photo(3) },
        { role: 'user', content: photo(4) },
        { role: 'user', content: photo(5) },
      ],
    );
    expect(prompt.includes('data:image')).toBe(false);
    expect(prompt.includes('base64')).toBe(false);
    expect(prompt).toContain('Kia K3 2023');
    expect(prompt).toContain('reparar la fascia');
    expect(original.intro).toContain('Kia K3 2023');
  });

  it('mantiene la cotización canónica y el bloque financiero', async () => {
    const canonical = quote();
    const parts = {
      intro: 'Revisé la fascia del Kia K3 2023.',
      technicalExplanation: 'El tratamiento indicado es reparar.',
      cta: '¿Agendamos la visita?',
    };
    const shared = {
      canonicalQuote: canonical,
      contactName: 'Cliente',
      hasActiveAppointment: false,
      userText: 'Es un Kia K3 2023. Quiero reparar la fascia.',
      llmParts: parts,
    };
    const withPhotos = await composeModernClientQuoteMessage({
      ...shared,
      conversationTurns: [
        { role: 'user', content: shared.userText },
        { role: 'user', content: photo(1) },
        { role: 'user', content: photo(2) },
        { role: 'user', content: photo(3) },
        { role: 'user', content: photo(4) },
        { role: 'user', content: photo(5) },
      ],
    });
    const textOnly = await composeModernClientQuoteMessage({
      ...shared,
      conversationTurns: [{ role: 'user', content: shared.userText }],
    });
    expect(withPhotos.financialBlock).toBe(textOnly.financialBlock);
    expect(withPhotos.finalMessage).toBe(textOnly.finalMessage);
    expect(canonical.total).toBe(3400);
    expect(withPhotos.financialBlock.replace(/\D/g, '')).toContain('3400');
    expect(projectNarrativeText(photo(1))).toBe('');
  });

  it('conserva textos de Messenger y WhatsApp y descarta solo su medio', () => {
    const projected = projectNarrativeHistory([
      { role: 'user', content: 'Hola, quiero cotizar por Messenger.' },
      { role: 'user', content: 'https://scontent.xx.fbcdn.net/v/foto.jpg' },
      { role: 'user', content: 'Por WhatsApp: la fascia está golpeada.' },
      { role: 'user', content: 'https://mmg.whatsapp.net/v/foto.webp' },
    ]);
    const serialized = JSON.stringify(projected);
    expect(serialized).toContain('cotizar por Messenger');
    expect(serialized).toContain('fascia está golpeada');
    expect(serialized.includes('fbcdn')).toBe(false);
    expect(serialized.includes('whatsapp.net')).toBe(false);
  });
});
