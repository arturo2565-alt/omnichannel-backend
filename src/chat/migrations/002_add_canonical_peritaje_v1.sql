-- Shadow state Fase 2. Nullable; no toca damageAnalysis ni quotePayload.
-- Seguro con registros existentes. Si DB_SYNCHRONIZE=true, TypeORM también puede añadir la columna.
ALTER TABLE draft_quotes
  ADD COLUMN IF NOT EXISTS "canonicalPeritajeV1" jsonb NULL;
