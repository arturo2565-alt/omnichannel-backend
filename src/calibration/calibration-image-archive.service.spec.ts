import { BadRequestException } from '@nestjs/common';
import { detectCalibrationImageFormat, validateCalibrationImage } from './calibration-image-archive.service';

describe('CAL-004B image validation (no network)', () => {
  it('accepts JPEG signatures and computes stable SHA-256', () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    expect(detectCalibrationImageFormat(bytes)).toBe('jpg');
    expect(validateCalibrationImage(bytes).sha256).toHaveLength(64);
    expect(validateCalibrationImage(bytes).sha256).toBe(validateCalibrationImage(bytes).sha256);
  });

  it('accepts PNG and WEBP signatures', () => {
    expect(detectCalibrationImageFormat(Buffer.from([137,80,78,71,13,10,26,10,0]))).toBe('png');
    expect(detectCalibrationImageFormat(Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WEBP')]))).toBe('webp');
  });

  it('rejects non-images, empty and oversized buffers', () => {
    expect(() => validateCalibrationImage(Buffer.from('not-an-image'))).toThrow(BadRequestException);
    expect(() => validateCalibrationImage(Buffer.alloc(0))).toThrow(BadRequestException);
    expect(() => validateCalibrationImage(Buffer.alloc(5 * 1024 * 1024 + 1))).toThrow(BadRequestException);
  });
});
