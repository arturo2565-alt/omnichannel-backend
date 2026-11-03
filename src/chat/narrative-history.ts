/**
 * Proyección textual del historial que recibe narrative_canonical_parts.
 * La visión ya interpretó las fotografías. Este módulo no registra el contenido excluido.
 */
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export const NARRATIVE_HISTORY_MESSAGE_CHARS = 1_500;
export const NARRATIVE_HISTORY_TURN_LIMIT = 12;
export const NARRATIVE_HISTORY_CHAR_BUDGET = 6_000;

const DATA_MARKER = 'data:';
const BASE64_MARKER = ';base64,';
const MEDIA_HOST =
  /(?:cloudinary\.com|res\.cloudinary\.com|fbcdn\.net|fbsbx\.com|lookaside\.|scontent\.|mmg\.whatsapp\.net|whatsapp\.net|graph\.facebook\.com)/i;
const MEDIA_EXTENSION = /\.(?:jpe?g|png|gif|webp|heic|mp4|webm|mov|pdf)(?:$|[?#])/i;
const VEHICLE_IDENTITY =
  /\b(?:19|20)\d{2}\b|\b(?:kia|nissan|toyota|volkswagen|honda|mazda|chevrolet|ford|bmw|audi|mercedes|hyundai|seat|renault|peugeot|jeep|dodge|ram|suzuki|mitsubishi|subaru|fiat|tesla|byd|changan|jac|geely)\b|\bes un[ao]?\b/i;

type NarrativeTurn = {
  role: 'user' | 'assistant';
  content: string;
  index: number;
  vehicle: boolean;
};

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    if ('text' in part && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('\n');
}

function stripDataUrls(input: string): string {
  let out = '';
  let cursor = 0;
  const lower = input.toLowerCase();
  while (cursor < input.length) {
    const start = lower.indexOf(DATA_MARKER, cursor);
    if (start < 0) {
      out += input.slice(cursor);
      break;
    }
    out += input.slice(cursor, start);
    const marker = lower.indexOf(BASE64_MARKER, start);
    if (marker < 0 || marker - start > 80) {
      out += input.slice(start, start + DATA_MARKER.length);
      cursor = start + DATA_MARKER.length;
      continue;
    }
    let end = marker + BASE64_MARKER.length;
    while (end < input.length && /[a-z0-9+/=\s]/i.test(input.charAt(end))) end += 1;
    cursor = end - marker - BASE64_MARKER.length >= 20 ? end : start + DATA_MARKER.length;
    if (cursor === start + DATA_MARKER.length) out += input.slice(start, cursor);
  }
  return out;
}

function isTemporaryMediaUrl(token: string): boolean {
  if (!/^https?:\/\//i.test(token)) return false;
  return MEDIA_HOST.test(token) || MEDIA_EXTENSION.test(token);
}

export function projectNarrativeText(
  raw: unknown,
  maxChars = NARRATIVE_HISTORY_MESSAGE_CHARS,
): string {
  const stripped = stripDataUrls(contentToText(raw));
  const kept = stripped
    .split(/\s+/)
    .filter((token) => token && !isTemporaryMediaUrl(token))
    .filter((token) => !/^[A-Za-z0-9+/=]{200,}$/.test(token));
  const text = kept.join(' ').replace(/[ \t]{2,}/g, ' ').trim();
  if (!Number.isFinite(maxChars) || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

export const ORCHESTRATOR_HISTORY_MESSAGE_CHARS = 4_000;
export const ORCHESTRATOR_HISTORY_TURN_LIMIT = 15;
export const ORCHESTRATOR_HISTORY_CHAR_BUDGET = 16_000;

export function projectNarrativeHistory(
  turns: readonly ChatCompletionMessageParam[] | null | undefined,
  options?: {
    maxMessageChars?: number;
    charBudget?: number;
    turnLimit?: number;
  },
): ChatCompletionMessageParam[] {
  const maxMessageChars = options?.maxMessageChars ?? NARRATIVE_HISTORY_MESSAGE_CHARS;
  const charBudget = options?.charBudget ?? NARRATIVE_HISTORY_CHAR_BUDGET;
  const turnLimit = options?.turnLimit ?? NARRATIVE_HISTORY_TURN_LIMIT;
  const projected: NarrativeTurn[] = [];
  for (const [index, turn] of (turns ?? []).entries()) {
    if (turn?.role !== 'user' && turn?.role !== 'assistant') continue;
    const content = projectNarrativeText(turn.content, maxMessageChars);
    if (!content) continue;
    projected.push({
      role: turn.role,
      content,
      index,
      vehicle: VEHICLE_IDENTITY.test(content),
    });
  }

  const selected: NarrativeTurn[] = [];
  let chars = 0;
  for (let index = projected.length - 1; index >= 0; index -= 1) {
    const turn = projected[index];
    if (!turn.vehicle && selected.length >= turnLimit) continue;
    if (!turn.vehicle && chars + turn.content.length > charBudget) continue;
    selected.push(turn);
    chars += turn.content.length;
  }
  for (const turn of projected) {
    if (!turn.vehicle || selected.includes(turn)) continue;
    selected.push(turn);
  }
  selected.sort((a, b) => a.index - b.index);
  while (selected.length > turnLimit) {
    const nonVehicle = selected.findIndex((turn) => !turn.vehicle);
    const vehicleCount = selected.filter((turn) => turn.vehicle).length;
    if (nonVehicle >= 0) selected.splice(nonVehicle, 1);
    else if (vehicleCount > 1) selected.shift();
    else break;
  }
  return selected.map((turn) => ({ role: turn.role, content: turn.content }));
}

/** Historial del orquestador: mismo recorte de medios, con espacio para la cotización. */
export function projectOrchestratorDialogue(
  turns: readonly ChatCompletionMessageParam[] | null | undefined,
): ChatCompletionMessageParam[] {
  return projectNarrativeHistory(turns, {
    maxMessageChars: ORCHESTRATOR_HISTORY_MESSAGE_CHARS,
    charBudget: ORCHESTRATOR_HISTORY_CHAR_BUDGET,
    turnLimit: ORCHESTRATOR_HISTORY_TURN_LIMIT,
  });
}
