import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, Minus, ShoppingCart, X, Check } from 'lucide-react';
import { toast, Toaster } from 'sonner';
import { getLocalPorToken, getCatalogoPorToken, crearPedidoMenuQr, type MenuQrLocal, type MenuQrItem } from '@/services/menuQrService';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatARS } from '@/lib/format';
import { menuQrCart, type MenuQrCartItem } from './carritoMenuStore';

export function MenuQrView() {
  const { token } = useParams<{ token: string }>();
  const tk = token ?? '';
  const [local, setLocal] = useState<MenuQrLocal | null>(null);
  const [catalogo, setCatalogo] = useState<MenuQrItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [grupoActivo, setGrupoActivo] = useState<number | null>(null);
  const [carritoOpen, setCarritoOpen] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [confirmado, setConfirmado] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const carrito = useSyncExternalStore(
    cb => menuQrCart.subscribe(tk, cb),
    () => menuQrCart.get(tk),
  );
  const subtotal = carrito.reduce((s, x) => s + x.precio * x.cantidad, 0);

  useEffect(() => {
    if (!tk) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([getLocalPorToken(tk), getCatalogoPorToken(tk)]).then(([l, c]) => {
      if (cancelled) return;
      if (l.error || !l.data) { setError(l.error ?? 'Token inválido'); setLoading(false); return; }
      setLocal(l.data);
      setCatalogo(c.data);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [tk]);

  const grupos = useMemo(() => {
    const map = new Map<number, { id: number; nombre: string; emoji: string | null; orden: number }>();
    for (const it of catalogo) {
      if (it.grupo_id != null && !map.has(it.grupo_id)) {
        map.set(it.grupo_id, {
          id: it.grupo_id, nombre: it.grupo_nombre ?? '',
          emoji: it.grupo_emoji, orden: it.grupo_orden ?? 0,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.orden - b.orden);
  }, [catalogo]);

  useEffect(() => {
    if (grupoActivo == null && grupos.length > 0) setGrupoActivo(grupos[0]!.id);
  }, [grupos, grupoActivo]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-center">
        <div>
          <div className="text-5xl mb-3">📵</div>
          <h1 className="font-semibold">QR vencido o inválido</h1>
          <p className="text-sm text-muted-foreground mt-2">Pedile al mozo que regenere el QR de esta mesa.</p>
        </div>
      </div>
    );
  }
  if (loading || !local) {
    return (
      <div className="min-h-screen p-4 space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const itemsDelGrupo = grupoActivo == null ? catalogo : catalogo.filter(i => i.grupo_id === grupoActivo);
  const puedePedir = local.modo !== 'readonly';

  function agregar(it: MenuQrItem) {
    const next = [...carrito];
    const idx = next.findIndex(x => x.item_id === it.item_id);
    if (idx >= 0) next[idx] = { ...next[idx]!, cantidad: next[idx]!.cantidad + 1 };
    else next.push({
      item_id: it.item_id, nombre: it.nombre, emoji: it.emoji,
      precio: Number(it.precio) || 0, cantidad: 1, notas: '',
    } satisfies MenuQrCartItem);
    menuQrCart.set(tk, next);
  }

  function setCantidad(idx: number, delta: number) {
    const next = [...carrito];
    const target = next[idx];
    if (!target) return;
    const nueva = target.cantidad + delta;
    if (nueva <= 0) menuQrCart.set(tk, next.filter((_, i) => i !== idx));
    else menuQrCart.set(tk, next.map((x, i) => i === idx ? { ...x, cantidad: nueva } : x));
  }

  async function confirmar() {
    if (carrito.length === 0) { toast.error('Carrito vacío'); return; }
    setEnviando(true);
    const idempotencyKey = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { ventaId, error: err } = await crearPedidoMenuQr({
      token: tk,
      items: carrito.map(c => ({ item_id: c.item_id, cantidad: c.cantidad })),
      idempotencyKey,
      notas: null,
    });
    setEnviando(false);
    if (err || !ventaId) { toast.error('No se pudo enviar', { description: err ?? '' }); return; }
    menuQrCart.clear(tk);
    setCarritoOpen(false);
    setConfirmado(ventaId);
  }

  function llamarMozo() {
    // Stub: la notificación real al POS queda como deuda.
    toast.success('Avisamos al mozo', { description: 'Se acerca enseguida.' });
  }

  return (
    <div className="min-h-screen bg-background pb-20">
      <Toaster position="top-center" richColors />
      <header className="bg-primary text-primary-foreground sticky top-0 z-30 shadow">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-base font-semibold truncate">{local.local_nombre}</h1>
            <p className="text-xs text-primary-foreground/80">Mesa {local.mesa_numero}{local.mesa_zona ? ` · ${local.mesa_zona}` : ''}</p>
          </div>
          {puedePedir && (
            <button type="button" onClick={llamarMozo} className="text-xs underline whitespace-nowrap opacity-90 hover:opacity-100">
              Llamar mozo
            </button>
          )}
        </div>
      </header>

      {confirmado && (
        <div className="max-w-3xl mx-auto p-4">
          <div className="rounded-md border border-emerald-500 bg-emerald-50 p-4 flex items-center gap-3">
            <Check className="h-6 w-6 text-emerald-600 flex-shrink-0" />
            <div className="text-sm">
              <div className="font-semibold">Pedido enviado · #{confirmado}</div>
              <div className="text-xs text-muted-foreground">
                {local.modo === 'autonomo' ? 'Está siendo preparado.' : 'El mozo lo va a confirmar enseguida.'}
              </div>
            </div>
            <button type="button" onClick={() => setConfirmado(null)} className="ml-auto text-emerald-700"><X className="h-4 w-4" /></button>
          </div>
        </div>
      )}

      <div className="max-w-3xl mx-auto">
        <div className="px-2 py-2 overflow-x-auto whitespace-nowrap border-b border-border">
          {grupos.map(g => (
            <button
              key={g.id}
              type="button"
              onClick={() => setGrupoActivo(g.id)}
              className={`px-3 h-9 mr-2 inline-flex items-center rounded-full text-xs font-medium border ${
                grupoActivo === g.id ? 'bg-primary text-primary-foreground border-primary' : 'border-border'
              }`}
            >
              {g.emoji ? `${g.emoji} ` : ''}{g.nombre}
            </button>
          ))}
        </div>

        <div className="p-4 space-y-3">
          {itemsDelGrupo.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-8">Sin productos.</p>
          ) : (
            itemsDelGrupo.map(it => (
              <article key={it.item_id} className="border border-border rounded-md p-3 flex gap-3">
                <div className="text-3xl flex-shrink-0">{it.emoji ?? '🍽️'}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-medium leading-tight">{it.nombre}</h3>
                    <span className="text-sm font-semibold whitespace-nowrap">{formatARS(Number(it.precio))}</span>
                  </div>
                  {it.descripcion && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{it.descripcion}</p>}
                </div>
                {puedePedir && (
                  <Button size="icon" className="h-9 w-9 self-center" onClick={() => agregar(it)} aria-label="Agregar">
                    <Plus className="h-4 w-4" />
                  </Button>
                )}
              </article>
            ))
          )}
        </div>
      </div>

      {puedePedir && carrito.length > 0 && (
        <button
          type="button"
          onClick={() => setCarritoOpen(true)}
          className="fixed bottom-0 left-0 right-0 h-14 bg-primary text-primary-foreground flex items-center justify-between px-5 text-sm font-medium shadow-lg z-30"
        >
          <span className="flex items-center gap-2"><ShoppingCart className="h-4 w-4" /> Ver carrito ({carrito.reduce((s, x) => s + x.cantidad, 0)})</span>
          <span className="font-semibold">{formatARS(subtotal)}</span>
        </button>
      )}

      {carritoOpen && (
        <div className="fixed inset-0 z-40 bg-black/40" onClick={() => setCarritoOpen(false)}>
          <div className="absolute bottom-0 left-0 right-0 bg-background rounded-t-2xl max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-border flex items-center justify-between sticky top-0 bg-background">
              <h2 className="font-semibold text-sm">Tu pedido</h2>
              <button type="button" onClick={() => setCarritoOpen(false)} aria-label="Cerrar"><X className="h-5 w-5" /></button>
            </div>
            <div className="p-4 space-y-3">
              {carrito.map((it, idx) => (
                <div key={idx} className="flex items-center gap-3">
                  <span className="text-2xl">{it.emoji ?? '🍽️'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{it.nombre}</div>
                    <div className="text-xs text-muted-foreground">{formatARS(it.precio)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => setCantidad(idx, -1)}><Minus className="h-3 w-3" /></Button>
                    <span className="w-6 text-center text-sm">{it.cantidad}</span>
                    <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => setCantidad(idx, +1)}><Plus className="h-3 w-3" /></Button>
                  </div>
                </div>
              ))}
              <div className="border-t border-border pt-3 flex justify-between font-semibold text-base">
                <span>Total</span><span>{formatARS(subtotal)}</span>
              </div>
              <Button onClick={confirmar} disabled={enviando} className="w-full h-12 text-base">
                {enviando ? 'Enviando…' : (local.modo === 'autonomo' ? 'Enviar a cocina' : 'Confirmar pedido')}
              </Button>
              {local.modo === 'asistido' && (
                <p className="text-[10px] text-muted-foreground text-center">El mozo aprueba antes de mandarlo a cocina.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
