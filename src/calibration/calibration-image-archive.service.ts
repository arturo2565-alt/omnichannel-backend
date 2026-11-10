import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { v2 as cloudinary } from 'cloudinary';

/**
 * CAL-004B: private image archive building block.
 * NOT wired to a route or production module in this branch.
 */
export type CalibrationUploadReceipt = {
  imageId: string;
  caseId: string;
  tenantId: string;
  assetId: string;
  publicId: string;
  version: number;
  resourceType: 'image';
  deliveryType: 'authenticated';
  bytes: number;
  sha256: string;
  format: string;
};

const MAX_BYTES = 5 * 1024 * 1024;
const CASE_ID = /^AF-[0-9]{6}$/;
const TENANT_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export function detectCalibrationImageFormat(buffer: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export function validateCalibrationImage(buffer: Buffer): { format: 'jpg' | 'png' | 'webp'; sha256: string } {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_BYTES) {
    throw new BadRequestException('Invalid calibration image size (maximum 5 MiB)');
  }
  const decoded = decodeCalibrationImage(buffer);
  return { format: decoded.format, sha256: createHash('sha256').update(buffer).digest('hex') };
}

/** One opaque pixel. No text, time, or EXIF chunks. */
export function minimalDecodablePng(rgb: readonly [number, number, number] = [16, 32, 48]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const scanline = Buffer.from([0, rgb[0], rgb[1], rgb[2]]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanline)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function decodeCalibrationImage(buffer: Buffer): { format: 'jpg' | 'png' | 'webp'; width: number; height: number } {
  const format = detectCalibrationImageFormat(buffer);
  if (format === 'png') return { format, ...decodePng(buffer) };
  if (format === 'jpg') return { format, ...decodeJpeg(buffer) };
  if (format === 'webp') return { format, ...decodeWebp(buffer) };
  throw new BadRequestException('Unsupported calibration image content');
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, checksum]);
}

function decodePng(buffer: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) {
    throw new BadRequestException('Unsupported calibration image content');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  const dataParts: Buffer[] = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (length > buffer.length || offset + 12 + length > buffer.length) {
      throw new BadRequestException('Unsupported calibration image content');
    }
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const chunk = buffer.subarray(offset + 4, offset + 8 + length);
    const actual = buffer.readUInt32BE(offset + 8 + length);
    if ((crc32(chunk) >>> 0) !== actual) throw new BadRequestException('Unsupported calibration image content');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) throw new BadRequestException('Unsupported calibration image content');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      if (width < 1 || height < 1 || width > 10000 || height > 10000) {
        throw new BadRequestException('Unsupported calibration image content');
      }
      if (data[10] !== 0 || data[11] !== 0 || (interlace !== 0 && interlace !== 1) || !pngColorAllowed(colorType, bitDepth)) {
        throw new BadRequestException('Unsupported calibration image content');
      }
      sawHeader = true;
    } else if (type === 'IDAT') {
      if (!sawHeader) throw new BadRequestException('Unsupported calibration image content');
      dataParts.push(Buffer.from(data));
      sawData = true;
    } else if (type === 'IEND') {
      if (!sawData || length !== 0) throw new BadRequestException('Unsupported calibration image content');
      sawEnd = true;
      offset += 12;
      break;
    }
    offset += 12 + length;
  }
  if (!sawHeader || !sawData || !sawEnd || offset !== buffer.length) {
    throw new BadRequestException('Unsupported calibration image content');
  }
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(dataParts));
  } catch {
    throw new BadRequestException('Unsupported calibration image content');
  }
  if (interlace === 0) {
    const samples = PNG_SAMPLES[colorType] ?? 0;
    const rowBytes = Math.ceil((width * samples * bitDepth) / 8) + 1;
    if (samples === 0 || inflated.length !== rowBytes * height) {
      throw new BadRequestException('Unsupported calibration image content');
    }
  } else if (inflated.length === 0) {
    throw new BadRequestException('Unsupported calibration image content');
  }
  return { width, height };
}

const PNG_SAMPLES: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function pngColorAllowed(colorType: number, bitDepth: number): boolean {
  if (colorType === 0) return [1, 2, 4, 8, 16].includes(bitDepth);
  if (colorType === 2 || colorType === 4 || colorType === 6) return bitDepth === 8 || bitDepth === 16;
  if (colorType === 3) return [1, 2, 4, 8].includes(bitDepth);
  return false;
}

