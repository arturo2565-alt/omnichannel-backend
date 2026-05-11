/** Claves estables para filas en `ai_config`. */
export const AI_CONFIG_KEYS = {
  DEFAULT_VISION_PROMPT: 'default_vision_prompt',
  DEFAULT_CHAT_APPOINTMENT_PROMPT: 'default_chat_appointment_prompt',
  /** Instrucciones del mensaje usuario (JSON / URLs) en análisis de fotos por visión */
  VISION_JSON_USER_INSTRUCTION: 'vision_json_user_instruction',
  /** Sugerencia rápida en panel cuando autopilot está apagado */
  INBOUND_SUGGESTION_PROMPT: 'inbound_suggestion_prompt',
  /** Sugerencia manual “IA” con historial */
  MANUAL_AI_CLOSER_PROMPT: 'manual_ai_closer_prompt',
  /** URL de Google Maps / dirección enlazable para clientes */
  BUSINESS_MAPS_URL: 'business_maps_url',
  BUSINESS_PHONE: 'business_phone',
  BUSINESS_HOURS: 'business_hours',
} as const;

export type AiConfigKey =
  (typeof AI_CONFIG_KEYS)[keyof typeof AI_CONFIG_KEYS];
