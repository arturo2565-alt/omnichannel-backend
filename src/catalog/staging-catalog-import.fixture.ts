import {
  APPROVED_CATALOG_KEYS,
  canonicalRowsJson,
  sha256,
  type CatalogCell,
} from './staging-catalog-import';

export function approvedPayload() {
  const cells: CatalogCell[] = APPROVED_CATALOG_KEYS.map(([pieza, severidad], index) => ({
    pieza,
    severidad,
    precio: index + 1,
    diasEntrega: 1,
    isInstantService: false,
  }));
  const rulesJson = JSON.stringify({
    sizeTierFactors: { Compacto: 1 },
    premiumFactor: 1.2,
    severityFactors: { LEVE: 1 },
    roundToMx: 50,
  });
  const manifestText = JSON.stringify({ rows: cells, rulesJson });
  return {
    manifestText,
    cells,
    rulesJson,
    locks: {
      rowsSha12: sha256(canonicalRowsJson(cells)).slice(0, 12),
      rulesSha12: sha256(rulesJson).slice(0, 12),
      manifestSha12: sha256(manifestText).slice(0, 12),
    },
  };
}
