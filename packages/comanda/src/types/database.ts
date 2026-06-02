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

export type ColorRamp =
  | 'amber' | 'pink' | 'purple' | 'blue' | 'gray' | 'coral' | 'teal' | 'green';

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
  color_ramp: ColorRamp | null;
  emoji: string | null;
  orden: number;
  tax_rate_id: number | null;
  estacion_default: Estacion | null;
}

// PosModo es alias de ModoVenta (el tipo "canónico" de Sprint 2). Lo
// declaramos para que features_pos_modos sea legible al instante.
export type PosModo = ModoVenta;

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
  tiempo_prep_min?: number | null;  // Sprint 16/05: minutos prep estimados
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

// ─── Sprint 2: POS, Caja, Tienda ──────────────────────────────────────────

export type RolPos = 'cajero' | 'encargado' | 'manager' | 'dueno' | 'bartender';
export type ModoVenta = 'salon' | 'mostrador' | 'pedidos';
export type EstadoVenta =
  | 'abierta' | 'enviada' | 'lista' | 'entregada' | 'cobrada' | 'anulada'
  | 'necesita_aprobacion' | 'programada'
  | 'en_camino';  // Plan Fase 1 Brainstorm #8 (2026-06-01) — delivery con rider afuera
export type EstadoVentaItem = 'hold' | 'enviado' | 'listo' | 'entregado' | 'anulado';
export type EstadoMesa = 'libre' | 'ocupada' | 'hold' | 'inactiva';
export type FormaMesa = 'cuadrado' | 'redondo' | 'rectangular';
export type EstadoTurno = 'abierto' | 'cerrado';
export type TipoMovimientoCaja =
  | 'apertura' | 'cierre' | 'venta' | 'venta_anulada'
  | 'retiro' | 'deposito' | 'ajuste';
export type EstadoPago = 'pendiente' | 'confirmado' | 'fallido' | 'reembolsado';
export type AccionOverride =
  | 'void' | 'comp' | 'discount' | 'refund' | 'reopen'
  | 'transfer_table' | 'cambio_mozo' | 'merge_mesas' | 'split_check';
export type OrigenVenta = 'pos' | 'tienda_online' | 'menu_qr';
export type TipoEntrega = 'retiro' | 'delivery';

export interface Mesa {
  id: number;
  tenant_id: string;
  local_id: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  numero: string;
  zona: string | null;
  capacidad: number | null;
  pos_x: number | null;
  pos_y: number | null;
  forma: FormaMesa;
  estado: EstadoMesa;
}

export interface TurnoCaja {
  id: number;
  tenant_id: string;
  local_id: number;
  numero: number;
  cajero_id: string;
  abierto_at: string;
  cerrado_at: string | null;
  cerrado_por: string | null;
  monto_inicial: number;
  monto_final_declarado: number | null;
  monto_final_calculado: number | null;
  diferencia: number | null;
  notas: string | null;
  estado: EstadoTurno;
  /** Cash Management: breakdown por denominación al cierre. NULL si fue modo rápido. */
  efectivo_breakdown: {
    billetes: Record<string, number>;
    monedas: Record<string, number>;
    total: number;
  } | null;
}

export interface MovimientoCaja {
  id: number;
  tenant_id: string;
  local_id: number;
  created_at: string;
  turno_caja_id: number;
  empleado_id: string;
  tipo: TipoMovimientoCaja;
  monto: number;
  metodo: string;
  motivo: string | null;
  venta_id: number | null;
  ip_origen: string | null;
  idempotency_key: string | null;
}

export interface VentaPos {
  id: number;
  tenant_id: string;
  local_id: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  numero_local: number;
  modo: ModoVenta;
  canal_id: number;
  turno_caja_id: number | null;
  mesa_id: number | null;
  mozo_id: string | null;
  cajero_id: string | null;
  cliente_nombre: string | null;
  cliente_telefono: string | null;
  cliente_direccion: string | null;
  covers: number | null;
  estado: EstadoVenta;
  origen: OrigenVenta;
  programada_para: string | null;
  tipo_entrega: TipoEntrega | null;
  subtotal: number;
  descuento_total: number;
  propina: number;
  total: number;
  abierta_at: string;
  enviada_at: string | null;
  cobrada_at: string | null;
  anulada_at: string | null;
  notas: string | null;
  cobro_idempotency_key: string | null;
  // Sprint 16/05
  coursing_auto?: boolean;
  tab_nombre?: string | null;
  // Sprint 16/05 — geocoding cliente (delivery)
  cliente_lat?: number | null;
  cliente_lon?: number | null;
  // Sprint 2026-05-18 (Fase B) — email del cliente como columna propia
  // (antes vivía dentro de notas con prefix "email:")
  cliente_email?: string | null;
  // Sprint 2026-05-19 (Fase B) — notif idempotency
  notif_email_recibido_at?: string | null;
  notif_email_listo_at?: string | null;
  // Sprint offline-first — UUID generado client-side. Permite que items
  // creados offline antes que se sincronice la venta padre puedan
  // referenciarla por uuid en lugar de bigint.
  idempotency_uuid?: string | null;
  // Plan Fase 1 Brainstorm #8 (2026-06-01) — timeline visual de pedidos
  listo_at?: string | null;
  entregada_at?: string | null;
  asignado_rider_at?: string | null;
  en_camino_at?: string | null;
  rider_id?: number | null;
}

export interface VentaPosItemModificador {
  nombre: string;
  precio_extra: number;
  modifier_id?: number;
}

