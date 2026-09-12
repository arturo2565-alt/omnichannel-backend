import { createMatrixPricingSnapshot } from './matrix-pricing-snapshot';
import {
  BANIO_SERVICE_IDENTITIES,
  assessBanioServiceReadiness,
  ensureBanioIntegralSlots,
  isBanioProductCode,
  lookupBanioCatalogBase,
  normalizeBanioProductCode,
} from './banio-service-identity';
import { commercialAmountMeaning } from '../chat/unconfigured-price';

function snap(rows: Array<{ servicio: string; precio: number }>) {
  return createMatrixPricingSnapshot(
    rows.map((r, i) => ({
      id: `r${i}`,
      servicio: r.servicio,
      severidad: 'BASE',
      precio: r.precio,
      diasEntrega: 5,
      isInstantService: true,
    })),
  );
}

describe('BPE / BPEI / BPCC identidades independientes', () => {
  it('BPE tiene identidad independiente', () => {
    expect(isBanioProductCode('BPE')).toBe(true);
    expect(BANIO_SERVICE_IDENTITIES.find((i) => i.code === 'BPE')?.catalogName).toBe(
      'Baño de Pintura Exterior',
    );
  });

  it('BPEI tiene identidad independiente', () => {
    expect(normalizeBanioProductCode('BPEI')).toBe('BPEI');
    expect(BANIO_SERVICE_IDENTITIES.find((i) => i.code === 'BPEI')?.catalogName).toBe(
      'Baño de Pintura Exterior e Interiores',
    );
  });

  it('BPCC tiene identidad independiente', () => {
    expect(normalizeBanioProductCode('BPCC')).toBe('BPCC');
    expect(BANIO_SERVICE_IDENTITIES.find((i) => i.code === 'BPCC')?.catalogName).toBe(
      'Baño de Pintura con Cambio de Color',
    );
  });

  it('BPEI sin precio no se convierte silenciosamente en BPE', () => {
    const s = snap([{ servicio: 'Baño de Pintura Exterior', precio: 20000 }]);
    const bpei = lookupBanioCatalogBase(s, 'BPEI');
    const bpe = lookupBanioCatalogBase(s, 'BPE');
    expect(bpe.status).toBe('READY');
    expect(bpei.status).toBe('UNCONFIGURED');
    expect(bpei.catalogName).not.toBe(bpe.catalogName);
    expect(bpei.basePrice).toBe(0);
  });

  it('BPCC sin precio no se convierte silenciosamente en BPE', () => {
    const s = snap([{ servicio: 'Baño de Pintura Exterior', precio: 20000 }]);
    const bpcc = lookupBanioCatalogBase(s, 'BPCC');
    expect(bpcc.status).toBe('UNCONFIGURED');
    expect(bpcc.catalogName).toBe('Baño de Pintura con Cambio de Color');
  });

  it('$0 de servicio integral unconfigured no significa gratis', () => {
    expect(commercialAmountMeaning(0, 'UNCONFIGURED')).toBe('unconfigured');
    expect(commercialAmountMeaning(20000, 'AUTOFIX_CATALOG')).toBe('configured');
  });

  it('ensureBanioIntegralSlots expone los tres aunque falten en BD', () => {
    const slots = ensureBanioIntegralSlots([
      {
        servicio: 'Baño de Pintura Exterior',
        basePrice: 20000,
        diasEntrega: 5,
        matrixRowId: '1',
        configStatus: 'READY',
      },
    ]);
    expect(slots.map((s) => s.banioCode).sort()).toEqual(
      ['BPE', 'BPEI', 'BPCC'].sort(),
    );
    expect(slots.find((s) => s.banioCode === 'BPEI')?.configStatus).toBe(
      'UNCONFIGURED',
    );
  });

  it('readiness reporta READY/UNCONFIGURED si falta fila', () => {
    const s = snap([{ servicio: 'Baño de Pintura Exterior', precio: 28000 }]);
    const rows = assessBanioServiceReadiness(s);
    expect(rows.find((r) => r.code === 'BPE')?.status).toBe('READY');
    expect(rows.find((r) => r.code === 'BPEI')?.status).toBe('UNCONFIGURED');
    expect(rows.find((r) => r.code === 'BPCC')?.status).toBe('UNCONFIGURED');
  });
});
