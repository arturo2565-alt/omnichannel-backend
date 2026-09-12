import { canonicalizePanelCode, findPanelPiezaOption } from '../../catalog/panel-pieza-catalog';
import { refaccionCatalogCodigoForPieza } from '../../catalog/panel-pieza-catalog';
import { coerceDamageLevelCode } from '../../chat/autofix-config';
import { parseStructuredTreatment } from '../../domain/peritaje-v1';
import type { DetectedDamageItem } from '../../chat/entities/chat.entity';

export type VisionContractViolation =
  | 'INVALID_JSON'
  | 'UNKNOWN_PIECE_CODE'
  | 'INVALID_SEVERITY'
  | 'MISSING_TREATMENT'
  | 'INVALID_TREATMENT'
  | 'UNKNOWN_INPUT_URL'
  | 'INVALID_HIDDEN_DAMAGE';

const MODERN_SEVERITIES = new Set([
  'DL',
  'DM',
  'DF',
  'DMFuerte',
  'N/A',
  'Chico',
  'Mediano',
  'Grande',
  'XL',
  'Compacto',
]);

function isKnownPiece(raw: string): boolean {
  const t = String(raw ?? '').trim();
  if (!t) return false;
  if (findPanelPiezaOption(t)) return true;
  const code = canonicalizePanelCode(t);
  if (findPanelPiezaOption(code)) return true;
  return refaccionCatalogCodigoForPieza(t) != null;
}

function severityLooksValid(raw: string): boolean {
  const t = String(raw ?? '').trim();
  if (!t) return false;
  if (MODERN_SEVERITIES.has(t)) return true;
  const coerced = coerceDamageLevelCode(t);
  return coerced === t || MODERN_SEVERITIES.has(coerced);
}

export function validateVisionContract(input: {
  parseError?: boolean;
  items: readonly DetectedDamageItem[];
  inputUrls?: readonly string[];
}): VisionContractViolation[] {
  if (input.parseError) return ['INVALID_JSON'];
  const violations = new Set<VisionContractViolation>();
  const allowedUrls = new Set(
    (input.inputUrls ?? []).map((u) => String(u).trim()).filter(Boolean),
  );

  for (const it of input.items) {
    if (!isKnownPiece(it.pieza)) violations.add('UNKNOWN_PIECE_CODE');
    if (!severityLooksValid(it.severidad)) violations.add('INVALID_SEVERITY');
    const rawTreatment = it.tratamiento;
    if (!rawTreatment) violations.add('MISSING_TREATMENT');
    else if (!parseStructuredTreatment(rawTreatment)) {
      violations.add('INVALID_TREATMENT');
    }
    if (allowedUrls.size) {
      for (const u of it.urls_origen ?? []) {
        if (u && !allowedUrls.has(String(u).trim())) {
          violations.add('UNKNOWN_INPUT_URL');
        }
      }
    }
    if (it.possibleHiddenDamage) {
      const h = it.possibleHiddenDamage;
      if (typeof h.detected !== 'boolean' || !Array.isArray(h.areas)) {
        violations.add('INVALID_HIDDEN_DAMAGE');
      }
    }
  }
  return [...violations];
}
