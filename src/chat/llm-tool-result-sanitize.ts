/**
 * Fase 8 — separación tool internal result vs resultado expuesto al LLM.
 * El backend conserva CanonicalQuoteV1; el modelo no recibe importes.
 */

export const CANONICAL_LLM_TOOL_INSTRUCTION =
  'La cotización se actualizó. NO inventes, calcules ni cites importes. El backend compondrá el mensaje final con el bloque financiero canónico.';

const MONEY_KEYS = new Set([
  'totalmx',
  'totalcombinadomx',
  'subtotal',
  'subtotalmx',
  'amount',
  'totalglobal',
  'expresstotalmx',
  'expresssubtotalmx',
  'totalaprobado',
  'totalcomplemento',
  'totalpendiente',
  'estimateamount',
  'preciomx',
  'preciominestimado',
  'preciomaxestimado',
  'preciocentral',
  'preciomin',
  'preciomax',
  'marketpreciomin',
  'marketpreciomax',
  'marketpreciocentral',
  'unitprice',
  'desglose',
  'desgloseaprobado',
  'desglosecomplemento',
  'desglosependiente',
  'canonicalquotev1',
  'lines',
  'cotizacionmultivehiculo',
  'lastsendsnapshot',
  'vehiclequotesbyid',
  'aggregatequoteview',
  'combinedtotal',
  'extras',
  'pricerange',
  'marketevidence',
]);

const KEEP_KEYS = new Set([
  'success',
  'error',
  'quoteupdated',
  'quotemode',
  'quoteflowmode',
  'requirescanonicalcomposition',
  'vehicledisplaylabel',
  'modelovehiculo',
  'diasentrega',
  'estadocarrito',
  'sendcount',
  'haycambiosdesdeultimoenvio',
  'cantidadlineas',
  'draftquoteid',
  'solicitar_modelo_banio',
  'resumendanosvisuales',
  'vehiclecount',
  'vehiclelabels',
  'quoteids',
  'vehicleids',
  'cartpersisted',
  'preview',
]);

function normKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function isCanonicalToolContext(
  toolName: string,
  payload: Record<string, unknown>,
): boolean {
  const mode = String(payload.quoteFlowMode ?? payload.quoteMode ?? '')
    .trim()
    .toUpperCase();
  if (mode === 'LEGACY') return false;
  if (mode === 'CANONICAL') return true;
  if (payload.canonicalQuoteV1 != null) return true;
  if (payload.requiresCanonicalComposition === true) return true;
  return toolName === 'obtenerCotizacionExpress' && payload.success === true;
}

function collectVehicleLabels(payload: Record<string, unknown>): string[] {
  const labels: string[] = [];
  const push = (raw: unknown) => {
    const s = String(raw ?? '').trim();
    if (s && !labels.includes(s)) labels.push(s);
  };
  if (Array.isArray(payload.vehicleLabels)) {
    for (const label of payload.vehicleLabels) push(label);
  }
  push(payload.vehicleDisplayLabel);
  push(payload.modeloVehiculo);
  for (const key of ['cotizacionMultiVehiculo', '_internalMultiVehicle'] as const) {
    const multi = payload[key];
    if (multi && typeof multi === 'object') {
      const vehiculos = (multi as { vehiculos?: unknown }).vehiculos;
      if (Array.isArray(vehiculos)) {
        for (const v of vehiculos) {
          if (v && typeof v === 'object') {
            const row = v as Record<string, unknown>;
            push(row.vehicleDisplayLabel);
            push(row.modeloVehiculo);
          }
        }
      }
    }
  }
  return labels;
}

export function shouldPreferCanonicalOnCartMutation(cart: {
  quotePayload?: { quoteFlowMode?: string | null } | null;
}): boolean {
  return String(cart.quotePayload?.quoteFlowMode ?? '').toUpperCase() !== 'LEGACY';
}

/**
 * Resultado interno (con dinero) → payload seguro para el modelo.
 * No muta el objeto original.
 */
export function sanitizeToolResultForLlm(
  internal: Record<string, unknown>,
  opts?: { toolName?: string },
): Record<string, unknown> {
  const toolName = opts?.toolName ?? '';
  if (!isCanonicalToolContext(toolName, internal)) {
    return { ...internal };
  }

  const labels = collectVehicleLabels(internal);
  const quoteMode = 'CANONICAL';
  const success = internal.success !== false;
  const exposed: Record<string, unknown> = {
    success,
    quoteUpdated: success && !internal.error,
    quoteMode,
    quoteFlowMode: quoteMode,
    requiresCanonicalComposition: true,
    instruccionParaModelo: CANONICAL_LLM_TOOL_INSTRUCTION,
  };

  for (const [key, value] of Object.entries(internal)) {
    const nk = normKey(key);
    if (MONEY_KEYS.has(nk)) continue;
    if (!KEEP_KEYS.has(nk)) continue;
    if (key === 'success') continue;
    if (value === undefined) continue;
    exposed[key] = value;
  }

  if (labels.length) {
    exposed.vehicleLabels = labels;
    if (labels.length > 1) exposed.vehicleCount = labels.length;
  }

  if (typeof internal.error === 'string' && internal.error.trim()) {
    exposed.error = internal.error;
    exposed.quoteUpdated = false;
  }

  return exposed;
}

export function toolResultHasExposedMoney(payload: Record<string, unknown>): boolean {
  const stack: unknown[] = [payload];
  const seen = new Set<unknown>();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      stack.push(...cur);
      continue;
    }
    for (const [key, value] of Object.entries(cur as Record<string, unknown>)) {
      if (MONEY_KEYS.has(normKey(key))) return true;
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return false;
}
