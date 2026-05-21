import type { OpenAI } from 'openai';
import type { InstantQuoteResolution } from './instant-quote-from-text';
import { isPlaceholderBañoVehicleLabel } from './instant-quote-from-text';
import { AUTO_FIX_CURRENCY, formatAutoFixMoney } from './autofix-config';

export type BañoLlmClassification = {
  vehicleLabel: string;
  segmentoEs: string;
  severidadLiteral: string;
};

const TALLER_MAPS_URL =
  'https://maps.app.goo.gl/a3tEimJquzaJAwSD9?g_st=ipc';

/**
 * Especificación contractual del mensaje instantáneo de Baño de Pintura.
 * La redacción final se genera con plantilla determinística para no alterar `resolution.precioMx`.
 */
const COMPOSE_SYSTEM = `Eres el redactor de cotizaciones instantáneas de un taller de hojalatería y pintura en México (WhatsApp).

Debes reproducir EXACTAMENTE esta estructura (mismos emojis, orden y viñetas; sin líneas extra al inicio ni despedidas genéricas largas):

🎨 Baño de pintura exterior ([Marca y Modelo del Auto])
💰 Estimado: [PRECIO_EXACTO] MXN
Incluye:
🔧 Hojalatería ligera y corrección de imperfecciones
✨ Materiales gama alta (Pintura y Barniz Sikkens)
🛡️ Garantía por escrito en brillo y adherencia
💎 Acabado espejo (Lijado y pulido nivel exposición)
⏳ Tiempo estimado: [DIAS_DB] días hábiles
📍 Ubicación del taller: ${TALLER_MAPS_URL}

REGLAS:
- [PRECIO_EXACTO] es el literal que te damos; cópialo carácter por carácter (no redondees ni recalcules).
- [DIAS_DB] es el entero de catálogo que te damos.
- [Marca y Modelo del Auto] usa el vehicleLabel proporcionado.

CIERRE si el vehículo ES convertible o descapotable (BMW Z4, Mazda MX-5, Mustang Convertible, etc.):
Añade OBLIGATORIAMENTE al final (después de la ubicación), una línea en blanco y:
📅 El [Modelo] requiere una inspección de cortesía para evaluar las gomas del toldo retráctil. ¿Te gustaría que te reserve fecha y hora para valoración?

CIERRE si el vehículo NO es convertible:
Tras la ubicación, una línea en blanco y una sola frase breve invitando a agendar fecha y hora en el taller.

Si hay suplemento de cambio de color, añade después del Estimado una línea: "Suplemento cambio de color: [MONTO_SUPLEMENTO] MXN" usando el monto exacto dado.

No uses negritas con asteriscos. No inventes otros precios ni servicios.`;

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

/** Nombre corto del modelo para la nota de convertible (p. ej. "BMW Z4"). */
function modelNameForConvertibleNote(vehicleLabel: string): string {
  const v = String(vehicleLabel ?? '').trim();
  return v || 'vehículo';
}

export type BañoInstantComposeFacts = {
  vehicleLabel: string;
  segmentoEs: string;
  servicioDb: string;
  severidadLiteral: string;
  resolution: InstantQuoteResolution;
};

/**
 * Plantilla determinística: cifras tomadas de `resolution.precioMx` y `resolution.diasEntrega` sin alterar.
 */
