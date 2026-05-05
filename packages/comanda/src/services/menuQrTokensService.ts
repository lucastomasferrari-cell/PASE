import { db } from '../lib/supabase';
import type { MenuQrModo } from './menuQrService';

export interface MenuQrToken {
  id: number;
  tenant_id: string;
  local_id: number;
  mesa_id: number;
  token: string;
  modo: MenuQrModo;
  activo: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MesaConToken {
  mesa_id: number;
  numero: string;
  zona: string | null;
  token: MenuQrToken | null;
}

function generarToken(): string {
  return (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function listMesasConToken(localId: number): Promise<{ data: MesaConToken[]; error: string | null }> {
  const [mesasRes, tokensRes] = await Promise.all([
    db.from('mesas').select('id,numero,zona').eq('local_id', localId).is('deleted_at', null).order('numero'),
    db.from('menu_qr_tokens').select('*').eq('local_id', localId).is('deleted_at', null),
  ]);
  if (mesasRes.error) return { data: [], error: mesasRes.error.message };
  if (tokensRes.error) return { data: [], error: tokensRes.error.message };
  const tokens = (tokensRes.data ?? []) as MenuQrToken[];
  const mesas = (mesasRes.data ?? []) as Array<{ id: number; numero: string; zona: string | null }>;
  const out: MesaConToken[] = mesas.map(m => ({
    mesa_id: m.id,
    numero: m.numero,
    zona: m.zona,
    token: tokens.find(t => t.mesa_id === m.id) ?? null,
  }));
  return { data: out, error: null };
}

export async function generarTokenMesa(args: {
  mesaId: number;
  localId: number;
  tenantId: string;
  modo: MenuQrModo;
}): Promise<{ token: string | null; error: string | null }> {
  const newToken = generarToken();
  // Soft-delete tokens previos de esa mesa.
  const { error: delErr } = await db
    .from('menu_qr_tokens')
    .update({ deleted_at: new Date().toISOString() })
    .eq('mesa_id', args.mesaId)
    .is('deleted_at', null);
  if (delErr) return { token: null, error: delErr.message };

  const { error: insErr } = await db.from('menu_qr_tokens').insert({
    tenant_id: args.tenantId,
    local_id: args.localId,
    mesa_id: args.mesaId,
    token: newToken,
    modo: args.modo,
    activo: true,
  });
  if (insErr) return { token: null, error: insErr.message };
  return { token: newToken, error: null };
}

export async function setModoToken(tokenId: number, modo: MenuQrModo): Promise<{ error: string | null }> {
  const { error } = await db.from('menu_qr_tokens').update({ modo }).eq('id', tokenId);
  return { error: error?.message ?? null };
}

export async function setActivoToken(tokenId: number, activo: boolean): Promise<{ error: string | null }> {
  const { error } = await db.from('menu_qr_tokens').update({ activo }).eq('id', tokenId);
  return { error: error?.message ?? null };
}
