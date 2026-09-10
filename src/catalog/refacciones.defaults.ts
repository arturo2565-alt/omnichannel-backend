import { RefaccionCategoria } from './entities/refaccion-catalog.entity';

export type RefaccionSeedRow = {
  codigo: string;
  nombre: string;
  categoria: RefaccionCategoria;
  costoReferenciaBase: number;
  margenPorcentaje: number;
  forzarPrecioManual: boolean;
};

/** Plantillas de códigos (sin precio de mercado). El peritaje no las usa salvo forzarPrecioManual. */
export const REFACCION_CATALOG_DEFAULTS: readonly RefaccionSeedRow[] = [
  {
    codigo: 'FARO_IZQ',
    nombre: 'Faro Principal Delantero Izquierdo',
    categoria: RefaccionCategoria.OPTICA,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
    forzarPrecioManual: false,
  },
  {
    codigo: 'FARO_DER',
    nombre: 'Faro Principal Delantero Derecho',
    categoria: RefaccionCategoria.OPTICA,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
    forzarPrecioManual: false,
  },
  {
    codigo: 'CAL_IZQ',
    nombre: 'Calavera Trasera Izquierda',
    categoria: RefaccionCategoria.OPTICA,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
    forzarPrecioManual: false,
  },
  {
    codigo: 'CAL_DER',
    nombre: 'Calavera Trasera Derecha',
    categoria: RefaccionCategoria.OPTICA,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
    forzarPrecioManual: false,
  },
  {
    codigo: 'FARO_NIEBLA_IZQ',
    nombre: 'Faro de Niebla Izquierdo',
    categoria: RefaccionCategoria.ILUMINACION,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
    forzarPrecioManual: false,
  },
  {
    codigo: 'FARO_NIEBLA_DER',
    nombre: 'Faro de Niebla Derecho',
    categoria: RefaccionCategoria.ILUMINACION,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
    forzarPrecioManual: false,
  },
  {
    codigo: 'MOLD_FD',
    nombre: 'Moldura Fascia Delantera',
    categoria: RefaccionCategoria.PLASTICO,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
    forzarPrecioManual: false,
  },
  {
    codigo: 'GUIA_FD',
    nombre: 'Guía Fascia Delantera',
    categoria: RefaccionCategoria.PLASTICO,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
    forzarPrecioManual: false,
  },
];
