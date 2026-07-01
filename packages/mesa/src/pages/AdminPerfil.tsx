// Editor del perfil público del local — sección del panel admin de MESA.
// Lo que ven los clientes en /:slug: descripción, fotos, dirección, contacto.
// (Extraído del AdminHome original al sumarse la Agenda de reservas.)

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CalendarCheck, ExternalLink, Save, Link2 } from 'lucide-react';
import { db } from '@/lib/supabase';

export interface LocalPerfil {
  settings_id: number;
  local_id: number;
  tenant_id: string;
  nombre: string;
  slug: string | null;
  direccion: string | null;
  telefono: string | null;
  instagram: string | null;
  web: string | null;
  mesa_descripcion: string | null;
  mesa_fotos: string[];
}

export function AdminPerfil({ local, onSaved }: { local: LocalPerfil; onSaved: (l: LocalPerfil) => void }) {
  const [form, setForm] = useState<LocalPerfil>(local);
  const [guardando, setGuardando] = useState(false);

  // Si cambia el local seleccionado en el shell, resetear el form.
  useEffect(() => { setForm(local); }, [local]);

  async function guardar() {
    setGuardando(true);
    try {
      const fotos = form.mesa_fotos.map((f) => f.trim()).filter(Boolean);
      const { error } = await db().from('comanda_local_settings').update({
        direccion: form.direccion?.trim() || null,
        telefono: form.telefono?.trim() || null,
        instagram: form.instagram?.trim() || null,
        web: form.web?.trim() || null,
        mesa_descripcion: form.mesa_descripcion?.trim() || null,
        mesa_fotos: fotos,
        updated_at: new Date().toISOString(),
      }).eq('id', form.settings_id);
      if (error) { toast.error('No se pudo guardar: ' + error.message); return; }
      toast.success('Perfil guardado — la página pública ya lo muestra');
      onSaved({ ...form, mesa_fotos: fotos });
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="mt-6 grid lg:grid-cols-2 gap-6 max-w-5xl">
      <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-5 space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="font-medium">{form.nombre}</p>
          {form.slug && (
            <div className="flex items-center gap-3">
              <button
                onClick={() => {
                  const link = `${window.location.origin}/${form.slug}`;
                  void navigator.clipboard.writeText(link).then(
                    () => toast.success('Link de reservas copiado'),
                    () => toast.error('No se pudo copiar'),
                  );
                }}
                className="text-xs text-brand-600 hover:underline inline-flex items-center gap-1">
                <Link2 className="h-3 w-3" /> Copiar link de reservas
              </button>
              <a href={`/${form.slug}`} target="_blank" rel="noopener"
                 className="text-xs text-brand-600 hover:underline inline-flex items-center gap-1">
                Ver página <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>
        <Campo label="Descripción (la historia del local, 'sobre nosotros')">
          <textarea rows={5} value={form.mesa_descripcion ?? ''}
                    placeholder="En Neko el sushi es cosa seria…"
                    onChange={(e) => setForm((f) => ({ ...f, mesa_descripcion: e.target.value }))}
                    className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
        </Campo>
        <Campo label="Fotos (una URL por línea — la primera es la grande del hero)">
          <textarea rows={4} value={form.mesa_fotos.join('\n')}
                    placeholder={'https://…/fachada.jpg\nhttps://…/salon.jpg'}
                    onChange={(e) => setForm((f) => ({ ...f, mesa_fotos: e.target.value.split('\n') }))}
                    className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm font-mono" />
        </Campo>
      </div>

      <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-5 space-y-4 self-start">
        <Campo label="Dirección">
          <input value={form.direccion ?? ''} onChange={(e) => setForm((f) => ({ ...f, direccion: e.target.value }))}
                 className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
        </Campo>
        <Campo label="Teléfono">
          <input value={form.telefono ?? ''} inputMode="tel" onChange={(e) => setForm((f) => ({ ...f, telefono: e.target.value }))}
                 className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
        </Campo>
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Instagram">
            <input value={form.instagram ?? ''} placeholder="@nekosushiar"
                   onChange={(e) => setForm((f) => ({ ...f, instagram: e.target.value }))}
                   className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </Campo>
          <Campo label="Web">
            <input value={form.web ?? ''} placeholder="https://…"
                   onChange={(e) => setForm((f) => ({ ...f, web: e.target.value }))}
                   className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </Campo>
        </div>
        <button onClick={() => void guardar()} disabled={guardando}
                className="w-full rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2.5 text-sm font-medium disabled:opacity-60 inline-flex items-center justify-center gap-2">
          <Save className="h-4 w-4" /> {guardando ? 'Guardando…' : 'Guardar perfil'}
        </button>
        <p className="text-xs text-ink-muted flex items-start gap-1.5">
          <CalendarCheck className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          Los horarios, la capacidad y las reglas de reserva se configuran en la
          sección <span className="font-medium">Configuración</span>.
        </p>
      </div>
    </div>
  );
}

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-ink-soft">{label}</label>
      {children}
    </div>
  );
}
