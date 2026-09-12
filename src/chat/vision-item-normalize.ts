import type { DetectedDamageItem } from './entities/chat.entity';
import {
  deriveStableVehicleId,
  parseTreatmentDecision,
  type TreatmentDecision,
} from './piece-treatment';

function asBool(raw: unknown): boolean | undefined {
  if (raw === true || raw === 1) return true;
  if (raw === false || raw === 0) return false;
  if (typeof raw === 'string') {
    const s = raw
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();
    if (['true', '1', 'si', 'yes'].includes(s)) return true;
    if (['false', '0', 'no'].includes(s)) return false;
  }
  return undefined;
}

function parseTipoDano(
  raw: unknown,
): 'SUSTITUCION' | 'REPARACION' | undefined {
  const t = String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
  if (
    t === 'SUSTITUCION' ||
    t === 'SUSTITUIR' ||
    t === 'REEMPLAZO' ||
    t === 'REPLACE' ||
    t === 'SUBSTITUTION'
  ) {
    return 'SUSTITUCION';
  }
  if (t === 'REPARACION' || t === 'REPARAR' || t === 'REPAIR') {
    return 'REPARACION';
  }
  return undefined;
}

export type VisionTreatmentMap = {
  tratamiento?: TreatmentDecision;
  posibleReemplazoRefaccion: boolean;
  hasStructuredDecision: boolean;
};

/**
 * Convierte campos de visión (tipo_dano / requiere_refaccion) al tratamiento canónico.
 * `posible_reemplazo_refaccion` nunca cambia el tratamiento.
 */
export function tratamientoFromVisionFields(
  raw: Record<string, unknown>,
): VisionTreatmentMap {
  const tipo = parseTipoDano(raw['tipo_dano'] ?? raw['tipoDano']);
  const requiere = asBool(
    raw['requiere_refaccion'] ?? raw['requiereRefaccion'],
  );
  const posible =
    asBool(
      raw['posible_reemplazo_refaccion'] ?? raw['posibleReemplazoRefaccion'],
    ) === true;
  const explicit = parseTreatmentDecision(
    raw['tratamiento'] ?? raw['treatment'],
  );

  let tratamiento: TreatmentDecision | undefined;
  let hasStructuredDecision = false;

  if (tipo != null && requiere != null) {
    hasStructuredDecision = true;
    if (tipo === 'SUSTITUCION' && requiere === true) {
      tratamiento = 'SUSTITUIR';
    } else if (tipo === 'REPARACION' && requiere === false) {
      tratamiento = 'REPARAR';
    } else {
      tratamiento = 'INCIERTO';
    }
  } else if (tipo != null) {
    hasStructuredDecision = true;
    tratamiento = tipo === 'SUSTITUCION' ? 'SUSTITUIR' : 'REPARAR';
  } else if (explicit) {
    hasStructuredDecision = true;
    tratamiento = explicit;
  }

  return {
    tratamiento,
    posibleReemplazoRefaccion: posible,
    hasStructuredDecision,
  };
}

