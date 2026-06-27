// Segmentos y campañas — explorá grupos de comensales (perdidos, en riesgo,
// recurrentes, etc.) y lanzá campañas (WhatsApp/email) sobre cada uno.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ChevronLeft, Download, Send, Phone, Users } from 'lucide-react';
import { SEGMENTOS, contarSegmento, listSegmento, type SegmentoDef } from '@/lib/segmentosService';
import type { Cliente } from '@/lib/clientesService';
import { CampaignComposer } from '@/components/CampaignComposer';

function nombreCliente(c: Cliente) {
  return [c.nombre, c.apellido].filter(Boolean).join(' ').trim() || c.telefono || 'Sin nombre';
}
function fechaCorta(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
}

export function Segmentos() {
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const [sel, setSel] = useState<SegmentoDef | null>(null);
  const [lista, setLista] = useState<Cliente[]>([]);
  const [cargandoLista, setCargandoLista] = useState(false);
  const [campana, setCampana] = useState(false);

  useEffect(() => {
    let vivo = true;
    void (async () => {
      for (const s of SEGMENTOS) {
        const n = await contarSegmento(s.key);
        if (!vivo) return;
        setCounts((prev) => ({ ...prev, [s.key]: n }));
      }
    })();
    return () => { vivo = false; };
  }, []);

  const abrir = useCallback(async (s: SegmentoDef) => {
    setSel(s); setCargandoLista(true); setLista([]);
    const { data, error } = await listSegmento(s.key);
    if (error) toast.error(error);
    setLista(data);
    setCargandoLista(false);
  }, []);

  function exportar() {
    if (!sel) return;
    const headers = ['Nombre', 'Teléfono', 'Email', 'Pedidos', 'Gastado', 'Último'];
    const rows = lista.map((c) => [
      nombreCliente(c), c.telefono ?? '', c.email ?? '',
      String(c.total_pedidos ?? 0), String(c.total_gastado ?? 0),
      c.ultimo_pedido_at ? fechaCorta(c.ultimo_pedido_at) : '',
    ]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `segmento-${sel.key}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  // ── Drilldown de un segmento ──
  if (sel) {
    return (
      <div className="space-y-4 max-w-3xl">
        <button onClick={() => setSel(null)} className="text-sm text-ink-soft hover:text-ink inline-flex items-center gap-1">
          <ChevronLeft className="h-4 w-4" /> Volver a segmentos
        </button>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-2xl font-medium">{sel.emoji} {sel.label}</h2>
            <p className="text-sm text-ink-muted">{sel.descripcion}</p>
            <p className="text-sm text-ink-soft mt-1">{lista.length} comensales</p>
          </div>
          <div className="flex gap-2">
            <button onClick={exportar} disabled={lista.length === 0}
                    className="rounded-lg border border-ink/15 bg-white hover:bg-ink/5 px-3 py-2 text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50">
              <Download className="h-4 w-4" /> Exportar
            </button>
            <button onClick={() => setCampana(true)} disabled={lista.length === 0}
                    className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-3.5 py-2 text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50">
              <Send className="h-4 w-4" /> Lanzar campaña
            </button>
          </div>
        </div>

        {cargandoLista ? (
          <div className="py-16 text-center text-ink-muted">Cargando…</div>
        ) : lista.length === 0 ? (
          <div className="rounded-2xl bg-white border border-ink/5 shadow-card py-14 text-center">
            <p className="font-medium">No hay comensales en este segmento</p>
          </div>
        ) : (
          <div className="rounded-2xl bg-white border border-ink/5 shadow-card divide-y divide-ink/5">
            {lista.map((c) => (
              <div key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="w-9 h-9 rounded-full bg-brand-100 text-brand-700 grid place-items-center font-medium text-sm shrink-0">
                  {(nombreCliente(c)[0] ?? '?').toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{nombreCliente(c)}</div>
                  <div className="text-xs text-ink-muted flex items-center gap-2">
                    {c.telefono && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{c.telefono}</span>}
                  </div>
                </div>
                <div className="text-right shrink-0 text-xs text-ink-muted">
                  <div>{c.total_pedidos ?? 0} pedidos</div>
                  <div>últ: {fechaCorta(c.ultimo_pedido_at)}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {campana && (
          <CampaignComposer clientes={lista} segmentoLabel={sel.label} sugerencia={sel.sugerencia} onClose={() => setCampana(false)} />
        )}
      </div>
    );
  }

  // ── Grilla de segmentos ──
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-muted max-w-2xl">
        Grupos automáticos de comensales según su comportamiento. Tocá uno para ver la lista y lanzar una campaña de WhatsApp o email.
      </p>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {SEGMENTOS.map((s) => (
          <button key={s.key} onClick={() => void abrir(s)}
                  className="text-left rounded-2xl bg-white border border-ink/5 shadow-card p-4 hover:border-brand-300 hover:-translate-y-0.5 transition-all">
            <div className="flex items-start justify-between">
              <span className="text-2xl">{s.emoji}</span>
              <span className="text-2xl font-medium text-ink tabular-nums">
                {counts[s.key] == null ? '…' : counts[s.key]}
              </span>
            </div>
            <div className="mt-2 font-medium inline-flex items-center gap-1.5">
              <Users className="h-4 w-4 text-brand-500" />{s.label}
            </div>
            <p className="text-xs text-ink-muted mt-1 leading-snug">{s.descripcion}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
