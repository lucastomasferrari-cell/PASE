// CampaignComposer — modal para lanzar una campaña sobre un grupo de comensales.
// Elegís canal (WhatsApp / Email), una plantilla, editás el mensaje, y:
//  · WhatsApp → lista de links wa.me por cliente (mandás 1x1, marcás enviado)
//  · Email → mailto con BCC de todos los que tienen email
// Sin API: el envío masivo automático se enchufa cuando esté la WA Business API.

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { X, MessageCircle, Mail, Copy, Check } from 'lucide-react';
import type { Cliente } from '@/lib/clientesService';
import { whatsAppUrl, plantillasPara, aplicarPlantilla } from '@/lib/campanasService';

function nombreCliente(c: Cliente) {
  return [c.nombre, c.apellido].filter(Boolean).join(' ').trim() || c.telefono || 'Sin nombre';
}

export function CampaignComposer({ clientes, segmentoLabel, sugerencia, onClose }: {
  clientes: Cliente[];
  segmentoLabel: string;
  sugerencia: string;
  onClose: () => void;
}) {
  const plantillas = useMemo(() => plantillasPara(sugerencia), [sugerencia]);
  const [canal, setCanal] = useState<'whatsapp' | 'email'>('whatsapp');
  const [texto, setTexto] = useState(plantillas[0]?.texto ?? 'Hola {nombre}!');
  const [enviados, setEnviados] = useState<Set<number>>(new Set());

  const conTel = clientes.filter((c) => c.telefono);
  const conEmail = clientes.filter((c) => c.email);

  function marcarEnviado(id: number) {
    setEnviados((s) => new Set(s).add(id));
  }

  function mailtoBCC() {
    const emails = conEmail.map((c) => c.email).filter(Boolean).join(',');
    if (!emails) { toast.error('Nadie de este grupo tiene email'); return; }
    // El email no soporta {nombre} por persona en un solo mailto → mensaje genérico.
    const cuerpo = aplicarPlantilla(texto, null);
    window.location.href = `mailto:?bcc=${encodeURIComponent(emails)}&body=${encodeURIComponent(cuerpo)}`;
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-lg max-h-[90vh] bg-white rounded-t-2xl sm:rounded-2xl shadow-card flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 pt-5 pb-3 flex items-center justify-between shrink-0">
          <div>
            <h3 className="font-display text-xl font-semibold">Campaña</h3>
            <p className="text-xs text-ink-muted">{segmentoLabel} · {clientes.length} comensales</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-ink/5 text-ink-soft"><X className="h-5 w-5" /></button>
        </header>

        <div className="px-5 pb-5 overflow-y-auto space-y-4">
          {/* Canal */}
          <div className="flex gap-2">
            <button onClick={() => setCanal('whatsapp')}
                    className={`flex-1 rounded-lg py-2 text-sm font-medium inline-flex items-center justify-center gap-1.5 border ${
                      canal === 'whatsapp' ? 'bg-emerald-500 text-white border-transparent' : 'bg-white border-ink/15 text-ink-soft'
                    }`}>
              <MessageCircle className="h-4 w-4" /> WhatsApp ({conTel.length})
            </button>
            <button onClick={() => setCanal('email')}
                    className={`flex-1 rounded-lg py-2 text-sm font-medium inline-flex items-center justify-center gap-1.5 border ${
                      canal === 'email' ? 'bg-brand-500 text-white border-transparent' : 'bg-white border-ink/15 text-ink-soft'
                    }`}>
              <Mail className="h-4 w-4" /> Email ({conEmail.length})
            </button>
          </div>

          {/* Plantillas */}
          <div className="flex flex-wrap gap-1.5">
            {plantillas.map((p) => (
              <button key={p.key} onClick={() => setTexto(p.texto)}
                      className="text-xs px-2.5 py-1 rounded-full border border-ink/15 bg-white hover:border-brand-300 text-ink-soft">
                {p.label}
              </button>
            ))}
          </div>

          {/* Mensaje */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Mensaje (usá {'{nombre}'} y se reemplaza por cada cliente)</label>
            <textarea rows={4} value={texto} onChange={(e) => setTexto(e.target.value)}
                      className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            <button onClick={() => void navigator.clipboard.writeText(aplicarPlantilla(texto, null)).then(() => toast.success('Mensaje copiado'))}
                    className="text-xs text-brand-600 hover:underline inline-flex items-center gap-1">
              <Copy className="h-3 w-3" /> Copiar mensaje
            </button>
          </div>

          {/* Acción por canal */}
          {canal === 'whatsapp' ? (
            <div className="space-y-2">
              <p className="text-xs text-ink-muted">Tocá cada uno para abrir WhatsApp con el mensaje listo. Marcá los que ya mandaste.</p>
              {conTel.length === 0 ? (
                <p className="text-sm text-ink-muted py-4 text-center">Nadie de este grupo tiene teléfono.</p>
              ) : (
                <div className="border border-ink/10 rounded-xl divide-y divide-ink/5 max-h-64 overflow-y-auto">
                  {conTel.map((c) => {
                    const url = whatsAppUrl(c.telefono, aplicarPlantilla(texto, nombreCliente(c)));
                    const ya = enviados.has(c.id);
                    return (
                      <div key={c.id} className={`flex items-center gap-2 px-3 py-2 ${ya ? 'opacity-50' : ''}`}>
                        <span className="flex-1 text-sm truncate">{nombreCliente(c)}</span>
                        {url && (
                          <a href={url} target="_blank" rel="noopener noreferrer" onClick={() => marcarEnviado(c.id)}
                             className="text-xs px-2.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white font-medium inline-flex items-center gap-1">
                            {ya ? <Check className="h-3.5 w-3.5" /> : <MessageCircle className="h-3.5 w-3.5" />}
                            {ya ? 'Enviado' : 'Enviar'}
                          </a>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="text-[11px] text-ink-muted">El envío masivo automático llega cuando conectemos la WhatsApp Business API.</p>
            </div>
          ) : (
            <div className="space-y-2">
              <button onClick={mailtoBCC} disabled={conEmail.length === 0}
                      className="w-full rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2.5 text-sm font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-50">
                <Mail className="h-4 w-4" /> Abrir email a {conEmail.length} contactos (BCC)
              </button>
              <button onClick={() => void navigator.clipboard.writeText(conEmail.map((c) => c.email).join(', ')).then(() => toast.success('Emails copiados'))}
                      disabled={conEmail.length === 0}
                      className="w-full rounded-lg border border-ink/15 hover:bg-ink/5 py-2 text-sm font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-50">
                <Copy className="h-4 w-4" /> Copiar emails (para tu herramienta de mailing)
              </button>
              <p className="text-[11px] text-ink-muted">En email el {'{nombre}'} no se personaliza por persona (es un solo envío BCC).</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
