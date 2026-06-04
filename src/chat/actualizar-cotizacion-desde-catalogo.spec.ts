import {
  parseActualizarCotizacionToolArgs,
  resolveCatalogItemToQuoteLine,
} from './actualizar-cotizacion-desde-catalogo';
import { createMatrixPricingSnapshot } from '../catalog/matrix-pricing-snapshot';

describe('actualizar-cotizacion-desde-catalogo', () => {
  const snap = createMatrixPricingSnapshot([
    { servicio: 'Fascia', severidad: 'DL', precio: 3500, diasEntrega: 3, isInstantService: true },
    { servicio: 'Puerta', severidad: 'DM', precio: 5500, diasEntrega: 4, isInstantService: false },
  ]);

  it('parsea argumentos de herramienta', () => {
    const parsed = parseActualizarCotizacionToolArgs(
      JSON.stringify({
        customerText: 'también la puerta',
        items: [
          {
            partName: 'fascia trasera',
            action: 'pintar',
            severityHint: 'unknown',
            source: 'texto_cliente',
          },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.items[0]?.partName).toBe('fascia trasera');
    }
  });

  it('resuelve FT con precio de catálogo', () => {
    const line = resolveCatalogItemToQuoteLine(
      {
        partName: 'fascia trasera',
        action: 'pintar',
        damageDescription: 'solo rayada',
        severityHint: 'unknown',
        serviceCodeHint: 'FT',
        source: 'texto_cliente',
      },
      snap,
      [],
    );
    expect(line.panelCode).toBe('FT');
    expect(line.precioOficial).toBe(3500);
    expect(line.precioFinal).toBe(3500);
    expect(line.fuente).toBe('texto_cliente');
  });

  it('marca pendiente si no hay precio en catálogo', () => {
    const line = resolveCatalogItemToQuoteLine(
      {
        partName: 'pieza desconocida xyz',
        action: 'otro',
        source: 'ai_suggestion',
      },
      snap,
      [],
    );
    expect(line.estadoRevision).toBe('requiere_revision_manual');
    expect(line.precioFinal).toBe(0);
  });
});