export function normalizeVisionDamageItem(
  el: unknown,
): DetectedDamageItem | null {
  if (!el || typeof el !== 'object') return null;
  const r = el as Record<string, unknown>;
  const pieza = typeof r['pieza'] === 'string' ? r['pieza'].trim() : '';
  const severidad =
    typeof r['severidad'] === 'string' ? r['severidad'].trim() : '';
  if (!pieza || !severidad) return null;
  const descripcionTecnica =
    typeof r['descripcionTecnica'] === 'string'
      ? r['descripcionTecnica'].trim()
      : typeof r['descripcion'] === 'string'
        ? String(r['descripcion']).trim()
        : '';
  const u = Array.isArray(r['urls_origen'])
    ? r['urls_origen']
    : Array.isArray(r['urls_asociadas'])
      ? r['urls_asociadas']
      : [];
  const urls_origen = u.map((x) => String(x).trim()).filter(Boolean);
  const mapped = tratamientoFromVisionFields(r);
  const vehiculoDetectado =
    typeof r['vehiculoDetectado'] === 'string'
      ? r['vehiculoDetectado'].trim()
      : typeof r['vehiculo_detectado'] === 'string'
        ? r['vehiculo_detectado'].trim()
        : '';
  const hiddenRaw = r['possibleHiddenDamage'] ?? r['possible_hidden_damage'];
  const possibleHiddenDamage =
    hiddenRaw && typeof hiddenRaw === 'object'
      ? {
          detected: Boolean((hiddenRaw as { detected?: unknown }).detected),
          areas: Array.isArray((hiddenRaw as { areas?: unknown }).areas)
            ? ((hiddenRaw as { areas: unknown[] }).areas).map(String)
            : [],
          requiresDisassembly: Boolean(
            (hiddenRaw as { requiresDisassembly?: unknown }).requiresDisassembly,
          ),
        }
      : undefined;
  const vehicleId = deriveStableVehicleId({
    vehiculoDetectado: vehiculoDetectado || undefined,
  });
  return {
    pieza,
    severidad,
    descripcionTecnica:
      descripcionTecnica || 'Sin descripción técnica disponible.',
    urls_origen,
    ...(vehiculoDetectado ? { vehiculoDetectado } : {}),
    ...(vehicleId ? { vehicleId } : {}),
    ...(mapped.tratamiento
      ? {
          tratamiento: mapped.tratamiento,
          treatmentSource: 'vision' as const,
          treatmentReason: 'vision_structured',
        }
      : {
          treatmentSource: 'vision' as const,
          treatmentReason: 'missing_structured_treatment',
        }),
    ...(mapped.posibleReemplazoRefaccion
      ? { posibleReemplazoRefaccion: true }
      : {}),
    ...(possibleHiddenDamage ? { possibleHiddenDamage } : {}),
  };
}

function uniqueTrimmedUrls(urls: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (urls ?? []).map((u) => String(u ?? '').trim()).filter(Boolean),
    ),
  ];
}

/**
 * Una misma URL puede evidenciar varios DamageItems.
 * No consume ni mueve la evidencia del primer ítem: la copia (unión)
 * cuando hay exactamente una foto atribuible en el lote.
 */
export function shareSinglePhotoEvidenceAcrossDamages(
  items: readonly DetectedDamageItem[],
  sessionUrls: readonly string[] = [],
): DetectedDamageItem[] {
  if (!items.length) return [];
  const present = uniqueTrimmedUrls(items.flatMap((it) => it.urls_origen ?? []));
  const session = uniqueTrimmedUrls(sessionUrls);
  const shared =
    present.length === 1
      ? present[0]
      : present.length === 0 && session.length === 1
        ? session[0]
        : undefined;
  if (!shared) {
    return items.map((it) => ({
      ...it,
      urls_origen: uniqueTrimmedUrls(it.urls_origen),
    }));
  }
  return items.map((it) => {
    const urls = uniqueTrimmedUrls(it.urls_origen);
    if (urls.includes(shared)) return { ...it, urls_origen: urls };
    if (urls.length === 0) return { ...it, urls_origen: [shared] };
    return { ...it, urls_origen: urls };
  });
}

export function parseVisionDamageItems(raw: unknown): DetectedDamageItem[] {
  const o =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const direct = Array.isArray(raw) ? raw : null;
  const arr =
    (Array.isArray(o['items']) ? o['items'] : null) ??
    (Array.isArray(o['detectedDamages']) ? o['detectedDamages'] : null) ??
    (Array.isArray(o['resultado']) ? o['resultado'] : null) ??
    direct;
  if (!Array.isArray(arr)) return [];
  const out: DetectedDamageItem[] = [];
  for (const el of arr) {
    const item = normalizeVisionDamageItem(el);
    if (item) out.push(item);
  }
  return shareSinglePhotoEvidenceAcrossDamages(out);
}
