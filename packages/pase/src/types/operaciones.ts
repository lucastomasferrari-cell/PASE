// Insumos / recetas / remitos / RRHH operacional — tipos compartidos por
// las pages de operaciones.

export type UnidadInsumo = "peso" | "volumen" | "unidad";

export interface Insumo {
  id: number;
  nombre: string;
  unidad: UnidadInsumo | string;
  unidad_label: string | null;
  merma: number;
  categoria: string | null;
  stock_actual: number;
  costo_promedio: number;
  activo: boolean;
}
