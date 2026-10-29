-- CRM-008. Aditiva e idempotente. No reescribe citas históricas.
-- Los importes del desglose van en centavos enteros.
-- attributionKind queda en 'unknown' por omisión: no inventa anuncios.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS "campaignName" character varying(120) NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS "adName" character varying(120) NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS "adExternalId" character varying(128) NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS "attributionKind" character varying(16) NOT NULL DEFAULT 'unknown';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CHK_appointments_attributionKind'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT "CHK_appointments_attributionKind"
      CHECK ("attributionKind" IN ('manual', 'verified', 'unknown'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "IDX_appointments_campaignName"
  ON appointments ("tallerId", "campaignName")
  WHERE "campaignName" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "IDX_appointments_adName"
  ON appointments ("tallerId", "adName")
  WHERE "adName" IS NOT NULL;

CREATE TABLE IF NOT EXISTS appointment_service_lines (
  id uuid PRIMARY KEY,
  "appointmentId" uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  "tallerId" uuid NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  name character varying(200) NOT NULL,
  "quantityHundredths" integer NOT NULL,
  "unitPriceCents" integer NOT NULL,
  "subtotalCents" integer NOT NULL,
  "sortOrder" integer NOT NULL DEFAULT 0,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

-- Las restricciones van aparte para que una tabla ya creada también las reciba.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CHK_service_lines_quantity'
  ) THEN
    ALTER TABLE appointment_service_lines
      ADD CONSTRAINT "CHK_service_lines_quantity"
      CHECK ("quantityHundredths" > 0 AND "quantityHundredths" <= 10000);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CHK_service_lines_unit'
  ) THEN
    ALTER TABLE appointment_service_lines
      ADD CONSTRAINT "CHK_service_lines_unit"
      CHECK ("unitPriceCents" >= 0 AND "unitPriceCents" <= 1000000000);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CHK_service_lines_subtotal'
  ) THEN
    ALTER TABLE appointment_service_lines
      ADD CONSTRAINT "CHK_service_lines_subtotal"
      CHECK (
        "subtotalCents" >= 0
        AND "subtotalCents" <= 1000000000
        AND "subtotalCents" = (("quantityHundredths"::bigint * "unitPriceCents"::bigint + 50) / 100)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "IDX_service_lines_appointment"
  ON appointment_service_lines ("appointmentId");

CREATE INDEX IF NOT EXISTS "IDX_service_lines_taller_name"
  ON appointment_service_lines ("tallerId", name);