function decodeJpeg(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new BadRequestException('Unsupported calibration image content');
  }
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawFrame = false;
  let sawEnd = false;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) throw new BadRequestException('Unsupported calibration image content');
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9) {
      sawEnd = true;
      break;
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker < 0xc0 || offset + 2 > buffer.length) {
      throw new BadRequestException('Unsupported calibration image content');
    }
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) {
      throw new BadRequestException('Unsupported calibration image content');
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 8) throw new BadRequestException('Unsupported calibration image content');
      height = buffer.readUInt16BE(offset + 3);
      width = buffer.readUInt16BE(offset + 5);
      if (width < 1 || height < 1 || width > 10000 || height > 10000) {
        throw new BadRequestException('Unsupported calibration image content');
      }
      sawFrame = true;
    }
    offset += length;
    if (marker === 0xda) offset = skipJpegEntropy(buffer, offset);
  }
  if (!sawFrame || !sawEnd) throw new BadRequestException('Unsupported calibration image content');
  return { width, height };
}

function skipJpegEntropy(buffer: Buffer, offset: number): number {
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const markerStart = offset;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return offset;
    const marker = buffer[offset];
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 1;
      continue;
    }
    return markerStart;
  }
  return offset;
}

function decodeWebp(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    throw new BadRequestException('Unsupported calibration image content');
  }
  if (buffer.readUInt32LE(4) !== buffer.length - 8) {
    throw new BadRequestException('Unsupported calibration image content');
  }
  const kind = buffer.toString('ascii', 12, 16);
  const size = buffer.readUInt32LE(16);
  if (size < 10 || 20 + size > buffer.length) throw new BadRequestException('Unsupported calibration image content');
  if (kind === 'VP8 ') {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) {
      throw new BadRequestException('Unsupported calibration image content');
    }
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    if (width < 1 || height < 1) throw new BadRequestException('Unsupported calibration image content');
    return { width, height };
  }
  if (kind === 'VP8L') {
    if (buffer[20] !== 0x2f) throw new BadRequestException('Unsupported calibration image content');
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') {
    const width = 1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16);
    const height = 1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16);
    if (width < 1 || height < 1 || width > 10000 || height > 10000) {
      throw new BadRequestException('Unsupported calibration image content');
    }
    return { width, height };
  }
  throw new BadRequestException('Unsupported calibration image content');
}

@Injectable()
export class CalibrationImageArchiveService {
  async uploadOriginal(input: {
    tenantId: string;
    caseId: string;
    bytes: Buffer;
  }): Promise<CalibrationUploadReceipt> {
    const { tenantId, caseId, bytes } = input;
    if (!TENANT_ID.test(tenantId) || !CASE_ID.test(caseId)) {
      throw new BadRequestException('Invalid calibration tenant or case identifier');
    }
    const { format, sha256 } = validateCalibrationImage(bytes);
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    if (!cloudName || !apiKey || !apiSecret) {
      throw new ServiceUnavailableException('Private image archive is not configured');
    }

    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
    // Deterministic ID supports idempotent upload retries within the same tenant/case.
    // A DB-backed manifest and reconciliation must be added before enabling the endpoint.
    const imageId = sha256.slice(0, 32);
    const publicId = `pegazuz_calibration/${tenantId}/${caseId}/${imageId}`;
    const result = await new Promise<{
      asset_id?: string; public_id?: string; version?: number;
      bytes?: number; format?: string; type?: string; resource_type?: string;
    }>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          public_id: publicId,
          resource_type: 'image',
          type: 'authenticated',
          overwrite: false,
          unique_filename: false,
          invalidate: false,
        },
        (err, uploaded) => err ? reject(err) : uploaded ? resolve(uploaded) : reject(new Error('Missing Cloudinary result')),
      );
      stream.end(bytes);
    });
    if (!result.asset_id || !result.public_id || result.type !== 'authenticated' ||
        result.resource_type !== 'image' || typeof result.version !== 'number' ||
        result.bytes !== bytes.length) {
      throw new ServiceUnavailableException('Cloudinary upload receipt verification failed');
    }
    return {
      imageId, caseId, tenantId,
      assetId: result.asset_id,
      publicId: result.public_id,
      version: result.version,
      resourceType: 'image',
      deliveryType: 'authenticated',
      bytes: result.bytes,
      sha256,
      format,
    };
  }
}
