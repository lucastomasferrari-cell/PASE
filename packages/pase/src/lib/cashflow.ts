// cashflow.ts — servicio del módulo Cashflow (la "ruta del dinero").
//
// Wrappers tipados de las RPCs Postgres (migraciones 202606141200–1800). Sin
// lógica de negocio: solo llaman la RPC y devuelven { data, error }. El cálculo
// vive en el backend (SECURITY DEFINER). Los parsers de extracto están en
// `mpExtractoParser.ts` / `bancoExtractoParser.ts` (devuelven CashflowExtractoParseado).
//
// Categorías del cashflow: ver docs/superpowers/specs/2026-06-14-cashflow-rene-design.md.

import { db } from "./supabase";
import type { CashflowLineaCargada } from "./cashflowExtracto";

export type CashflowCategoria =
  | "venta" | "comision" | "retencion" | "proveedor" | "sueldo" | "gasto"
  | "retiro_socio" | "aporte_socio" | "obra_capex" | "transferencia_interna"
  | "apertura_ajuste" | "otro";

export type CashflowCuenta = "MercadoPago" | "Banco";

export interface ResumenSaldos {
  efectivo: number; mercadopago: number; banco: number; utilidades: number;
}
export interface ResumenCategoria { categoria: CashflowCategoria; total: number; }
export interface ResumenExtracto {
  cuenta: string; saldo_inicial: number; saldo_final_real: number;
  saldo_final_calc: number; diferencia: number; cuadra: boolean;
}
export interface CashflowResumen {
  periodo: string; local_id: number;
  saldos_iniciales: ResumenSaldos; saldos_finales: ResumenSaldos;
  ingresos: ResumenCategoria[]; egresos: ResumenCategoria[];
  retiros_total: number; aportes_total: number;
  en_transito: { bruto: number; acreditado: number; neto: number };
  posicion: { liquido_operativo: number; reservado: number; en_transito: number };
  extractos: ResumenExtracto[];
  por_revisar: number; bloqueado: boolean;
}

export interface LibroFila {
  fecha: string; concepto: string; categoria: CashflowCategoria | null;
  debe: number; haber: number; saldo: number; ref_id: string;
}
export interface CashflowLibro {
  cuenta: string; saldo_inicial: number; filas: LibroFila[]; saldo_final: number;
}

export interface PuenteLinea {
  concepto: string; signo: "=" | "+" | "-"; monto: number; estimado?: boolean;
}
export interface CashflowPuente {
  periodo: string; local_id: number;
  devengado: {
    ventas: number; cmv: number; gastos_fijos: number; gastos_variables: number;
    sueldos: number; cargas_sociales: number; publicidad: number; comisiones: number;
    impuestos: number; otros: number; utilidad_neta: number;
  };
  puente: PuenteLinea[];
  cash_generado: number; stock_estimado: boolean;
}

type R<T> = Promise<{ data: T | null; error: string | null }>;

/** Sube un extracto MP/Banco ya parseado (crea el extracto + clasifica las líneas). */
export async function subirExtracto(params: {
  localId: number; cuenta: CashflowCuenta; periodoMes: string;
  parseado: { saldoInicial: number; saldoFinal: number; lineas: CashflowLineaCargada[] };
  archivoNombre?: string; idempotencyKey?: string;
}): R<{ extracto_id: string; lineas: number }> {
  const { data, error } = await db.rpc("cashflow_subir_extracto", {
    p_local_id: params.localId,
    p_cuenta: params.cuenta,
    p_periodo_mes: params.periodoMes,
    p_saldo_inicial: params.parseado.saldoInicial,
    p_saldo_final: params.parseado.saldoFinal,
    p_archivo_nombre: params.archivoNombre ?? null,
    p_lineas: params.parseado.lineas,
    p_idempotency_key: params.idempotencyKey ?? null,
  });
  return { data: (data as { extracto_id: string; lineas: number } | null), error: error?.message ?? null };
}

/** Reclasifica una línea de extracto (con memoria opcional). */
export async function reclasificarLinea(params: {
  lineaId: string; categoria: CashflowCategoria; esInterno?: boolean;
  aplicarTodas?: boolean; global?: boolean;
}): R<{ linea_id: string; afectadas: number }> {
  const { data, error } = await db.rpc("cashflow_reclasificar", {
    p_linea_id: params.lineaId,
    p_categoria: params.categoria,
    p_es_interno: params.esInterno ?? false,
    p_aplicar_todas: params.aplicarTodas ?? false,
    p_global: params.global ?? false,
  });
  return { data: (data as { linea_id: string; afectadas: number } | null), error: error?.message ?? null };
}

/** Reclasifica un movimiento de efectivo (override + memoria opcional). */
export async function reclasificarMov(params: {
  movId: string; categoria: CashflowCategoria; esInterno?: boolean; aplicarTodas?: boolean;
}): R<{ mov_id: string; afectadas: number }> {
  const { data, error } = await db.rpc("cashflow_reclasificar_mov", {
    p_mov_id: params.movId,
    p_categoria: params.categoria,
    p_es_interno: params.esInterno ?? false,
    p_aplicar_todas: params.aplicarTodas ?? false,
  });
  return { data: (data as { mov_id: string; afectadas: number } | null), error: error?.message ?? null };
}

/** Resumen mensual consolidado (efectivo + MP/banco). */
export async function resumenMes(localId: number, periodoMes: string): R<CashflowResumen> {
  const { data, error } = await db.rpc("cashflow_resumen_mes", { p_local_id: localId, p_periodo_mes: periodoMes });
  return { data: (data as CashflowResumen | null), error: error?.message ?? null };
}

/** Libro contable / línea de tiempo. `cuenta` null = efectivo consolidado. */
export async function libroMes(localId: number, periodoMes: string, cuenta?: string | null): R<CashflowLibro> {
  const { data, error } = await db.rpc("cashflow_libro_mes", {
    p_local_id: localId, p_periodo_mes: periodoMes, p_cuenta: cuenta ?? null,
  });
  return { data: (data as CashflowLibro | null), error: error?.message ?? null };
}

/** Puente devengado ↔ cash. */
export async function puenteMes(localId: number, periodoMes: string): R<CashflowPuente> {
  const { data, error } = await db.rpc("cashflow_puente_mes", { p_local_id: localId, p_periodo_mes: periodoMes });
  return { data: (data as CashflowPuente | null), error: error?.message ?? null };
}

/** Cierra/bloquea un mes conciliado. */
export async function cerrarMes(localId: number, periodoMes: string, idempotencyKey?: string): R<{ bloqueado: boolean; saldos: ResumenSaldos }> {
  const { data, error } = await db.rpc("cashflow_cerrar_mes", {
    p_local_id: localId, p_periodo_mes: periodoMes, p_idempotency_key: idempotencyKey ?? null,
  });
  return { data: (data as { bloqueado: boolean; saldos: ResumenSaldos } | null), error: error?.message ?? null };
}

/** Etiquetas en castellano para mostrar las categorías. */
export const CATEGORIA_LABEL: Record<CashflowCategoria, string> = {
  venta: "Ventas", comision: "Comisiones", retencion: "Impuestos / retenciones",
  proveedor: "Proveedores", sueldo: "Sueldos", gasto: "Gastos",
  retiro_socio: "Retiros de socios", aporte_socio: "Aportes de socios",
  obra_capex: "Obra / inversión", transferencia_interna: "Transferencias internas",
  apertura_ajuste: "Apertura / ajustes", otro: "Sin clasificar",
};
