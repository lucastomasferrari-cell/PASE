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
  /** Forma de pago del empleado. Default 'MENSUAL'. Determina cuántas cuotas
   *  se generan al confirmar una novedad: MENSUAL=1, QUINCENAL=2, SEMANAL=4. */
  modo_pago?: "MENSUAL" | "QUINCENAL" | "SEMANAL";
}

export interface Novedad {
  id?: string;
  empleado_id: string;
  mes: number;
  anio: number;
  inasistencias: number;
  presentismo: "MANTIENE" | "PIERDE";
  horas_extras: number;
  dobles: number;
  feriados: number;
  adelantos: number;
  vacaciones_dias: number;
  observaciones: string;
  estado: "borrador" | "confirmado";
  cargado_por?: string;
  updated_at?: string;
  /** Descuentos manuales arbitrarios (préstamos, daños, faltantes de caja). */
  otros_descuentos?: number;
  otros_descuentos_motivo?: string | null;
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
  // Totales por forma de pago. Migration 20260423_rpc_pagos_atomicos los
  // populates en INSERT desde p_calc->>'efectivo' / 'transferencia'.
  efectivo: number;
  transferencia: number;
  estado: "pendiente" | "pagado";
  gasto_id: string | null;
  pagado_at: string | null;
  pagado_por: string | null;
  calculado_at: string | null;
  anulado: boolean;
  // Cuotas: para empleados QUINCENAL/SEMANAL una novedad genera N filas en
  // rrhh_liquidaciones. cuota_num=1..cuotas_total. Para MENSUAL ambas valen 1.
  cuota_num?: number;
  cuotas_total?: number;
  fecha_vencimiento?: string | null;
}

export interface PagoEspecial {
  id?: number;
  empleado_id: string;
  tipo: "vacaciones" | "aguinaldo" | "liquidacion_final";
  monto: number;
  // monto_pagado y pendiente reflejan el flow de "pago parcial". Si el user
  // pagó solo una parte del monto esperado, monto_pagado < monto y
  // pendiente = true. Migration 20260423_rpc_pagos_atomicos los popula en
  // pagar_vacaciones / pagar_aguinaldo.
  monto_pagado?: number;
  pendiente?: boolean;
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

// ─── Tipos de joins comunes ─────────────────────────────────────────────────
// Supabase tipa los nested FK como array por default. Estas interfaces reflejan
// que en este codebase las relaciones son conceptualmente 1:1 y siempre se
// acceden como objeto (las cast manuales `as unknown as { ... }` se reemplazan
// por estos tipos cuando aplican).

export interface EmpleadoMin {
  nombre: string;
  apellido: string;
  puesto: string;
  local_id: number;
}

export interface NovedadConEmpleado {
  mes: number;
  anio: number;
  empleado_id: string;
  rrhh_empleados: EmpleadoMin | null;
}

export interface LiquidacionConEmpleado extends Liquidacion {
  rrhh_novedades: NovedadConEmpleado | null;
}

// ─── Tipos compartidos entre RRHH.tsx y RRHHLegajo.tsx ──────────────────────

// Forma del registro en rrhh_valores_doble (config de valor por puesto).
export interface ValorDoble {
  id: number;
  puesto: string;
  valor: number;
  updated_at?: string;
}

// Adelanto a empleado (rrhh_adelantos).
export interface Adelanto {
  id: number;
  empleado_id: string;
  fecha: string;
  monto: number;
  cuenta: string | null;
  descontado: boolean;
}

// Documento del legajo (rrhh_documentos).
export interface DocumentoLegajo {
  id: number;
  empleado_id: string;
  tipo: string;
  nombre_archivo: string;
  url: string;
  mes: number | null;
  anio: number | null;
  subido_at: string;
  subido_por: number | null;
}

// Novedad con liquidaciones nested (Supabase devuelve liquidaciones como
// array — la convención del codebase es tomar el [0] como la "actual").
export interface NovedadConLiquidaciones extends Novedad {
  rrhh_liquidaciones?: Liquidacion[];
}

// Linea de pago (cuenta + monto en string desde el input). Usada en formasPago,
// vacLineas, aguLineas. El monto viene como string desde el input numérico
// y se parsea con parseFloat al sumar/enviar.
export interface LineaPago { cuenta: string; monto: string }
