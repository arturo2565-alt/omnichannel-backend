import { createHash } from 'node:crypto';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { confirmArchiveChecksum } from './calibration-engine';
import {
  CalibrationImageArchiveService,
  validateCalibrationImage,
  type CalibrationUploadReceipt,
} from './calibration-image-archive.service';
import {
  cloudinaryCredentials,
  createCloudinaryGateway,
} from './calibration-cloudinary-archive';

/**
 * CAL-008. One synthetic authenticated image, outside real case paths.
 * The command never deletes. A later cleanup may use the printed identifiers
 * only when probeAssetOwnershipIsUnequivocal is true for that same asset.
 */
export const CALIBRATION_PHOTO_PROBE_TENANT = 'cal008-probe';
export const CALIBRATION_PHOTO_PROBE_CASE = 'AF-008008';
export const CALIBRATION_PHOTO_PROBE_PREFIX =
  `pegazuz_calibration/${CALIBRATION_PHOTO_PROBE_TENANT}/${CALIBRATION_PHOTO_PROBE_CASE}/`;

const SYNTHETIC_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export type CalibrationPhotoCategory =
  | 'missing'
  | 'incomplete'
  | 'checksum'
  | 'exposed'
  | 'rejected'
  | 'read_failed'
  | 'wrong_target'
  | 'scope';

export type CalibrationPhotoReport = {
  service: 'cloudinary-photo';
  result: 'ok' | 'error';
  category?: CalibrationPhotoCategory;
  assetId?: string;
  publicId?: string;
  version?: number;
  bytes?: number;
  contentSha256?: string;
  checksumMatch?: boolean;
  unauthorizedStatus?: number;
  unauthorizedBlocked?: boolean;
  deleted: false;
};

export type PhotoProbePorts = {
  upload(input: { tenantId: string; caseId: string; bytes: Buffer }): Promise<CalibrationUploadReceipt>;
  download(input: { publicId: string; format: string; version: number }): Promise<Buffer>;
  probeUnauthenticated(input: {
    publicId: string;
    format: string;
    version: number;
  }): Promise<{ status: number; body: Buffer }>;
};

export function syntheticCalibrationProbeImage(): Buffer {
  return Buffer.from(SYNTHETIC_PNG);
}

export function probePublicId(sha256: string): string {
  return `${CALIBRATION_PHOTO_PROBE_PREFIX}${sha256.slice(0, 32)}`;
}

export function probeAssetOwnershipIsUnequivocal(input: {
  publicId: string;
  tenantId: string;
  caseId: string;
  sha256: string;
  deliveryType: string;
}): boolean {
  return input.tenantId === CALIBRATION_PHOTO_PROBE_TENANT
    && input.caseId === CALIBRATION_PHOTO_PROBE_CASE
    && input.deliveryType === 'authenticated'
    && /^[a-f0-9]{64}$/.test(input.sha256)
    && input.publicId === probePublicId(input.sha256)
    && input.publicId.startsWith(CALIBRATION_PHOTO_PROBE_PREFIX)
    && !input.publicId.includes('AF-000001')
    && !input.publicId.includes('omnichannel_chats')
    && !/^pegazuz_calibration\/AF-/.test(input.publicId);
}

/** Unsigned delivery URL. It is fetched inside the process and never reported. */
export function unsignedAuthenticatedDeliveryUrl(
  cloudName: string,
  input: { publicId: string; format: string; version: number },
): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(cloudName)) {
    throw new Error('Anonymous probe failed');
  }
  if (!Number.isInteger(input.version) || input.version <= 0 || !/^(png|jpg|webp)$/.test(input.format)) {
    throw new Error('Anonymous probe failed');
  }
  if (!input.publicId.startsWith(CALIBRATION_PHOTO_PROBE_PREFIX) || input.publicId.includes('://')) {
    throw new Error('Anonymous probe failed');
  }
  return `https://res.cloudinary.com/${cloudName}/image/authenticated/v${input.version}/${input.publicId}.${input.format}`;
}

