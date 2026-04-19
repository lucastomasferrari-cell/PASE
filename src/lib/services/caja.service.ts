import { db } from "../supabase";
import type { Movimiento, SaldoCaja } from "../../types";

export const cajaService = {
  async getMovimientos(localId?: number, limit = 80): Promise<Movimiento[]> {
    let q = db.from("movimientos")
      .select("*")
      .eq("anulado", false)
      .order("fecha", { ascending: false })
      .limit(limit);
    if (localId) q = q.eq("local_id", localId);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  async getSaldos(localId?: number): Promise<SaldoCaja[]> {
    let q = db.from("saldos_caja").select("*");
    if (localId) q = q.eq("local_id", localId);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  async insertMovimiento(mov: Omit<Movimiento, "anulado" | "anulado_motivo" | "editado" | "editado_motivo" | "editado_at">): Promise<void> {
    const { error } = await db.from("movimientos").insert([mov]);
    if (error) throw error;
  },

  async actualizarSaldo(cuenta: string, localId: number, delta: number): Promise<void> {
    const { data: caja } = await db.from("saldos_caja").select("saldo")
      .eq("cuenta", cuenta).eq("local_id", localId).maybeSingle();
    if (!caja) return;
    const { error } = await db.from("saldos_caja")
      .update({ saldo: (caja.saldo || 0) + delta })
      .eq("cuenta", cuenta).eq("local_id", localId);
    if (error) throw error;
  },
};
