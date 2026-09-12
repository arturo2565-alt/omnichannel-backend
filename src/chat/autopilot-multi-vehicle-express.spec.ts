import {
  MultiVehicleExpressTracker,
  buildCotizacionMultiVehiculoAggregate,
  buildMultiVehicleLlmView,
} from './autopilot-multi-vehicle-express';
import {
  sanitizeToolResultForLlm,
  toolResultHasExposedMoney,
} from './llm-tool-result-sanitize';

describe('autopilot-multi-vehicle-express', () => {
  it('el agregado interno conserva totalCombinadoMx (no se envía al LLM)', () => {
    const agg = buildCotizacionMultiVehiculoAggregate([
      {
        modeloVehiculo: 'Nissan March 2018',
        desglose: [{ pieza: 'Baño de pintura', severidad: 'Chico', precioMx: 12000 }],
        subtotalMx: 12000,
        totalMx: 12000,
      },
      {
        modeloVehiculo: 'BMW Serie 3 2020',
        desglose: [{ pieza: 'Baño de pintura', severidad: 'Mediano', precioMx: 28000 }],
        subtotalMx: 28000,
        totalMx: 28000,
      },
    ]);
    expect(agg.totalCombinadoMx).toBe(40000);
    expect(agg.cantidadVehiculos).toBe(2);
    expect(agg.instruccionParaModelo).not.toMatch(/40[,.]?000/);
    const llmView = buildMultiVehicleLlmView(agg.vehiculos);
    expect(llmView.vehicleCount).toBe(2);
    expect(llmView.totalCombinadoMx).toBeUndefined();
    expect(toolResultHasExposedMoney(llmView)).toBe(false);
  });

  it('tracker agrega vista LLM a partir del segundo vehículo', () => {
    const tracker = new MultiVehicleExpressTracker();
    const argsA = JSON.stringify({
      servicios: ['baño de pintura'],
      modeloVehiculo: 'Aveo 2015',
    });
    const argsB = JSON.stringify({
      servicios: ['baño de pintura'],
      modeloVehiculo: 'Jetta 2019',
    });

    const first = tracker.enrichPayload(
      { success: true, totalMx: 15000, desglose: [], subtotalMx: 15000, modeloVehiculo: 'Aveo 2015' },
      argsA,
    );
    expect(first.vehicleCount).toBeUndefined();

    const second = tracker.enrichPayload(
      { success: true, totalMx: 18000, desglose: [], subtotalMx: 18000, modeloVehiculo: 'Jetta 2019' },
      argsB,
    );
    expect(second.vehicleCount).toBe(2);
    expect(second.requiresCanonicalComposition).toBe(true);
    expect(
      (second._internalMultiVehicle as { totalCombinadoMx: number }).totalCombinadoMx,
    ).toBe(33000);

    const exposed = sanitizeToolResultForLlm(second, {
      toolName: 'obtenerCotizacionExpress',
    });
    expect(toolResultHasExposedMoney(exposed)).toBe(false);
    expect(exposed.vehicleLabels).toEqual(['Aveo 2015', 'Jetta 2019']);
  });

  it('patchBatchOutputs no inyecta totalCombinadoMx al modelo', () => {
    const tracker = new MultiVehicleExpressTracker();
    tracker.enrichPayload(
      { success: true, totalMx: 10000, desglose: [], subtotalMx: 10000, modeloVehiculo: 'A' },
      '{}',
    );
    tracker.enrichPayload(
      { success: true, totalMx: 20000, desglose: [], subtotalMx: 20000, modeloVehiculo: 'B' },
      '{}',
    );

    const batch = [
      {
        name: 'obtenerCotizacionExpress',
        output: JSON.stringify({ success: true, totalMx: 10000 }),
      },
      {
        name: 'obtenerCotizacionExpress',
        output: JSON.stringify({ success: true, totalMx: 20000 }),
      },
    ];
    tracker.patchBatchOutputs(batch);

    const parsedFirst = JSON.parse(batch[0]!.output) as Record<string, unknown>;
    expect(parsedFirst.cotizacionMultiVehiculo).toBeUndefined();
    expect(parsedFirst.totalCombinadoMx).toBeUndefined();
    expect(parsedFirst.vehicleCount).toBe(2);
    expect(parsedFirst.requiresCanonicalComposition).toBe(true);
  });
});
