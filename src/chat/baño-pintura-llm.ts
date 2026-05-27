import type { OpenAI } from 'openai';
import type { InstantQuoteResolution } from './instant-quote-from-text';
import {
  extractBañoColorDetailHeuristic,
  flattenBañoTierSource,
  isPlaceholderBañoVehicleLabel,
  mentionsCambioDeColor,
  tierSourceMentionsBora,
} from './instant-quote-from-text';

export type BañoLlmClassification = {
  vehicleLabel: string;
  segmentoEs: string;
  severidadLiteral: string;
};

/** Entrada estructurada para inferir vehículo sin concatenar logs ni historial crudo. */
export type BañoVehicleInferenceInput = {
  visionInventory: Array<{
    pieza: string;
    severidad: string;
    descripcionTecnica?: string;
  }>;
  damageSummary?: {
    descripcionTecnica?: string;
    justificacion?: string;
    pieza?: string;
  };
  chatTurns?: Array<{ role: 'user' | 'assistant'; content: string }>;
};

function parseVehicleInferenceJson(raw: string): {
  vehicleLabel: string;
  confidence?: string;
  reason?: string;
} | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const vehicleLabel =
      typeof o['vehicleLabel'] === 'string' ? o['vehicleLabel'].trim() : '';
    return {
      vehicleLabel,
      confidence:
        typeof o['confidence'] === 'string' ? o['confidence'].trim() : undefined,
      reason: typeof o['reason'] === 'string' ? o['reason'].trim() : undefined,
    };
  } catch {
    return null;
  }
}

/** Rechaza salidas obviamente inválidas (no es limpieza del hilo; es validación post-IA). */
function isLikelyContaminatedVehicleLabel(label: string): boolean {
  const t = String(label ?? '').trim();
  if (!t || t.length > 72) return true;
  if (t.includes('\n')) return true;
  if (t.includes('http://') || t.includes('https://')) return true;
  if (t.includes('cloudinary')) return true;
  if (isPlaceholderBañoVehicleLabel(t)) return true;
  return false;
}

const INFER_VEHICLE_SYSTEM = `Eres un extractor de identidad vehicular para un taller de carrocería y pintura en México.

Recibirás un JSON con:
- inventario_vision: piezas y descripciones del análisis por fotos (visión multimodal).
- peritaje: resumen técnico del daño (sin precios ni plantillas de cotización).
- conversacion: mensajes recientes user/assistant del chat.

Tu única tarea: inferir el vehículo del cliente (marca, modelo y año si hay evidencia).

Responde SOLO con JSON válido:
{
  "vehicleLabel": "Marca Modelo Año",
  "confidence": "high" | "medium" | "low",
  "reason": "una frase breve en español"
}

REGLAS ESTRICTAS para vehicleLabel:
- Una sola línea corta, legible para humanos. Ejemplos válidos: "Volkswagen Passat 2005", "Audi Q5 2023", "Ford Figo".
- Prioridad de evidencia: mensajes del usuario que nombren su auto > descripción técnica de visión > contexto indirecto.
- NO copies ni parafrasees logs del sistema, IDs, URLs, precios, listas de piezas dañadas, códigos de severidad (DL, DM, DMF), ni texto de cotizaciones previas.
- NO incluyas frases del asistente salvo que repitan explícitamente el modelo confirmado por el cliente.
- Si no puedes identificar marca y modelo con confianza razonable, devuelve vehicleLabel como cadena vacía "".
- No inventes año si no hay pista; puedes omitir el año.
- Prohibido usar placeholders: "tu vehículo", "su vehículo", "vehículo del cliente", "auto", etc.`;

/**
 * Inferencia pura por IA (gpt-4o): aísla marca, modelo y año para plantillas BPC.
 */
