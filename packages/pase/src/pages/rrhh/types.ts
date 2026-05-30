// Tipos compartidos del módulo RRHH. Extraídos de RRHH.tsx en F6 split
// (2026-05-11) para que los sub-componentes Tab* en archivos separados
// puedan importarlos sin duplicar interfaces.
//
// Las interfaces de dominio (Empleado, Novedad, Liquidacion, etc) viven
// en src/types/rrhh.ts — acá solo viven las extensiones específicas de
// la UI (forms, joins de queries, estados de modal).

import type {
  Empleado, Novedad, Liquidacion, PagoEspecial, Adelanto,
} from "../../types/rrhh";

// Estructura del state empForm (form de creación/edición de empleado).
// Difiere de Empleado en que sueldo_mensual y local_id vienen como string
// desde el input (parsean al guardar).
export interface EmpForm {
  local_id: string;
  apellido: string;
  nombre: string;
  cuil: string;
  puesto: string;
  sueldo_mensual: string;
  alias_mp: string;
  fecha_inicio: string;
  activo: boolean;
  /** Días de vacaciones ya consumidos ANTES del alta en PASE (default 0). */
  dias_vacaciones_ya_tomados_al_alta: string;
  /** TRUE = en nómina formal (AFIP), FALSE = "en blanco" (default FALSE). */
  registrado: boolean;
  /** Forma de pago: MENSUAL (1 cuota), QUINCENAL (2), SEMANAL (4). */
  modo_pago: "MENSUAL" | "QUINCENAL" | "SEMANAL";
}

// State de empModal: null cuando cerrado, "new" cuando agregando nuevo,
// Empleado cuando editando uno existente.
export type EmpModalState = Empleado | "new" | null;

// State de novMap: map de empleado_id → novedad parcial editable. Difiere de
// Novedad porque los campos opcionales pueden estar undefined antes del
// confirmar y porque guardamos id si ya está persistida.
export interface NovedadEditable extends Partial<Novedad> {
  fecha_inicio_mes?: string | null;
}

// Liquidación posiblemente generada en frontend (sin persistir todavía).
// Los flags _generated, _novedadId se usan en pagar_sueldo RPC para que
// la función SQL la cree on-the-fly con p_calc.
export interface LiquidacionConGenerated extends Partial<Liquidacion> {
  _generated?: boolean;
  _novedadId?: string;
}

// Fila del array pagoData — combina empleado, novedad confirmada y liquidación
// (pre-generada o persistida).
export interface PagoDataRow {
  emp: Empleado;
  nov: Novedad;
  liq: LiquidacionConGenerated;
}

// State del form de adelanto.
export interface AdelantoForm {
  empleado_id: string;
  monto: string;
  cuenta: string;
  fecha: string;
  descripcion: string;
  /** Si true (default), el adelanto se descuenta automáticamente en el
   *  próximo pago de sueldo del empleado. Si false, queda como "saldo a
   *  favor del empleador" y solo se descuenta cuando Anto lo tilde
   *  explícitamente en el modal de pago. */
  auto_aplicar?: boolean;
}

// Stats del Dashboard (calculadas en loadDashboard).
export interface DashStats {
  total: number;
  sinDatos: number;
  conNovedades: number;
  confirmadas: number;
  pagados: number;
  estimado: number;
  totalSAC: number;
  proxSAC: string;
  diasSAC: number;
  diasFinMes: number;
  mes: number;
  anio: number;
}

// Empleado info devuelto por joins de rrhh_pagos_especiales / rrhh_adelantos /
// rrhh_novedades→rrhh_empleados (mismo subset en todas).
export interface EmpleadoMin {
  nombre: string;
  apellido: string;
  puesto: string;
  local_id: number;
}

// Novedad como viene del join de la query de Historial.
export interface NovedadHist extends Pick<Novedad, "mes" | "anio" | "empleado_id" | "inasistencias" | "presentismo" | "horas_extras" | "dobles" | "feriados" | "adelantos" | "observaciones"> {
  rrhh_empleados: EmpleadoMin | null;
}

// Liquidación como viene del join.
export interface LiquidacionConNovedadHist extends Liquidacion {
  rrhh_novedades: NovedadHist | null;
}

// Pago especial con join al empleado.
export interface PagoEspecialConEmpleado extends PagoEspecial {
  rrhh_empleados: EmpleadoMin | null;
}

// Adelanto con join al empleado.
export interface AdelantoConEmpleado extends Adelanto {
  rrhh_empleados: EmpleadoMin | null;
}

// Fila normalizada del array histData. Union de los 3 tipos de pagos
// (sueldo, especial, adelanto) con sus campos comunes + detalle.
export interface HistRow {
  tipo: string;
  /** Fecha del PAGO (pagado_at de liq/especial, fecha de adelanto). Es la
   *  fecha que el dueño seleccionó al cargar el pago. Cuando paga atrasado,
   *  esto refleja la fecha real del pago, no el momento de la carga. */
  fecha: string | null | undefined;
  /** Fecha+hora en la que se REGISTRÓ el pago en el sistema (created_at).
   *  Útil para auditoría: "cargó este pago hoy aunque la fecha real es vieja".
   *  Toggle de orden en TabHistorial (Anto 2026-05-30). */
  fecha_carga?: string | null;
  emp: EmpleadoMin | null;
  nov?: NovedadHist | null;
  liq?: LiquidacionConNovedadHist;
  monto: number;
  label: string;
  detalle?: PagoEspecialConEmpleado | AdelantoConEmpleado;
}
