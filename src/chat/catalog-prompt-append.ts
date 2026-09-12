import { createHash } from 'node:crypto';
import { BANIO_SERVICE_IDENTITIES } from '../catalog/banio-service-identity';

export const CATALOG_APPEND_LABEL = 'catalog-append-v2-nonfinancial';
export const LEGACY_CATALOG_APPEND_LABEL = 'catalog-append-v1-financial-legacy';

const FINANCIAL_INSTRUCTION_RE =
  /\$\s*8[,.]?000|\$\s*10[,.]?000|suma el suplemento|entrega total y desglose|desglose amable|importe debe salir|puedes dar el precio de inmediato|cot[ií]zalos en el mismo mensaje con precios|PROHIBIDO dar cifras o totales|inversión total|totalMx|totalGlobal/i;

/** Hash estable de texto estático de prompt (no historial). */
export function hashPromptText(text: string): string {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
}

export function catalogAppendContainsFinancialInstructions(text: string): boolean {
  return FINANCIAL_INSTRUCTION_RE.test(String(text ?? ''));
}

/**
 * Contexto de catálogo visible al LLM en flujo CANONICAL.
 * Nombres y cuándo llamar tools. Cero reglas de cálculo o importes.
 */
/** Los tres baños son seleccionables aunque aún no tengan precio en BD. */
export function ensureBanioCatalogNamesForLlm(
  names: readonly string[],
): string[] {
  const out = [...names];
  const seen = new Set(out.map((n) => String(n ?? '').trim().toLowerCase()));
  for (const id of BANIO_SERVICE_IDENTITIES) {
    const key = id.catalogName.toLowerCase();
    if (!seen.has(key)) {
      out.push(id.catalogName);
      seen.add(key);
    }
  }
  return out;
}

export function buildCatalogContextForLlm(names: readonly string[]): string {
  const withBanios = ensureBanioCatalogNamesForLlm(names);
  if (!withBanios.length) {
    return '\n\n[Catálogo de piezas/servicios aún sin datos en base de datos.]';
  }
  const list = withBanios.join(', ');
  return `

Estos son los nombres EXACTOS de servicios y piezas en base de datos (PriceMatrix): ${list}.
NUNCA inventes nombres de servicio: si cotizas algo, el nombre debe ser uno de esa lista (copiado tal cual).
NO calcules, sumes, cites ni presentes precios, totales ni desgloses: el backend es la autoridad financiera y compondrá el mensaje final.
Si el usuario dice "baño de pintura" sin matiz, corresponde al servicio BPE (Baño de Pintura Exterior). BPEI = exterior e interiores. BPCC = cambio de color. Elige el código/servicio; no decidas su precio.
**Baño de pintura:** si no hay marca/modelo ni tamaño de carrocería (Chico, Mediano, Grande, XL) en el mensaje o historial reciente, pregunta el vehículo. No inventes talla ni importe.
Servicios integrales (cerámico, estética, baño) se cotizan con la herramienta obtenerCotizacionExpress cuando ya conoces el vehículo. Hojalatería con daño sigue el flujo de fotos / carrito.
**Después de cotizar:** si el cliente muestra interés, prioriza agendar (createAppointment). No repitas montos.`;
}

/**
 * Texto legacy con reglas financieras. NO inyectar en CANONICAL.
 * Conservado solo para compatibilidad aislada / comparación de tests.
 */
export function buildLegacyFinancialCatalogAppendForLlm(
  names: readonly string[],
): string {
  if (!names.length) {
    return '\n\n[Catálogo de piezas/servicios aún sin datos en base de datos.]';
  }
  const list = names.join(', ');
  return `\n\nEstos son los nombres EXACTOS de servicios y piezas en base de datos (PriceMatrix): ${list}.
NUNCA inventes precios ni inventes nombres de servicio: si cotizas algo, el nombre del servicio debe ser uno de esa lista (copiado tal cual) y el importe debe salir solo de la matriz para la severidad correcta.
Si el usuario dice "baño de pintura" o similar sin decir "Exterior", corresponde al servicio de catálogo "Baño de Pintura Exterior" y al tamaño (severidad) que toque según el vehículo o el tamaño que el cliente indique.
**Baño de pintura (obligatorio):** si en el mensaje actual y el historial reciente del cliente NO aparece el modelo de su auto ni camioneta (ni año, ni marca, ni frases tipo "es un…", "tengo un…", "mi …") y tampoco dice explícitamente el tamaño de carrocería (Chico, Mediano, Grande, XL, con o sin Premium), PROHIBIDO dar cifras o totales. Responde exactamente: "¡Claro! Con gusto. Para darte el precio estimado, ¿qué auto o camioneta tienes?" Si el modelo ya se dijo antes en el chat, úsalo y cotiza sin volver a preguntar.
**Servicios de precio fijo en catálogo (p. ej. Estética Automotriz, Cerámico cuando aplique en la lista):** puedes dar el precio de inmediato; no dependen del tamaño del vehículo en nuestro flujo actual.
Para baño de pintura con vehículo ya conocido, tamaños de referencia: Audi A4/A5, BMW Serie 3 / 318–335, Mercedes Clase C, Mazda 6 = severidad "Mediano Premium" salvo que el usuario indique explícitamente otro tamaño (Chico, Grande, XL, Premium, etc.).
Los servicios InstantQuote (p. ej. baño de pintura exterior por tamaño, cerámico, estética automotriz) cotízalos en el mismo mensaje con precios del catálogo: *no pidas borrador ni autorización humana ni fotos* para esos casos; entrega total y desglose amable al instante. Si pide baño de pintura y además "cambio de color", suma el suplemento: $8,000 MXN si el tamaño es Chico o Mediano (incluye variantes Premium de esos tamaños), y $10,000 MXN si es Grande o XL (incluye Premium). Para el resto de hojalatería con daño, sigue el flujo de borrador / fotos cuando aplique.
**Después de cotizar:** si el cliente ya recibió el precio y muestra interés, pide día/hora o menciona un día de la semana, tu prioridad es **agendar** (en canales con herramientas: función createAppointment). No repitas montos que ya enviaste salvo que pida otra cotización explícita.`;
}

export function catalogAppendVersionMeta(catalogAppend: string): {
  catalogAppendVersion: string;
  catalogAppendLabel: string;
} {
  return {
    catalogAppendVersion: hashPromptText(catalogAppend),
    catalogAppendLabel: CATALOG_APPEND_LABEL,
  };
}

export function effectiveChatPromptHash(
  baseChatPrompt: string,
  catalogAppend: string,
): string {
  return hashPromptText(`${String(baseChatPrompt ?? '').trim()}\n${String(catalogAppend ?? '').trim()}`);
}