export async function inferBañoVehicleDisplayLabelWithLlm(
  openai: OpenAI,
  input: BañoVehicleInferenceInput,
): Promise<string | null> {
  const payload = JSON.stringify({
    inventario_vision: input.visionInventory ?? [],
    peritaje: input.damageSummary ?? null,
    conversacion: (input.chatTurns ?? []).slice(-14),
  });

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.1,
    max_tokens: 160,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: INFER_VEHICLE_SYSTEM },
      {
        role: 'user',
        content: `Datos estructurados para inferir el vehículo:\n${payload.slice(0, 14_000)}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content?.trim() ?? '';
  const parsed = parseVehicleInferenceJson(raw);
  if (!parsed) {
    console.warn('[BañoVehicleInfer] JSON inválido:', raw.slice(0, 200));
    return null;
  }

  const label = parsed.vehicleLabel;
  if (!label || isLikelyContaminatedVehicleLabel(label)) {
    console.log(
      '[BañoVehicleInfer] sin vehículo usable',
      JSON.stringify({
        vehicleLabel: label?.slice(0, 80) ?? '',
        confidence: parsed.confidence,
        reason: parsed.reason,
      }),
    );
    return null;
  }

  console.log(
    '[BañoVehicleInfer]',
    JSON.stringify({
      vehicleLabel: label,
      confidence: parsed.confidence,
      reason: parsed.reason,
    }),
  );
  return label;
}

const TALLER_MAPS_URL =
  'https://maps.app.goo.gl/a3tEimJquzaJAwSD9?g_st=ipc';

const BAÑO_COLOR_EXTRA_DIAS = 2;

/** Precio en plantilla: `$29,000 MXN` (sin depender de OpenAI). */
function formatBañoTemplatePriceMx(amount: number): string {
  const v = Math.round(Number(amount) || 0);
  return `$${v.toLocaleString('es-MX')} MXN`;
}

function parseClassificationJson(raw: string): Partial<BañoLlmClassification> | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      vehicleLabel: typeof o['vehicleLabel'] === 'string' ? o['vehicleLabel'].trim() : '',
      segmentoEs: typeof o['segmentoEs'] === 'string' ? o['segmentoEs'].trim() : '',
      severidadLiteral:
        typeof o['severidadLiteral'] === 'string' ? o['severidadLiteral'].trim() : '',
    };
  } catch {
    return null;
  }
}

export function coerceBañoSeveridadToCatalog(
  raw: string,
  allowed: readonly string[],
): string | null {
  const t = String(raw ?? '').trim();
  if (!t || !allowed.length) return null;
  if (allowed.includes(t)) return t;
  const low = t.toLowerCase();
  for (const a of allowed) {
    if (a.toLowerCase() === low) return a;
  }
  return null;
}

const CLASSIFY_SYSTEM = `Eres un clasificador de TALLA de carrocería para cotizar "Baño de Pintura Exterior" en México.
Debes leer el texto del cliente (puede haber varios mensajes) e identificar el vehículo.

Responde SOLO con un JSON válido con estas claves exactas:
- "vehicleLabel": string breve (ej. "Audi Q5 2023")
- "segmentoEs": string breve en español (ej. "SUV premium mediana")
- "severidadLiteral": string EXACTAMENTE igual a uno de los valores permitidos (copia literal, mayúsculas incluidas).

REGLAS DE TAMAÑO (elige UNA severidad base: Chico, Mediano, Grande o XL):
1) Hatch/sedán muy compacto o entrada (Spark, Beat, March, Mirage, Versa, Aveo, Rio, **Ford Figo**, Chevy Beat, etc.) → Chico.
2) Sedán compacto/mediano común (Jetta, Civic, Corolla, Sentra, Elantra, Mazda 3, **Volkswagen Bora**, etc.) → Mediano.
3) SUV mediana/grande, minivan mediana, pick-up mediana (CR-V, RAV4, Explorer, Pathfinder, Pilot, Highlander, Tacoma, Hilux, Ranger, etc.) → Grande o XL según tamaño real: pick-ups y SUVs de 3 filas o muy grandes → XL; SUV mediana de 2 filas tipo CR-V, Q5, X3, GLC → Grande.
4) SUVs enormes o pick-ups full size (Suburban, Tahoe, Expedition, F-250+, RAM 2500+, etc.) → XL.

