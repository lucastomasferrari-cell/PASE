// Widget de soporte en COMANDA. Mismo diseño funcional que el de PASE pero
// con Tailwind y radix. Llama a /api/claude (vive en pase-yndx.vercel.app
// pero COMANDA hoy se sirve embebida en PASE bajo /comanda-app/*, así que
// fetch relativo funciona). Si en algún momento COMANDA se despliega en un
// dominio distinto, hay que agregar CORS al endpoint o usar URL absoluta.

import { useState, useRef, useEffect } from 'react';
import { LifeBuoy, X, Send, Bug, RotateCcw } from 'lucide-react';
import { db } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

export function SoporteWidget() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [reportando, setReportando] = useState(false);
  const [reporteOk, setReporteOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Screenshot adjunto (2026-05-20): paste con Ctrl+V, drop, o file picker.
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function aceptarImagen(f: File) {
    if (!f.type.startsWith('image/')) {
      setError('Solo imágenes (PNG, JPG, GIF, WebP)');
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      setError('Imagen > 5MB. Comprimila o usá screenshot más chico.');
      return;
    }
    setScreenshotFile(f);
    setError(null);
    const reader = new FileReader();
    reader.onload = (e) => setScreenshotPreview(typeof e.target?.result === 'string' ? e.target.result : null);
    reader.readAsDataURL(f);
  }

  function quitarImagen() {
    setScreenshotFile(null);
    setScreenshotPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) { e.preventDefault(); aceptarImagen(f); return; }
      }
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) aceptarImagen(f);
  }

  async function resizeImage(file: File, maxWidth = 1600): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = img.width > maxWidth ? maxWidth / img.width : 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('Canvas null')); return; }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error('toBlob failed')),
          file.type === 'image/png' ? 'image/png' : 'image/jpeg',
          0.85,
        );
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
      img.src = url;
    });
  }

  async function uploadScreenshot(file: File, tenantId: string): Promise<string | null> {
    try {
      const resized = await resizeImage(file);
      const ext = file.type === 'image/png' ? 'png' : 'jpg';
      const path = `${tenantId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error: upErr } = await db.storage
        .from('soporte-screenshots')
        .upload(path, resized, { cacheControl: '3600', contentType: file.type });
      if (upErr) { console.error('Upload error:', upErr); return null; }
      const { data: pub } = db.storage.from('soporte-screenshots').getPublicUrl(path);
      return pub.publicUrl ?? null;
    } catch (e) {
      console.error('uploadScreenshot:', e);
      return null;
    }
  }

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [msgs, open]);

  // Guard antes de los handlers para que TS sepa que user no es null adentro.
  // (Early return en componente no propaga la narrowing a funciones inner.)
  if (!user) return null;
  const u = user;

  async function enviar() {
    const text = input.trim();
    if (!text || loading) return;
    setError(null);
    setReporteOk(false);
    const nuevoMsgs: ChatMsg[] = [...msgs, { role: 'user', content: text }];
    setMsgs(nuevoMsgs);
    setInput('');
    setLoading(true);
    try {
      const { data: sess } = await db.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error('Sesión expirada. Refrescá la página.');

      const resp = await fetch('/api/claude', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          task: 'soporte-chat',
          messages: nuevoMsgs.map((m) => ({ role: m.role, content: m.content })),
          contexto: {
            sistema: 'comanda',
            pantalla: window.location.pathname,
            rol: u.rol,
            email: u.email,
          },
        }),
      });
      const json = await resp.json();
      if (!resp.ok) {
        throw new Error(json?.error?.message || json?.error || `HTTP ${resp.status}`);
      }
      const respText = json.content?.[0]?.text || json.content?.text || '(Respuesta vacía)';
      setMsgs((prev) => [...prev, { role: 'assistant', content: respText }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function reportarBug() {
    if (msgs.length === 0 || reportando) return;
    if (!u.tenant_id) {
      setError('No hay tenant asociado al usuario. No se puede crear ticket.');
      return;
    }
    setReportando(true);
    setError(null);
    try {
      let screenshotUrl: string | null = null;
      if (screenshotFile) {
        screenshotUrl = await uploadScreenshot(screenshotFile, u.tenant_id);
        if (!screenshotUrl) console.warn('Screenshot no se pudo subir, reportando sin imagen');
      }

      const ultimaUser = [...msgs].reverse().find((m) => m.role === 'user');
      const ultimaAssistant = [...msgs].reverse().find((m) => m.role === 'assistant');
      const { error: rpcErr } = await db.from('tickets_soporte').insert({
        tenant_id: u.tenant_id,
        autor_user_id: u.id,
        autor_email: u.email,
        autor_rol: u.rol,
        sistema: 'comanda',
        pantalla_origen: window.location.pathname,
        mensaje: ultimaUser?.content || '(sin mensaje)',
        categoria: 'bug',
        prioridad: 'media',
        respuesta_llm: ultimaAssistant?.content || null,
        screenshot_url: screenshotUrl,
        contexto_jsonb: {
          historial: msgs,
          user_agent: navigator.userAgent,
          url_completa: window.location.href,
          screenshot_url: screenshotUrl,
        },
      });
      if (rpcErr) throw rpcErr;
      setReporteOk(true);
      setMsgs((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: '✓ Reporte enviado a Lucas. Vas a recibir respuesta cuando lo atienda.',
        },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReportando(false);
    }
  }

  function reset() {
    setMsgs([]);
    setInput('');
    setError(null);
    setReporteOk(false);
    quitarImagen();
  }

  return (
    <>
      {/* Botón flotante */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="fixed bottom-5 right-5 z-[9000] w-13 h-13 rounded-full bg-primary text-primary-foreground shadow-lg hover:scale-105 transition-transform flex items-center justify-center"
        style={{ width: 52, height: 52 }}
        title="Ayuda / Soporte"
        aria-label="Abrir soporte"
      >
        <LifeBuoy className="w-5 h-5" />
      </button>

      {open && (
        <div
          className="fixed right-5 z-[9001] bg-card border border-border rounded-lg shadow-2xl flex flex-col"
          style={{
            bottom: 84,
            width: 400,
            maxWidth: 'calc(100vw - 40px)',
            height: 560,
            maxHeight: 'calc(100vh - 110px)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <header className="px-4 py-3 border-b border-border flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">Ayuda COMANDA</div>
              <div className="text-[10px] text-muted-foreground">
                Te respondo dudas o reporto un bug a Lucas.
              </div>
            </div>
            {msgs.length > 0 && (
              <button
                onClick={reset}
                className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-border text-muted-foreground hover:bg-accent flex items-center gap-1"
                title="Empezar conversación nueva"
              >
                <RotateCcw className="w-3 h-3" />
                Nuevo
              </button>
            )}
            <button
              onClick={() => setOpen(false)}
              className="w-7 h-7 rounded hover:bg-accent flex items-center justify-center text-muted-foreground"
              aria-label="Cerrar"
            >
              <X className="w-4 h-4" />
            </button>
          </header>

          {/* Body */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2 text-sm">
            {msgs.length === 0 && (
              <div className="text-xs text-muted-foreground">
                Hola. Escribime tu duda &mdash; ej: <em>"¿Cómo cobro una venta con dos formas de pago?"</em>,
                <em>"No me deja partir una cuenta"</em>, <em>"Para qué sirve mandar curso"</em>.
                Si no resuelvo, podés convertirlo en ticket para Lucas.
              </div>
            )}
            {msgs.map((m, i) => (
              <div
                key={i}
                className={cn(
                  'rounded-lg px-3 py-2 border whitespace-pre-wrap leading-snug',
                  'max-w-[85%]',
                  m.role === 'user'
                    ? 'self-end bg-primary/10 border-primary/20'
                    : 'self-start bg-muted border-border',
                )}
              >
                {m.content}
              </div>
            ))}
            {loading && (
              <div className="text-xs text-muted-foreground italic">Pensando…</div>
            )}
            {error && (
              <div className="text-xs text-destructive p-2 rounded border border-destructive/30 bg-destructive/5">
                Error: {error}
              </div>
            )}
          </div>

          {/* Footer */}
          <footer
            className={cn(
              'border-t border-border p-3 space-y-2 transition-colors',
              dragOver && 'bg-primary/10'
            )}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            {/* Thumbnail screenshot */}
            {screenshotPreview && (
              <div className="flex items-center gap-2 p-1.5 bg-muted rounded border border-border">
                <img
                  src={screenshotPreview}
                  alt="Screenshot adjunto"
                  className="w-12 h-12 object-cover rounded border border-border"
                />
                <div className="flex-1 min-w-0 text-xs text-muted-foreground">
                  {screenshotFile?.name ?? 'imagen pegada'}
                  {screenshotFile && (
                    <span className="ml-1.5">({Math.round((screenshotFile.size / 1024))} KB)</span>
                  )}
                </div>
                <button
                  onClick={quitarImagen}
                  className="text-muted-foreground hover:text-destructive p-1"
                  title="Quitar imagen"
                  type="button"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void enviar();
                }
              }}
              onPaste={handlePaste}
              placeholder="Escribí tu duda y enter… (podés pegar screenshots con Ctrl+V)"
              rows={2}
              className="w-full px-2 py-1.5 rounded bg-muted border border-border text-sm focus:outline-none focus:border-primary resize-none"
            />

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) aceptarImagen(f);
              }}
            />

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-2.5 py-1.5 rounded bg-muted border border-border text-sm hover:bg-accent"
                title="Adjuntar imagen (también con Ctrl+V o drag)"
              >
                📎
              </button>
              <button
                type="button"
                onClick={() => void enviar()}
                disabled={!input.trim() || loading}
                className="flex-1 px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity flex items-center justify-center gap-1.5"
              >
                <Send className="w-3.5 h-3.5" />
                {loading ? '…' : 'Enviar'}
              </button>
              {msgs.some((m) => m.role === 'assistant') && !reporteOk && (
                <button
                  type="button"
                  onClick={() => void reportarBug()}
                  disabled={reportando}
                  className="px-3 py-1.5 rounded border border-border text-sm hover:bg-accent disabled:opacity-40 flex items-center gap-1.5"
                  title="Persiste este chat como ticket para que Lucas lo atienda"
                >
                  <Bug className="w-3.5 h-3.5" />
                  {reportando ? 'Enviando…' : 'Reportar bug'}
                </button>
              )}
            </div>
            {dragOver && (
              <div className="text-xs text-primary text-center p-1.5 border border-dashed border-primary rounded">
                Soltá la imagen acá…
              </div>
            )}
          </footer>
        </div>
      )}
    </>
  );
}
