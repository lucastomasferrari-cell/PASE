import { db } from '../lib/supabase';
import type { TaxRate } from '../types/database';

export async function listTaxRates(tenantId: string | null): Promise<{ data: TaxRate[]; error: string | null }> {
  let q = db.from('tax_rates').select('*').is('deleted_at', null).order('id', { ascending: true });
  if (tenantId) q = q.eq('tenant_id', tenantId);
  const { data, error } = await q;
  if (error) return { data: [], error: error.message };
  return { data: data ?? [], error: null };
}

export type TaxRateDraft = Pick<TaxRate, 'nombre' | 'porcentaje' | 'es_default'> & {
  tenant_id: string;
  local_id: number | null;
};

export async function createTaxRate(draft: TaxRateDraft): Promise<{ id: number | null; error: string | null }> {
  // Si es_default=true, quitar es_default de los demás del mismo tenant primero.
  if (draft.es_default) {
    await db.from('tax_rates').update({ es_default: false }).eq('tenant_id', draft.tenant_id).eq('es_default', true);
  }
  const { data, error } = await db.from('tax_rates').insert(draft).select('id').single();
  if (error) return { id: null, error: error.message };
  return { id: data.id as number, error: null };
}

export async function updateTaxRate(id: number, patch: Partial<TaxRateDraft>): Promise<{ error: string | null }> {
  if (patch.es_default && patch.tenant_id) {
    await db
      .from('tax_rates')
      .update({ es_default: false })
      .eq('tenant_id', patch.tenant_id)
      .eq('es_default', true)
      .neq('id', id);
  }
  const { error } = await db.from('tax_rates').update(patch).eq('id', id);
  return { error: error?.message ?? null };
}
