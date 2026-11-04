-- Borrador de cita por conversación.
-- No confirma la visita y no modifica citas ya registradas.

ALTER TABLE conversation
  ADD COLUMN IF NOT EXISTS "appointmentDraft" jsonb;

-- Una sola cita pendiente o confirmada por conversación.
-- No impide varias citas del mismo taller ni citas ya cerradas.
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_appointments_one_active_conversation"
  ON appointments ("conversationId")
  WHERE "conversationId" IS NOT NULL
    AND status IN ('pendiente', 'confirmada');
