export interface Movimiento {
  id: string;
  fecha: string;
  cuenta: string;
  tipo: string;
  cat: string | null;
  importe: number;
  detalle: string | null;
  local_id: number | null;
  // ─── Referencias de ORIGEN ───
  // Cada movimiento puede ser manual O generado por una RPC atómica desde
  // otro módulo. En ese caso se rellena el FK correspondiente y Caja
  // muestra un badge "vía X" para aclarar que NO es duplicado.
  fact_id?: string | null;              // vía Factura (pago de compra)
  remito_id_ref?: string | null;        // vía Remito (pago directo)
  liquidacion_id?: string | null;       // vía Sueldo (RRHH liquidación mensual)
  adelanto_id_ref?: string | null;      // vía Adelanto (RRHH adelanto sueldo)
  pago_especial_id_ref?: string | null; // vía Pago especial (RRHH aguinaldo/vacaciones)
  gasto_id_ref?: string | null;         // vía Gasto (módulo Gastos)
  anulado: boolean;
  anulado_motivo: string | null;
  editado: boolean;
  editado_motivo: string | null;
  editado_at: string | null;
  /** Timestamp real de inserción (migration 202606040900). Permite ordenar
   *  por "fecha de carga" sin depender del parseo lexicográfico del id, que
   *  rompía el orden cuando había ids con formato distinto (ej. ajustes
   *  iniciales que ponían "AJUSTE" en el prefijo). */
  created_at?: string | null;
}

// Helper: devuelve el badge "vía X" según qué referencia esté poblada.
// null si es un movimiento manual (sin origen externo).
export function origenMovimiento(m: Movimiento): { label: string; tooltip: string } | null {
  if (m.fact_id) return { label: "vía Factura", tooltip: "Originado al pagar una factura desde Compras." };
  if (m.remito_id_ref) return { label: "vía Remito", tooltip: "Originado al pagar un remito desde Compras." };
  if (m.liquidacion_id) return { label: "vía Sueldo", tooltip: "Originado al liquidar sueldo en Equipo." };
  if (m.adelanto_id_ref) return { label: "vía Adelanto", tooltip: "Originado al dar un adelanto de sueldo." };
  if (m.pago_especial_id_ref) return { label: "vía Pago RRHH", tooltip: "Originado en aguinaldo / vacaciones / liquidación final." };
  if (m.gasto_id_ref) return { label: "vía Gasto", tooltip: "Originado al cargar un gasto en el módulo Gastos." };
  return null;
}

export interface SaldoCaja {
  id?: number;
  cuenta: string;
  saldo: number;
  local_id: number;
}

export interface Factura {
  id: string;
  // prov_id es FK a proveedores.id (number). Antes estaba tipado como string
  // por error — el codebase ya usaba parseInt(form.prov_id) o Number(f.prov_id)
  // para comparar, lo cual funciona tanto con string como con number en runtime
  // (parseInt de un number devuelve el número). Corrección sin impacto runtime.
  prov_id: number;
  local_id: number;
  nro: string;
  fecha: string;
  venc: string | null;
  neto: number;
  iva21: number;
  iva105: number;
  iibb: number;
  total: number;
  cat: string;
  estado: "pendiente" | "pagada" | "anulada" | "vencida";
  detalle: string | null;
  pagos: PagoFactura[];
  tipo: string;
  perc_iva: number;
  otros_cargos: number;
  descuentos: number;
  // Discriminación fiscal AR (migración 202606102300 / Lucas 10-jun: el
  // contador necesita TODO desglosado). Todas opcionales con default 0
  // — facturas viejas tienen estos en 0 (excepto iibb_otros, backfilleado
  // desde el iibb legacy plano para que el contador re-asigne después).
  iva27?: number;
  no_gravado?: number;
  exento?: number;
  iibb_caba?: number;
  iibb_ba?: number;
  iibb_otros?: number;
  iibb_otros_jurisdiccion?: string | null;
  perc_ganancias?: number;
  retencion_suss?: number;
  // Path al archivo de comprobante en Supabase Storage (bucket "facturas").
  // Set por LectorFacturasIA al subir, leído por Compras → "Ver factura".
  imagen_url?: string | null;
  // Bucket: clasifica a qué línea del EERR pertenece. Derivado del tipo de
  // la categoría en config_categorias (cat_compra | gasto_fijo | gasto_variable
  // | gasto_publicidad | gasto_comision | gasto_impuesto). NULL = factura
  // legacy (pre-2026-05-13): EERR la trata como CMV. Migration 202605130000.
  bucket?: string | null;
}

export interface PagoFactura {
  fecha: string;
  monto: number;
  cuenta: string;
}

export interface Gasto {
  id: string;
  fecha: string;
  local_id: number | null;
  categoria: string;
  subcategoria: string | null;
  tipo: string;
  monto: number;
  detalle: string | null;
  cuenta: string | null;
  estado: string | null;
  // plantilla_id apunta a gastos_plantillas.id (number). Antes estaba tipado
  // como string por error — el único consumidor (Gastos.tsx) compara con
  // plantilla.id que es number.
  plantilla_id: number | null;
}

// Shape REAL de la tabla proveedores. Antes este type tenía id:string y
// activo:boolean — ambos divergían del runtime (id es number, y la columna
// es estado:string "Activo" | "Inactivo"). Cero consumidores del type
// importan los campos divergentes hoy, así que lo corregimos al schema real.
export interface Proveedor {
  id: number;
  nombre: string;
  cuit: string | null;
  cat: string | null;
  saldo: number;
  /** Saldo a favor del cliente sobre este proveedor. Positivo = el proveedor
   *  nos debe (lo podemos usar como crédito). Negativo = le debemos aparte.
   *  NO incluye NC/ND oficiales — esas son fiscales y van al contador.
   *  Cache derivado de proveedor_saldo_movimientos (Lucas 03-jun). */
  saldo_a_favor?: number;
  estado: string;
}

export interface Venta {
  id: string;
  local_id: number;
  fecha: string;
  turno: string;
  medio: string;
  monto: number;
  origen: string | null;
  venta_ids?: string[] | null;
}

// Agrupado en memoria por (fecha, turno, local_id) — lo que en la UI se
// muestra como un "cierre" de turno.
export interface CierreVentas {
  key: string;
  fecha: string;
  turno: string;
  local_id: number;
  items: Venta[];
  total: number;
}

