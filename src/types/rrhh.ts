export interface Empleado {
  id: string;
  local_id: number;
  apellido: string;
  nombre: string;
  cuil: string | null;
  puesto: string;
  sueldo_mensual: number;
  alias_mp: string | null;
  fecha_inicio: string | null;
  activo: boolean;
  aguinaldo_acumulado: number;
  vacaciones_dias_acumulados: number;
  fecha_egreso: string | null;
  motivo_baja: string | null;
}

export interface Novedad {
  id?: string;
  empleado_id: string;
  mes: number;
  anio: number;
  inasistencias: number;
  presentismo: "MANTIENE" | "PIERDE" | "PIERDE_LLEGADAS" | "INICIO_PARCIAL";
  horas_extras: number;
  dobles: number;
  feriados: number;
  adelantos: number;
  vacaciones_dias: number;
  observaciones: string;
  estado: "borrador" | "confirmado";
  cargado_por?: string;
  updated_at?: string;
}

export interface Liquidacion {
  id?: string;
  novedad_id: string;
  sueldo_base: number;
  descuento_ausencias: number;
  total_horas_extras: number;
  total_dobles: number;
  total_feriados: number;
  total_vacaciones: number;
  subtotal1: number;
  monto_presentismo: number;
  subtotal2: number;
  adelantos: number;
  pagos_realizados: number;
  total_a_pagar: number;
  estado: "pendiente" | "pagado";
  gasto_id: string | null;
  pagado_at: string | null;
  pagado_por: string | null;
  calculado_at: string | null;
  anulado: boolean;
}

export interface PagoEspecial {
  id?: number;
  empleado_id: string;
  tipo: "vacaciones" | "aguinaldo" | "liquidacion_final";
  monto: number;
  dias?: number;
  gasto_id: string | null;
  pagado_por: string | null;
  pagado_at?: string;
}

export interface HistorialSueldo {
  id?: number;
  empleado_id: string;
  sueldo_anterior: number;
  sueldo_nuevo: number;
  motivo: string | null;
  registrado_por: string | null;
  fecha_cambio?: string;
}
