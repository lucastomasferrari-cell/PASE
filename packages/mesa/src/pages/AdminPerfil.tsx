// Editor del perfil público del local — sección del panel admin de MESA.
// Lo que ven los clientes en /:slug: descripción, fotos, dirección, contacto.
// (Extraído del AdminHome original al sumarse la Agenda de reservas.)

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CalendarCheck, ExternalLink, Save, Link2, ImagePlus, X, Star, Upload } from 'lucide-react';
import { db } from '@/lib/supabase';
import { subirFotoLocal } from '@/lib/uploadFoto';

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

const MAX_FOTOS = 6;

export function AdminPerfil({ local, onSaved }: { local: LocalPerfil; onSaved: (l: LocalPerfil) => void }) {
  const [form, setForm] = useState<LocalPerfil>(local);
  const [guardando, setGuardando] = useState(false);
  const [subiendo, setSubiendo] = useState(false);
  const [mostrarUrls, setMostrarUrls] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Si cambia el local seleccionado en el shell, resetear el form.
  useEffect(() => { setForm(local); }, [local]);

  // Fotos con URL no vacía — lo que se muestra en la grilla.
  const fotos = form.mesa_fotos.filter((f) => f.trim());

  function quitarFoto(url: string) {
    setForm((f) => ({ ...f, mesa_fotos: f.mesa_fotos.filter((x) => x !== url) }));
  }

  function hacerPortada(url: string) {
    setForm((f) => ({
      ...f,
      mesa_fotos: [url, ...f.mesa_fotos.filter((x) => x !== url)],
    }));
  }

  async function onSeleccionarArchivos(e: React.ChangeEvent<HTMLInputElement>) {
    const archivos = Array.from(e.target.files ?? []);
    // Reseteo el input para poder re-subir el mismo archivo si hace falta.
    e.target.value = '';
    if (archivos.length === 0) return;

    // Tope de fotos: solo subimos las que entren hasta el máximo.
    const libres = MAX_FOTOS - form.mesa_fotos.filter((f) => f.trim()).length;
    if (libres <= 0) { toast.error(`Máximo ${MAX_FOTOS} fotos. Quitá alguna para agregar otra.`); return; }
    const aSubir = archivos.slice(0, libres);
    if (archivos.length > libres) toast.error(`Solo se suben ${libres}: el máximo es ${MAX_FOTOS} fotos.`);

    setSubiendo(true);
    try {
      for (const file of aSubir) {
        const { url, error } = await subirFotoLocal(file, form.tenant_id, form.local_id);
        if (error || !url) {
          toast.error(`No se pudo subir ${file.name}: ${error ?? 'error desconocido'}`);
          continue;
        }
        setForm((f) => ({ ...f, mesa_fotos: [...f.mesa_fotos, url] }));
      }
    } finally {
      setSubiendo(false);
    }
  }

  async function guardar() {
    setGuardando(true);
    try {
      const fotos = form.mesa_fotos.map((f) => f.trim()).filter(Boolean).slice(0, MAX_FOTOS);
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
        <Campo label="Fotos — la primera es la portada del hero">
          {/* Grilla de miniaturas */}
          {fotos.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {fotos.map((url, i) => (
                <div key={url} className="group relative aspect-square overflow-hidden rounded-lg border border-ink/15 bg-ink/5">
                  <img src={url} alt={i === 0 ? 'Portada del local' : `Foto ${i + 1}`}
                       className="h-full w-full object-cover" />

                  {i === 0 && (
                    <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-md bg-brand-500 px-1.5 py-0.5 text-[10px] font-medium text-white shadow-card">
                      <Star className="h-2.5 w-2.5 fill-current" /> Portada
                    </span>
                  )}

                  {/* Quitar */}
                  <button type="button" onClick={() => quitarFoto(url)}
                          title="Quitar foto"
                          className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md bg-black/55 text-white opacity-0 transition-opacity hover:bg-black/75 group-hover:opacity-100">
                    <X className="h-3.5 w-3.5" />
                  </button>

                  {/* Hacer portada (no en la primera) */}
                  {i !== 0 && (
                    <button type="button" onClick={() => hacerPortada(url)}
                            className="absolute inset-x-1.5 bottom-1.5 inline-flex items-center justify-center gap-1 rounded-md bg-white/90 py-1 text-[10px] font-medium text-ink opacity-0 shadow-card transition-opacity hover:bg-white group-hover:opacity-100">
                      <Star className="h-2.5 w-2.5" /> Hacer portada
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Input oculto + botón agregar */}
          <input ref={fileInputRef} type="file" accept="image/*" multiple hidden
                 onChange={(e) => void onSeleccionarArchivos(e)} />
          <div className="mt-1 flex items-center gap-3 flex-wrap">
            <button type="button" disabled={subiendo || fotos.length >= MAX_FOTOS}
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-2 rounded-lg border border-dashed border-ink/25 px-3 py-2 text-sm text-ink-soft hover:border-brand-500 hover:text-brand-600 disabled:opacity-60 disabled:hover:border-ink/25 disabled:hover:text-ink-soft">
              {subiendo
                ? (<><Upload className="h-4 w-4 animate-pulse" /> Subiendo…</>)
                : (<><ImagePlus className="h-4 w-4" /> Agregar fotos</>)}
            </button>
            <span className="text-xs text-ink-muted">{fotos.length}/{MAX_FOTOS}{fotos.length >= MAX_FOTOS ? ' — máximo' : ''}</span>
          </div>

          <p className="text-xs text-ink-muted">
            La primera foto es la portada del hero. Los cambios se guardan cuando
            tocás <span className="font-medium">Guardar perfil</span>.{' '}
            <button type="button" onClick={() => setMostrarUrls((v) => !v)}
                    className="text-brand-600 hover:underline">
              {mostrarUrls ? 'ocultar URLs' : 'pegar una URL'}
            </button>
          </p>

          {/* Escape hatch: editar URLs a mano (comportamiento viejo) */}
          {mostrarUrls && (
            <textarea rows={4} value={form.mesa_fotos.join('\n')}
                      placeholder={'https://…/fachada.jpg\nhttps://…/salon.jpg'}
                      onChange={(e) => setForm((f) => ({ ...f, mesa_fotos: e.target.value.split('\n') }))}
                      className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm font-mono" />
          )}
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
