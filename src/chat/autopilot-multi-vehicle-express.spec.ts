import {
  MultiVehicleExpressTracker,
  buildCotizacionMultiVehiculoAggregate,
} from './autopilot-multi-vehicle-express';

describe('autopilot-multi-vehicle-express', () => {
  it('suma totalCombinadoMx desde totales por vehículo', () => {
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
    expect(agg.instruccionParaModelo).toContain('40,000');
  });

  it('tracker agrega cotizacionMultiVehiculo a partir del segundo vehículo', () => {
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
    expect(first.cotizacionMultiVehiculo).toBeUndefined();

    const second = tracker.enrichPayload(
      { success: true, totalMx: 18000, desglose: [], subtotalMx: 18000, modeloVehiculo: 'Jetta 2019' },
      argsB,
    );
    expect(second.cotizacionMultiVehiculo).toBeDefined();
    expect(
      (second.cotizacionMultiVehiculo as { totalCombinadoMx: number }).totalCombinadoMx,
    ).toBe(33000);
  });

  it('patchBatchOutputs actualiza todas las salidas express del batch', () => {
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

    const parsedFirst = JSON.parse(batch[0]!.output) as {
      cotizacionMultiVehiculo?: { totalCombinadoMx: number };
    };
    expect(parsedFirst.cotizacionMultiVehiculo?.totalCombinadoMx).toBe(30000);
  });
});
