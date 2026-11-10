import { createHash } from 'node:crypto';
import {
  CalibrationCloudinaryArchive,
  CAL010_CLOUDINARY_PREFIX,
  type CloudinaryGateway,
  type CloudinaryReceipt,
} from './calibration-cloudinary-archive';
import { minimalDecodablePng } from './calibration-image-archive.service';

const image = minimalDecodablePng();

function receipt(publicId: string, overrides: Partial<CloudinaryReceipt> = {}): CloudinaryReceipt {
  return {
    assetId: 'asset-1',
    publicId,
    version: 7,
    bytes: image.length,
    format: 'png',
    type: 'authenticated',
    resourceType: 'image',
    ...overrides,
  };
}

describe('CAL-007A authenticated photo verification', () => {
  it('verifies a private download whose SHA-256 matches the original', async () => {
    const downloads: string[] = [];
    const gateway: CloudinaryGateway = {
      async uploadAuthenticated({ publicId }) {
        return receipt(publicId);
      },
      async downloadAuthenticated({ publicId }) {
        downloads.push(publicId);
        return Buffer.from(image);
      },
    };
    const archive = new CalibrationCloudinaryArchive(gateway);
    const stored = await archive.store({ caseId: 'AF-000002', bytes: image });
    expect(stored.verified).toBe(true);
    expect(stored.sha256).toBe(createHash('sha256').update(image).digest('hex'));
    expect(stored.assetPublicId).toBe(
      `pegazuz_calibration/AF-000002/${stored.sha256.slice(0, 32)}`,
    );
    expect(stored.assetVersion).toBe(7);
    expect(downloads).toEqual([stored.assetPublicId]);
    expect(JSON.stringify(stored)).not.toContain('https://');
  });

  it('keeps the photo unverified when the downloaded checksum differs', async () => {
    const gateway: CloudinaryGateway = {
      async uploadAuthenticated({ publicId }) {
        return receipt(publicId);
      },
      async downloadAuthenticated() {
        return Buffer.from([0xff, 0xd8, 0xff, 0x99]);
      },
    };
    const archive = new CalibrationCloudinaryArchive(gateway);
    const stored = await archive.store({ caseId: 'AF-000002', bytes: image });
    expect(stored).toMatchObject({
      verified: false,
      assetPublicId: null,
      assetVersion: null,
      failure: 'checksum_mismatch',
    });
  });

  it('keeps the photo unverified when the receipt is not an authenticated private asset', async () => {
    const gateway: CloudinaryGateway = {
      async uploadAuthenticated({ publicId }) {
        return receipt(publicId, { type: 'upload' });
      },
      async downloadAuthenticated() {
        throw new Error('download must not run');
      },
    };
    const archive = new CalibrationCloudinaryArchive(gateway);
    await expect(archive.store({ caseId: 'AF-000002', bytes: image })).resolves.toMatchObject({
      verified: false,
      assetPublicId: null,
    });
  });

  it('keeps the photo unverified when the authenticated download fails', async () => {
    const gateway: CloudinaryGateway = {
      async uploadAuthenticated({ publicId }) {
        return receipt(publicId);
      },
      async downloadAuthenticated() {
        throw new Error('https://res.cloudinary.com/secret-signed-url');
      },
    };
    const archive = new CalibrationCloudinaryArchive(gateway);
    const stored = await archive.store({ caseId: 'AF-000002', bytes: image });
    expect(stored).toMatchObject({ verified: false, failure: 'download_failed', assetPublicId: null });
    expect(JSON.stringify(stored)).not.toContain('https://');
    expect(JSON.stringify(stored)).not.toContain('cloudinary');
  });

  it('classifies an upload rejection separately from a later download failure', async () => {
    const uploadGateway: CloudinaryGateway = {
      async uploadAuthenticated() {
        throw new Error('https://api.cloudinary.com/v1_1/secret');
      },
      async downloadAuthenticated() {
        throw new Error('https://res.cloudinary.com/secret-signed-url');
      },
    };
    const rejected = await new CalibrationCloudinaryArchive(uploadGateway, CAL010_CLOUDINARY_PREFIX)
      .store({ caseId: 'AF-900001', bytes: image });
    expect(rejected).toMatchObject({ verified: false, failure: 'upload_rejected', assetPublicId: null });
    expect(JSON.stringify(rejected)).not.toContain('https://');

    const downloadGateway: CloudinaryGateway = {
      async uploadAuthenticated({ publicId }) {
        return receipt(publicId);
      },
      async downloadAuthenticated() {
        throw new Error('https://res.cloudinary.com/secret-signed-url');
      },
    };
    const downloaded = await new CalibrationCloudinaryArchive(downloadGateway, CAL010_CLOUDINARY_PREFIX)
      .store({ caseId: 'AF-900001', bytes: image });
    expect(downloaded.failure).toBe('download_failed');
    expect(JSON.stringify(downloaded)).not.toContain('https://');

    let calls = 0;
    const blocked: CloudinaryGateway = {
      async uploadAuthenticated() {
        calls += 1;
        throw new Error('must not upload');
      },
      async downloadAuthenticated() {
        throw new Error('must not download');
      },
    };
    await expect(new CalibrationCloudinaryArchive(blocked, CAL010_CLOUDINARY_PREFIX).store({
      caseId: 'AF-900001',
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0x0a, 0x10, 0x01]),
    })).rejects.toThrow('Unsupported calibration image content');
    expect(calls).toBe(0);
  });
});
