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
  /** `vehiculo_detectado` del JSON de visión (ojo de la IA en fotos). */
  visionDetectedVehicle?: string | null;
};

export type BañoVehicleInferenceResult = {
  vehicleLabel: string | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  reason?: string;
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
- vehiculo_detectado_vision: marca/modelo/año que la IA de visión identificó en las fotos (puede estar vacío).

Tu única tarea: inferir el vehículo del cliente (marca, modelo y año si hay evidencia).

Responde SOLO con JSON válido:
{
  "vehicleLabel": "Marca Modelo Año",
  "confidence": "high" | "medium" | "low",
  "reason": "una frase breve en español"
}

REGLAS ESTRICTAS para vehicleLabel:
- Una sola línea corta, legible para humanos. Ejemplos válidos: "Volkswagen Passat 2005", "Audi Q5 2023", "Ford Figo".
- Prioridad de evidencia: mensajes del usuario que nombren su auto > vehiculo_detectado_vision (fotos) > descripción técnica de peritaje.
- Si vehiculo_detectado_vision es confiable y el chat no contradice, puedes usarlo como vehicleLabel.
- NO copies ni parafrasees logs del sistema, IDs, URLs, precios, listas de piezas dañadas, códigos de severidad (DL, DM, DMF), ni texto de cotizaciones previas.
- NO incluyas frases del asistente salvo que repitan explícitamente el modelo confirmado por el cliente.
- Si no puedes identificar marca y modelo con confianza razonable, devuelve vehicleLabel como cadena vacía "".
- No inventes año si no hay pista; puedes omitir el año.
- Prohibido usar placeholders: "tu vehículo", "su vehículo", "vehículo del cliente", "auto", etc.`;

function normalizeVehicleConfidence(
  raw: string | undefined,
): BañoVehicleInferenceResult['confidence'] {
  const c = String(raw ?? '').trim().toLowerCase();
  if (c === 'high' || c === 'alta' || c === 'alto') return 'high';
  if (c === 'medium' || c === 'media' || c === 'medio') return 'medium';
  if (c === 'low' || c === 'baja' || c === 'bajo') return 'low';
  return 'none';
}

/**
 * Inferencia pura por IA (gpt-4o): aísla marca, modelo y año para plantillas BPC.
 */
export async function inferBañoVehicleDisplayLabelWithLlm(
  openai: OpenAI,
  input: BañoVehicleInferenceInput,
): Promise<BañoVehicleInferenceResult> {
  const payload = JSON.stringify({
    inventario_vision: input.visionInventory ?? [],
    peritaje: input.damageSummary ?? null,
    conversacion: (input.chatTurns ?? []).slice(-14),
    vehiculo_detectado_vision: String(input.visionDetectedVehicle ?? '').trim(),
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
    return { vehicleLabel: null, confidence: 'none' };
  }

  const confidence = normalizeVehicleConfidence(parsed.confidence);
  const label = parsed.vehicleLabel;
  if (!label || isLikelyContaminatedVehicleLabel(label)) {
    console.log(
      '[BañoVehicleInfer] sin vehículo usable',
      JSON.stringify({
        vehicleLabel: label?.slice(0, 80) ?? '',
        confidence,
        reason: parsed.reason,
      }),
    );
    return { vehicleLabel: null, confidence, reason: parsed.reason };
  }

  console.log(
    '[BañoVehicleInfer]',
    JSON.stringify({
      vehicleLabel: label,
      confidence,
      reason: parsed.reason,
    }),
  );
  return { vehicleLabel: label, confidence, reason: parsed.reason };
}

const TALLER_MAPS_URL =
  'https://maps.app.goo.gl/a3tEimJquzaJAwSD9?g_st=ipc';

const BAÑO_COLOR_EXTRA_DIAS = 2;

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

export type BañoPremiumVariant = 'A' | 'B' | 'C';

export type BañoDraftLlmComposeInput = BañoInstantComposeFacts & {
  variant: BañoPremiumVariant;
  inventarioDanos: Array<{
    pieza: string;
    severidad: string;
    descripcionTecnica?: string;
  }>;
  needsHeavyBodyworkDisclaimer: boolean;
  mapsUrl?: string;
};

/** Variante A/B/C estable por conversación (misma lógica que el panel). */
export function pickBañoPremiumVariant(
  conversationId: string,
  variantSalt = '',
): BañoPremiumVariant {
  const id = `${String(conversationId ?? '')}${String(variantSalt ?? '')}`;
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h + id.charCodeAt(i)) % 3;
  }
  return (['A', 'B', 'C'] as const)[h]!;
}

function buildBañoPricingContext(resolution: InstantQuoteResolution): {
  baseMx: number;
  extrasMx: number;
  totalMx: number;
  hasColorChange: boolean;
  diasBase: number;
  diasMostrar: number;
  extrasLabels: string[];
} {
  const baseMx = Math.round(Number(resolution.precioMx) || 0);
  const extrasMx = cambioColorAddonFromResolution(resolution);
  const totalMx = Math.round(Number(resolution.total) || baseMx + extrasMx);
  const hasColorChange = hasCambioColorInResolution(resolution);
  const diasBase = Math.max(
    1,
    Math.floor(Number(resolution.diasEntrega) || 0) || 3,
  );
  const diasMostrar = hasColorChange ? diasBase + BAÑO_COLOR_EXTRA_DIAS : diasBase;
  const extrasLabels = resolution.extras.map((e) => e.label).filter(Boolean);
  return {
    baseMx,
    extrasMx,
    totalMx,
    hasColorChange,
    diasBase,
    diasMostrar,
    extrasLabels,
  };
}

const BAÑO_DRAFT_MESSAGE_SYSTEM = `Eres el redactor premium de AutoFix (taller de carrocería y pintura en México).
Generas el mensaje final para WhatsApp/Messenger del **Baño de Pintura Exterior** (cotización de borrador).

Recibirás JSON con: vehículo, precios de catálogo (obligatorios), inventario de daños/severidad de visión, variante de redacción (A, B o C), y flags.

Responde SOLO el texto del mensaje al cliente (sin JSON, sin meta-explicación).

ESTRUCTURA OBLIGATORIA (puedes variar redacción según variante):
1) Título con 🎨 que mencione baño de pintura (+ cambio de color si aplica) y el vehículo con marca/modelo.
2) Línea de total con 💰 usando EXACTAMENTE los montos en pesos del JSON (formato: $29,000 MXN). Si hay cambio de color, desglosa base + extra en la misma línea o sublínea.
3) Bloque "**Incluye:**" con viñetas con emojis (🔧 hojalatería, ✨ materiales Sikkens, 🛡️ garantía, 💎 acabado espejo). NO inventes servicios fuera de este paquete.
4) ⏳ Tiempo estimado en días hábiles (usa diasMostrar del JSON).
5) 📍 Ubicación con el mapsUrl del JSON (copiar URL tal cual).
6) Cierre cordial invitando a agendar (📆); si es convertible, menciona inspección de toldo.

