-- Tabla de auditoría de llamadas LLM (costo / tokens / latencia).
-- Segura de aplicar si TypeORM synchronize está desactivado en producción.
-- Requiere Postgres con gen_random_uuid (pgcrypto / PG13+).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS llm_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tallerId" uuid NULL,
  "conversationId" uuid NULL,
  provider character varying(64) NOT NULL DEFAULT 'openai',
  model character varying(128) NOT NULL,
  purpose character varying(64) NOT NULL,
  "promptTokens" integer NOT NULL DEFAULT 0,
  "completionTokens" integer NOT NULL DEFAULT 0,
  "totalTokens" integer NOT NULL DEFAULT 0,
  "cachedTokens" integer NOT NULL DEFAULT 0,
  "estimatedCostUsd" numeric(10, 6) NOT NULL DEFAULT 0,
  "durationMs" integer NOT NULL DEFAULT 0,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_llm_calls_taller_id ON llm_calls ("tallerId");
CREATE INDEX IF NOT EXISTS idx_llm_calls_conversation_id ON llm_calls ("conversationId");
CREATE INDEX IF NOT EXISTS idx_llm_calls_created_at ON llm_calls ("createdAt");
