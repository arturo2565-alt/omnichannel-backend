import { randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { isStagingRuntime } from '../config/staging-guard';
import { readStagingSandbox } from '../config/staging-sandbox';
import {
  STAGING_OWNER_EMAIL_SUFFIX,
  STAGING_TALLER_ID,
} from '../config/staging-synthetic';

export const LAB_PLATFORM = 'lab';
export const LAB_MAX_IMAGES = 6;
export const LAB_MAX_TEXT = 2_000;
export const LAB_CONTACT_NAME = 'Cliente de laboratorio';

const LAB_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
type LabMime = (typeof LAB_MIME)[number];

const DATA_URL =
  /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FORBIDDEN_TURN_KEYS = new Set([
  'externalId',
  'externalid',
  'from',
  'wa_id',
  'waId',
  'senderId',
  'sender_id',
  'platform',
  'tallerId',
  'to',
  'phone',
  'metaMessageId',
  'messageId',
  'mid',
  'conversationId',
  'pageId',
  'metaPageId',
]);

export function isLabPlatform(platform: string | null | undefined): boolean {
  return String(platform ?? '').trim().toLowerCase() === LAB_PLATFORM;
}

function environmentHidden(env: NodeJS.ProcessEnv): boolean {
  if (!isStagingRuntime(env)) return true;
  if (String(env.RAILWAY_ENVIRONMENT_NAME ?? '').trim() === 'production') {
    return true;
  }
  const service = String(env.RAILWAY_SERVICE_NAME ?? '').trim();
  if (service === 'omnichannel-backend' || service === 'Postgres') return true;
  if (String(env.DATABASE_URL ?? '').includes('caboose.proxy.rlwy.net')) {
    return true;
  }
  return false;
}

/** El laboratorio no existe fuera del sandbox de staging. */
export function labRouteVisibility(env: NodeJS.ProcessEnv): 'hidden' | 'open' {
  if (environmentHidden(env) || !readStagingSandbox(env).active) return 'hidden';
  return 'open';
}

export function labAccess(
  env: NodeJS.ProcessEnv,
  user: AuthenticatedUser,
): 'ok' | 'hidden' | 'forbidden' {
  if (labRouteVisibility(env) === 'hidden') return 'hidden';
  const email = String(user.email ?? '');
  if (
    user.role !== 'owner' ||
    user.tallerId !== STAGING_TALLER_ID ||
    !email.endsWith(STAGING_OWNER_EMAIL_SUFFIX)
  ) {
    return 'forbidden';
  }
  return 'ok';
}

export function createLabExternalId(): string {
  const externalId = `lab:${randomUUID()}`;
  if (
    !externalId.startsWith('lab:') ||
    !UUID_RE.test(externalId.slice(4)) ||
    /^\d+$/.test(externalId)
  ) {
    throw new BadRequestException('No se pudo crear la conversación.');
  }
  return externalId;
}

export function assertEmptyLabCreateBody(body: unknown): void {
  if (body == null || body === '') return;
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('La solicitud no es válida.');
  }
  if (Object.keys(body as Record<string, unknown>).length > 0) {
    throw new BadRequestException(
      'El laboratorio no acepta identificadores de canal.',
    );
  }
}

export type ParsedLabTurn = {
  text: string;
  images: string[];
  idempotencyKey?: string;
};

export function readLabImageMaxBytes(env: NodeJS.ProcessEnv): number {
  const sandbox = readStagingSandbox(env);
  if (!sandbox.active) return 5_242_880;
  return sandbox.config.mediaMaxBytes;
}

export function parseLabTurn(body: unknown, maxImageBytes: number): ParsedLabTurn {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('La solicitud no es válida.');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_TURN_KEYS.has(key) || !['text', 'images', 'idempotencyKey'].includes(key)) {
      throw new BadRequestException(
        'El laboratorio no acepta identificadores de canal.',
      );
    }
  }
  let text = '';
  if (record.text != null) {
    if (typeof record.text !== 'string') {
      throw new BadRequestException('El texto no es válido.');
    }
    text = record.text.trim();
    if (text.length > LAB_MAX_TEXT) {
      throw new BadRequestException('El texto es demasiado largo.');
    }
    if (text.includes('data:image') || /^https?:\/\//i.test(text)) {
      throw new BadRequestException('El texto no puede incluir imágenes.');
    }
  }
  const images: string[] = [];
  if (record.images != null) {
    if (!Array.isArray(record.images)) {
      throw new BadRequestException('Las fotografías no son válidas.');
    }
    if (record.images.length > LAB_MAX_IMAGES) {
      throw new BadRequestException('Se pueden enviar hasta 6 fotografías.');
    }
    record.images.forEach((image, index) => {
      images.push(parseLabImage(image, index, maxImageBytes));
    });
  }
  if (!text && images.length === 0) {
    throw new BadRequestException('Escribe un mensaje o adjunta una fotografía.');
  }
  let idempotencyKey: string | undefined;
  if (record.idempotencyKey != null) {
    if (typeof record.idempotencyKey !== 'string' || !UUID_RE.test(record.idempotencyKey)) {
      throw new BadRequestException('La clave del turno no es válida.');
    }
    idempotencyKey = record.idempotencyKey.toLowerCase();
  }
  return { text, images, ...(idempotencyKey ? { idempotencyKey } : {}) };
}

export function labMessagePlan(
  conversationId: string,
  idempotencyKey: string,
  turn: ParsedLabTurn,
): Array<{ kind: 'text' | 'image'; content: string; externalId: string }> {
  const parts: Array<{ kind: 'text' | 'image'; content: string; externalId: string }> = [];
  if (turn.text) {
    parts.push({
      kind: 'text',
      content: turn.text,
      externalId: `lab:${conversationId}:${idempotencyKey}:text`,
    });
  }
  turn.images.forEach((content, index) => {
    parts.push({
      kind: 'image',
      content,
      externalId: `lab:${conversationId}:${idempotencyKey}:img:${index}`,
    });
  });
  return parts;
}

function parseLabImage(value: unknown, index: number, maxImageBytes: number): string {
  const label = `La fotografía ${index + 1}`;
  if (typeof value !== 'string') {
    throw new BadRequestException(`${label} no es válida.`);
  }
  if (value.length > maxImageBytes * 2) {
    throw new BadRequestException(`${label} excede el tamaño permitido.`);
  }
  if (/cloudinary|https?:\/\//i.test(value)) {
    throw new BadRequestException(`${label} debe enviarse como archivo.`);
  }
  const match = DATA_URL.exec(value);
  if (!match) {
    throw new BadRequestException(`${label} debe ser JPEG, PNG o WebP.`);
  }
  const mime = match[1].toLowerCase() as LabMime;
  if (!LAB_MIME.includes(mime)) {
    throw new BadRequestException(`${label} debe ser JPEG, PNG o WebP.`);
  }
  const encoded = match[2];
  const bytes = Buffer.from(encoded, 'base64');
  const roundTrip = bytes.toString('base64').replace(/=+$/, '');
  if (!bytes.length || roundTrip !== encoded.replace(/=+$/, '')) {
    throw new BadRequestException(`${label} no es válida.`);
  }
  if (bytes.length > maxImageBytes) {
    throw new BadRequestException(`${label} excede el tamaño permitido.`);
  }
  if (!magicMatches(mime, bytes)) {
    throw new BadRequestException(`${label} no coincide con su formato.`);
  }
  return `data:${mime};base64,${encoded}`;
}

function magicMatches(mime: LabMime, bytes: Buffer): boolean {
  if (mime === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === 'image/png') {
    return (
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
    );
  }
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}