VARIANTES DE TONO (aplica SOLO la indicada en variant):
- **A — Directo:** apertura tipo "¡Listo! Aquí tienes el desglose…" / cotización clara; cierre "¿Qué día te queda mejor para ingresar tu unidad?"
- **B — Aspiracional:** "¡Perfecto! Te comparto la estimación para dejar tu [vehículo] impecable"; enfatiza Sikkens y acabado espejo; cierre amable para agendar.
- **C — Profesional cordial:** "Con gusto, este es el resumen de tu cotización"; tono sereno; cierre "dime qué día de la semana te funciona mejor".

REGLA DISCLAIMER HOJALATERÍA PESADA (si needsHeavyBodyworkDisclaimer es true):
- En la viñeta de hojalatería NO digas solo "hojalatería ligera".
- Debes indicar que puede requerir **hojalatería media/pesada**, posibles refacciones o trabajo extra tras desarme, **no incluido** en el baño de pintura exterior cotizado.
- Puedes aludir brevemente al inventario de daños (DM, DF, etc.) sin listar precios por pieza suelta.

INVENTARIO DE DAÑOS:
- Menciona de forma natural 1–3 hallazgos del inventarioDanos si ayudan al contexto (oxidación, desgaste, golpes en fascia, etc.).
- No conviertas el mensaje en cotización por piezas sueltas; el servicio cotizado es el baño integral.

PRECIOS:
- PROHIBIDO inventar, redondear distinto o omitir totalMx / baseMx / extrasMx del JSON.
- PROHIBIDO placeholders: "tu vehículo", "su vehículo", "[Modelo]", "[Precio]".

