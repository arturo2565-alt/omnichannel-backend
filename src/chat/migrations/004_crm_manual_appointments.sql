-- CRM-001-A. Citas manuales sobre la agenda existente.
-- Agrega columnas y la tabla de trabajo contratado.
-- No reescribe filas históricas: status, horario, nombres y quoteSummary quedan igual.
-- Las citas viejas siguen viéndose por el taller de su conversación.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS "tallerId" uuid NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS "contactId" uuid NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS "vehicleMake" character varying(80) NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS "vehicleModel" character varying(80) NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS "vehicleYear" integer NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS "serviceRequested" character varying(200) NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS "quotedAmount" integer NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS origin character varying(32) NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS notes text NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS source character varying(16) NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS "clientRequestId" character varying(64) NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS "createdByUserId" uuid NULL;

CREATE INDEX IF NOT EXISTS "IDX_appointments_tallerId"
  ON appointments ("tallerId");

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_appointments_client_request"
  ON appointments ("tallerId", "clientRequestId")
  WHERE "clientRequestId" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
    WHERE t.relname = 'appointments'
      AND c.contype = 'f'
      AND a.attname = 'tallerId'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT "FK_appointments_tallerId"
      FOREIGN KEY ("tallerId") REFERENCES talleres(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
    WHERE t.relname = 'appointments'
      AND c.contype = 'f'
      AND a.attname = 'contactId'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT "FK_appointments_contactId"
      FOREIGN KEY ("contactId") REFERENCES contacts(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS contracted_works (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tallerId" uuid NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  "appointmentId" uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  "contactId" uuid NULL REFERENCES contacts(id) ON DELETE SET NULL,
  "conversationId" uuid NULL,
  "quotedAmountSnapshot" integer NULL,
  "contractedAmount" integer NOT NULL CHECK ("contractedAmount" > 0),
  notes text NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "UQ_contracted_works_appointment" UNIQUE ("appointmentId")
);

CREATE INDEX IF NOT EXISTS "IDX_contracted_works_tallerId"
  ON contracted_works ("tallerId");
