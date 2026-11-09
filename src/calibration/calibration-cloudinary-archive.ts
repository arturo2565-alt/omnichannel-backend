import { createHash } from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import { confirmArchiveChecksum } from './calibration-engine';
import { validateCalibrationImage } from './calibration-image-archive.service';

/**
 * CAL-007A. Uploads a private image and archives it only after an authenticated
 * download reproduces the original SHA-256. No delivery URL leaves this module.
 */
export type CloudinaryReceipt = {
  assetId: string;
  publicId: string;
  version: number;
  bytes: number;
  format: string;
  type: string;
  resourceType: string;
};

export type CloudinaryGateway = {
  uploadAuthenticated(input: { publicId: string; bytes: Buffer }): Promise<CloudinaryReceipt>;
  downloadAuthenticated(input: { publicId: string; format: string; version?: number }): Promise<Buffer>;
};

/** CAL-010 photos stay on this prefix. It is not the CAL-008 probe and not a real case. */
export const CAL010_CLOUDINARY_PREFIX = 'pegazuz_calibration/cal010-probe';

export type VerifiedCalibrationPhoto = {
  sha256: string;
  verified: boolean;
  assetPublicId: string | null;
  assetVersion: number | null;
};

const UNVERIFIED: Omit<VerifiedCalibrationPhoto, 'sha256'> = {
  verified: false,
  assetPublicId: null,
  assetVersion: null,
};

export class CalibrationCloudinaryArchive {
  constructor(
    private readonly gateway: CloudinaryGateway,
    private readonly publicPrefix = 'pegazuz_calibration',
  ) {
    if (this.publicPrefix !== 'pegazuz_calibration' && this.publicPrefix !== CAL010_CLOUDINARY_PREFIX) {
      throw new Error('Calibration photo prefix is not allowed');
    }
  }

  async store(input: { caseId: string; bytes: Buffer }): Promise<VerifiedCalibrationPhoto> {
    const checked = validateCalibrationImage(input.bytes);
    if (!this.caseIdAllowed(input.caseId)) return { sha256: checked.sha256, ...UNVERIFIED };
    const publicId = `${this.publicPrefix}/${input.caseId}/${checked.sha256.slice(0, 32)}`;
    if (!this.publicIdAllowed(publicId)) return { sha256: checked.sha256, ...UNVERIFIED };
    let receipt: CloudinaryReceipt;
    try {
      receipt = await this.gateway.uploadAuthenticated({ publicId, bytes: input.bytes });
    } catch {
      if (this.publicPrefix !== CAL010_CLOUDINARY_PREFIX) return { sha256: checked.sha256, ...UNVERIFIED };
      return this.confirmExisting(publicId, checked.sha256, checked.format);
    }
    if (!receiptMatches(receipt, publicId, input.bytes.length, checked.format)) {
      return { sha256: checked.sha256, ...UNVERIFIED };
    }
    let downloaded: Buffer;
    try {
      downloaded = await this.gateway.downloadAuthenticated({
        publicId: receipt.publicId,
        format: checked.format,
        version: receipt.version,
      });
    } catch {
      return { sha256: checked.sha256, ...UNVERIFIED };
    }
    const downloadedSha = createHash('sha256').update(downloaded).digest('hex');
    if (!confirmArchiveChecksum(checked.sha256, downloadedSha)) {
      return { sha256: checked.sha256, ...UNVERIFIED };
    }
    return {
      sha256: checked.sha256,
      verified: true,
      assetPublicId: receipt.publicId,
      assetVersion: receipt.version,
    };
  }

  private caseIdAllowed(caseId: string): boolean {
    if (this.publicPrefix !== CAL010_CLOUDINARY_PREFIX) return true;
    return /^AF-9\d{5}$/.test(caseId) && caseId !== 'AF-900000' && caseId !== 'AF-000001';
  }

