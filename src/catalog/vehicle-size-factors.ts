/** Tamaño de carrocería. Módulo sin dependencias para que las constantes existan antes de chat o visión. */
export type VehicleSizeTier = 'Compacto' | 'Mediano' | 'Grande' | 'XL';

export const DEFAULT_PREMIUM_FACTOR = 1.1;

/**
 * Factor sobre precio base compacto estándar (DL legacy en matriz).
 * Ajustables cuando existan celdas `Tier|severidad` en catálogo.
 */
export const VEHICLE_SIZE_TIER_FACTORS: Readonly<
  Record<VehicleSizeTier, number>
> = {
  Compacto: 1,
  Mediano: 1.0344827586, // ~3000/2900
  Grande: 1.1724137931, // ~3400/2900
  XL: 1.275862069, // ~3700/2900 sin premium extra
};
