import type { OpenAI } from 'openai';
import type { InstantQuoteResolution } from './instant-quote-from-text';
import { AUTO_FIX_CURRENCY, formatAutoFixMoney } from './autofix-config';

export type BañoLlmClassification = {
  vehicleLabel: string;
  segmentoEs: string;
  severidadLiteral: string;
};

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
2) Sedán compacto/mediano común (Jetta, Civic, Corolla, Sentra, Elantra, Mazda 3, etc.) → Mediano.
3) SUV mediana/grande, minivan mediana, pick-up mediana (CR-V, RAV4, Explorer, Pathfinder, Pilot, Highlander, Tacoma, Hilux, Ranger, etc.) → Grande o XL según tamaño real: pick-ups y SUVs de 3 filas o muy grandes → XL; SUV mediana de 2 filas tipo CR-V, Q5, X3, GLC → Grande.
4) SUVs enormes o pick-ups full size (Suburban, Tahoe, Expedition, F-250+, RAM 2500+, etc.) → XL.

REGLA DE ORO — PREMIUM:
Si la marca es de lujo/premium europea o equivalente, la severidad DEBE llevar sufijo " Premium" (con espacio):
Marcas premium: Audi, BMW, Mercedes-Benz / Mercedes, Porsche, Land Rover, Range Rover, Volvo, Jaguar, Lexus (como marca premium), Infiniti, Acura, Genesis, Maserati, Bentley, Rolls-Royce, Ferrari, Lamborghini, McLaren, Aston Martin.
Ejemplos: Audi Q5 → "Grande Premium" (SUV premium mediana). Audi A4 → "Mediano Premium". BMW X5 muy grande → "XL Premium" o "Grande Premium" según criterio de tamaño corporal del vehículo.

Si el cliente ya escribió explícitamente el tamaño de taller (Chico, Mediano, Grande, XL, con o sin Premium), respeta esa severidad exacta si coincide con la lista permitida.

No inventes marcas. Si no hay vehículo claro, severidadLiteral debe ser aun así el mejor intento razonable (no dejes vacío).`;

const COMPOSE_SYSTEM = `Eres el asistente de un taller de hojalatería y pintura en México (WhatsApp).
Redacta UN solo mensaje en español, cordial y natural, sin plantillas genéricas tipo "¡Hola! Con gusto te comparto la cotización según nuestro catálogo vigente".
Menciona el vehículo del cliente y la categoría (segmento) de forma fluida.
Debes incluir los montos EXACTOS que te damos (MXN); no redondees ni cambies cifras. No inventes otros servicios ni totales distintos.
Puedes usar negritas con * de forma moderada. Cierra invitando brevemente a agendar si encaja el tono.`;

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

/**
 * Redacción natural del mensaje al cliente con cifras fijas del catálogo.
 */
export async function composeBañoNaturalInstantReply(
  openai: OpenAI,
  facts: {
    vehicleLabel: string;
    segmentoEs: string;
    servicioDb: string;
    severidadLiteral: string;
    resolution: InstantQuoteResolution;
  },
): Promise<string> {
  const { vehicleLabel, segmentoEs, servicioDb, severidadLiteral, resolution } = facts;
  const lineDesc = resolution.lines.map((l) => `${l.label}: ${formatAutoFixMoney(l.amount)} ${resolution.currency}`).join(' | ');
  const extrasDesc =
    resolution.extras.length > 0
      ? resolution.extras
          .map((l) => `${l.label}: ${formatAutoFixMoney(l.amount)} ${resolution.currency}`)
          .join(' | ')
      : '';
  const totalStr = formatAutoFixMoney(resolution.total);

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.45,
    max_tokens: 450,
    messages: [
      { role: 'system', content: COMPOSE_SYSTEM },
      {
        role: 'user',
        content: `Datos (no modificar montos):
- Vehículo: ${vehicleLabel}
- Categoría (tu descripción al cliente): ${segmentoEs}
- Servicio en catálogo: ${servicioDb}
- Tamaño (severidad) aplicada: ${severidadLiteral}
- Línea(s) cotizadas: ${lineDesc}
${extrasDesc ? `- Suplementos: ${extrasDesc}\n` : ''}- Total exacto a mencionar: ${totalStr} ${AUTO_FIX_CURRENCY}

Escribe el mensaje al cliente.`,
      },
    ],
  });

  const text = completion.choices[0]?.message?.content?.trim();
  if (!text) {
    throw new Error('composeBañoNaturalInstantReply: respuesta vacía');
  }
  return text;
}
