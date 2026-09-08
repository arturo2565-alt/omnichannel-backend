export const VISION_MOTIVOS_INVIABLE = [
  'FOTO_BORROSA',
  'TOMA_DEMASIADO_CERRADA',
  'NO_ES_AUTO',
  'SIN_DANOS_EVIDENTES',
] as const;

export type VisionMotivoInviable = (typeof VISION_MOTIVOS_INVIABLE)[number];

export type VisionViability = {
  peritajeViable: boolean;
  motivoInviable?: VisionMotivoInviable;
  mensajeClienteAclaracion?: string;
};

const DEFAULT_ACLARACION: Record<VisionMotivoInviable, string> = {
  FOTO_BORROSA:
    'La foto se ve un poco borrosa. ¿Me puedes enviar otra más nítida, de un poco más lejos, para cotizarte bien?',
  TOMA_DEMASIADO_CERRADA:
    'Esta toma está muy cerrada. ¿Puedes mandarme una foto más abierta donde se vea la pieza completa?',
  NO_ES_AUTO:
    'No logro identificar un vehículo en esa imagen. Cuando puedas, mándame fotos del auto y del daño.',
  SIN_DANOS_EVIDENTES:
    'En estas fotos no alcanzo a ver un daño claro. ¿Me mandas otra toma del golpe o de la zona que quieres cotizar?',
};

const GENERIC_ACLARACION =
  'No pude valuarte con esas fotos. ¿Me envías otras más nítidas, de un poco más lejos, donde se vea bien el daño?';

function coerceMotivoInviable(raw: unknown): VisionMotivoInviable | undefined {
  const s = String(raw ?? '')
    .toUpperCase()
    .replace(/\s+/g, '_')
    .trim();
  if ((VISION_MOTIVOS_INVIABLE as readonly string[]).includes(s)) {
    return s as VisionMotivoInviable;
  }
  if (/borros|blur/i.test(s)) return 'FOTO_BORROSA';
  if (/cerrad|close.?up|macro/i.test(s)) return 'TOMA_DEMASIADO_CERRADA';
  if (/no.?es.?auto|no.?vehiculo|not.?a.?car/i.test(s)) return 'NO_ES_AUTO';
  if (/sin.?dano|no.?dano|sin.?golpe/i.test(s)) return 'SIN_DANOS_EVIDENTES';
  return undefined;
}

function readBool(raw: unknown): boolean | null {
  if (raw === true || raw === 1 || raw === '1') return true;
  if (raw === false || raw === 0 || raw === '0') return false;
  if (typeof raw === 'string') {
    const k = raw.trim().toLowerCase();
    if (k === 'true' || k === 'si' || k === 'sí' || k === 'yes') return true;
    if (k === 'false' || k === 'no') return false;
  }
  return null;
}

export function extractVisionViability(root: unknown): VisionViability {
  if (!root || typeof root !== 'object') {
    return { peritajeViable: true };
  }
  const o = root as Record<string, unknown>;
  const explicit = readBool(
    o.peritaje_viable ?? o.peritajeViable ?? o.viable,
  );
  const motivo = coerceMotivoInviable(
    o.motivo_inviable ?? o.motivoInviable ?? o.motivo,
  );
  const msg = String(
    o.mensaje_cliente_aclaracion ??
      o.mensajeClienteAclaracion ??
      o.aclaracion ??
      '',
  ).trim();

  const peritajeViable = explicit == null ? true : explicit;
  if (peritajeViable) {
    return { peritajeViable: true };
  }
  return {
    peritajeViable: false,
    ...(motivo ? { motivoInviable: motivo } : {}),
    mensajeClienteAclaracion:
      msg || (motivo ? DEFAULT_ACLARACION[motivo] : GENERIC_ACLARACION),
  };
}

export function resolveClienteAclaracion(viability: VisionViability): string {
  const custom = String(viability.mensajeClienteAclaracion ?? '').trim();
  if (custom) return custom;
  if (viability.motivoInviable) {
    return DEFAULT_ACLARACION[viability.motivoInviable];
  }
  return GENERIC_ACLARACION;
}

/** Combina lotes: si alguno es viable con ítems, el consolidado es viable. */
export function mergeVisionViability(
  parts: readonly { viability: VisionViability; itemCount: number }[],
): VisionViability {
  if (!parts.length) {
    return {
      peritajeViable: false,
      motivoInviable: 'SIN_DANOS_EVIDENTES',
      mensajeClienteAclaracion: GENERIC_ACLARACION,
    };
  }
  const withItems = parts.filter((p) => p.itemCount > 0 && p.viability.peritajeViable);
  if (withItems.length > 0) {
    return { peritajeViable: true };
  }
  const inviable = parts.find((p) => !p.viability.peritajeViable) ?? parts[0]!;
  return {
    peritajeViable: false,
    motivoInviable: inviable.viability.motivoInviable,
    mensajeClienteAclaracion: resolveClienteAclaracion(inviable.viability),
  };
}
