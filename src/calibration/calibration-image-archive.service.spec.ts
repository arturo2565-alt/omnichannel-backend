import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { BadRequestException } from '@nestjs/common';
import {
  detectCalibrationImageFormat,
  minimalDecodablePng,
  validateCalibrationImage,
} from './calibration-image-archive.service';
import { syntheticCalibrationProbeImage } from './calibration-diagnose-photo';

describe('CAL-004B image validation (no network)', () => {
  it('decodes a real PNG and keeps a stable SHA-256', () => {
    const bytes = minimalDecodablePng();
    expect(detectCalibrationImageFormat(bytes)).toBe('png');
    const checked = validateCalibrationImage(bytes);
    expect(checked.format).toBe('png');
    expect(checked.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(checked.sha256).toBe(validateCalibrationImage(bytes).sha256);
    const idatStart = 33;
    const idatLength = bytes.readUInt32BE(idatStart);
    const idat = bytes.subarray(idatStart + 8, idatStart + 8 + idatLength);
    expect(inflateSync(idat)).toEqual(Buffer.from([0, 16, 32, 48]));
    expect(validateCalibrationImage(syntheticCalibrationProbeImage()).format).toBe('png');
  });

  it('rejects truncated files that only imitate JPEG, PNG, or WEBP signatures', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x0a, 0x10, 0x01]);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
    expect(detectCalibrationImageFormat(jpeg)).toBe('jpg');
    expect(detectCalibrationImageFormat(png)).toBe('png');
    expect(detectCalibrationImageFormat(webp)).toBe('webp');
    expect(() => validateCalibrationImage(jpeg)).toThrow(BadRequestException);
    expect(() => validateCalibrationImage(png)).toThrow(BadRequestException);
    expect(() => validateCalibrationImage(webp)).toThrow(BadRequestException);
    expect(() => validateCalibrationImage(Buffer.from('not-an-image'))).toThrow(BadRequestException);
    expect(() => validateCalibrationImage(Buffer.alloc(0))).toThrow(BadRequestException);
    expect(() => validateCalibrationImage(Buffer.alloc(5 * 1024 * 1024 + 1))).toThrow(BadRequestException);
  });
});
