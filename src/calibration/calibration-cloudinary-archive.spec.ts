import { createHash } from 'node:crypto';
import {
  CalibrationCloudinaryArchive,
  type CloudinaryGateway,
  type CloudinaryReceipt,
} from './calibration-cloudinary-archive';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x11, 0x22]);

function receipt(publicId: string, overrides: Partial<CloudinaryReceipt> = {}): CloudinaryReceipt {
  return {
    assetId: 'asset-1',
    publicId,
    version: 7,
    bytes: jpeg.length,
    format: 'jpg',
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
        return Buffer.from(jpeg);
      },
    };
    const archive = new CalibrationCloudinaryArchive(gateway);
    const stored = await archive.store({ caseId: 'AF-000002', bytes: jpeg });
    expect(stored.verified).toBe(true);
    expect(stored.sha256).toBe(createHash('sha256').update(jpeg).digest('hex'));
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
    const stored = await archive.store({ caseId: 'AF-000002', bytes: jpeg });
    expect(stored).toMatchObject({ verified: false, assetPublicId: null, assetVersion: null });
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
    await expect(archive.store({ caseId: 'AF-000002', bytes: jpeg })).resolves.toMatchObject({
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
    const stored = await archive.store({ caseId: 'AF-000002', bytes: jpeg });
    expect(stored.verified).toBe(false);
    expect(JSON.stringify(stored)).not.toContain('cloudinary');
  });
});
