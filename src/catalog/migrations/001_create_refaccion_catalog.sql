-- Catálogo de refacciones y ópticas por taller.
-- Segura de aplicar si TypeORM synchronize está desactivado.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS refaccion_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tallerId" uuid NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
  codigo character varying(48) NOT NULL,
  nombre character varying(160) NOT NULL,
  categoria character varying(24) NOT NULL,
  costo_referencia_base integer NOT NULL,
  margen_porcentaje integer NOT NULL DEFAULT 30,
  forzar_precio_manual boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_refaccion_catalog_taller_codigo
  ON refaccion_catalog ("tallerId", codigo);

CREATE INDEX IF NOT EXISTS idx_refaccion_catalog_taller_id
  ON refaccion_catalog ("tallerId");

CREATE INDEX IF NOT EXISTS idx_refaccion_catalog_codigo
  ON refaccion_catalog (codigo);

ALTER TABLE refaccion_catalog
  ADD COLUMN IF NOT EXISTS forzar_precio_manual boolean NOT NULL DEFAULT false;
