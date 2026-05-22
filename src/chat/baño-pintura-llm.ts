import type { OpenAI } from 'openai';
import type { InstantQuoteResolution } from './instant-quote-from-text';
import {
  extractBañoColorDetailHeuristic,
  isPlaceholderBañoVehicleLabel,
  mentionsCambioDeColor,
} from './instant-quote-from-text';

export type BañoLlmClassification = {
  vehicleLabel: string;
  segmentoEs: string;
  severidadLiteral: string;
};

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

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.15,
    max_tokens: 220,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: CLASSIFY_SYSTEM },
      {
        role: 'user',
        content: `Valores permitidos para severidadLiteral (elige uno, copia exacto):\n${allowed.map((s) => `- ${s}`).join('\n')}\n\nTexto del cliente:\n${String(userContextText ?? '').trim().slice(0, 8000)}`,
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
  return buildBañoNaturalInstantReplyText(facts);
}
