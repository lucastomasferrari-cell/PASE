import { db } from "../supabase";
import type { Empleado, Novedad, Liquidacion, PagoEspecial } from "../../types";

export const rrhhService = {
  async getEmpleados(localId?: number): Promise<Empleado[]> {
    let q = db.from("rrhh_empleados").select("*").order("apellido");
    if (localId) q = q.eq("local_id", localId);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  async getEmpleadosActivos(localId?: number): Promise<Empleado[]> {
    let q = db.from("rrhh_empleados").select("*").eq("activo", true).order("apellido");
    if (localId) q = q.eq("local_id", localId);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  async getNovedades(mes: number, anio: number, empIds: string[]): Promise<Novedad[]> {
    if (!empIds.length) return [];
    const { data, error } = await db.from("rrhh_novedades")
      .select("*")
      .eq("mes", mes).eq("anio", anio)
      .in("empleado_id", empIds);
    if (error) throw error;
    return data || [];
  },

  async getLiquidaciones(novedadIds: string[]): Promise<Liquidacion[]> {
    if (!novedadIds.length) return [];
    const { data, error } = await db.from("rrhh_liquidaciones")
      .select("*")
      .in("novedad_id", novedadIds);
    if (error) throw error;
    return data || [];
  },

  async getPagosEspeciales(empleadoId: string): Promise<PagoEspecial[]> {
    const { data, error } = await db.from("rrhh_pagos_especiales")
      .select("*")
      .eq("empleado_id", empleadoId)
      .order("pagado_at", { ascending: false });
    if (error) throw error;
    return data || [];
  },

  async getValoresDoble(): Promise<{ puesto: string; valor: number }[]> {
    const { data, error } = await db.from("rrhh_valores_doble").select("*").order("puesto");
    if (error) throw error;
    return data || [];
  },
};
