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
  prov_id: string;
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
  plantilla_id: string | null;
}

export interface Proveedor {
  id: string;
  nombre: string;
  cuit: string | null;
  cat: string | null;
  saldo: number;
  activo: boolean;
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

// Caja Efectivo privada (separada de Tesorería; flow del dueño).
export interface MovimientoCajaEfectivo {
  id: string;
  fecha: string;
  descripcion: string;
  monto: number;
  local_id: number;
  creado_por: string | null;
  created_at?: string | null;
}
