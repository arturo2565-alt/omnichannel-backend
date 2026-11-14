import { createHash } from 'node:crypto';
import { confirmArchiveChecksum } from './calibration-engine';
import { validateCalibrationImage } from './calibration-image-archive.service';
import type { CloudinaryGateway, CloudinaryReceipt } from './calibration-cloudinary-archive';

/**
 * Private archive for CQ and RQ evidence. It never uses the AF prefix.
 * A signed delivery URL is consumed inside the gateway and is not returned.
 */
export const EVIDENCE_CLOUDINARY_PREFIX = 'pegazuz_calibration_evidence';
const SUBJECT_ID = /^(?:CQ|RQ)-\d{6}$/;
const EVIDENCE_ID = /^EV-\d{6}$/;

export type EvidencePhotoReceipt = {
  sha256: string;
  verified: boolean;
  assetPublicId: string | null;
  assetVersion: number | null;
  failure?: 'upload_rejected' | 'receipt_rejected' | 'download_failed' | 'checksum_mismatch';
};

export class EvidenceCloudinaryArchive {
  async store(
    gateway: CloudinaryGateway,
    input: { subjectId: string; evidenceId: string; bytes: Buffer },
  ): Promise<EvidencePhotoReceipt> {
    const checked = validateCalibrationImage(input.bytes);
    const publicId = evidencePublicId(input.subjectId, input.evidenceId, checked.sha256);
    if (!publicId) return unverified(checked.sha256, 'receipt_rejected');
    let receipt: CloudinaryReceipt;
    try {
      receipt = await gateway.uploadAuthenticated({ publicId, bytes: input.bytes });
    } catch {
      return unverified(checked.sha256, 'upload_rejected');
    }
    if (!receiptMatches(receipt, publicId, input.bytes.length, checked.format)) {
      return unverified(checked.sha256, 'receipt_rejected');
    }
    let downloaded: Buffer;
    try {
      downloaded = await gateway.downloadAuthenticated({
        publicId: receipt.publicId,
        format: checked.format,
        version: receipt.version,
      });
    } catch {
      return unverified(checked.sha256, 'download_failed');
    }
    const downloadedSha = createHash('sha256').update(downloaded).digest('hex');
    if (!confirmArchiveChecksum(checked.sha256, downloadedSha)) {
      return unverified(checked.sha256, 'checksum_mismatch');
    }
    return {
      sha256: checked.sha256,
      verified: true,
      assetPublicId: receipt.publicId,
      assetVersion: receipt.version,
    };
  }
}

export function evidencePublicId(subjectId: string, evidenceId: string, sha256: string): string | null {
  if (!SUBJECT_ID.test(subjectId) || !EVIDENCE_ID.test(evidenceId) || !/^[a-f0-9]{64}$/.test(sha256)) return null;
  const publicId = `${EVIDENCE_CLOUDINARY_PREFIX}/${subjectId}/${evidenceId}/${sha256.slice(0, 32)}`;
  if (!evidencePublicIdAllowed(publicId)) return null;
  return publicId;
}

export function evidencePublicIdAllowed(publicId: string): boolean {
  if (publicId.includes('://') || publicId.includes('..') || publicId.includes('AF-')) return false;
  if (publicId.startsWith('pegazuz_calibration/')) return false;
  return new RegExp(
    `^${EVIDENCE_CLOUDINARY_PREFIX}/(?:CQ|RQ)-\\d{6}/EV-\\d{6}/[a-f0-9]{32}$`,
  ).test(publicId);
}

function unverified(sha256: string, failure: EvidencePhotoReceipt['failure']): EvidencePhotoReceipt {
  return { sha256, verified: false, assetPublicId: null, assetVersion: null, failure };
}

function receiptMatches(receipt: CloudinaryReceipt, publicId: string, size: number, format: string): boolean {
  const formatMatches = receipt.format === format || (format === 'jpg' && receipt.format === 'jpeg');
  return Boolean(receipt.assetId)
    && receipt.publicId === publicId
    && evidencePublicIdAllowed(receipt.publicId)
    && receipt.type === 'authenticated'
    && receipt.resourceType === 'image'
    && receipt.bytes === size
    && Number.isInteger(receipt.version)
    && receipt.version > 0
    && formatMatches;
}