export interface VentaPosItem {
  id: number;
  tenant_id: string;
  local_id: number;
  venta_id: number;
  item_id: number;
  cantidad: number;
  precio_unitario: number;
  subtotal: number;
  descuento: number;
  modificadores: VentaPosItemModificador[] | null;
  curso: number | null;
  combo_padre_id: number | null;
  es_combo_padre: boolean;
  estado: EstadoVentaItem;
  enviado_at: string | null;
  listo_at: string | null;
  anulado_at: string | null;
  anulado_motivo: string | null;
  notas: string | null;
  cargado_por: string | null;
  // Sprint 16/05: precio puntual + cortesía
  es_cortesia?: boolean;
  precio_unitario_original?: number | null;
  // Sprint 2 competitor F #1: stay = item se queda en hold aunque mande el curso
  stay_until_release?: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface VentaPosPago {
  id: number;
  tenant_id: string;
  local_id: number;
  venta_id: number;
  metodo: string;
  monto: number;
  idempotency_key: string;
  vuelto: number | null;
  propina_incluida: number;
  cobrado_por: string | null;
  estado: EstadoPago;
  confirmado_at: string | null;
  reembolsado_at: string | null;
  created_at: string;
}

export interface VentaPosOverride {
  id: number;
  tenant_id: string;
  local_id: number;
  venta_id: number;
  venta_item_id: number | null;
  cajero_id: string;
  manager_id: string;
  accion: AccionOverride;
  motivo: string;
  valor_anterior: number | null;
  valor_nuevo: number | null;
  monto_afectado: number | null;
  ip_origen: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
  idempotency_key: string | null;
}

export interface MetodoCobro {
  id: number;
  tenant_id: string;
  local_id: number | null;
  nombre: string;
  slug: string;
  emoji: string | null;
  pide_vuelto: boolean;
  activo: boolean;
  orden: number;
}

export interface HorariosLocal {
  horario_lun?: string | null;
  horario_mar?: string | null;
  horario_mie?: string | null;
  horario_jue?: string | null;
  horario_vie?: string | null;
  horario_sab?: string | null;
  horario_dom?: string | null;
}

export interface ComandaLocalSettings extends HorariosLocal {
  id: number;
  tenant_id: string;
  local_id: number;
  slug: string;
  direccion: string | null;
  telefono: string | null;
  instagram: string | null;
  web: string | null;
  mp_qr_url: string | null;
  costo_envio_default: number;
  tiempo_retiro_min: number;
  tiempo_delivery_min: number;
  tienda_activa: boolean;
  acepta_delivery: boolean;
  autolock_minutos: number;
  features_pos_modos: PosModo[];
  // Sprint 8 (timezone configurable). Default 'America/Argentina/Buenos_Aires'.
  // Configurable por local cuando entren clientes en otras zonas.
  timezone: string;
}

// ─── F1.2 CRM (auditoría estructural 2026-05-15) ───────────────────────────
export interface Cliente {
  id: number;
  tenant_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  created_by: number | null;
  updated_by: number | null;
  telefono: string;
  email: string | null;
  nombre: string | null;
  apellido: string | null;
  direccion: string | null;
  direccion_aclaracion: string | null;
  zona: string | null;
  notas: string | null;
  vip: boolean;
  acepta_marketing: boolean;
  total_pedidos: number;
  total_gastado: number;
  ultimo_pedido_at: string | null;
  primer_pedido_at: string | null;
}

// ─── F1.1 CMV (auditoría estructural 2026-05-15) ───────────────────────────
export type UnidadInsumo = 'kg' | 'g' | 'L' | 'ml' | 'un' | 'porcion';

export interface Insumo {
  id: number;
  tenant_id: string;
  local_id: number | null; // NULL = catálogo global del tenant
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  created_by: number | null;
  updated_by: number | null;
  nombre: string;
  descripcion: string | null;
  emoji: string | null;
  foto_url: string | null;
  unidad: UnidadInsumo;
  costo_actual: number | null;
  costo_actualizado_at: string | null;
  costo_promedio_30d: number | null;
  proveedor_preferido_id: number | null;
  activo: boolean;
  es_comprado: boolean;
  /** Auto-86 CMV: cuando es FALSE, los items con receta que usan este insumo se marcan agotados auto. */
  stock_disponible: boolean;
  /** Stock actual en unidad del insumo. Mantenido por triggers sobre insumo_movimientos. */
  stock_actual: number | null;
  /** Cantidad por debajo de la cual el insumo dispara alerta. NULL = sin alerta. */
  stock_minimo: number | null;
  /** Cantidad por encima de la cual se considera sobrestock. NULL = sin tope. */
  stock_maximo: number | null;
  /** Ubicación física en el depósito (ej: "Cámara fría", "Almacén seco"). */
  ubicacion: string | null;
  /** Categoría P&L: 'alimentos' | 'bebidas' | 'limpieza' | 'descartables' | 'condimentos' | 'otros'. NULL = sin categorizar. */
  categoria_pl: string | null;
}

export interface Receta {
  id: number;
  tenant_id: string;
  local_id: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  created_by: number | null;
  updated_by: number | null;
  item_id: number;
  nombre: string;
  rendimiento: number;
  notas: string | null;
  activa: boolean;
}

export interface RecetaInsumo {
  id: number;
  tenant_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  created_by: number | null;
  updated_by: number | null;
  receta_id: number;
  insumo_id: number;
  cantidad: number;
  merma_pct: number;
  notas: string | null;
  orden: number;
}

export interface EmpleadoPos {
  id: string;
  local_id: number | null;
  apellido: string;
  nombre: string;
  puesto: string;
  activo: boolean;
  pos_activo: boolean;
  rol_pos: RolPos | null;
  pin_actualizado_at: string | null;
  // pin_pos NUNCA se expone en clientes
  // Sprint 16/05: Quick Items personales del cajero/mozo (array de item_ids)
  pos_favoritos?: number[];
}
