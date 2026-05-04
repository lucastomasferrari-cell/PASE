export interface Movimiento {
  id: string;
  fecha: string;
  cuenta: string;
  tipo: string;
  cat: string | null;
  importe: number;
  detalle: string | null;
  local_id: number | null;
  fact_id: string | null;
  // gasto_id_ref se rellena cuando el movimiento fue creado por la RPC
  // crear_gasto (carga desde el módulo Gastos): hace doble-insert atómico
  // en gastos + movimientos y deja el FK en movimientos. Tesorería lo usa
  // para mostrar un badge "vía Gastos" y aclarar que NO es un duplicado.
  gasto_id_ref?: string | null;
  anulado: boolean;
  anulado_motivo: string | null;
  editado: boolean;
  editado_motivo: string | null;
  editado_at: string | null;
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
  // Path al archivo de comprobante en Supabase Storage (bucket "facturas").
  // Set por LectorFacturasIA al subir, leído por Compras → "Ver factura".
  imagen_url?: string | null;
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

