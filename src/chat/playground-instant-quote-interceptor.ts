import { normalizeTextForMatch } from './autofix-config';

/** Turnos recientes que analizan gate de cotización / post-cotización en el playground. */
export const PLAYGROUND_INSTANT_INTERCEPTOR_HISTORY_TURNS = 10;

export type PlaygroundHistoryTurn = { role: 'user' | 'assistant'; text: string };

/** Último turno del asistente en el historial del playground (excluye el mensaje user actual). */
export function playgroundLastAssistantMessage(
  historyTurns: readonly PlaygroundHistoryTurn[],
): string | null {
  for (let i = historyTurns.length - 1; i >= 0; i--) {
    const h = historyTurns[i];
    if (h?.role === 'assistant') {
      const t = String(h.text ?? '').trim();
      if (t) return t;
    }
  }
  return null;
}

/**
 * Heurística: el asistente ya entregó una cotización con montos de catálogo (InstantQuote / MXN).
 * Evita re-disparar el interceptor de cotización en el siguiente turno.
 */
export function playgroundAssistantLikelyDeliveredInstantCatalogQuote(
  assistantText: string,
): boolean {
  const t = String(assistantText ?? '');
  if (!t.trim() || !/\bMXN\b/i.test(t)) return false;
  if (/\$\s*[\d,.]{2,}/.test(t)) return true;
  if (/[\d,.]{2,}\s*MXN/i.test(t)) return true;
  if (/\btotal\b/i.test(t) && /\d/.test(t)) return true;
  if (
    /\b(baño|bano|pintura exterior|cerámico|ceramico|estética automotriz|estetica automotriz)\b/i.test(
      t,
    ) &&
    /[\d,.]{3,}/.test(t)
  ) {
    return true;
  }
  return false;
}

/** Día de semana o intención de agendar / interés sin pedir explícitamente otra cotización. */
export function playgroundUserSchedulingOrInterestIntent(userText: string): boolean {
  const n = normalizeTextForMatch(userText);
  if (/\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(n)) {
    return true;
  }
  if (/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/.test(userText)) {
    return true;
  }
  if (
    /\b(me interesa|me interesa mucho|quiero agendar|agendar|reservar|una cita|la cita|horario|disponibilidad|turno|que hora|a las \d|manana|mañana|pasado manana|pasado mañana|proxima semana|próxima semana|este fin|fin de semana)\b/.test(
      n,
    )
  ) {
    return true;
  }
  return false;
}

/** El usuario pide de nuevo cotización / precio de un servicio de catálogo (no solo “me interesa”). */
export function playgroundUserExplicitlyRequestsNewCatalogInstantQuote(
  userText: string,
): boolean {
  const n = normalizeTextForMatch(userText);
  if (n.includes('bano de pintura')) return true;
  if (/\b(ceramico|cerámico|estetica automotriz|estética automotriz)\b/.test(n)) return true;
  if (/\b(cuanto|cuesta|precio|cotiz|presupuest)\b/.test(n)) return true;
  return false;
}

export function playgroundUserMessageMentionsWeekdayOnlyRough(userText: string): boolean {
  const n = normalizeTextForMatch(userText);
  return /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(n);
}

export type PlaygroundInstantInterceptorDecision = {
  /** No ejecutar gate / baño LLM / tryResolve instant (dejar paso al chat normal o con herramientas). */
  skipInstantInterceptor: boolean;
  lastAssistantHadCatalogPrice: boolean;
  userSchedulingOrInterest: boolean;
  userExplicitNewCatalogQuote: boolean;
};

/**
 * Control de flujo tipo “one-shot”: no repetir cotización instantánea si el asistente ya mostró precios,
 * salvo que el usuario pida explícitamente otra cotización. Prioridad a agendamiento si hay día / interés.
 */
export function getPlaygroundInstantInterceptorDecision(args: {
  historyTurns: readonly PlaygroundHistoryTurn[];
  currentUserText: string;
}): PlaygroundInstantInterceptorDecision {
  const window = args.historyTurns.slice(-PLAYGROUND_INSTANT_INTERCEPTOR_HISTORY_TURNS);
  const last = playgroundLastAssistantMessage(window);
  const lastPrice =
    last != null && playgroundAssistantLikelyDeliveredInstantCatalogQuote(last);
  const sched = playgroundUserSchedulingOrInterestIntent(args.currentUserText);
  const explicitNew = playgroundUserExplicitlyRequestsNewCatalogInstantQuote(
    args.currentUserText,
  );

  const skipInstantInterceptor = (lastPrice && !explicitNew) || sched;

  return {
    skipInstantInterceptor,
    lastAssistantHadCatalogPrice: lastPrice,
    userSchedulingOrInterest: sched,
    userExplicitNewCatalogQuote: explicitNew,
  };
}

export function buildPlaygroundPostQuoteSchedulingSystemAppend(opts: {
  userMentionedWeekday: boolean;
}): string {
  const horario =
    'Lunes a viernes 9:00–18:00; sábados 9:00–14:00; domingo cerrado (zona horaria del taller).';
  const dosFrases = opts.userMentionedWeekday
    ? `Si el cliente mencionó un día de la semana **sin** hora exacta, responde en **máximo 2 frases**: confirma que ese día atendemos dentro de ${horario} y pide la **hora específica** que prefiera dentro de ese horario.`
    : `Si falta la hora exacta, pide una hora dentro de ${horario}`;

  return `\n\n[Panel de pruebas — fase post-cotización o agendamiento]
- Si el cliente **ya recibió precios** del catálogo en el historial y ahora muestra interés, propone día u hora, tu **única misión** es concretar la visita: usa **createAppointment** cuando tengas fecha y hora completas válidas en ISO. **No repitas** precios ni desgloses que ya enviaste, salvo que pida explícitamente otra cotización o servicio nuevo.
- ${dosFrases}
- En este simulador, **createAppointment** no persiste en base de datos: la herramienta devuelve solo vista previa si el horario es válido.`;
}
