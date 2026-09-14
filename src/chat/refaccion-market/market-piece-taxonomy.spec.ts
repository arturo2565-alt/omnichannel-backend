import { parseMarketSide } from './market-side';
import {
  listingMentionsPieceFamily,
  resolveMarketPieceTaxonomy,
} from './market-piece-taxonomy';
import { buildMarketSearchQueryPlan } from './market-search-queries';
import { parseVehiclePartIdentity } from './parse-vehicle-part-identity';
import { canonicalPhysicalPanelKey } from '../piece-treatment';

describe('taxonomía comercial de pieza (identidad ≠ búsqueda)', () => {
  it('Calavera_Izquierda: aliases comerciales, side LEFT, panel intacto', () => {
    const tax = resolveMarketPieceTaxonomy('Calavera_Izquierda');
    expect(tax.family).toBe('CALAVERA');
    expect(tax.canonicalLabel).toBe('Calavera izquierda');
    expect(tax.requiredSide).toBe('LEFT');
    expect(tax.searchAliases).toEqual(
      expect.arrayContaining([
        'calavera trasera izquierda',
        'calavera izquierda',
        'stop izquierdo',
        'stop trasero izquierdo',
        'lampara trasera izquierda',
      ]),
    );
    const panel = canonicalPhysicalPanelKey('Calavera_Izquierda');
    expect(panel).toBeTruthy();
    expect(canonicalPhysicalPanelKey('Calavera_Izquierda')).toBe(panel);
    expect(canonicalPhysicalPanelKey('stop izquierdo')).not.toBe(panel);
  });

  it('Calavera_Derecha: aliases equivalentes a la derecha', () => {
    const tax = resolveMarketPieceTaxonomy('Calavera_Derecha');
    expect(tax.family).toBe('CALAVERA');
    expect(tax.canonicalLabel).toBe('Calavera derecha');
    expect(tax.requiredSide).toBe('RIGHT');
    expect(tax.searchAliases).toEqual(
      expect.arrayContaining([
        'calavera trasera derecha',
        'calavera derecha',
        'stop derecho',
        'stop trasero derecho',
        'lampara trasera derecha',
      ]),
    );
    expect(canonicalPhysicalPanelKey('Calavera_Izquierda')).not.toBe(
      canonicalPhysicalPanelKey('Calavera_Derecha'),
    );
  });

  it('calavera == stop comercialmente', () => {
    const tax = resolveMarketPieceTaxonomy('Calavera_Izquierda');
    expect(
      listingMentionsPieceFamily('Stop trasero izq Nissan Altima', '', tax),
    ).toBe(true);
    expect(
      listingMentionsPieceFamily('Calavera izquierda Nissan Altima', '', tax),
    ).toBe(true);
    expect(
      listingMentionsPieceFamily('Lámpara trasera izquierda Nissan', '', tax),
    ).toBe(true);
    expect(
      listingMentionsPieceFamily('Cofre Nissan Altima 2014', '', tax),
    ).toBe(false);
  });
});

describe('parser determinista de side', () => {
  it('LEFT aliases', () => {
    for (const alias of [
      'izquierda',
      'izquierdo',
      'izq',
      'izq.',
      'left',
      'LH',
      'lado izquierdo',
    ]) {
      expect(parseMarketSide(alias)).toBe('LEFT');
    }
    expect(parseMarketSide('Stop trasero izq Nissan Altima')).toBe('LEFT');
  });

  it('RIGHT aliases', () => {
    for (const alias of [
      'derecha',
      'derecho',
      'der',
      'der.',
      'right',
      'RH',
      'lado derecho',
    ]) {
      expect(parseMarketSide(alias)).toBe('RIGHT');
    }
    expect(parseMarketSide('Stop trasero der Nissan Altima')).toBe('RIGHT');
  });

  it('sin side y ambos lados → null', () => {
    expect(parseMarketSide('Calavera Nissan Altima 2014')).toBeNull();
    expect(parseMarketSide('calavera izquierda y derecha')).toBeNull();
  });
});

describe('queries Altima 2014 — conjunto pequeño', () => {
  it('Calavera_Izquierda genera 4 queries controladas', () => {
    const identity = parseVehiclePartIdentity({
      vehiculoText: 'Nissan Altima 2014',
      pieza: 'Calavera_Izquierda',
    });
    const plan = buildMarketSearchQueryPlan(identity);
    expect(plan.queries).toHaveLength(4);
    expect(plan.googleQueries.length).toBeLessThanOrEqual(2);
    expect(plan.mlQueries.length).toBeLessThanOrEqual(2);
    expect(plan.queries).toEqual([
      'calavera trasera izquierda Nissan Altima 2014',
      'calavera izquierda Nissan Altima 2014',
      'stop izquierdo Nissan Altima 2014',
      'calavera izquierda Nissan Altima 2013 2014 2015',
    ]);
  });

  it('Calavera_Derecha espeja el conjunto', () => {
    const identity = parseVehiclePartIdentity({
      vehiculoText: 'Nissan Altima 2014',
      pieza: 'Calavera_Derecha',
    });
    const plan = buildMarketSearchQueryPlan(identity);
    expect(plan.queries).toEqual([
      'calavera trasera derecha Nissan Altima 2014',
      'calavera derecha Nissan Altima 2014',
      'stop derecho Nissan Altima 2014',
      'calavera derecha Nissan Altima 2013 2014 2015',
    ]);
  });
});
