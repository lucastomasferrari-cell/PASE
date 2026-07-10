// auditService — registra cambios sensibles (alta/baja/cambio de permisos/
// reset PIN/etc) y los muestra en la sección Auditoría. Tabla `accesos_audit`
// (migración 202606250700). Graceful si no está aplicada.

import { db } from './supabase';

export type AuditAccion =
  | 'crear' | 'editar' | 'activar' | 'desactivar' | 'reset_password'
  | 'cambio_rol' | 'cambio_apps' | 'cambio_locales' | 'cambio_permisos' | 'reset_pin';

export interface AuditEntry {
  id: number;
  actor_id: number;
  usuario_id: number;
  accion: AuditAccion;
  detalle: Record<string, unknown>;
  created_at: string;
  usuario_nombre?: string;
}

function faltaTabla(msg: string) {
  return /relation .*accesos_audit.* does not exist/i.test(msg) || /could not find the table/i.test(msg);
}

// Resuelve solo quién es el actor (el dueño/admin logueado) desde la sesión,
// así los callers solo pasan a quién y qué acción. Silencioso si no hay sesión,
// no se puede resolver el actor, o la tabla no está migrada (nunca rompe el flujo).
export async function logAudit(args: {
  usuarioId: number;
  accion: AuditAccion;
  detalle?: Record<string, unknown>;
}): Promise<{ error: string | null }> {
  const { data: sess } = await db().auth.getSession();
  const authId = sess.session?.user?.id;
  if (!authId) return { error: null };
  const { data: actor } = await db().from('usuarios').select('id').eq('auth_id', authId).maybeSingle();
  const actorId = (actor as { id: number } | null)?.id ?? null;
  if (actorId == null) return { error: null };

  const { error } = await db().from('accesos_audit').insert({
    actor_id: actorId,
    usuario_id: args.usuarioId,
    accion: args.accion,
    detalle: args.detalle ?? {},
  });
  if (error && faltaTabla(error.message)) return { error: null }; // silencioso si no está
  return { error: error?.message ?? null };
}

export async function listAudit(limit = 100): Promise<{ data: AuditEntry[]; sinTabla: boolean; error: string | null }> {
  const { data, error } = await db()
    .from('accesos_audit')
    .select('id, actor_id, usuario_id, accion, detalle, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (faltaTabla(error.message)) return { data: [], sinTabla: true, error: null };
    return { data: [], sinTabla: false, error: error.message };
  }
  return { data: (data ?? []) as AuditEntry[], sinTabla: false, error: null };
}
