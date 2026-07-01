// Experiencias (eventos) + Giftcards — sección del admin de MESA.
// CRUD directo sobre las tablas `eventos` y `giftcards` (RLS: staff del tenant).
// La plata (inscripciones/compras) la manejan la RPC pública + el webhook MP;
// acá solo se administra el catálogo. Unifica en MESA lo que vivía en COMANDA.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, Loader2, CalendarCheck, Gift } from 'lucide-react';
import { db } from '@/lib/supabase';

const fmtARS = (n: number) => n.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const inp = 'rounded-lg border border-ink/15 px-2.5 py-2 text-sm';

interface Evento { id: number; titulo: string; descripcion: string | null; foto_url: string | null; fecha_inicio: string; precio_por_persona: number; cupos_total: number; cupos_vendidos: number; estado: string }
interface Giftcard { id: number; local_id: number | null; nombre: string; descripcion: string | null; foto_url: string | null; precio: number; activa: boolean }

export function AdminExperiencias({ localId, tenantId }: { localId: number; tenantId: string }) {
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [giftcards, setGiftcards] = useState<Giftcard[]>([]);
  const [cargando, setCargando] = useState(true);

  const cargar = useCallback(async () => {
    setCargando(true);
    const [e, g] = await Promise.all([
      db().from('eventos').select('id,titulo,descripcion,foto_url,fecha_inicio,precio_por_persona,cupos_total,cupos_vendidos,estado').eq('local_id', localId).is('deleted_at', null).order('fecha_inicio', { ascending: true }),
      db().from('giftcards').select('id,local_id,nombre,descripcion,foto_url,precio,activa').or(`local_id.eq.${localId},local_id.is.null`).is('deleted_at', null).order('id'),
    ]);
    if (e.error) toast.error('Eventos: ' + e.error.message);
    if (g.error) toast.error('Giftcards: ' + g.error.message);
    setEventos((e.data ?? []) as Evento[]);
    setGiftcards((g.data ?? []) as Giftcard[]);
    setCargando(false);
  }, [localId]);
  useEffect(() => { void cargar(); }, [cargar]);

  // ── Eventos ──────────────────────────────────────────────────────────────
  const [nuevoEv, setNuevoEv] = useState({ titulo: '', fecha: '', precio: '', cupos: '', foto: '', desc: '' });
  const [addingEv, setAddingEv] = useState(false);
  async function crearEvento() {
    if (!nuevoEv.titulo.trim() || !nuevoEv.fecha) { toast.error('Título y fecha son obligatorios'); return; }
    setAddingEv(true);
    try {
      const { data, error } = await db().from('eventos').insert({
        tenant_id: tenantId, local_id: localId, titulo: nuevoEv.titulo.trim(),
        descripcion: nuevoEv.desc.trim() || null, foto_url: nuevoEv.foto.trim() || null,
        fecha_inicio: nuevoEv.fecha, precio_por_persona: Number(nuevoEv.precio) || 0,
        cupos_total: Number(nuevoEv.cupos) || 0, estado: 'publicado',
      }).select('id,titulo,descripcion,foto_url,fecha_inicio,precio_por_persona,cupos_total,cupos_vendidos,estado').single();
      if (error) { toast.error('No se pudo crear: ' + error.message); return; }
      setEventos((p) => [...p, data as Evento]);
      setNuevoEv({ titulo: '', fecha: '', precio: '', cupos: '', foto: '', desc: '' });
    } finally { setAddingEv(false); }
  }
  async function patchEvento(id: number, patch: Partial<Evento>) {
    setEventos((p) => p.map((e) => e.id === id ? { ...e, ...patch } : e));
    const { error } = await db().from('eventos').update(patch).eq('id', id);
    if (error) { toast.error('No se pudo guardar: ' + error.message); void cargar(); }
  }
  async function borrarEvento(id: number) {
    if (!window.confirm('¿Eliminar este evento?')) return;
    setEventos((p) => p.filter((e) => e.id !== id));
    const { error } = await db().from('eventos').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (error) { toast.error(error.message); void cargar(); }
  }

  // ── Giftcards ────────────────────────────────────────────────────────────
  const [nuevaGc, setNuevaGc] = useState({ nombre: '', precio: '', foto: '', desc: '', grupo: false });
  const [addingGc, setAddingGc] = useState(false);
  async function crearGiftcard() {
    if (!nuevaGc.nombre.trim() || !nuevaGc.precio) { toast.error('Nombre y precio son obligatorios'); return; }
    setAddingGc(true);
    try {
      const { data, error } = await db().from('giftcards').insert({
        tenant_id: tenantId, local_id: nuevaGc.grupo ? null : localId, nombre: nuevaGc.nombre.trim(),
        descripcion: nuevaGc.desc.trim() || null, foto_url: nuevaGc.foto.trim() || null,
        precio: Number(nuevaGc.precio) || 0, activa: true,
      }).select('id,local_id,nombre,descripcion,foto_url,precio,activa').single();
      if (error) { toast.error('No se pudo crear: ' + error.message); return; }
      setGiftcards((p) => [...p, data as Giftcard]);
      setNuevaGc({ nombre: '', precio: '', foto: '', desc: '', grupo: false });
    } finally { setAddingGc(false); }
  }
  async function patchGiftcard(id: number, patch: Partial<Giftcard>) {
    setGiftcards((p) => p.map((g) => g.id === id ? { ...g, ...patch } : g));
    const { error } = await db().from('giftcards').update(patch).eq('id', id);
    if (error) { toast.error('No se pudo guardar: ' + error.message); void cargar(); }
  }
  async function borrarGiftcard(id: number) {
    if (!window.confirm('¿Eliminar esta giftcard?')) return;
    setGiftcards((p) => p.filter((g) => g.id !== id));
    const { error } = await db().from('giftcards').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (error) { toast.error(error.message); void cargar(); }
  }

  if (cargando) return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-ink-muted" /></div>;

  return (
    <div className="mt-6 max-w-3xl space-y-8 pb-10">
      {/* EVENTOS */}
      <section>
        <h2 className="font-medium flex items-center gap-2 mb-3"><CalendarCheck className="h-4 w-4 text-brand-500" /> Experiencias / Eventos</h2>
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-4 flex flex-wrap items-end gap-2 mb-3">
          <F label="Título" w="w-44"><input className={`w-full ${inp}`} value={nuevoEv.titulo} onChange={(e) => setNuevoEv((n) => ({ ...n, titulo: e.target.value }))} placeholder="Omakase de invierno" /></F>
          <F label="Fecha y hora" w="w-52"><input type="datetime-local" className={`w-full ${inp}`} value={nuevoEv.fecha} onChange={(e) => setNuevoEv((n) => ({ ...n, fecha: e.target.value }))} /></F>
          <F label="Precio p/persona" w="w-28"><input type="number" min={0} className={`w-full ${inp}`} value={nuevoEv.precio} onChange={(e) => setNuevoEv((n) => ({ ...n, precio: e.target.value }))} /></F>
          <F label="Cupos" w="w-20"><input type="number" min={0} className={`w-full ${inp}`} value={nuevoEv.cupos} onChange={(e) => setNuevoEv((n) => ({ ...n, cupos: e.target.value }))} /></F>
          <F label="Foto (URL)" w="w-40"><input className={`w-full ${inp}`} value={nuevoEv.foto} onChange={(e) => setNuevoEv((n) => ({ ...n, foto: e.target.value }))} placeholder="https://…" /></F>
          <button onClick={() => void crearEvento()} disabled={addingEv} className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-4 py-2 text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-60">{addingEv ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Crear</button>
        </div>
        {eventos.length === 0 ? <p className="text-sm text-ink-muted px-1">Todavía no hay eventos.</p> : (
          <div className="space-y-2">
            {eventos.map((e) => (
              <div key={e.id} className="rounded-xl bg-white border border-ink/5 shadow-card p-3 flex flex-wrap items-center gap-3">
                <input defaultValue={e.titulo} onBlur={(ev) => { const v = ev.target.value.trim(); if (v && v !== e.titulo) void patchEvento(e.id, { titulo: v }); }} className={`flex-1 min-w-[160px] ${inp}`} />
                <span className="text-xs text-ink-muted">{new Date(e.fecha_inicio).toLocaleString('es-AR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                <input type="number" defaultValue={e.precio_por_persona} onBlur={(ev) => { const v = Number(ev.target.value); if (v !== e.precio_por_persona) void patchEvento(e.id, { precio_por_persona: v }); }} className={`w-24 ${inp}`} />
                <span className="text-xs text-ink-muted">{e.cupos_vendidos}/{e.cupos_total} cupos</span>
                <select value={e.estado} onChange={(ev) => void patchEvento(e.id, { estado: ev.target.value })} className={inp}>
                  <option value="publicado">Publicado</option><option value="borrador">Borrador</option><option value="finalizado">Finalizado</option><option value="cancelado">Cancelado</option>
                </select>
                <button onClick={() => void borrarEvento(e.id)} className="text-ink-muted hover:text-red-500 p-1"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* GIFTCARDS */}
      <section>
        <h2 className="font-medium flex items-center gap-2 mb-3"><Gift className="h-4 w-4 text-brand-500" /> Giftcards</h2>
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-4 flex flex-wrap items-end gap-2 mb-3">
          <F label="Nombre" w="w-44"><input className={`w-full ${inp}`} value={nuevaGc.nombre} onChange={(e) => setNuevaGc((n) => ({ ...n, nombre: e.target.value }))} placeholder="Dinner Card para 2" /></F>
          <F label="Precio" w="w-28"><input type="number" min={0} className={`w-full ${inp}`} value={nuevaGc.precio} onChange={(e) => setNuevaGc((n) => ({ ...n, precio: e.target.value }))} /></F>
          <F label="Foto (URL)" w="w-40"><input className={`w-full ${inp}`} value={nuevaGc.foto} onChange={(e) => setNuevaGc((n) => ({ ...n, foto: e.target.value }))} placeholder="https://…" /></F>
          <F label="Descripción" w="w-56"><input className={`w-full ${inp}`} value={nuevaGc.desc} onChange={(e) => setNuevaGc((n) => ({ ...n, desc: e.target.value }))} /></F>
          <label className="flex items-center gap-1.5 text-xs text-ink-soft pb-2"><input type="checkbox" checked={nuevaGc.grupo} onChange={(e) => setNuevaGc((n) => ({ ...n, grupo: e.target.checked }))} /> Todo el grupo</label>
          <button onClick={() => void crearGiftcard()} disabled={addingGc} className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-4 py-2 text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-60">{addingGc ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Crear</button>
        </div>
        {giftcards.length === 0 ? <p className="text-sm text-ink-muted px-1">Todavía no hay giftcards.</p> : (
          <div className="space-y-2">
            {giftcards.map((g) => (
              <div key={g.id} className="rounded-xl bg-white border border-ink/5 shadow-card p-3 flex flex-wrap items-center gap-3">
                <input defaultValue={g.nombre} onBlur={(ev) => { const v = ev.target.value.trim(); if (v && v !== g.nombre) void patchGiftcard(g.id, { nombre: v }); }} className={`flex-1 min-w-[160px] ${inp}`} />
                <input type="number" defaultValue={g.precio} onBlur={(ev) => { const v = Number(ev.target.value); if (v !== g.precio) void patchGiftcard(g.id, { precio: v }); }} className={`w-24 ${inp}`} />
                <span className="text-xs text-ink-muted">{g.local_id == null ? 'todo el grupo' : 'este local'}</span>
                <span className="text-sm text-ink-soft">{fmtARS(g.precio)}</span>
                <label className="flex items-center gap-1.5 text-xs text-ink-soft"><input type="checkbox" checked={g.activa} onChange={(ev) => void patchGiftcard(g.id, { activa: ev.target.checked })} /> Activa</label>
                <button onClick={() => void borrarGiftcard(g.id)} className="text-ink-muted hover:text-red-500 p-1"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function F({ label, w, children }: { label: string; w?: string; children: React.ReactNode }) {
  return <div className={`space-y-1 ${w ?? ''}`}><label className="text-xs font-medium text-ink-soft">{label}</label>{children}</div>;
}
