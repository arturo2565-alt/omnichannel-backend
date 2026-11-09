import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  validateCalibrationImage,
  type CalibrationUploadReceipt,
} from './calibration-image-archive.service';
import { writeCalibrationPhotoDiagnostic } from './calibration-diagnose-photo-main';
import {
  CALIBRATION_PHOTO_PROBE_CASE,
  CALIBRATION_PHOTO_PROBE_PREFIX,
  CALIBRATION_PHOTO_PROBE_TENANT,
  diagnoseCalibrationPhoto,
  probeAssetOwnershipIsUnequivocal,
  probePublicId,
  syntheticCalibrationProbeImage,
  unsignedAuthenticatedDeliveryUrl,
  type PhotoProbePorts,
} from './calibration-diagnose-photo';

const image = syntheticCalibrationProbeImage();
const checked = validateCalibrationImage(image);

function receipt(overrides: Partial<CalibrationUploadReceipt> = {}): CalibrationUploadReceipt {
  return {
    imageId: checked.sha256.slice(0, 32),
    caseId: CALIBRATION_PHOTO_PROBE_CASE,
    tenantId: CALIBRATION_PHOTO_PROBE_TENANT,
    assetId: 'asset-probe-1',
    publicId: probePublicId(checked.sha256),
    version: 7,
    resourceType: 'image',
    deliveryType: 'authenticated',
    bytes: image.length,
    sha256: checked.sha256,
    format: checked.format,
    ...overrides,
  };
}

function ports(overrides: Partial<PhotoProbePorts> = {}): PhotoProbePorts & {
  upload: jest.Mock;
  download: jest.Mock;
  probeUnauthenticated: jest.Mock;
} {
  return {
    upload: jest.fn(async () => receipt()),
    download: jest.fn(async () => Buffer.from(image)),
    probeUnauthenticated: jest.fn(async () => ({ status: 401, body: Buffer.from('denied') })),
    ...overrides,
  };
}

