jest.mock('@nestjs/bullmq', () => ({
  Processor: () => () => undefined,
  WorkerHost: class WorkerHost {},
  InjectQueue: () => () => undefined,
}));

jest.mock('bullmq', () => ({
  UnrecoverableError: class UnrecoverableError extends Error {},
}));

import { ChatService } from './chat.service';
import { projectOrchestratorDialogue } from './narrative-history';
import {
  isStagingSandboxBudgetError,
  STAGING_TURN_NOT_DELIVERED_REPLY,
} from '../config/staging-sandbox';

function photo(index: number): string {
  return `data:image/jpeg;base64,${'A'.repeat(80_000)}${index}`;
}

const quoteText = [
  'Volkswagen Beetle 2015.',
  'Pieza: fascia delantera. Reparación y pintura: $3,400.',
  'Refacción: precio pendiente de estimación.',
  'Contexto comercial: la visita se revisa en el taller.',
].join(' ');

describe('contexto del orquestador', () => {
  it('cinco fotografías grandes no llegan en base64 y el texto comercial se conserva', () => {
    const turns = [
      { role: 'user' as const, content: 'Es un Volkswagen Beetle 2015. La fascia quedó estrellada.' },
      { role: 'assistant' as const, content: quoteText },
      { role: 'user' as const, content: photo(1) },
      { role: 'user' as const, content: photo(2) },
      { role: 'user' as const, content: photo(3) },
      { role: 'user' as const, content: photo(4) },
      { role: 'user' as const, content: photo(5) },
      { role: 'user' as const, content: 'https://res.cloudinary.com/demo/golpe.jpg' },
    ];
    const beforeChars = turns.reduce((sum, turn) => sum + turn.content.length, 0);
    const projected = projectOrchestratorDialogue(turns);
    const serialized = JSON.stringify(projected);
    const afterChars = projected.reduce((sum, turn) => sum + String(turn.content).length, 0);
    const imagesForVision = turns.filter((turn) => turn.content.startsWith('data:image'));

    expect(serialized.includes('data:image')).toBe(false);
    expect(serialized.includes('base64')).toBe(false);
    expect(serialized.includes('AAAA')).toBe(false);
    expect(serialized.includes('cloudinary')).toBe(false);
    expect(serialized).toContain('Volkswagen Beetle 2015');
    expect(serialized).toContain('fascia delantera');
    expect(serialized).toContain('$3,400');
    expect(serialized).toContain('precio pendiente de estimación');
    expect(serialized).toContain('Contexto comercial');
    expect(beforeChars).toBeGreaterThan(400_000);
    expect(afterChars).toBeLessThan(2_000);
    expect(Math.ceil(afterChars / 4)).toBeLessThan(Math.ceil(beforeChars / 4) / 50);
    expect(imagesForVision).toHaveLength(5);
    expect(imagesForVision[0]?.content.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('el segundo turno de agendar conserva vehículo, precios y la frase del cliente', () => {
    const first = projectOrchestratorDialogue([
      { role: 'user', content: 'Es un Volkswagen Beetle 2015.' },
      { role: 'user', content: photo(1) },
      { role: 'assistant', content: quoteText },
    ]);
    const second = projectOrchestratorDialogue([
      ...first,
      { role: 'user', content: 'Sí, quiero agendar' },
    ]);
    const serialized = JSON.stringify(second);
    expect(serialized).toContain('Sí, quiero agendar');
    expect(serialized).toContain('Volkswagen Beetle 2015');
    expect(serialized).toContain('fascia delantera');
    expect(serialized).toContain('$3,400');
    expect(serialized).toContain('precio pendiente de estimación');
    expect(serialized.includes('data:image')).toBe(false);
  });

  it('el historial que arma el orquestador tampoco arrastra base64 ni medios de Meta', () => {
    const turns = (
      ChatService.prototype as unknown as {
        messagesToChatCompletionTurns: (
          rows: Array<{ content: string; direction: string }>,
        ) => Array<{ content: string }>;
      }
    ).messagesToChatCompletionTurns([
      { direction: 'inbound', content: 'Quiero cotizar por WhatsApp la fascia.' },
      { direction: 'inbound', content: photo(1) },
      { direction: 'inbound', content: 'https://mmg.whatsapp.net/v/foto.webp' },
      { direction: 'inbound', content: 'Por Messenger: es un Beetle 2015.' },
      { direction: 'inbound', content: 'https://scontent.xx.fbcdn.net/v/foto.jpg' },
      { direction: 'outbound', content: quoteText },
    ]);
    const serialized = JSON.stringify(projectOrchestratorDialogue(turns));
    expect(serialized).toContain('cotizar por WhatsApp');
    expect(serialized).toContain('Por Messenger');
    expect(serialized).toContain('$3,400');
    expect(serialized.includes('data:image')).toBe(false);
    expect(serialized.includes('whatsapp.net')).toBe(false);
    expect(serialized.includes('fbcdn')).toBe(false);
    expect(serialized.includes('cloudinary')).toBe(false);
  });

  it('un presupuesto agotado no inventa cita ni cotización entregada', () => {
    expect(
      isStagingSandboxBudgetError({
        status: 503,
        type: 'staging_sandbox_budget',
        message: '503 staging: los servicios externos están apagados.',
      }),
    ).toBe(true);
    expect(STAGING_TURN_NOT_DELIVERED_REPLY).toContain('expediente sigue guardado');
    expect(STAGING_TURN_NOT_DELIVERED_REPLY).toContain('no confirma ninguna cita');
    expect(STAGING_TURN_NOT_DELIVERED_REPLY).not.toMatch(/cotización actualizada/i);
    expect(STAGING_TURN_NOT_DELIVERED_REPLY).not.toMatch(/qued[oó] agendada/i);
  });
});
