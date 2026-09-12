import {
  parseVisionDamageItems,
  tratamientoFromVisionFields,
} from './vision-item-normalize';
import {
  inferTreatmentDecision,
  looksLikeReplacementCue,
} from './piece-treatment';
import {
  inventoryItemsToVehicleAnalysis,
  mergeVisionIntoPriorInventory,
} from './quote-cart-analysis';
import { resolveMarketVehicleText } from './vision-bpc-inventory';
import { parseVehiclePartIdentity } from './refaccion-market/parse-vehicle-part-identity';

describe('visión → tratamiento canónico', () => {
  it('SUSTITUCION + requiere_refaccion=true → SUSTITUIR', () => {
    const mapped = tratamientoFromVisionFields({
      tipo_dano: 'SUSTITUCION',
      requiere_refaccion: true,
      posible_reemplazo_refaccion: true,
    });
    expect(mapped.tratamiento).toBe('SUSTITUIR');
    expect(mapped.posibleReemplazoRefaccion).toBe(true);
  });

  it('REPARACION + requiere_refaccion=false + posible_reemplazo → REPARAR', () => {
    const mapped = tratamientoFromVisionFields({
      tipo_dano: 'REPARACION',
      requiere_refaccion: false,
      posible_reemplazo_refaccion: true,
    });
    expect(mapped.tratamiento).toBe('REPARAR');
    expect(mapped.posibleReemplazoRefaccion).toBe(true);
  });

  it('campos principales contradictorios → INCIERTO', () => {
    expect(
      tratamientoFromVisionFields({
        tipo_dano: 'SUSTITUCION',
        requiere_refaccion: false,
      }).tratamiento,
    ).toBe('INCIERTO');
    expect(
      tratamientoFromVisionFields({
        tipo_dano: 'REPARACION',
        requiere_refaccion: true,
      }).tratamiento,
    ).toBe('INCIERTO');
  });

  it('posible_reemplazo no dispara SUSTITUIR por regex', () => {
    expect(
      looksLikeReplacementCue('DMFuerte', 'posible reemplazo de refacción'),
    ).toBe(false);
    expect(
      inferTreatmentDecision({
        pieza: 'Cofre',
        severidad: 'DMFuerte',
        descripcionTecnica: 'posible reemplazo de refacción',
        urls_origen: [],
        tratamiento: 'REPARAR',
        posibleReemplazoRefaccion: true,
      }),
    ).toBe('REPARAR');
  });

  it('parser persiste tratamiento y no descarta campos de visión', () => {
    const items = parseVisionDamageItems({
      vehiculo_detectado: 'Mazda 3 2020',
      items: [
        {
          pieza: 'FD',
          severidad: 'DMFuerte',
          descripcionTecnica: 'Fascia colapsada',
          tipo_dano: 'SUSTITUCION',
          requiere_refaccion: true,
          posible_reemplazo_refaccion: true,
          urls_origen: ['https://cdn.example/fd.jpg'],
        },
        {
          pieza: 'Cofre',
          severidad: 'DMFuerte',
          descripcionTecnica: 'Abolladura con posible reemplazo de refacción',
          tipo_dano: 'REPARACION',
          requiere_refaccion: false,
          posible_reemplazo_refaccion: true,
          urls_origen: ['https://cdn.example/cofre.jpg'],
        },
      ],
    });
    expect(items).toHaveLength(2);
    expect(items[0]?.tratamiento).toBe('SUSTITUIR');
    expect(items[1]?.tratamiento).toBe('REPARAR');
    expect(items[1]?.posibleReemplazoRefaccion).toBe(true);
  });

  it('tratamiento y vehiculo_detectado sobreviven analysis + merge', () => {
    const items = parseVisionDamageItems({
      items: [
        {
          pieza: 'FD',
          severidad: 'DMFuerte',
          descripcionTecnica: 'Fascia',
          tipo_dano: 'SUSTITUCION',
          requiere_refaccion: true,
        },
      ],
    });
    const merged = mergeVisionIntoPriorInventory([], items);
    expect(merged.mergedInventory[0]?.tratamiento).toBe('SUSTITUIR');
    const analysis = inventoryItemsToVehicleAnalysis(
      merged.mergedInventory,
      [],
      'Mazda 3 2020',
    );
    expect(analysis.vehiculoDetectado).toBe('Mazda 3 2020');
    expect(analysis.inventory?.[0]?.tratamiento).toBe('SUSTITUIR');
    const identity = parseVehiclePartIdentity({
      vehiculoText: resolveMarketVehicleText(analysis),
      pieza: 'FD',
    });
    expect(identity).toMatchObject({
      marca: 'Mazda',
      modelo: '3',
      anio: '2020',
      pieza: 'FD',
      confirmed: true,
    });
  });

  it('el parser no inventa urls_origen: deja vacío lo que Vision omitió', () => {
    const photo = 'https://cdn.example/lado-derecho.jpg';
    const items = parseVisionDamageItems({
      items: [
        {
          pieza: 'PTD',
          severidad: 'DM',
          descripcionTecnica: 'Puerta',
          tipo_dano: 'REPARACION',
          requiere_refaccion: false,
          urls_origen: [photo],
        },
        {
          pieza: 'STD',
          severidad: 'DM',
          descripcionTecnica: 'Salpicadera',
          tipo_dano: 'REPARACION',
          requiere_refaccion: false,
          urls_origen: [],
        },
      ],
    });
    expect(items.map((it) => it.pieza)).toEqual(['PTD', 'STD']);
    expect(items[0]?.urls_origen).toEqual([photo]);
    expect(items[1]?.urls_origen).toEqual([]);
  });
});
