-- Fase 4: identidad DamageItem ↔ QuoteLine. Nullable para históricos.
-- No elimina columnas. Si DB_SYNCHRONIZE=true, TypeORM también puede añadirlas.
ALTER TABLE draft_quote_items
  ADD COLUMN IF NOT EXISTS "damageItemId" text NULL,
  ADD COLUMN IF NOT EXISTS "quoteLineId" text NULL,
  ADD COLUMN IF NOT EXISTS "vehicleId" text NULL,
  ADD COLUMN IF NOT EXISTS "serviceType" text NULL,
  ADD COLUMN IF NOT EXISTS "billable" boolean NULL;

ALTER TABLE draft_quotes
  ADD COLUMN IF NOT EXISTS "canonicalQuoteV1" jsonb NULL;