REGLA DE ORO — PREMIUM:
Si la marca es de lujo/premium europea o equivalente, la severidad DEBE llevar sufijo " Premium" (con espacio):
Marcas premium: Audi, BMW, Mercedes-Benz / Mercedes, Porsche, Land Rover, Range Rover, Volvo, Jaguar, Lexus (como marca premium), Infiniti, Acura, Genesis, Maserati, Bentley, Rolls-Royce, Ferrari, Lamborghini, McLaren, Aston Martin.
Ejemplos: Audi Q5 → "Grande Premium" (SUV premium mediana). Audi A4 → "Mediano Premium". BMW X5 muy grande → "XL Premium" o "Grande Premium" según criterio de tamaño corporal del vehículo.

Si el cliente ya escribió explícitamente el tamaño de taller (Chico, Mediano, Grande, XL, con o sin Premium), respeta esa severidad exacta si coincide con la lista permitida.

No inventes marcas. Si no hay vehículo claro, severidadLiteral debe ser aun así el mejor intento razonable (no dejes vacío).`;

/** Vehículo descapotable / convertible → nota de inspección de toldo. */
export function isConvertibleVehicleLabel(vehicleLabel: string): boolean {
  const n = String(vehicleLabel ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (!n) return false;
  if (/\b(convertible|descapotable|cabrio|cabriolet|roadster|spyder|spider|targa)\b/.test(n)) {
    return true;
  }
  if (/\b(z4|mx-5|mx5|miata|mx 5|boxster|cayman|tt roadster)\b/.test(n)) {
    return true;
  }
  if (/\bmustang\b/.test(n) && /\b(conv|convertible)\b/.test(n)) {
    return true;
  }
  if (/\b(beetle|escarabajo|new beetle)\b/.test(n) && /\bconv/.test(n)) {
    return true;
  }
  return false;
}

/** Nombre corto del modelo para cierre (p. ej. "Bora"). */
function shortModelNameForClosing(vehicleLabel: string): string {
  const parts = String(vehicleLabel ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return 'vehículo';
  return parts[parts.length - 1] ?? parts[0]!;
}

function cambioColorAddonFromResolution(resolution: InstantQuoteResolution): number {
  return resolution.extras.reduce(
    (sum, line) => sum + Math.round(Number(line.amount) || 0),
    0,
  );
}

function hasCambioColorInResolution(resolution: InstantQuoteResolution): boolean {
  return cambioColorAddonFromResolution(resolution) > 0;
}

export type BañoInstantComposeFacts = {
  vehicleLabel: string;
  segmentoEs: string;
  servicioDb: string;
  severidadLiteral: string;
  resolution: InstantQuoteResolution;
  /** Colores / toldo / perla pedidos por el cliente (línea Detalle personalizado). */
  personalizedColorDetail?: string | null;
};

/**
 * Maqueta premium fija en TypeScript (sin redacción OpenAI del cuerpo del mensaje).
 */
export function buildBañoNaturalInstantReplyText(facts: BañoInstantComposeFacts): string {
  const { vehicleLabel, resolution, personalizedColorDetail } = facts;
  const vehicle = String(vehicleLabel ?? '').trim();
  if (!vehicle || isPlaceholderBañoVehicleLabel(vehicle)) {
    throw new Error(
      'buildBañoNaturalInstantReplyText: vehículo no perfilado (prohibido cotizar con placeholder)',
    );
  }

  const basePrice = Math.round(Number(resolution.precioMx));
  const extraPrice = cambioColorAddonFromResolution(resolution);
  const totalPrice = Math.round(
    Number(resolution.total) || basePrice + extraPrice,
  );
  if (!Number.isFinite(basePrice) || basePrice <= 0 || !Number.isFinite(totalPrice) || totalPrice <= 0) {
    throw new Error('buildBañoNaturalInstantReplyText: precios inválidos');
  }

  const hasColorChange = hasCambioColorInResolution(resolution);
  const diasBase = Math.max(
    1,
    Math.floor(Number(resolution.diasEntrega) || 0) || 3,
  );
  const diasShown = hasColorChange ? diasBase + BAÑO_COLOR_EXTRA_DIAS : diasBase;
  const modeloCorto = shortModelNameForClosing(vehicle);

  const detail =
    String(personalizedColorDetail ?? '').trim() ||
    (hasColorChange ? '' : '');

  if (hasColorChange && extraPrice > 0) {
    const baseStr = formatBañoTemplatePriceMx(basePrice);
    const extraStr = formatBañoTemplatePriceMx(extraPrice);
    const totalStr = formatBañoTemplatePriceMx(totalPrice);

    const lines = [
      `🎨 **Baño de Pintura + Cambio de Color (${vehicle})**`,
      `💰 **Total Estimado: ${totalStr}** *(Base: ${baseStr} + Cambio de color: ${extraStr})*`,
      `**Incluye:**`,
      `🔧 Hojalatería ligera y corrección de imperfecciones`,
      `✨ Materiales gama alta (Pintura y Barniz Sikkens)`,
      `🛡️ Garantía por escrito en brillo y adherencia`,
      `💎 Acabado espejo (Lijado y pulido nivel exposición)`,
    ];

    if (detail) {
      lines.push(`🎨 **Detalle personalizado:** ${detail}`);
    }

    lines.push(
      `⏳ **Tiempo estimado:** ${diasShown} días hábiles (Añade ${BAÑO_COLOR_EXTRA_DIAS} días extras si hay cambio de color)`,
      `📍 **Ubicación del taller:** ${TALLER_MAPS_URL}`,
      ``,
    );

    if (isConvertibleVehicleLabel(vehicle)) {
      lines.push(
        `📅 **El ${modeloCorto}** requiere una inspección de cortesía para evaluar las gomas del toldo retráctil. ¿Te gustaría que te reserve fecha y hora para valoración?`,
      );
    } else {
      lines.push(
        `¿Te gustaría que te reserve fecha y hora para la transformación de tu ${modeloCorto}? 📆✨`,
      );
    }

    return lines.join('\n');
  }

  const totalStr = formatBañoTemplatePriceMx(totalPrice);
  const lines = [
    `🎨 **Baño de Pintura Exterior (${vehicle})**`,
    `💰 **Total Estimado: ${totalStr}**`,
    `**Incluye:**`,
    `🔧 Hojalatería ligera y corrección de imperfecciones`,
    `✨ Materiales gama alta (Pintura y Barniz Sikkens)`,
    `🛡️ Garantía por escrito en brillo y adherencia`,
    `💎 Acabado espejo (Lijado y pulido nivel exposición)`,
    `⏳ **Tiempo estimado:** ${diasShown} días hábiles`,
    `📍 **Ubicación del taller:** ${TALLER_MAPS_URL}`,
    ``,
  ];

  if (isConvertibleVehicleLabel(vehicle)) {
    lines.push(
      `📅 **El ${modeloCorto}** requiere una inspección de cortesía para evaluar las gomas del toldo retráctil. ¿Te gustaría que te reserve fecha y hora para valoración?`,
    );
  } else {
    lines.push(
      `¿Te gustaría que te reserve fecha y hora para tu baño de pintura en el taller? 📆✨`,
    );
  }

  return lines.join('\n');
}

/**
 * Clasificación de severidad (tamaño) para Baño de Pintura Exterior vía modelo pequeño + JSON.
 */
export async function classifyBañoPinturaTierWithLlm(
  openai: OpenAI,
  userContextText: string,
  allowedSeveridades: readonly string[],
): Promise<BañoLlmClassification> {
  const allowed = [...new Set(allowedSeveridades)].filter(Boolean);
  if (!allowed.length) {
    throw new Error('classifyBañoPinturaTierWithLlm: lista de severidades vacía');
  }

  const contextFlat = flattenBañoTierSource(userContextText);
  if (tierSourceMentionsBora(contextFlat)) {
    const coercedBora =
      coerceBañoSeveridadToCatalog('Mediano', allowed) ?? allowed[0]!;
    return {
      vehicleLabel: 'Volkswagen Bora',
      segmentoEs: 'sedán compacto mediano',
      severidadLiteral: coercedBora,
    };
  }

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.15,
    max_tokens: 220,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: CLASSIFY_SYSTEM },
      {
        role: 'user',
        content: `Valores permitidos para severidadLiteral (elige uno, copia exacto):\n${allowed.map((s) => `- ${s}`).join('\n')}\n\nTexto del cliente:\n${contextFlat.slice(0, 8000)}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content?.trim() ?? '';
  const parsed = parseClassificationJson(raw);
  if (!parsed?.severidadLiteral) {
    throw new Error('classifyBañoPinturaTierWithLlm: JSON inválido o vacío');
  }

  const coerced = coerceBañoSeveridadToCatalog(parsed.severidadLiteral, allowed);
  if (!coerced) {
    throw new Error(
      `classifyBañoPinturaTierWithLlm: severidad no catalogada: ${parsed.severidadLiteral}`,
    );
  }

  const out: BañoLlmClassification = {
    vehicleLabel: (parsed.vehicleLabel || 'tu vehículo').trim(),
    segmentoEs: (parsed.segmentoEs || 'segmento no especificado').trim(),
    severidadLiteral: coerced,
  };

  console.log(
    '[BañoLlmClassify]',
    JSON.stringify({
      vehicleLabel: out.vehicleLabel,
      segmentoEs: out.segmentoEs,
      severidadLiteral: out.severidadLiteral,
    }),
  );

  return out;
}

