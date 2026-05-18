// Service para CRUD de dashboard config + pinned notes + objetivos.
// Solo dueño/admin puede modificar config de otros usuarios (RLS lo enforces).

import { db } from "../lib/supabase";
import type { DashboardConfig } from "./types";

export interface PinnedNote {
  id: number;
  tenant_id: string;
  local_id: number | null;
  created_at: string;
  created_by: number;
  expires_at: string | null;
  target_usuario_id: number | null;
  target_rol: string | null;
  prioridad: "info" | "normal" | "alta" | "urgente";
  titulo: string;
  cuerpo: string | null;
  es_tarea: boolean;
  completada_at: string | null;
  completada_por: number | null;
}

// ─── Dashboard config ─────────────────────────────────────────────────────

export async function getDashboardConfig(
  usuarioId: number,
): Promise<{ data: DashboardConfig | null; error: string | null }> {
  const { data, error } = await db
    .from("usuario_dashboard_config")
    .select("widgets_activos, widgets_config, es_default")
    .eq("usuario_id", usuarioId)
    .maybeSingle();
  if (error) return { data: null, error: error.message };
  if (!data) return { data: null, error: null };
  return {
    data: {
      widgets_activos: (data.widgets_activos as string[] | null) ?? [],
      widgets_config: (data.widgets_config as Record<string, Record<string, unknown>> | null) ?? {},
      es_default: Boolean(data.es_default),
    },
    error: null,
  };
}

export async function saveDashboardConfig(
  usuarioId: number,
  tenantId: string,
  config: Partial<DashboardConfig>,
): Promise<{ error: string | null }> {
  // Upsert: si existe, update; si no, insert.
  const { error } = await db
    .from("usuario_dashboard_config")
    .upsert(
      {
        usuario_id: usuarioId,
        tenant_id: tenantId,
        widgets_activos: config.widgets_activos ?? [],
        widgets_config: config.widgets_config ?? {},
        es_default: config.es_default ?? false,
      },
      { onConflict: "usuario_id" },
    );
  return { error: error?.message ?? null };
}

// ─── Pinned notes ─────────────────────────────────────────────────────────

// Devuelve las notas pineadas para un usuario específico (incluye las que
// están dirigidas a su rol). Filtra las expiradas.
export async function getPinnedNotesPara(
  usuarioId: number,
  rol: string,
): Promise<{ data: PinnedNote[]; error: string | null }> {
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("dashboard_pinned_notes")
    .select("*")
    .or(`target_usuario_id.eq.${usuarioId},target_rol.eq.${rol}`)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as PinnedNote[], error: null };
}

export interface CrearNotaArgs {
  tenantId: string;
  localId?: number | null;
  targetUsuarioId?: number | null;
  targetRol?: string | null;
  prioridad?: PinnedNote["prioridad"];
  titulo: string;
  cuerpo?: string | null;
  esTarea?: boolean;
  expiresAt?: string | null;
}

export async function crearNotaPineada(
  args: CrearNotaArgs,
  createdBy: number,
): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db
    .from("dashboard_pinned_notes")
    .insert({
      tenant_id: args.tenantId,
      local_id: args.localId ?? null,
      created_by: createdBy,
      target_usuario_id: args.targetUsuarioId ?? null,
      target_rol: args.targetRol ?? null,
      prioridad: args.prioridad ?? "normal",
      titulo: args.titulo,
      cuerpo: args.cuerpo ?? null,
      es_tarea: args.esTarea ?? false,
      expires_at: args.expiresAt ?? null,
    })
    .select("id")
    .single();
  if (error) return { id: null, error: error.message };
  return { id: data.id as number, error: null };
}

// Usa RPC marcar_tarea_completada (SECURITY DEFINER) en vez de UPDATE
// directo. Razón: la policy `pinned_modify` solo permite UPDATE a
// dueño/admin, así que un encargado con tarea asignada veía el botón pero
// el UPDATE fallaba silenciosamente (RLS bloquea con 0 rows, sin error).
// La RPC valida que el caller sea el target_usuario o tenga el target_rol.
// El parámetro usuarioId queda en la firma para compat con el call site
// pero ya no se usa (la RPC toma el usuario del auth context).
export async function completarTarea(
  notaId: number,
  _usuarioId: number,
): Promise<{ error: string | null }> {
  const { error } = await db.rpc("marcar_tarea_completada", { p_nota_id: notaId });
  return { error: error?.message ?? null };
}

export async function eliminarNota(notaId: number): Promise<{ error: string | null }> {
  const { error } = await db.from("dashboard_pinned_notes").delete().eq("id", notaId);
  return { error: error?.message ?? null };
}

// Lista de usuarios activos del tenant — para el dropdown de "destinatario"
// del form de crear mensajes pineados. RLS restringe automáticamente al tenant
// del caller (dueño/admin). Para encargados/cajeros que no pueden crear, esta
// función no se llama desde la UI.
export async function listarUsuariosTenant(): Promise<{
  data: Array<{ id: number; nombre: string }>;
  error: string | null;
}> {
  const { data, error } = await db
    .from("usuarios")
    .select("id, nombre")
    .eq("activo", true)
    .order("nombre");
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as Array<{ id: number; nombre: string }>, error: null };
}
