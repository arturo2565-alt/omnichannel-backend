import { inflateSync } from 'node:zlib';
import { detectCalibrationImageFormat } from './calibration-image-archive.service';

/**
 * Muestra el color de carrocería en PNG RGB de 8 bits.
 * No inventa acabado, código ni color original.
 * Una foto que no se puede muestrear no vota.
 */

export type BodyColorSample = {
  color: string | null;
  method: 'body_pixel_sample';
  status: 'clear' | 'ambiguous' | 'contradictory' | 'none';
};

const NAMES = ['rojo', 'naranja', 'amarillo', 'verde', 'azul', 'guinda', 'blanco', 'negro'] as const;

export function inferBodyColor(images: readonly Buffer[]): BodyColorSample {
  if (images.length === 0) return { color: null, method: 'body_pixel_sample', status: 'none' };
  const samples = images.map(sampleImage);
  const votes = samples.flatMap((sample) => (sample.kind === 'clear' ? [sample.color] : []));
  const distinct = new Set(votes);
  if (distinct.size > 1) return { color: null, method: 'body_pixel_sample', status: 'contradictory' };
  if (distinct.size === 1) return { color: votes[0], method: 'body_pixel_sample', status: 'clear' };
  if (samples.some((sample) => sample.kind === 'ambiguous')) {
    return { color: null, method: 'body_pixel_sample', status: 'ambiguous' };
  }
  return { color: null, method: 'body_pixel_sample', status: 'none' };
}

function sampleImage(bytes: Buffer): { kind: 'clear'; color: string } | { kind: 'ambiguous' } | { kind: 'unreadable' } {
  if (detectCalibrationImageFormat(bytes) !== 'png') return { kind: 'unreadable' };
  const pixels = readPngRgb(bytes);
  if (!pixels) return { kind: 'unreadable' };
  const counts = new Map<string, number>();
  let counted = 0;
  let light = 0;
  const step = Math.max(1, Math.floor(pixels.length / 3 / 2000));
  for (let index = 0; index < pixels.length; index += 3 * step) {
    const named = nameOf(pixels[index], pixels[index + 1], pixels[index + 2]);
    if (named.kind === 'light') {
      light += 1;
      continue;
    }
    if (named.kind !== 'color') continue;
    counted += 1;
    counts.set(named.color, (counts.get(named.color) ?? 0) + 1);
  }
  if (counted === 0) return light > 0 ? { kind: 'ambiguous' } : { kind: 'unreadable' };
  let best = '';
  let bestCount = 0;
  for (const name of NAMES) {
    const count = counts.get(name) ?? 0;
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  if (!best || bestCount / counted < 0.8) return { kind: 'ambiguous' };
  return { kind: 'clear', color: best };
}

function nameOf(red: number, green: number, blue: number): { kind: 'color'; color: string } | { kind: 'light' } | { kind: 'dark' } {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const average = (red + green + blue) / 3;
  if (delta < 18) {
    if (average >= 245 || average < 20) return { kind: average >= 245 ? 'light' : 'dark' };
    if (average >= 210) return { kind: 'color', color: 'blanco' };
    if (average <= 45) return { kind: 'color', color: 'negro' };
    return { kind: 'light' };
  }
  if (max < 80) return { kind: 'dark' };
  if (max > 245 && delta < 40) return { kind: 'light' };
  let hue = 0;
  if (max === red) hue = ((green - blue) / delta) % 6;
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  let color = 'rojo';
  if (hue < 15 || hue >= 345) color = 'rojo';
  else if (hue < 45) color = 'naranja';
  else if (hue < 70) color = 'amarillo';
  else if (hue < 170) color = 'verde';
  else if (hue < 255) color = 'azul';
  else if (hue < 320) color = 'guinda';
  return { kind: 'color', color };
}

function readPngRgb(buffer: Buffer): Buffer | null {
  if (buffer.length < 8) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const parts: Buffer[] = [];
  let sawHeader = false;
  let sawEnd = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (offset + 12 + length > buffer.length) return null;
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      if (length !== 13) return null;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      sawHeader = true;
    } else if (type === 'IDAT') {
      parts.push(Buffer.from(data));
    } else if (type === 'IEND') {
      sawEnd = true;
      break;
    }
    offset += 12 + length;
  }
  if (!sawHeader || !sawEnd || colorType !== 2 || bitDepth !== 8 || interlace !== 0) return null;
  if (width < 1 || height < 1 || width > 2048 || height > 2048) return null;
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(parts));
  } catch {
    return null;
  }
  const rowBytes = width * 3;
  if (inflated.length !== (rowBytes + 1) * height) return null;
  const pixels = Buffer.alloc(width * height * 3);
  for (let row = 0; row < height; row += 1) {
    const filter = inflated[row * (rowBytes + 1)];
    const source = row * (rowBytes + 1) + 1;
    const target = row * rowBytes;
    if (filter > 4) return null;
    for (let column = 0; column < rowBytes; column += 1) {
      const left = column >= 3 ? pixels[target + column - 3] : 0;
      const up = row > 0 ? pixels[target - rowBytes + column] : 0;
      const upLeft = row > 0 && column >= 3 ? pixels[target - rowBytes + column - 3] : 0;
      const raw = inflated[source + column];
      let value = raw;
      if (filter === 1) value = (raw + left) & 255;
      else if (filter === 2) value = (raw + up) & 255;
      else if (filter === 3) value = (raw + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) value = (raw + paeth(left, up, upLeft)) & 255;
      pixels[target + column] = value;
    }
  }
  return pixels;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}
