// Campañas de email — armá, probá y enviá campañas reales por Resend, y mirá
// las métricas (enviados, aperturas, clicks). Motor: /api/mkt + tablas mkt_*.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Mail, Plus, Send, ChevronLeft, Eye, Trash2, BarChart3, Users } from 'lucide-react';
import {
  listCampanas, crearCampana, getCampana, actualizarCampana, eliminarCampana,
  enviarCampana, enviarPrueba, tasaApertura, tasaClick, atribucionVentas,
  type MktCampana, type MktEstado, type Atribucion,
} from '@/lib/mktService';
import { SEGMENTOS, listSegmento, type SegmentoKey } from '@/lib/segmentosService';
import { remitenteDeMarca, type Marca } from '@/lib/marcasService';

const ESTADO_STYLE: Record<MktEstado, string> = {
  borrador: 'bg-ink/10 text-ink-soft',
  programada: 'bg-amber-100 text-amber-700',
  enviando: 'bg-blue-100 text-blue-700',
  enviada: 'bg-emerald-100 text-emerald-700',
  pausada: 'bg-ink/10 text-ink-soft',
  cancelada: 'bg-ink/10 text-ink-muted',
  error: 'bg-red-100 text-red-700',
};
const ESTADO_LABEL: Record<MktEstado, string> = {
  borrador: 'Borrador', programada: 'Programada', enviando: 'Enviando…',
  enviada: 'Enviada', pausada: 'Pausada', cancelada: 'Cancelada', error: 'Error',
};

const HTML_STARTER = `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;line-height:1.6">
  <h1 style="font-size:22px">Hola {{nombre}} 👋</h1>
  <p>Escribí acá tu mensaje. Contale a tu cliente qué hay de nuevo: un plato nuevo, una promo de la semana, un horario especial. Cuanto más natural y personal, mejor.</p>
  <p>Podés usar <b>{{nombre}}</b> en cualquier parte y se reemplaza por el nombre de cada contacto, así el mail se siente uno a uno.</p>
  <p>Un par de líneas más de texto real ayudan a que el correo entre a la bandeja principal (los filtros desconfían de los mails que son solo un botón).</p>
  <p style="margin:24px 0"><a href="https://comanda.lat" style="display:inline-block;background:#111;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none">Ver el menú</a></p>
  <p style="color:#666;font-size:14px">¡Te esperamos! 🍽️</p>
</div>`;

function fecha(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
}

