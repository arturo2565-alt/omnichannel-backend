import type { CotizacionExpressDesgloseLine } from './autopilot-cotizacion-express';
import {
  CANONICAL_LLM_TOOL_INSTRUCTION,
  sanitizeToolResultForLlm,
} from './llm-tool-result-sanitize';

export type MultiVehicleExpressEntry = {
  modeloVehiculo: string;
  vehicleDisplayLabel?: string;
  desglose: CotizacionExpressDesgloseLine[];
  subtotalMx: number;
  totalMx: number;
  servicios?: string[];
};

/**
 * Agregado INTERNO. combinedTotal / totalCombinadoMx no se exponen al LLM.
 * El mensaje al cliente se compone desde CanonicalQuotes individuales.
 */
export type CotizacionMultiVehiculoAggregate = {
  cantidadVehiculos: number;
  vehiculos: MultiVehicleExpressEntry[];
  /** Presentación interna. No enviar al modelo. */
  totalCombinadoMx: number;
  instruccionParaModelo: string;
};

export function buildCotizacionMultiVehiculoAggregate(
  entries: readonly MultiVehicleExpressEntry[],
): CotizacionMultiVehiculoAggregate {
  const vehiculos = entries.map((e) => ({ ...e }));
  const totalCombinadoMx = vehiculos.reduce(
    (sum, e) => sum + Math.max(0, Math.round(Number(e.totalMx) || 0)),
    0,
  );
  return {
    cantidadVehiculos: vehiculos.length,
    vehiculos,
    totalCombinadoMx,
    instruccionParaModelo: `Cotización simultánea de ${vehiculos.length} vehículos. ${CANONICAL_LLM_TOOL_INSTRUCTION}`,
  };
}

export function buildMultiVehicleLlmView(
  entries: readonly MultiVehicleExpressEntry[],
): Record<string, unknown> {
  const labels = entries
    .map((e) => String(e.vehicleDisplayLabel || e.modeloVehiculo || '').trim())
    .filter(Boolean);
  return {
    quoteUpdated: true,
    quoteMode: 'CANONICAL',
    requiresCanonicalComposition: true,
    vehicleCount: entries.length,
    vehicleLabels: labels,
    instruccionParaModelo: `Cotización simultánea de ${entries.length} vehículos. ${CANONICAL_LLM_TOOL_INSTRUCTION}`,
  };
}

function parseExpressToolArgs(argsJson: string): Record<string, unknown> {
  try {
    return JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function entryFromExpressPayload(
  payload: Record<string, unknown>,
  argsJson: string,
): MultiVehicleExpressEntry | null {
  if (payload.success !== true) return null;
  const totalMx = Math.round(Number(payload.totalMx) || 0);
  if (!Number.isFinite(totalMx) || totalMx < 0) return null;

  const raw = parseExpressToolArgs(argsJson);
  const serviciosRaw = raw.servicios ?? raw.services ?? raw.piezas;
  const servicios = Array.isArray(serviciosRaw)
    ? serviciosRaw.map((s) => String(s ?? '').trim()).filter(Boolean)
    : typeof serviciosRaw === 'string' && serviciosRaw.trim()
      ? [serviciosRaw.trim()]
      : undefined;

  const modeloVehiculo = String(
    payload.modeloVehiculo ?? raw.modeloVehiculo ?? 'Vehículo',
  ).trim();

  const desglose = Array.isArray(payload.desglose)
    ? (payload.desglose as CotizacionExpressDesgloseLine[])
    : [];

  const subtotalMx = Math.round(
    Number(payload.subtotalMx) || totalMx,
  );

  return {
    modeloVehiculo,
    vehicleDisplayLabel:
      typeof payload.vehicleDisplayLabel === 'string'
        ? payload.vehicleDisplayLabel
        : undefined,
    desglose,
    subtotalMx: Math.max(0, subtotalMx),
    totalMx: Math.max(0, totalMx),
    ...(servicios?.length ? { servicios } : {}),
  };
}

/** Acumula cotizaciones express del mismo turno de autopilot (varios vehículos). */
export class MultiVehicleExpressTracker {
  private readonly entries: MultiVehicleExpressEntry[] = [];

  enrichPayload(
    payload: Record<string, unknown>,
    argsJson: string,
  ): Record<string, unknown> {
    const entry = entryFromExpressPayload(payload, argsJson);
    if (!entry) return payload;

    this.entries.push(entry);
    if (this.entries.length < 2) return payload;

    return {
      ...payload,
      /** Interno: el sanitizer lo retira antes de enviarlo al modelo. */
      _internalMultiVehicle: buildCotizacionMultiVehiculoAggregate(this.entries),
      ...buildMultiVehicleLlmView(this.entries),
    };
  }

  /** Inyecta la vista LLM (sin importes) en todas las salidas express del batch. */
  patchBatchOutputs(
    batch: ReadonlyArray<{ name: string; output: string }>,
  ): void {
    if (this.entries.length < 2) return;
    const llmView = buildMultiVehicleLlmView(this.entries);
    for (const item of batch) {
      if (item.name !== 'obtenerCotizacionExpress') continue;
      try {
        const parsed = JSON.parse(item.output) as Record<string, unknown>;
        if (parsed.success !== true) continue;
        item.output = JSON.stringify(
          sanitizeToolResultForLlm(
            { ...parsed, ...llmView, quoteFlowMode: 'CANONICAL' },
            { toolName: 'obtenerCotizacionExpress' },
          ),
        );
      } catch {
        /* ignore malformed output */
      }
    }
  }

  getInternalEntries(): readonly MultiVehicleExpressEntry[] {
    return this.entries;
  }
}