function parseColorDetailJson(raw: string): string | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const d = typeof o['detail'] === 'string' ? o['detail'].trim() : '';
    return d.length >= 8 ? d : null;
  } catch {
    return null;
  }
}

/**
 * Extrae descripción estética del cambio de color (solo JSON corto; el cuerpo del mensaje es plantilla fija).
 */
export async function extractBañoPersonalizedColorDetail(
  openai: OpenAI,
  userContextText: string,
): Promise<string | null> {
  const ctx = String(userContextText ?? '').trim();
  if (!ctx || !mentionsCambioDeColor(ctx)) return null;

  const heuristic = extractBañoColorDetailHeuristic(ctx);

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.15,
      max_tokens: 140,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Extrae SOLO la descripción estética del cambio de color que pidió el cliente en el hilo (colores, toldo/techo, perla, dos tonos, arriba/abajo).
Responde JSON: {"detail":"..."} en español, máximo 120 caracteres, tono elegante y concreto (ej. "Toldo negro y carrocería blanco con perla violeta").
Sin precios, sin saludos, sin preguntas. Si no hay detalle concreto de color, {"detail":""}.`,
        },
        { role: 'user', content: ctx.slice(0, 8000) },
      ],
    });
    const raw = completion.choices[0]?.message?.content?.trim() ?? '';
    const fromLlm = parseColorDetailJson(raw);
    return fromLlm ?? heuristic;
  } catch (err) {
    console.warn('[BañoColorDetail] LLM fallback heurística:', err);
    return heuristic;
  }
}

/**
 * Mensaje instantáneo al cliente: únicamente {@link buildBañoNaturalInstantReplyText} (sin redacción LLM).
 */
export async function composeBañoNaturalInstantReply(
  _openai: OpenAI,
  facts: BañoInstantComposeFacts,
): Promise<string> {
  console.log('--- [DEBUG ENTRÓ A VARIANTES DE BAÑO] ---');
  console.log('Vehículo:', facts.vehicleLabel);
  console.log('Servicio DB:', facts.servicioDb);
  console.log('Severidad / tier:', facts.severidadLiteral);
  console.log('Total resolución:', facts.resolution?.total);
  return buildBañoNaturalInstantReplyText(facts);
}
