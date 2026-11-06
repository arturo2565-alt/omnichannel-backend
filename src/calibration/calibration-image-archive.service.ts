import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
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
  const format = detectCalibrationImageFormat(buffer);
  if (!format) throw new BadRequestException('Unsupported calibration image content');
  return { format, sha256: createHash('sha256').update(buffer).digest('hex') };
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
