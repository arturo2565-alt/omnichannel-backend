import type { CotizacionExpressDesgloseLine } from './autopilot-cotizacion-express';

export type MultiVehicleExpressEntry = {
  modeloVehiculo: string;
  vehicleDisplayLabel?: string;
  desglose: CotizacionExpressDesgloseLine[];
  subtotalMx: number;
  totalMx: number;
  servicios?: string[];
};

export type CotizacionMultiVehiculoAggregate = {
  cantidadVehiculos: number;
  vehiculos: MultiVehicleExpressEntry[];
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
    instruccionParaModelo: `Cotización simultánea de ${vehiculos.length} vehículos. Presenta cada presupuesto por separado (modelo + desglose + totalMx de ese vehículo). Para el gran total combinado usa EXACTAMENTE totalCombinadoMx (${totalCombinadoMx.toLocaleString('es-MX')} MXN). PROHIBIDO sumar precios mentalmente.`,
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
      cotizacionMultiVehiculo: buildCotizacionMultiVehiculoAggregate(
        this.entries,
      ),
    };
  }

  /** Inyecta el agregado en todas las salidas express del mismo batch. */
  patchBatchOutputs(
    batch: ReadonlyArray<{ name: string; output: string }>,
  ): void {
    if (this.entries.length < 2) return;
    const aggregate = buildCotizacionMultiVehiculoAggregate(this.entries);
    for (const item of batch) {
      if (item.name !== 'obtenerCotizacionExpress') continue;
      try {
        const parsed = JSON.parse(item.output) as Record<string, unknown>;
        if (parsed.success !== true) continue;
        item.output = JSON.stringify({
          ...parsed,
          cotizacionMultiVehiculo: aggregate,
        });
      } catch {
        /* ignore malformed output */
      }
    }
  }
}
