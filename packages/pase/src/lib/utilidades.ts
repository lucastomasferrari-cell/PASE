// utilidades.ts — servicio del módulo Utilidades / Reparto.
//
// Wrappers tipados de las RPCs Postgres (migraciones 202606160100–0500). El
// cálculo y los movimientos de plata viven en el backend (SECURITY DEFINER):
// reservar reusa transferencia_cuentas; el reparto crea gastos retiro_socio
// (crear_gasto) que hitean EERR + cashflow. Ver
// docs/superpowers/specs/2026-06-16-utilidades-reparto-design.md.

import { db } from "./supabase";

export interface Socio {
  id: string; local_id: number; nombre: string; porcentaje: number; activo: boolean;
}

export interface RepartoDetalle {
  socio_id: string; monto: number; nombre: string | null; gasto_id: string | null;
}

export interface Reparto {
  id: string; local_id: number; fecha: string; periodo_ref: string | null;
  total: number; cuenta_origen: string; nota: string | null; anulado: boolean;
  created_at: string; detalle: RepartoDetalle[];
}

export interface CuantoRepartir {
  plata_total: number; reservado: number; obligaciones_pendientes: number;
  colchon: number; meses_colchon: number; seguro_repartir: number;
  ya_repartido_mes: number; sobre_distribuido: boolean;
}

type R<T> = Promise<{ data: T | null; error: string | null }>;

/** Alta/edición de un socio. Devuelve el id + la suma de % activos del local. */
export async function guardarSocio(params: {
  localId: number; id?: string | null; nombre: string; porcentaje: number; activo?: boolean;
}): R<{ id: string; suma_porcentajes: number }> {
  const { data, error } = await db.rpc("utilidades_guardar_socio", {
    p_local_id: params.localId,
    p_id: params.id ?? null,
    p_nombre: params.nombre,
    p_porcentaje: params.porcentaje,
    p_activo: params.activo ?? true,
  });
  return { data: (data as { id: string; suma_porcentajes: number } | null), error: error?.message ?? null };
}

/** Lista los socios de un local (incluye inactivos; la UI filtra). */
export async function listarSocios(localId: number): R<Socio[]> {
  const { data, error } = await db
    .from("utilidades_socios")
    .select("id, local_id, nombre, porcentaje, activo")
    .eq("local_id", localId)
    .order("activo", { ascending: false })
    .order("nombre");
  return { data: (data as Socio[] | null), error: error?.message ?? null };
}

/** Aparta plata de una cuenta operativa → CAJA UTILIDADES. */
export async function reservar(params: {
  localId: number; cuentaOrigen: string; monto: number; fecha: string; idempotencyKey?: string;
}): R<{ reservado: number }> {
  const { data, error } = await db.rpc("utilidades_reservar", {
    p_local_id: params.localId,
    p_cuenta_origen: params.cuentaOrigen,
    p_monto: params.monto,
    p_fecha: params.fecha,
    p_idempotency_key: params.idempotencyKey ?? null,
  });
  return { data: (data as { reservado: number } | null), error: error?.message ?? null };
}

/** Registra un reparto: un gasto retiro_socio por socio + cabecera/detalle. */
export async function registrarReparto(params: {
  localId: number; fecha: string; total: number; cuentaOrigen: string;
  periodoRef?: string | null; nota?: string | null;
  detalle: { socio_id: string; monto: number }[]; idempotencyKey?: string;
}): R<{ reparto_id: string; total: number }> {
  const { data, error } = await db.rpc("utilidades_registrar_reparto", {
    p_local_id: params.localId,
    p_fecha: params.fecha,
    p_total: params.total,
    p_cuenta_origen: params.cuentaOrigen,
    p_periodo_ref: params.periodoRef ?? null,
    p_nota: params.nota ?? null,
    p_detalle: params.detalle,
    p_idempotency_key: params.idempotencyKey ?? null,
  });
  return { data: (data as { reparto_id: string; total: number } | null), error: error?.message ?? null };
}

/** Anula un reparto (revierte cada gasto retiro_socio). */
export async function anularReparto(repartoId: string, motivo?: string): R<{ anulado: boolean; gastos_revertidos: number }> {
  const { data, error } = await db.rpc("utilidades_anular_reparto", {
    p_reparto_id: repartoId, p_motivo: motivo ?? null,
  });
  return { data: (data as { anulado: boolean; gastos_revertidos: number } | null), error: error?.message ?? null };
}

/** Calculador "cuánto es seguro repartir" (read-only). */
export async function cuantoRepartir(localId: number, periodoMes: string, mesesColchon = 1): R<CuantoRepartir> {
  const { data, error } = await db.rpc("utilidades_cuanto_repartir", {
    p_local_id: localId, p_periodo_mes: periodoMes, p_meses_colchon: mesesColchon,
  });
  return { data: (data as CuantoRepartir | null), error: error?.message ?? null };
}

/** Historial de repartos de un mes (con detalle por socio embebido). */
export async function listarRepartos(localId: number, periodoMes: string): R<Reparto[]> {
  const fin = new Date(periodoMes);
  fin.setMonth(fin.getMonth() + 1);
  const finISO = fin.toISOString().slice(0, 10);
  const { data, error } = await db
    .from("utilidades_repartos")
    .select("id, local_id, fecha, periodo_ref, total, cuenta_origen, nota, anulado, created_at, " +
      "detalle:utilidades_reparto_detalle(socio_id, monto, gasto_id, socio:utilidades_socios(nombre))")
    .eq("local_id", localId)
    .gte("fecha", periodoMes)
    .lt("fecha", finISO)
    .order("fecha", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) return { data: null, error: error.message };
  // Aplanar el nombre del socio embebido.
  const rows = (data ?? []).map((r): Reparto => ({
    ...(r as unknown as Reparto),
    detalle: ((r as { detalle?: { socio_id: string; monto: number; gasto_id: string | null; socio?: { nombre: string } | null }[] }).detalle ?? [])
      .map((d) => ({ socio_id: d.socio_id, monto: d.monto, gasto_id: d.gasto_id, nombre: d.socio?.nombre ?? null })),
  }));
  return { data: rows, error: null };
}
