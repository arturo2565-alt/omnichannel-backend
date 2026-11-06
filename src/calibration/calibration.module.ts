import { Module } from '@nestjs/common';
import { CalibrationIngestController } from './calibration-ingest.controller';
import { CalibrationIngestService } from './calibration-ingest.service';

/**
 * Intentionally absent from AppModule. Importing this module would still
 * leave POST /calibration/cases inert unless CALIBRATION_INGEST_ENABLED=true.
 */
@Module({
  controllers: [CalibrationIngestController],
  providers: [CalibrationIngestService],
})
export class CalibrationModule {}