export async function diagnoseCalibrationPhoto(
  env: NodeJS.ProcessEnv,
  ports?: PhotoProbePorts,
): Promise<CalibrationPhotoReport> {
  if (env.CALIBRATION_INGEST_ENABLED === 'true') {
    return failure('rejected');
  }
  const image = syntheticCalibrationProbeImage();
  let checked: { format: 'jpg' | 'png' | 'webp'; sha256: string };
  try {
    checked = validateCalibrationImage(image);
  } catch {
    return failure('rejected');
  }
  const expectedPublicId = probePublicId(checked.sha256);
  try {
    const active = ports ?? livePorts(env);
    if (!active) return failure('missing');
    let receipt: CalibrationUploadReceipt;
    try {
      receipt = await active.upload({
        tenantId: CALIBRATION_PHOTO_PROBE_TENANT,
        caseId: CALIBRATION_PHOTO_PROBE_CASE,
        bytes: image,
      });
    } catch (err) {
      return failure(err instanceof ServiceUnavailableException ? 'incomplete' : 'rejected');
    }
    const owned = probeAssetOwnershipIsUnequivocal({
      publicId: receipt.publicId,
      tenantId: receipt.tenantId,
      caseId: receipt.caseId,
      sha256: checked.sha256,
      deliveryType: receipt.deliveryType,
    });
    if (!owned) return failure('scope');
    if (!receiptIsComplete(receipt, image.length, checked.format)) {
      return { ...failure('incomplete'), publicId: expectedPublicId, contentSha256: checked.sha256 };
    }
    let downloaded: Buffer;
    try {
      downloaded = await active.download({
        publicId: receipt.publicId,
        format: checked.format,
        version: receipt.version,
      });
    } catch {
      return identified(receipt, checked.sha256, { category: 'read_failed' });
    }
    const checksumMatch = confirmArchiveChecksum(
      checked.sha256,
      createHash('sha256').update(downloaded).digest('hex'),
    );
    let anonymous: { status: number; body: Buffer };
    try {
      anonymous = await active.probeUnauthenticated({
        publicId: receipt.publicId,
        format: checked.format,
        version: receipt.version,
      });
    } catch {
      return identified(receipt, checked.sha256, { category: 'read_failed', checksumMatch });
    }
    const unauthorizedBlocked = !confirmArchiveChecksum(
      checked.sha256,
      createHash('sha256').update(anonymous.body).digest('hex'),
    );
    const observed = {
      checksumMatch,
      unauthorizedStatus: anonymous.status,
      unauthorizedBlocked,
    };
    if (!unauthorizedBlocked) return identified(receipt, checked.sha256, { category: 'exposed', ...observed });
    if (!checksumMatch) return identified(receipt, checked.sha256, { category: 'checksum', ...observed });
    return identified(receipt, checked.sha256, observed);
  } catch (err) {
    if (err instanceof BadRequestException) return failure('rejected');
    return failure('rejected');
  }
}

function failure(category: CalibrationPhotoCategory): CalibrationPhotoReport {
  return { service: 'cloudinary-photo', result: 'error', category, deleted: false };
}

function identified(
  receipt: CalibrationUploadReceipt,
  sha256: string,
  extra: {
    category?: CalibrationPhotoCategory;
    checksumMatch?: boolean;
    unauthorizedStatus?: number;
    unauthorizedBlocked?: boolean;
  },
): CalibrationPhotoReport {
  return {
    service: 'cloudinary-photo',
    result: extra.category ? 'error' : 'ok',
    ...(extra.category ? { category: extra.category } : {}),
    assetId: receipt.assetId,
    publicId: receipt.publicId,
    version: receipt.version,
    bytes: receipt.bytes,
    contentSha256: sha256,
    ...extra,
    deleted: false,
  };
}

function receiptIsComplete(
  receipt: CalibrationUploadReceipt,
  size: number,
  format: string,
): boolean {
  return Boolean(receipt.assetId)
    && receipt.format === format
    && receipt.resourceType === 'image'
    && receipt.bytes === size
    && Number.isInteger(receipt.version)
    && receipt.version > 0
    && !receipt.publicId.includes('://')
    && !receipt.assetId.includes('://');
}

function livePorts(env: NodeJS.ProcessEnv): PhotoProbePorts | null {
  const clean = withoutLineSeparators(env);
  const credentials = cloudinaryCredentials(clean);
  const gateway = createCloudinaryGateway(clean);
  if (!credentials || !gateway) return null;
  const archive = new CalibrationImageArchiveService();
  return {
    upload: (input) => archive.uploadOriginal(input),
    download: (input) => gateway.downloadAuthenticated(input),
    async probeUnauthenticated(input) {
      const url = unsignedAuthenticatedDeliveryUrl(credentials.cloudName, input);
      try {
        const response = await fetch(url);
        return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
      } catch {
        throw new Error('Anonymous probe failed');
      }
    },
  };
}

function withoutLineSeparators(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const key of ['CLOUDINARY_API_SECRET', 'CLOUDINARY_API_KEY', 'CLOUDINARY_CLOUD_NAME']) {
    const value = copy[key];
    if (value) copy[key] = value.replace(/[\u2028\u2029]/g, '');
  }
  return copy;
}
