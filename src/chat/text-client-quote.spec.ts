import {
  detectTextClientQuoteIntent,
  extractClientQuotePiecesHeuristic,
  resolveExtractedPiecesAgainstCatalog,
} from './text-client-quote';
import { createMatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';

describe('text-client-quote', () => {
  const snap = createMatrixPricingSnapshot([
    { servicio: 'Fascia', severidad: 'DL', precio: 3500, diasEntrega: 3, isInstantService: true },
    { servicio: 'Fascia', severidad: 'DM', precio: 5200, diasEntrega: 4, isInstantService: false },
    { servicio: 'Puerta', severidad: 'DL', precio: 4200, diasEntrega: 3, isInstantService: true },
    { servicio: 'Toldo', severidad: 'DL', precio: 6800, diasEntrega: 5, isInstantService: false },
  ]);

  it('detecta intención de agregar pieza por texto', () => {
    expect(
      detectTextClientQuoteIntent(
        'También quiero pintar la fascia trasera, solo está rayada',
      ),
    ).toBe(true);
    expect(
      detectTextClientQuoteIntent('cuánto por pintar cofre y toldo'),
    ).toBe(true);
  });

  it('extrae FT con severidad DL desde texto de rayón', () => {
    const pieces = extractClientQuotePiecesHeuristic(
      'También quiero pintar la fascia trasera, solo está rayada',
    );
    expect(pieces.length).toBeGreaterThanOrEqual(1);
    expect(pieces.some((p) => p.panelCode === 'FT')).toBe(true);
    const ft = pieces.find((p) => p.panelCode === 'FT');
    expect(ft?.severidadHint).toBe('DL');
  });

  it('resuelve precio oficial del catálogo sin inventar', () => {
    const pieces = extractClientQuotePiecesHeuristic(
      'incluye la puerta delantera derecha',
    );
    const { resolved } = resolveExtractedPiecesAgainstCatalog(pieces, snap);
    const pdd = resolved.find((r) => r.panelCode === 'PDD');
    expect(pdd?.catalogServicio).toBe('Puerta');
    expect(pdd?.precioOficial).toBe(4200);
    expect(pdd?.precioFinal).toBe(4200);
    expect(pdd?.fuente).toBe('texto_cliente');
    expect(pdd?.evidencia).toContain('sin foto');
  });

  it('marca requiere revisión manual si no hay precio en catálogo', () => {
    const { resolved } = resolveExtractedPiecesAgainstCatalog(
      [
        {
          textoOriginal: 'pieza rara xyz',
          panelCode: 'PiezaInexistente',
          confidence: 0.5,
        },
      ],
      snap,
    );
    expect(resolved[0]?.estadoRevision).toBe('requiere_revision_manual');
    expect(resolved[0]?.precioFinal).toBe(0);
  });
});