  private publicIdAllowed(publicId: string): boolean {
    if (publicId.includes('://')) return false;
    if (this.publicPrefix === CAL010_CLOUDINARY_PREFIX) {
      return publicId.startsWith(`${CAL010_CLOUDINARY_PREFIX}/AF-9`)
        && !publicId.includes('AF-900000')
        && !publicId.includes('AF-000001')
        && !publicId.includes('cal008-probe');
    }
    return publicId.startsWith('pegazuz_calibration/');
  }

  private async confirmExisting(
    publicId: string,
    sha256: string,
    format: string,
  ): Promise<VerifiedCalibrationPhoto> {
    try {
      const downloaded = await this.gateway.downloadAuthenticated({ publicId, format });
      const downloadedSha = createHash('sha256').update(downloaded).digest('hex');
      if (!confirmArchiveChecksum(sha256, downloadedSha) || !this.publicIdAllowed(publicId)) {
        return { sha256, ...UNVERIFIED };
      }
      return { sha256, verified: true, assetPublicId: publicId, assetVersion: null };
    } catch {
      return { sha256, ...UNVERIFIED };
    }
  }
}

function receiptMatches(
  receipt: CloudinaryReceipt,
  publicId: string,
  size: number,
  format: string,
): boolean {
  const formatMatches = receipt.format === format || (format === 'jpg' && receipt.format === 'jpeg');
  return Boolean(receipt.assetId)
    && receipt.publicId === publicId
    && receipt.type === 'authenticated'
    && receipt.resourceType === 'image'
    && receipt.bytes === size
    && Number.isInteger(receipt.version)
    && receipt.version > 0
    && formatMatches
    && !receipt.publicId.includes('://');
}

export function cloudinaryCredentials(env: NodeJS.ProcessEnv): {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
} | null {
  const cloudName = env.CLOUDINARY_CLOUD_NAME?.trim() ?? '';
  const apiKey = env.CLOUDINARY_API_KEY?.trim() ?? '';
  const apiSecret = env.CLOUDINARY_API_SECRET?.trim() ?? '';
  if (!cloudName && !apiKey && !apiSecret) return null;
  if (!cloudName || !apiKey || !apiSecret) return null;
  return { cloudName, apiKey, apiSecret };
}

/**
 * Live gateway. It is not called unless an authorized ingest request supplies
 * credentials at call time. Signed download URLs are not returned.
 */
export function createCloudinaryGateway(
  env: NodeJS.ProcessEnv,
  transport: typeof fetch = fetch,
): CloudinaryGateway | null {
  const credentials = cloudinaryCredentials(env);
  if (!credentials) return null;
  return {
    async uploadAuthenticated({ publicId, bytes }) {
      cloudinary.config({
        cloud_name: credentials.cloudName,
        api_key: credentials.apiKey,
        api_secret: credentials.apiSecret,
        secure: true,
      });
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            public_id: publicId,
            resource_type: 'image',
            type: 'authenticated',
            overwrite: false,
            unique_filename: false,
            invalidate: false,
          },
          (err, uploaded) => (err ? reject(err) : uploaded ? resolve(uploaded as unknown as Record<string, unknown>) : reject(new Error('Missing Cloudinary result'))),
        );
        stream.end(bytes);
      });
      return {
        assetId: String(result.asset_id ?? ''),
        publicId: String(result.public_id ?? ''),
        version: Number(result.version),
        bytes: Number(result.bytes),
        format: String(result.format ?? ''),
        type: String(result.type ?? ''),
        resourceType: String(result.resource_type ?? ''),
      };
    },
    async downloadAuthenticated({ publicId, format, version }) {
      cloudinary.config({
        cloud_name: credentials.cloudName,
        api_key: credentials.apiKey,
        api_secret: credentials.apiSecret,
        secure: true,
      });
      const url = cloudinary.url(publicId, {
        resource_type: 'image',
        type: 'authenticated',
        sign_url: true,
        secure: true,
        ...(version == null ? {} : { version }),
        format,
      });
      const response = await transport(url);
      if (!response.ok) throw new Error('Authenticated download failed');
      return Buffer.from(await response.arrayBuffer());
    },
  };
}
