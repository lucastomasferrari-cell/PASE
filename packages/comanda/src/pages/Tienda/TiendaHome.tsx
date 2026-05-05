import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { ShoppingCart, Plus, Minus, X } from 'lucide-react';
import { getCatalogoPorSlug, type CatalogoPublicoItem } from '@/services/tiendaService';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatARS } from '@/lib/format';
import { carritoStore, calcularSubtotal, type CarritoItem } from './carritoStore';
import type { TiendaCtx } from './TiendaLayout';

export function TiendaHome() {
  const { local } = useOutletContext<TiendaCtx>();
  const [items, setItems] = useState<CatalogoPublicoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [grupoActivo, setGrupoActivo] = useState<number | null>(null);
  const [carritoOpen, setCarritoOpen] = useState(false);

  const carrito = useSyncExternalStore(
    carritoStore.subscribe,
    () => carritoStore.get(local.slug),
  );
  const subtotal = calcularSubtotal(carrito.items);
  const costoEnvio = carrito.tipoEntrega === 'delivery' ? Number(local.costo_envio_default) || 0 : 0;
  const total = subtotal + costoEnvio;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getCatalogoPorSlug(local.slug).then(({ data }) => {
      if (cancelled) return;
      setItems(data);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [local.slug]);

  const grupos = useMemo(() => {
    const map = new Map<number, { id: number; nombre: string; emoji: string | null }>();
    for (const it of items) {
      if (it.grupo_id != null && !map.has(it.grupo_id)) {
        map.set(it.grupo_id, { id: it.grupo_id, nombre: it.grupo_nombre ?? '', emoji: it.grupo_emoji });
      }
    }
    return Array.from(map.values());
  }, [items]);

  useEffect(() => {
    if (grupoActivo == null && grupos.length > 0) setGrupoActivo(grupos[0]!.id);
  }, [grupos, grupoActivo]);

  const itemsDelGrupo = grupoActivo == null ? items : items.filter(i => i.grupo_id === grupoActivo);
  const aceptaPedidos = local.features_pos_modos?.includes('pedidos') ?? false;

  function agregar(it: CatalogoPublicoItem) {
    const next = { ...carrito };
    const idx = next.items.findIndex(x => x.item_id === it.item_id && x.modificadores.length === 0 && !x.notas);
    if (idx >= 0) {
      next.items = next.items.map((x, i) => i === idx ? { ...x, cantidad: x.cantidad + 1 } : x);
    } else {
      next.items = [...next.items, {
        item_id: it.item_id, nombre: it.nombre, emoji: it.emoji,
        precio: Number(it.precio) || 0, cantidad: 1, modificadores: [], notas: '',
      } satisfies CarritoItem];
    }
    carritoStore.set(next);
  }

  function setCantidad(itemId: number, idx: number, delta: number) {
    const next = { ...carrito };
    const target = next.items[idx];
    if (!target || target.item_id !== itemId) return;
    const nueva = target.cantidad + delta;
    next.items = nueva <= 0
      ? next.items.filter((_, i) => i !== idx)
      : next.items.map((x, i) => i === idx ? { ...x, cantidad: nueva } : x);
    carritoStore.set(next);
  }

  function setTipoEntrega(t: 'retiro' | 'delivery') {
    if (t === 'delivery' && !local.acepta_delivery) return;
    carritoStore.set({ ...carrito, tipoEntrega: t });
  }

  function setDireccion(d: string) {
    carritoStore.set({ ...carrito, direccion: d });
  }

  if (!aceptaPedidos) {
    return (
      <div className="max-w-3xl mx-auto p-6 text-center">
        <div className="text-5xl mb-3">🚧</div>
        <h2 className="text-lg font-semibold">Esta tienda no está aceptando pedidos por ahora</h2>
        <p className="text-sm text-muted-foreground mt-2">Probá llamarlos al {local.telefono ?? 'teléfono del local'}.</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto pb-32">
      <div className="px-4 py-3 sticky top-[60px] z-20 bg-background border-b border-border flex gap-2">
        {(['retiro', 'delivery'] as const).map(t => {
          const disabled = t === 'delivery' && !local.acepta_delivery;
          return (
            <button
              key={t}
              type="button"
              disabled={disabled}
              onClick={() => setTipoEntrega(t)}
              className={`flex-1 h-11 rounded-md border text-sm font-medium ${
                carrito.tipoEntrega === t
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background border-border'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {t === 'retiro' ? '🚶 Retiro' : '🛵 Delivery'}
            </button>
          );
        })}
      </div>

      {carrito.tipoEntrega === 'delivery' && (
        <div className="px-4 py-3 border-b border-border">
          <label className="block text-xs text-muted-foreground mb-1">Dirección de entrega</label>
          <input
            value={carrito.direccion}
            onChange={e => setDireccion(e.target.value)}
            placeholder="Calle 123, depto, entre calles..."
            className="w-full h-11 px-3 rounded-md border border-border bg-background text-sm"
          />
          {Number(local.costo_envio_default) > 0 && (
            <p className="text-[10px] text-muted-foreground mt-1">
              Costo de envío: {formatARS(Number(local.costo_envio_default))}
            </p>
          )}
        </div>
      )}

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
        {loading ? (
          [1, 2, 3].map(i => <Skeleton key={i} className="h-20 w-full" />)
        ) : itemsDelGrupo.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-8">Sin productos en esta categoría.</p>
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
              <Button size="icon" className="h-9 w-9 self-center" onClick={() => agregar(it)} aria-label="Agregar">
                <Plus className="h-4 w-4" />
              </Button>
            </article>
          ))
        )}
      </div>

      {carrito.items.length > 0 && (
        <button
          type="button"
          onClick={() => setCarritoOpen(true)}
          className="fixed bottom-0 left-0 right-0 h-14 bg-primary text-primary-foreground flex items-center justify-between px-5 text-sm font-medium shadow-lg z-30"
        >
          <span className="flex items-center gap-2">
            <ShoppingCart className="h-4 w-4" />
            Ver carrito ({carrito.items.reduce((s, x) => s + x.cantidad, 0)})
          </span>
          <span className="font-semibold">{formatARS(total)}</span>
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
              {carrito.items.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">Carrito vacío.</p>}
              {carrito.items.map((it, idx) => (
                <div key={idx} className="flex items-center gap-3">
                  <span className="text-2xl">{it.emoji ?? '🍽️'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{it.nombre}</div>
                    <div className="text-xs text-muted-foreground">{formatARS(it.precio)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => setCantidad(it.item_id, idx, -1)}><Minus className="h-3 w-3" /></Button>
                    <span className="w-6 text-center text-sm">{it.cantidad}</span>
                    <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => setCantidad(it.item_id, idx, +1)}><Plus className="h-3 w-3" /></Button>
                  </div>
                </div>
              ))}
              {carrito.items.length > 0 && (
                <>
                  <div className="border-t border-border pt-3 space-y-1 text-sm">
                    <div className="flex justify-between"><span>Subtotal</span><span>{formatARS(subtotal)}</span></div>
                    {costoEnvio > 0 && <div className="flex justify-between"><span>Envío</span><span>{formatARS(costoEnvio)}</span></div>}
                    <div className="flex justify-between font-semibold text-base"><span>Total</span><span>{formatARS(total)}</span></div>
                  </div>
                  <Link
                    to={`/tienda/${local.slug}/checkout`}
                    onClick={() => setCarritoOpen(false)}
                    aria-disabled={carrito.tipoEntrega === 'delivery' && !carrito.direccion.trim()}
                    className={`block text-center h-12 leading-[3rem] rounded-md font-medium ${
                      carrito.tipoEntrega === 'delivery' && !carrito.direccion.trim()
                        ? 'pointer-events-none bg-muted text-muted-foreground'
                        : 'bg-primary text-primary-foreground'
                    }`}
                  >
                    Continuar pedido
                  </Link>
                  {carrito.tipoEntrega === 'delivery' && !carrito.direccion.trim() && (
                    <p className="text-[10px] text-destructive text-center">Ingresá la dirección antes de continuar.</p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
