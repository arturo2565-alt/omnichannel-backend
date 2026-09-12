import { RefaccionCategoria } from './entities/refaccion-catalog.entity';

export type RefaccionSeedRow = {
  codigo: string;
  nombre: string;
  categoria: RefaccionCategoria;
  costoReferenciaBase: number;
  margenPorcentaje: number;
};

/**
 * @deprecated LEGACY_ONLY — no sembrar precios en CANONICAL.
 * Solo metadatos (codigo/nombre/categoría). Los importes no cotizan.
 */
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
  {
    codigo: 'COFRE',
    nombre: 'Cofre',
    categoria: RefaccionCategoria.COLISION,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
  },
  {
    codigo: 'FASCIA_DEL',
    nombre: 'Fascia Delantera',
    categoria: RefaccionCategoria.COLISION,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
  },
  {
    codigo: 'FASCIA_TRAS',
    nombre: 'Fascia Trasera',
    categoria: RefaccionCategoria.COLISION,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
  },
  {
    codigo: 'PUERTA',
    nombre: 'Puerta',
    categoria: RefaccionCategoria.COLISION,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
  },
  {
    codigo: 'SALPICADERA',
    nombre: 'Salpicadera',
    categoria: RefaccionCategoria.COLISION,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
  },
  {
    codigo: 'TAPA_CAJUELA',
    nombre: 'Tapa de Cajuela',
    categoria: RefaccionCategoria.COLISION,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
  },
  {
    codigo: 'TOLDO',
    nombre: 'Toldo',
    categoria: RefaccionCategoria.COLISION,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
  },
  {
    codigo: 'ESTRIBO',
    nombre: 'Estribo',
    categoria: RefaccionCategoria.COLISION,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
  },
  {
    codigo: 'ESPEJO',
    nombre: 'Espejo',
    categoria: RefaccionCategoria.COLISION,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
  },
  {
    codigo: 'POSTE',
    nombre: 'Poste',
    categoria: RefaccionCategoria.COLISION,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
  },
  {
    codigo: 'BICO',
    nombre: 'Bigote de Cofre',
    categoria: RefaccionCategoria.COLISION,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
  },
  {
    codigo: 'PARILLA',
    nombre: 'Parilla',
    categoria: RefaccionCategoria.COLISION,
    costoReferenciaBase: 0,
    margenPorcentaje: 30,
  },
];
