import { VEHICLE_CATALOG, presentVehicle } from './vehicle-presentation';

describe('presentación de marca', () => {
  it('documenta fuente y ambigüedad en cada correspondencia', () => {
    expect(VEHICLE_CATALOG.length).toBeGreaterThan(0);
    for (const entry of VEHICLE_CATALOG) {
      expect(entry.ambiguity.trim().length).toBeGreaterThan(0);
      expect(entry.spans.length).toBeGreaterThan(0);
      for (const span of entry.spans) {
        expect(span.source.trim().length).toBeGreaterThan(0);
        expect(span.to).toBeGreaterThanOrEqual(span.from);
      }
    }
  });

  it('infiere Aveo 2026, Prius 2022, CR-V, Explorer y Charger 2022', () => {
    expect(presentVehicle({ model: 'Aveo', year: 2026 })).toMatchObject({
      make: 'Chevrolet',
      provenance: 'catalog_inferred',
      label: 'Chevrolet Aveo 2026',
    });
    expect(presentVehicle({ model: 'Prius', year: 2022 })).toMatchObject({
      make: 'Toyota',
      provenance: 'catalog_inferred',
      label: 'Toyota Prius 2022',
    });
    expect(presentVehicle({ model: 'CR-V' })).toMatchObject({
      make: 'Honda',
      provenance: 'catalog_inferred',
      label: 'Honda CR-V',
    });
    expect(presentVehicle({ model: 'Explorer' })).toMatchObject({
      make: 'Ford',
      provenance: 'catalog_inferred',
      label: 'Ford Explorer',
    });
    expect(presentVehicle({ model: 'Charger', year: 2022 })).toMatchObject({
      make: 'Dodge',
      provenance: 'catalog_inferred',
      label: 'Dodge Charger 2022',
    });
  });

  it('acepta alias explícitos y rechaza la ortografía aproximada', () => {
    expect(presentVehicle({ model: 'CRV', year: 2010 }).make).toBe('Honda');
    expect(presentVehicle({ model: 'CR V', year: 2010 }).make).toBe('Honda');
    expect(presentVehicle({ model: 'cr-v', year: 2010 }).label).toBe('Honda cr-v 2010');
    expect(presentVehicle({ model: 'Abeo', year: 2026 }).provenance).toBe('unknown');
    expect(presentVehicle({ model: 'Priuss', year: 2022 }).provenance).toBe('unknown');
    expect(presentVehicle({ model: 'Explorador' }).provenance).toBe('unknown');
    expect(presentVehicle({ model: 'CR-Z', year: 2014 }).provenance).toBe('unknown');
  });

  it('mantiene desconocidos los modelos numéricos, ajenos y los homónimos sin contexto', () => {
    expect(presentVehicle({ model: '3', year: 2019 }).provenance).toBe('unknown');
    expect(presentVehicle({ model: '1500', year: 2020 }).provenance).toBe('unknown');
    expect(presentVehicle({ model: 'Sedán', year: 2019 })).toMatchObject({
      make: null,
      provenance: 'unknown',
      label: 'Sedán 2019',
    });
    expect(presentVehicle({ model: 'Aveo' }).make).toBe('Chevrolet');
    expect(presentVehicle({ model: 'Charger' })).toMatchObject({ make: null, provenance: 'unknown' });
    expect(presentVehicle({ model: 'Charger', year: 1975 })).toMatchObject({ make: null, provenance: 'unknown' });
    expect(presentVehicle({ model: 'Charger', year: 1975, market: 'US' }).make).toBe('Dodge');
    expect(presentVehicle({ model: 'Charger', year: 1975, market: 'AU' }).make).toBe('Chrysler');
    expect(presentVehicle({ model: 'Charger', year: 1975, market: 'MX' }).provenance).toBe('unknown');
    expect(presentVehicle({ model: 'Aveo', year: 1990 }).provenance).toBe('unknown');
  });

  it('conserva la marca declarada y no muta el origen', () => {
    const input = { make: 'Nissan', model: 'Aveo', year: 2026, market: null };
    expect(presentVehicle(input)).toEqual({
      make: 'Nissan',
      provenance: 'customer_provided',
      label: 'Nissan Aveo 2026',
    });
    expect(input).toEqual({ make: 'Nissan', model: 'Aveo', year: 2026, market: null });
    expect(presentVehicle({ make: 'Honda', model: 'CR-V', year: 2010 })).toMatchObject({
      make: 'Honda',
      provenance: 'customer_provided',
    });
  });

  it('no inventa modelo, año, versión, color ni mercado', () => {
    const result = presentVehicle({ model: 'Prius' });
    expect(result).toEqual({
      make: 'Toyota',
      provenance: 'catalog_inferred',
      label: 'Toyota Prius',
    });
    expect(result).not.toHaveProperty('model');
    expect(result).not.toHaveProperty('year');
    expect(result).not.toHaveProperty('variant');
    expect(result).not.toHaveProperty('color');
    expect(result).not.toHaveProperty('market');
    expect(presentVehicle({}).label).toBe('');
  });
});