export function buildBañoNaturalInstantReplyText(facts: BañoInstantComposeFacts): string {
  const { vehicleLabel, resolution } = facts;
  const vl = vehicleLabel.trim();
  if (!vl || isPlaceholderBañoVehicleLabel(vl)) {
    throw new Error(
      'buildBañoNaturalInstantReplyText: vehículo no perfilado (prohibido cotizar con placeholder)',
    );
  }
  const precioMx = Math.round(Number(resolution.precioMx));
  if (!Number.isFinite(precioMx) || precioMx <= 0) {
    throw new Error('buildBañoNaturalInstantReplyText: precioMx inválido');
  }
  const precioStr = formatAutoFixMoney(precioMx);
  const dias = Math.max(
    1,
    Math.floor(Number(resolution.diasEntrega) || 0) || 3,
  );

  const blocks: string[] = [
    `🎨 Baño de pintura exterior (${vl})`,
    `💰 Estimado: ${precioStr} MXN`,
  ];

  for (const extra of resolution.extras) {
    const amt = Math.round(Number(extra.amount));
    if (Number.isFinite(amt) && amt > 0) {
      blocks.push(
        `Suplemento ${extra.label}: ${formatAutoFixMoney(amt)} MXN`,
      );
    }
  }

  blocks.push(
    'Incluye:',
    '🔧 Hojalatería ligera y corrección de imperfecciones',
    '✨ Materiales gama alta (Pintura y Barniz Sikkens)',
    '🛡️ Garantía por escrito en brillo y adherencia',
    '💎 Acabado espejo (Lijado y pulido nivel exposición)',
    `⏳ Tiempo estimado: ${dias} días hábiles`,
    `📍 Ubicación del taller: ${TALLER_MAPS_URL}`,
  );

  if (isConvertibleVehicleLabel(vl)) {
    const modelo = modelNameForConvertibleNote(vl);
    blocks.push(
      '',
      `📅 El ${modelo} requiere una inspección de cortesía para evaluar las gomas del toldo retráctil. ¿Te gustaría que te reserve fecha y hora para valoración?`,
    );
  } else {
    blocks.push(
      '',
      '¿Te gustaría que te reserve fecha y hora para tu baño de pintura en el taller?',
    );
  }

  return blocks.join('\n');
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

/**
 * Redacción del mensaje instantáneo al cliente (plantilla fija + cifras de catálogo).
 * Usa OpenAI solo si la plantilla falla; el prompt {@link COMPOSE_SYSTEM} define la estructura contractual.
 */
export async function composeBañoNaturalInstantReply(
  openai: OpenAI,
  facts: BañoInstantComposeFacts,
): Promise<string> {
  const deterministic = buildBañoNaturalInstantReplyText(facts);
  const precioLiteral = formatAutoFixMoney(Math.round(facts.resolution.precioMx));
  if (deterministic.includes(precioLiteral)) {
    return deterministic;
  }

  const { vehicleLabel, segmentoEs, servicioDb, severidadLiteral, resolution } =
    facts;
  const precioStr = formatAutoFixMoney(Math.round(resolution.precioMx));
  const dias = Math.max(1, Math.floor(Number(resolution.diasEntrega) || 0) || 3);
  const extrasDesc =
    resolution.extras.length > 0
      ? resolution.extras
          .map((l) => `${l.label}: ${formatAutoFixMoney(Math.round(l.amount))}`)
          .join(' | ')
      : '';
  const esConvertible = isConvertibleVehicleLabel(vehicleLabel);

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    max_tokens: 520,
    messages: [
      { role: 'system', content: COMPOSE_SYSTEM },
      {
        role: 'user',
        content: `Datos (obligatorio respetar precio y días):
- Vehículo (vehicleLabel): ${vehicleLabel}
- Categoría interna: ${segmentoEs}
- Servicio catálogo: ${servicioDb}
- Severidad: ${severidadLiteral}
- PRECIO_EXACTO (resolution.precioMx, no modificar): ${precioStr}
- DIAS_DB (resolution.diasEntrega): ${dias}
- Moneda: ${AUTO_FIX_CURRENCY}
- Es convertible/descapotable: ${esConvertible ? 'sí' : 'no'}
${extrasDesc ? `- Suplementos: ${extrasDesc}\n` : ''}
Escribe el mensaje al cliente siguiendo la estructura del system.`,
      },
    ],
  });

  const text = completion.choices[0]?.message?.content?.trim();
  if (!text || !text.includes(precioStr)) {
    return deterministic;
  }
  return text;
}
