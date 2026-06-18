// periodos.ts — cierre/bloqueo de mes. Wrappers de las RPCs + consulta de estado.
import { db } from "./supabase";

type R<T> = Promise<{ data: T | null; error: string | null }>;

const aMesISO = (mes: string) => `${mes.slice(0, 7)}-01`; // "YYYY-MM" | "YYYY-MM-DD" → "YYYY-MM-01"

export async function cerrarPeriodo(localId: number, mes: string): R<{ cerrado: boolean }> {
  const { data, error } = await db.rpc("cerrar_periodo", { p_local_id: localId, p_periodo_mes: aMesISO(mes) });
  return { data: (data as { cerrado: boolean } | null), error: error?.message ?? null };
}

export async function reabrirPeriodo(localId: number, mes: string): R<{ reabierto: boolean }> {
  const { data, error } = await db.rpc("reabrir_periodo", { p_local_id: localId, p_periodo_mes: aMesISO(mes) });
  return { data: (data as { reabierto: boolean } | null), error: error?.message ?? null };
}

export async function estaCerrado(localId: number, mes: string): R<boolean> {
  const { data, error } = await db
    .from("periodos_cerrados")
    .select("id")
    .eq("local_id", localId)
    .eq("periodo_mes", aMesISO(mes))
    .maybeSingle();
  return { data: !!data, error: error?.message ?? null };
}
