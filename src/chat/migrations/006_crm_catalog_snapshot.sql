-- CRM-010: snapshot del servicio y la tarifa elegidos.
-- Aditivo. Las filas existentes quedan con NULL. No reescribe precios.

ALTER TABLE appointment_service_lines
  ADD COLUMN IF NOT EXISTS "catalogPieceCode" character varying(32),
  ADD COLUMN IF NOT EXISTS "tariffKind" character varying(32),
  ADD COLUMN IF NOT EXISTS "catalogOperations" character varying(40),
  ADD COLUMN IF NOT EXISTS "catalogMatrixRowId" uuid,
  ADD COLUMN IF NOT EXISTS "catalogUnitPriceCents" integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CHK_service_lines_tariffKind'
  ) THEN
    ALTER TABLE appointment_service_lines
      ADD CONSTRAINT "CHK_service_lines_tariffKind"
      CHECK (
        "tariffKind" IS NULL
        OR "tariffKind" IN (
          'reparacion_pintura',
          'montaje',
          'montaje_pintura',
          'integral',
          'manual'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CHK_service_lines_catalogUnit'
  ) THEN
    ALTER TABLE appointment_service_lines
      ADD CONSTRAINT "CHK_service_lines_catalogUnit"
      CHECK (
        "catalogUnitPriceCents" IS NULL
        OR (
          "catalogUnitPriceCents" >= 0
          AND "catalogUnitPriceCents" <= 1000000000
        )
      );
  END IF;
END $$;