describe('CAL-008 private photo probe', () => {
  it('builds a small synthetic image outside real case paths', () => {
    expect(checked.format).toBe('png');
    expect(checked.sha256).toHaveLength(64);
    expect(image.length).toBeLessThan(200);
    expect(image.toString('latin1')).not.toContain('EXIF');
    expect(probePublicId(checked.sha256)).toBe(
      `${CALIBRATION_PHOTO_PROBE_PREFIX}${checked.sha256.slice(0, 32)}`,
    );
    expect(probePublicId(checked.sha256)).not.toContain('AF-000001');
    expect(probePublicId(checked.sha256)).not.toContain('omnichannel_chats');
    expect(probeAssetOwnershipIsUnequivocal({
      publicId: `pegazuz_calibration/AF-000001/${checked.sha256.slice(0, 32)}`,
      tenantId: CALIBRATION_PHOTO_PROBE_TENANT,
      caseId: 'AF-000001',
      sha256: checked.sha256,
      deliveryType: 'authenticated',
    })).toBe(false);
  });

  it('uploads, downloads, and rejects an anonymous fetch without reporting secrets', async () => {
    const gateway = ports();
    const report = await diagnoseCalibrationPhoto({}, gateway);
    expect(report).toMatchObject({
      service: 'cloudinary-photo',
      result: 'ok',
      assetId: 'asset-probe-1',
      publicId: probePublicId(checked.sha256),
      version: 7,
      bytes: image.length,
      contentSha256: checked.sha256,
      checksumMatch: true,
      unauthorizedStatus: 401,
      unauthorizedBlocked: true,
      deleted: false,
    });
    expect(gateway.upload).toHaveBeenCalledWith({
      tenantId: CALIBRATION_PHOTO_PROBE_TENANT,
      caseId: CALIBRATION_PHOTO_PROBE_CASE,
      bytes: image,
    });
    expect(gateway.download).toHaveBeenCalledWith({
      publicId: probePublicId(checked.sha256),
      format: 'png',
      version: 7,
    });
    expect(JSON.stringify(report)).not.toContain('https://');
    expect(JSON.stringify(report)).not.toContain('s--');
  });

  it('reports a checksum mismatch and still does not delete', async () => {
    const gateway = ports({
      download: jest.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0x99])),
    });
    const report = await diagnoseCalibrationPhoto({}, gateway);
    expect(report).toMatchObject({
      result: 'error',
      category: 'checksum',
      checksumMatch: false,
      unauthorizedBlocked: true,
      deleted: false,
      publicId: probePublicId(checked.sha256),
    });
  });

  it('fails when an unauthorized response returns the original bytes', async () => {
    const gateway = ports({
      probeUnauthenticated: jest.fn(async () => ({ status: 200, body: Buffer.from(image) })),
    });
    const report = await diagnoseCalibrationPhoto({}, gateway);
    expect(report).toMatchObject({
      result: 'error',
      category: 'exposed',
      checksumMatch: true,
      unauthorizedStatus: 200,
      unauthorizedBlocked: false,
      deleted: false,
    });
    expect(JSON.stringify(report)).not.toContain('https://');
  });

  it('stops on an incomplete receipt and does not download it', async () => {
    const gateway = ports({
      upload: jest.fn(async () => receipt({ assetId: '' })),
    });
    const report = await diagnoseCalibrationPhoto({}, gateway);
    expect(report).toMatchObject({
      result: 'error',
      category: 'incomplete',
      deleted: false,
      publicId: probePublicId(checked.sha256),
    });
    expect(gateway.download).not.toHaveBeenCalled();
    expect(gateway.probeUnauthenticated).not.toHaveBeenCalled();
  });

  it('does not echo a foreign asset id or a signed error', async () => {
    const foreign = ports({
      upload: jest.fn(async () => receipt({
        publicId: 'pegazuz_calibration/AF-000001/abcdefabcdefabcdefabcdefabcdefab',
        caseId: 'AF-000001',
      })),
    });
    const scoped = await diagnoseCalibrationPhoto({}, foreign);
    expect(scoped).toEqual({
      service: 'cloudinary-photo',
      result: 'error',
      category: 'scope',
      deleted: false,
    });
    expect(foreign.download).not.toHaveBeenCalled();
    expect(JSON.stringify(scoped)).not.toContain('AF-000001');

    const leaked = ports({
      upload: jest.fn(async () => {
        throw new Error('https://res.cloudinary.com/probe/image/authenticated/s--secret');
      }),
    });
    const rejected = await diagnoseCalibrationPhoto({}, leaked);
    expect(rejected.category).toBe('rejected');
    expect(JSON.stringify(rejected)).not.toContain('https://');
    expect(JSON.stringify(rejected)).not.toContain('s--');

    const unavailable = ports({
      upload: jest.fn(async () => {
        throw new ServiceUnavailableException('https://res.cloudinary.com/incomplete');
      }),
    });
    const incomplete = await diagnoseCalibrationPhoto({}, unavailable);
    expect(incomplete).toMatchObject({ category: 'incomplete', deleted: false });
    expect(JSON.stringify(incomplete)).not.toContain('https://');
  });

  it('does not upload when ingest is enabled or credentials are absent', async () => {
    const gateway = ports();
    await expect(diagnoseCalibrationPhoto({
      CALIBRATION_INGEST_ENABLED: 'true',
    }, gateway)).resolves.toMatchObject({ category: 'rejected', deleted: false });
    expect(gateway.upload).not.toHaveBeenCalled();
    await expect(diagnoseCalibrationPhoto({})).resolves.toMatchObject({
      category: 'missing',
      deleted: false,
    });
  });

  it('builds an unsigned probe url and keeps the command out of the app', async () => {
    const url = unsignedAuthenticatedDeliveryUrl('probe-cloud', {
      publicId: probePublicId(checked.sha256),
      format: 'png',
      version: 7,
    });
    expect(url).toBe(
      `https://res.cloudinary.com/probe-cloud/image/authenticated/v7/${probePublicId(checked.sha256)}.png`,
    );
    expect(url).not.toContain('?');
    expect(url).not.toContain('api_secret');
    const source = readFileSync(join(__dirname, 'calibration-diagnose-photo.ts'), 'utf8');
    expect(source).not.toContain('.destroy(');
    expect(source).not.toContain('calibration-github');
    expect(source).not.toContain('@Controller');
    const entry = readFileSync(join(__dirname, 'calibration-diagnose-cloudinary-photo.ts'), 'utf8');
    expect(entry).not.toContain('ts-node');
    expect(entry).not.toContain('@Controller');
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['diagnose:calibration-cloudinary-photo']).toBe(
      'node dist/calibration/calibration-diagnose-cloudinary-photo.js',
    );
    const app = readFileSync(join(__dirname, '../app.module.ts'), 'utf8');
    expect(app).not.toContain('CalibrationModule');
  });

  it('refuses to run outside the staging container', async () => {
    const keys = [
      'RAILWAY_ENVIRONMENT_NAME',
      'RAILWAY_ENVIRONMENT',
      'RAILWAY_SERVICE_NAME',
      'RAILWAY_SERVICE',
      'RAILWAY_PROJECT_ID',
      'RAILWAY_ENVIRONMENT_ID',
      'RAILWAY_SERVICE_ID',
    ];
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    const lines: string[] = [];
    const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      for (const key of keys) delete process.env[key];
      await writeCalibrationPhotoDiagnostic();
    } finally {
      write.mockRestore();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(lines.join('')).toContain('"category":"wrong_target"');
    expect(lines.join('')).toContain('"deleted":false');
    expect(lines.join('')).not.toContain('https://');
  });
});
