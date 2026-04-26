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
