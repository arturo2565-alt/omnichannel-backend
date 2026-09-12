-- Versionado observable de prompts (Fase pre-live).
-- Seguro si TypeORM synchronize está desactivado.

ALTER TABLE llm_calls
  ADD COLUMN IF NOT EXISTS "visionPromptVersion" character varying(32) NULL,
  ADD COLUMN IF NOT EXISTS "chatPromptVersion" character varying(32) NULL,
  ADD COLUMN IF NOT EXISTS "baseChatPromptVersion" character varying(32) NULL,
  ADD COLUMN IF NOT EXISTS "catalogAppendVersion" character varying(32) NULL,
  ADD COLUMN IF NOT EXISTS "effectiveChatPromptHash" character varying(32) NULL,
  ADD COLUMN IF NOT EXISTS "caseId" character varying(128) NULL,
  ADD COLUMN IF NOT EXISTS "promptLabel" character varying(64) NULL;

CREATE INDEX IF NOT EXISTS idx_llm_calls_case_id ON llm_calls ("caseId");
