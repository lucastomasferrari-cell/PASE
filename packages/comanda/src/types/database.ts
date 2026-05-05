// Types hand-crafted para las tablas COMANDA Sprint 1.
// Mantener en sync con migration 202605051200_comanda_sprint_1.sql.
// Cuando estabilicemos el schema, regenerar con `supabase gen types typescript`.

export type Estacion = 'cocina_caliente' | 'cocina_fria' | 'barra' | 'postres';
export type ItemEstado = 'disponible' | 'agotado' | 'inactivo';
export type ModoPos = 'salon' | 'mostrador' | 'pedidos';
export type ModifierTipo = 'opcion' | 'extra' | 'aclaracion' | 'sin_con';

export interface TaxRate {
  id: number;
  tenant_id: string;
  local_id: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  created_by: number | null;
  updated_by: number | null;
  nombre: string;
  porcentaje: number;
  es_default: boolean;
}

export interface ItemGrupo {
  id: number;
  tenant_id: string;
  local_id: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  created_by: number | null;
  updated_by: number | null;
  nombre: string;
  color: string | null;
  emoji: string | null;
  orden: number;
  tax_rate_id: number | null;
  estacion_default: Estacion | null;
}

export interface Item {
  id: number;
  tenant_id: string;
  local_id: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  created_by: number | null;
  updated_by: number | null;
  nombre: string;
  descripcion: string | null;
  emoji: string | null;
  foto_url: string | null;
  codigo: string | null;
  grupo_id: number | null;
  orden: number;
  precio_madre: number;
  costo_actual: number | null;
  costo_actualizado_at: string | null;
  receta_version_id_vigente: number | null;
  tax_rate_id: number | null;
  estacion: Estacion | null;
  estado: ItemEstado;
  agotado_motivo: string | null;
  agotado_por: number | null;
  agotado_at: string | null;
  agotado_hasta: string | null;
  es_combo: boolean;
  visible_pos: boolean;
  visible_qr: boolean;
  visible_tienda: boolean;
  es_open_item: boolean;
}

export interface Canal {
  id: number;
  tenant_id: string;
  local_id: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  created_by: number | null;
  updated_by: number | null;
  nombre: string;
  slug: string;
  emoji: string | null;
  color: string | null;
  modo_pos: ModoPos;
  atado_madre: boolean;
  ajuste_madre_pct: number;
  comision_externa_pct: number;
  redondeo_a: number;
  activo: boolean;
  grupo: string | null;
}

export interface ItemPrecioCanal {
  id: number;
  tenant_id: string;
  local_id: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  created_by: number | null;
  updated_by: number | null;
  item_id: number;
  canal_id: number;
  precio: number;
  edicion_manual: boolean;
  vendible: boolean;
}

export interface ModifierGroup {
  id: number;
  tenant_id: string;
  local_id: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  created_by: number | null;
  updated_by: number | null;
  nombre: string;
  descripcion: string | null;
  requerido: boolean;
  min_seleccion: number;
  max_seleccion: number | null;
  tipo: ModifierTipo;
}

export interface Modifier {
  id: number;
  tenant_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  created_by: number | null;
  updated_by: number | null;
  modifier_group_id: number;
  nombre: string;
  precio_extra: number;
  orden: number;
  receta_modifier_id: number | null;
  activo: boolean;
}

export interface ItemModifierGroup {
  id: number;
  tenant_id: string;
  created_at: string;
  item_id: number;
  modifier_group_id: number;
  orden: number;
  requerido_override: boolean | null;
  min_seleccion_override: number | null;
  max_seleccion_override: number | null;
}

export interface ComboComponente {
  id: number;
  tenant_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  created_by: number | null;
  updated_by: number | null;
  combo_id: number;
  slot_nombre: string;
  slot_orden: number;
  min_seleccion: number;
  max_seleccion: number;
  item_elegible_id: number;
  precio_extra: number;
}

// Nota: el cliente Supabase NO se generica con Database (ver lib/supabase.ts);
// los services usan los types Row de arriba en sus signatures, y las queries
// internas son loose-typed. Cuando regeneremos con `supabase gen types`,
// reactivamos el generic.
