import { RefaccionCategoria } from './entities/refaccion-catalog.entity';

export type RefaccionSeedRow = {
  codigo: string;
  nombre: string;
  categoria: RefaccionCategoria;
  costoReferenciaBase: number;
  margenPorcentaje: number;
};

/** Semilla inicial de ópticas y plásticos frecuentes (MXN). */
export const REFACCION_CATALOG_DEFAULTS: readonly RefaccionSeedRow[] = [
  {
    codigo: 'FARO_IZQ',
    nombre: 'Faro Principal Delantero Izquierdo',
    categoria: RefaccionCategoria.OPTICA,
    costoReferenciaBase: 3800,
    margenPorcentaje: 30,
  },
  {
    codigo: 'FARO_DER',
    nombre: 'Faro Principal Delantero Derecho',
    categoria: RefaccionCategoria.OPTICA,
    costoReferenciaBase: 3800,
    margenPorcentaje: 30,
  },
  {
    codigo: 'CAL_IZQ',
    nombre: 'Calavera Trasera Izquierda',
    categoria: RefaccionCategoria.OPTICA,
    costoReferenciaBase: 2200,
    margenPorcentaje: 30,
  },
  {
    codigo: 'CAL_DER',
    nombre: 'Calavera Trasera Derecha',
    categoria: RefaccionCategoria.OPTICA,
    costoReferenciaBase: 2200,
    margenPorcentaje: 30,
  },
  {
    codigo: 'FARO_NIEBLA_IZQ',
    nombre: 'Faro de Niebla Izquierdo',
    categoria: RefaccionCategoria.ILUMINACION,
    costoReferenciaBase: 1400,
    margenPorcentaje: 30,
  },
  {
    codigo: 'FARO_NIEBLA_DER',
    nombre: 'Faro de Niebla Derecho',
    categoria: RefaccionCategoria.ILUMINACION,
    costoReferenciaBase: 1400,
    margenPorcentaje: 30,
  },
  {
    codigo: 'MOLD_FD',
    nombre: 'Moldura Fascia Delantera',
    categoria: RefaccionCategoria.PLASTICO,
    costoReferenciaBase: 850,
    margenPorcentaje: 30,
  },
  {
    codigo: 'GUIA_FD',
    nombre: 'Guía Fascia Delantera',
    categoria: RefaccionCategoria.PLASTICO,
    costoReferenciaBase: 650,
    margenPorcentaje: 30,
  },
];
