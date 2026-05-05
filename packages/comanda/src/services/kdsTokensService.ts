import { db } from '../lib/supabase';

export type EstacionKds = 'cocina_caliente' | 'cocina_fria' | 'barra' | 'postres';

export interface KdsToken {
  id: number;
  tenant_id: string;
  local_id: number;
  estacion: EstacionKds;
  token: string;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export const ESTACIONES: { id: EstacionKds; label: string; emoji: string }[] = [
  { id: 'cocina_caliente', label: 'Cocina caliente', emoji: '🔥' },
  { id: 'cocina_fria', label: 'Cocina fría', emoji: '🥗' },
  { id: 'barra', label: 'Barra', emoji: '🍹' },
  { id: 'postres', label: 'Postres', emoji: '🍰' },
];

function generarToken(): string {
  // crypto.randomUUID disponible en navegadores modernos.
  return (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export async function listTokensLocal(localId: number, tenantId: string): Promise<{ data: KdsToken[]; error: string | null }> {
  const { data, error } = await db
    .from('kds_tokens')
    .select('*')
    .eq('local_id', localId)
    .is('deleted_at', null)
    .order('estacion');
  if (error) return { data: [], error: error.message };
  void tenantId;
  return { data: (data ?? []) as KdsToken[], error: null };
}

export async function generarOReemplazarToken(args: {
  localId: number;
  tenantId: string;
  estacion: EstacionKds;
}): Promise<{ token: string | null; error: string | null }> {
  // Soft-delete del existente (si lo hay) y crear uno nuevo. Atómico no es
  // crítico: el UNIQUE INDEX en (local_id, estacion) WHERE deleted_at IS NULL
  // garantiza una sola fila activa.
  const newToken = generarToken();
  const { error: delErr } = await db
    .from('kds_tokens')
    .update({ deleted_at: new Date().toISOString() })
    .eq('local_id', args.localId)
    .eq('estacion', args.estacion)
    .is('deleted_at', null);
  if (delErr) return { token: null, error: delErr.message };

  const { error: insErr } = await db.from('kds_tokens').insert({
    tenant_id: args.tenantId,
    local_id: args.localId,
    estacion: args.estacion,
    token: newToken,
  });
  if (insErr) return { token: null, error: insErr.message };
  return { token: newToken, error: null };
}