export function Campanas({ tenantId, marca }: { tenantId: string; marca: Marca | null }) {
  const [modo, setModo] = useState<'lista' | 'editor'>('lista');
  const [campanas, setCampanas] = useState<MktCampana[]>([]);
  const [cargando, setCargando] = useState(true);
  const [editId, setEditId] = useState<string | null>(null);

  const recargar = useCallback(async () => {
    setCargando(true);
    try { setCampanas(await listCampanas()); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Error cargando campañas'); }
    setCargando(false);
  }, []);

  useEffect(() => { void recargar(); }, [recargar]);

  async function nueva() {
    try {
      const r = remitenteDeMarca(marca);
      const c = await crearCampana(tenantId, r ? { from_nombre: r.nombre, from_email: r.email } : {});
      setEditId(c.id); setModo('editor');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'No se pudo crear'); }
  }

  function abrir(id: string) { setEditId(id); setModo('editor'); }

  if (modo === 'editor' && editId) {
    return <Editor id={editId} marca={marca} onVolver={() => { setModo('lista'); setEditId(null); void recargar(); }} />;
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-xl font-medium flex items-center gap-2"><Mail className="h-5 w-5 text-brand-600" /> Campañas de email</h2>
          <p className="text-sm text-ink-muted mt-0.5">Enviá por tu propio dominio y medí aperturas, clicks y bajas.</p>
        </div>
        <button onClick={nueva} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 text-white px-3.5 py-2 text-sm font-medium hover:bg-brand-700">
          <Plus className="h-4 w-4" /> Nueva campaña
        </button>
      </div>

      {cargando ? (
        <div className="text-center py-16 text-ink-muted">Cargando…</div>
      ) : campanas.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-ink/15 rounded-xl">
          <Mail className="h-8 w-8 mx-auto text-ink-muted mb-2" />
          <p className="text-ink-soft">Todavía no creaste ninguna campaña.</p>
          <button onClick={nueva} className="mt-3 text-sm text-brand-600 font-medium">Crear la primera →</button>
        </div>
      ) : (
        <div className="overflow-x-auto border border-ink/10 rounded-xl bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ink-muted border-b border-ink/10">
                <th className="px-4 py-2.5 font-medium">Campaña</th>
                <th className="px-4 py-2.5 font-medium">Estado</th>
                <th className="px-4 py-2.5 font-medium text-right">Enviados</th>
                <th className="px-4 py-2.5 font-medium text-right">Aperturas</th>
                <th className="px-4 py-2.5 font-medium text-right">Clicks</th>
                <th className="px-4 py-2.5 font-medium">Fecha</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {campanas.map((c) => (
                <tr key={c.id} className="border-b border-ink/5 hover:bg-ink/[0.02] cursor-pointer" onClick={() => abrir(c.id)}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-ink">{c.nombre}</div>
                    <div className="text-xs text-ink-muted truncate max-w-[220px]">{c.asunto || 'Sin asunto'}</div>
                  </td>
                  <td className="px-4 py-3"><span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${ESTADO_STYLE[c.estado]}`}>{ESTADO_LABEL[c.estado]}</span></td>
                  <td className="px-4 py-3 text-right tabular-nums">{c.total_enviados || '—'}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{c.total_enviados ? `${tasaApertura(c)}%` : '—'}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{c.total_enviados ? `${tasaClick(c)}%` : '—'}</td>
                  <td className="px-4 py-3 text-ink-muted whitespace-nowrap">{fecha(c.enviada_at || c.created_at)}</td>
                  <td className="px-4 py-3 text-right"><Eye className="h-4 w-4 text-ink-muted inline" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Editor de campaña ──────────────────────────────────────────────────────
function Editor({ id, marca, onVolver }: { id: string; marca: Marca | null; onVolver: () => void }) {
  const [c, setC] = useState<MktCampana | null>(null);
  const [seg, setSeg] = useState<SegmentoKey>('marketing');
  const [count, setCount] = useState<number | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [progreso, setProgreso] = useState<{ enviados: number; restantes: number } | null>(null);
  const [emailPrueba, setEmailPrueba] = useState('');
  const [atrib, setAtrib] = useState<Atribucion | null>(null);
  const [dias, setDias] = useState(7);

  useEffect(() => {
    void getCampana(id).then((x) => {
      if (!x) { setC(null); return; }
      const r = remitenteDeMarca(marca);
      // Defaults: contenido starter + remitente de la marca activa si están vacíos.
      setC({
        ...x,
        html: x.html === '' ? HTML_STARTER : x.html,
        from_nombre: x.from_nombre || r?.nombre || '',
        from_email: x.from_email || r?.email || '',
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Atribución de ventas: solo si la campaña ya se envió.
  useEffect(() => {
    if (!c?.enviada_at) { setAtrib(null); return; }
    let vivo = true;
    void atribucionVentas(id, dias).then((a) => { if (vivo) setAtrib(a); }).catch(() => {});
    return () => { vivo = false; };
  }, [id, c?.enviada_at, dias]);

  // Contar destinatarios del segmento elegido (para mostrar "a X contactos").
  useEffect(() => {
    let vivo = true;
    void listSegmento(seg, 5000).then(({ data }) => {
      if (!vivo) return;
      setCount(data.filter((x) => x.email && (x as { acepta_marketing?: boolean }).acepta_marketing).length);
    });
    return () => { vivo = false; };
  }, [seg]);

  const setCampo = (k: keyof MktCampana, v: string) => setC((p) => (p ? { ...p, [k]: v } : p));

  async function guardar(silencioso = false) {
    if (!c) return;
    setGuardando(true);
    try {
      await actualizarCampana(id, {
        nombre: c.nombre, asunto: c.asunto, preheader: c.preheader, from_nombre: c.from_nombre,
        from_email: c.from_email, reply_to: c.reply_to, html: c.html, segmento_nombre: SEGMENTOS.find((s) => s.key === seg)?.label,
      });
      if (!silencioso) toast.success('Guardado');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'No se pudo guardar'); }
    setGuardando(false);
  }

  async function prueba() {
    if (!emailPrueba.includes('@')) { toast.error('Poné un email válido'); return; }
    await guardar(true);
    const r = await enviarPrueba(id, emailPrueba);
    if (r.ok) toast.success(`Prueba enviada a ${emailPrueba}`);
    else toast.error(r.error || 'No se pudo enviar la prueba');
  }

  async function enviar() {
    if (!c) return;
    if (!c.asunto.trim()) { toast.error('Falta el asunto'); return; }
    if (!window.confirm(`Enviar "${c.nombre}" a ${count ?? '?'} contactos (${SEGMENTOS.find((s) => s.key === seg)?.label})?`)) return;
    await guardar(true);
    setEnviando(true); setProgreso({ enviados: 0, restantes: count ?? 0 });
    try {
      const { data } = await listSegmento(seg, 5000);
      const ids = data.filter((x) => x.email && (x as { acepta_marketing?: boolean }).acepta_marketing).map((x) => x.id as number);
      const r = await enviarCampana(id, ids, setProgreso);
      if (r.ok) { toast.success(`Campaña enviada a ${r.enviados} contactos`); onVolver(); }
      else toast.error(r.error || 'Error enviando');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error'); }
    setEnviando(false);
  }

  if (!c) return <div className="text-center py-16 text-ink-muted">Cargando…</div>;
  const bloqueado = c.estado === 'enviada' || c.estado === 'enviando';

  return (
    <div className="max-w-6xl mx-auto">
      <button onClick={onVolver} className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink mb-4"><ChevronLeft className="h-4 w-4" /> Volver</button>

      <div className="grid md:grid-cols-2 gap-5">
        {/* Columna edición */}
        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-ink-soft">Nombre interno</label>
            <input value={c.nombre} disabled={bloqueado} onChange={(e) => setCampo('nombre', e.target.value)}
              className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="Ej: Promo agosto" />
          </div>
          <div>
            <label className="text-xs font-medium text-ink-soft">Asunto</label>
            <input value={c.asunto} disabled={bloqueado} onChange={(e) => setCampo('asunto', e.target.value)}
              className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="Lo que ve el contacto en su bandeja" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-ink-soft">Remitente (nombre)</label>
              <input value={c.from_nombre ?? ''} disabled={bloqueado} onChange={(e) => setCampo('from_nombre', e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="Neko" />
            </div>
            <div>
              <label className="text-xs font-medium text-ink-soft">Responder a</label>
              <input value={c.reply_to ?? ''} disabled={bloqueado} onChange={(e) => setCampo('reply_to', e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="hola@..." />
            </div>
          </div>
          <p className="-mt-2 text-xs text-ink-muted">Envía desde <b>{c.from_email || 'hola@mailing.comanda.lat'}</b>{marca ? ` · marca ${marca.nombre}` : ''}. Cambiá la marca en el sidebar.</p>
          <div>
            <label className="text-xs font-medium text-ink-soft flex items-center gap-1"><Users className="h-3.5 w-3.5" /> Audiencia</label>
            <select value={seg} disabled={bloqueado} onChange={(e) => setSeg(e.target.value as SegmentoKey)}
              className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm bg-white">
              {SEGMENTOS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <p className="text-xs text-ink-muted mt-1">{count === null ? 'Contando…' : `${count} contactos con email y opt-in`}</p>
          </div>
          <div>
            <label className="text-xs font-medium text-ink-soft">Contenido (HTML)</label>
            <textarea value={c.html} disabled={bloqueado} onChange={(e) => setCampo('html', e.target.value)} rows={12}
              className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-xs font-mono" />
            <p className="text-xs text-ink-muted mt-1">Etiquetas: <code>{'{{nombre}}'}</code>, <code>{'{{email}}'}</code>, <code>{'{{unsubscribe}}'}</code> (link de baja).</p>
          </div>
        </div>

        {/* Columna preview + acciones */}
        <div className="space-y-4">
          <div>
            <div className="text-xs font-medium text-ink-soft mb-1 flex items-center gap-1"><Eye className="h-3.5 w-3.5" /> Vista previa</div>
            <div className="border border-ink/15 rounded-lg bg-white p-4 min-h-[240px] overflow-auto">
              <iframe title="preview" className="w-full h-[360px] border-0" srcDoc={c.html.replace(/\{\{\s*nombre\s*\}\}/g, 'Ana').replace(/\{\{\s*email\s*\}\}/g, 'ana@mail.com').replace(/\{\{\s*unsubscribe\s*\}\}/g, '#')} />
            </div>
          </div>

          {!bloqueado && (
            <>
              <div className="flex gap-2">
                <input value={emailPrueba} onChange={(e) => setEmailPrueba(e.target.value)} placeholder="tu@email.com para prueba"
                  className="flex-1 rounded-lg border border-ink/15 px-3 py-2 text-sm" />
                <button onClick={prueba} className="rounded-lg border border-ink/15 px-3 py-2 text-sm hover:bg-ink/5">Prueba</button>
              </div>
              <div className="flex gap-2">
                <button onClick={() => guardar()} disabled={guardando} className="flex-1 rounded-lg border border-ink/15 px-3 py-2 text-sm font-medium hover:bg-ink/5">
                  {guardando ? 'Guardando…' : 'Guardar borrador'}
                </button>
                <button onClick={enviar} disabled={enviando} className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand-600 text-white px-3 py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-60">
                  <Send className="h-4 w-4" /> {enviando ? 'Enviando…' : `Enviar a ${count ?? '…'}`}
                </button>
              </div>
              <button onClick={async () => { if (window.confirm('¿Eliminar esta campaña?')) { await eliminarCampana(id); onVolver(); } }}
                className="inline-flex items-center gap-1 text-xs text-red-600 hover:underline"><Trash2 className="h-3.5 w-3.5" /> Eliminar</button>
            </>
          )}

          {progreso && (
            <div className="rounded-lg bg-brand-50 p-3">
              <div className="flex justify-between text-xs text-brand-700 mb-1">
                <span>Enviando…</span><span>{progreso.enviados} enviados · {progreso.restantes} restantes</span>
              </div>
              <div className="h-1.5 bg-brand-100 rounded-full overflow-hidden">
                <div className="h-full bg-brand-600 transition-all" style={{ width: `${progreso.enviados + progreso.restantes ? (progreso.enviados / (progreso.enviados + progreso.restantes)) * 100 : 0}%` }} />
              </div>
            </div>
          )}

          {bloqueado && (
            <div className="rounded-lg border border-ink/10 p-4">
              <div className="text-sm font-medium flex items-center gap-1.5 mb-3"><BarChart3 className="h-4 w-4 text-brand-600" /> Resultados</div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Metrica label="Enviados" valor={c.total_enviados} />
                <Metrica label="Entregados" valor={c.total_entregados} />
                <Metrica label="Aperturas" valor={`${c.total_aperturas} (${tasaApertura(c)}%)`} />
                <Metrica label="Clicks" valor={`${c.total_clicks} (${tasaClick(c)}%)`} />
                <Metrica label="Rebotes" valor={c.total_rebotes} />
                <Metrica label="Bajas" valor={c.total_bajas} />
              </div>

              <div className="mt-4 pt-4 border-t border-ink/10">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-medium">Ventas atribuidas</div>
                  <select value={dias} onChange={(e) => setDias(Number(e.target.value))}
                    className="text-xs rounded-md border border-ink/15 px-2 py-1 bg-white">
                    <option value={7}>7 días</option>
                    <option value={14}>14 días</option>
                    <option value={30}>30 días</option>
                  </select>
                </div>
                {atrib === null ? (
                  <div className="text-xs text-ink-muted">Calculando…</div>
                ) : (
                  <div className="grid grid-cols-3 gap-3">
                    <Metrica label="Ingresos" valor={`$${atrib.ingresos.toLocaleString('es-AR')}`} />
                    <Metrica label="Compradores" valor={atrib.compradores} />
                    <Metrica label="Ventas" valor={atrib.ventas} />
                  </div>
                )}
                <p className="text-xs text-ink-muted mt-2">Ventas de contactos que recibieron la campaña, dentro de {dias} días del envío.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Metrica({ label, valor }: { label: string; valor: number | string }) {
  return (
    <div className="rounded-lg bg-ink/[0.03] px-3 py-2">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{valor}</div>
    </div>
  );
}
