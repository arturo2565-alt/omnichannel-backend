import { createHash } from 'node:crypto';
import { CalibrationCloudinaryArchive, type CloudinaryGateway, type CloudinaryReceipt } from './calibration-cloudinary-archive';
import { minimalDecodablePng } from './calibration-image-archive.service';
import {
  EVIDENCE_CLOUDINARY_PREFIX,
  EvidenceCloudinaryArchive,
  evidencePublicId,
  evidencePublicIdAllowed,
} from './evidence-cloudinary';

const image = minimalDecodablePng();
const digest = createHash('sha256').update(image).digest('hex');

function receipt(publicId: string, overrides: Partial<CloudinaryReceipt> = {}): CloudinaryReceipt {
  return {
    assetId: 'asset-evidence',
    publicId,
    version: 4,
    bytes: image.length,
    format: 'png',
    type: 'authenticated',
    resourceType: 'image',
    ...overrides,
  };
}

describe('archivo privado de evidencia CQ y RQ', () => {
  it('verifica la descarga autenticada y no devuelve una URL', async () => {
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
    const stored = await new EvidenceCloudinaryArchive().store(gateway, {
      subjectId: 'CQ-000010',
      evidenceId: 'EV-000001',
      bytes: image,
    });
    expect(stored.verified).toBe(true);
    expect(stored.sha256).toBe(digest);
    expect(stored.assetPublicId).toBe(`${EVIDENCE_CLOUDINARY_PREFIX}/CQ-000010/EV-000001/${digest.slice(0, 32)}`);
    expect(stored.assetPublicId?.startsWith('pegazuz_calibration/')).toBe(false);
    expect(downloads).toEqual([stored.assetPublicId]);
    expect(JSON.stringify(stored)).not.toContain('https://');
  });

  it('deja la fotografía sin verificar cuando el SHA-256 descargado no coincide', async () => {
    const gateway: CloudinaryGateway = {
      async uploadAuthenticated({ publicId }) {
        return receipt(publicId);
      },
      async downloadAuthenticated() {
        return minimalDecodablePng([1, 2, 3]);
      },
    };
    const stored = await new EvidenceCloudinaryArchive().store(gateway, {
      subjectId: 'RQ-000001',
      evidenceId: 'EV-000004',
      bytes: image,
    });
    expect(stored.verified).toBe(false);
    expect(stored.failure).toBe('checksum_mismatch');
    expect(stored.assetPublicId).toBeNull();
    expect(JSON.stringify(stored)).not.toContain('https://');
  });

  it('rechaza un identificador de expediente AF y el prefijo del archivo visual', () => {
    expect(evidencePublicId('AF-000002', 'EV-000001', digest)).toBeNull();
    expect(evidencePublicIdAllowed(`pegazuz_calibration/AF-000002/${digest.slice(0, 32)}`)).toBe(false);
    expect(evidencePublicIdAllowed(`${EVIDENCE_CLOUDINARY_PREFIX}/CQ-000010/EV-000001/${digest.slice(0, 32)}`)).toBe(true);
    const gateway: CloudinaryGateway = {
      async uploadAuthenticated({ publicId }) {
        return receipt(publicId);
      },
      async downloadAuthenticated() {
        return Buffer.from(image);
      },
    };
    expect(() => new CalibrationCloudinaryArchive(gateway, EVIDENCE_CLOUDINARY_PREFIX)).toThrow(
      'Calibration photo prefix is not allowed',
    );
  });
});