OTROS:
- Español de México, tono premium cercano.
- Usa **negritas** markdown donde encaje.
- Máximo ~45 líneas.`;

/**
 * Redacción dinámica del mensaje BPC (gpt-4o) — sin plantilla TypeScript fija.
 */
export async function composeBañoDraftMessageWithLlm(
  openai: OpenAI,
  input: BañoDraftLlmComposeInput,
): Promise<string> {
  const vehicle = String(input.vehicleLabel ?? '').trim();
  if (!vehicle || isPlaceholderBañoVehicleLabel(vehicle)) {
    throw new Error(
      'composeBañoDraftMessageWithLlm: vehículo no perfilado (prohibido cotizar con placeholder)',
    );
  }

  const pricing = buildBañoPricingContext(input.resolution);
  if (pricing.baseMx <= 0 || pricing.totalMx <= 0) {
    throw new Error('composeBañoDraftMessageWithLlm: precios inválidos');
  }

  const mapsUrl = String(input.mapsUrl ?? TALLER_MAPS_URL).trim();
  const payload = {
    variant: input.variant,
    vehiculo: vehicle,
    segmentoCarroceria: input.segmentoEs,
    servicioCatalogo: input.servicioDb,
    severidadTalla: input.severidadLiteral,
    precios: {
      baseMx: pricing.baseMx,
      extrasMx: pricing.extrasMx,
      totalMx: pricing.totalMx,
      moneda: 'MXN',
      extrasDetalle: input.resolution.extras,
    },
    cambioDeColor: pricing.hasColorChange,
    detalleColorPersonalizado: String(input.personalizedColorDetail ?? '').trim(),
    diasBase: pricing.diasBase,
    diasMostrar: pricing.diasMostrar,
    diasExtraPorCambioColor: pricing.hasColorChange ? BAÑO_COLOR_EXTRA_DIAS : 0,
    inventarioDanos: input.inventarioDanos,
    needsHeavyBodyworkDisclaimer: input.needsHeavyBodyworkDisclaimer,
    vehiculoConvertible: isConvertibleVehicleLabel(vehicle),
    mapsUrl,
  };

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.65,
    max_tokens: 900,
    messages: [
      { role: 'system', content: BAÑO_DRAFT_MESSAGE_SYSTEM },
      {
        role: 'user',
        content: `Redacta el mensaje al cliente con estos datos (respeta variante ${input.variant}):\n${JSON.stringify(payload, null, 2)}`,
      },
    ],
  });

  const text = String(completion.choices[0]?.message?.content ?? '').trim();
  if (!text || text.length < 80) {
    throw new Error('composeBañoDraftMessageWithLlm: respuesta vacía o demasiado corta');
  }
  if (!text.includes('💰')) {
    throw new Error('composeBañoDraftMessageWithLlm: falta línea de total con 💰');
  }
  if (!text.includes('🎨')) {
    throw new Error('composeBañoDraftMessageWithLlm: falta encabezado 🎨');
  }

  console.log(
    '[BañoDraftLlm]',
    JSON.stringify({
      variant: input.variant,
      vehicleLabel: vehicle,
      totalMx: pricing.totalMx,
      heavyDisclaimer: input.needsHeavyBodyworkDisclaimer,
      chars: text.length,
    }),
  );

  return text;
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

export type ComposeBañoNaturalInstantReplyOptions = {
  inventarioDanos?: BañoDraftLlmComposeInput['inventarioDanos'];
  needsHeavyBodyworkDisclaimer?: boolean;
  conversationId?: string;
  variantSalt?: string;
  variant?: BañoPremiumVariant;
  mapsUrl?: string;
};

/**
 * Mensaje al cliente para baño de pintura: redacción gpt-4o (variantes A/B/C + disclaimer dinámico).
 */
export async function composeBañoNaturalInstantReply(
  openai: OpenAI,
  facts: BañoInstantComposeFacts,
  options?: ComposeBañoNaturalInstantReplyOptions,
): Promise<string> {
  const variant =
    options?.variant ??
    pickBañoPremiumVariant(
      options?.conversationId ?? '',
      options?.variantSalt ?? facts.severidadLiteral,
    );

  console.log('--- [DEBUG ENTRÓ A VARIANTES DE BAÑO — LLM] ---');
  console.log('Variante:', variant);
  console.log('Vehículo:', facts.vehicleLabel);
  console.log('Total resolución:', facts.resolution?.total);

  return composeBañoDraftMessageWithLlm(openai, {
    ...facts,
    variant,
    inventarioDanos: options?.inventarioDanos ?? [],
    needsHeavyBodyworkDisclaimer:
      options?.needsHeavyBodyworkDisclaimer === true,
    mapsUrl: options?.mapsUrl,
  });
}
