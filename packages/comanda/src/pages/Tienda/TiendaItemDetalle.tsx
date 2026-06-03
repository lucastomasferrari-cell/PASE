// Pantalla detalle del ítem en la Tienda pública con selección de
// modificadores (Fase 6 Brainstorm #8, chunk item-detalle, 2026-06-02).
//
// Flujo:
//   - TiendaHome detecta `item.tiene_modificadores === true` en el card y
//     navega acá en vez de hacer +1 directo al carrito.
//   - Acá traemos el item del catálogo + sus modifier_groups vía
//     fn_get_modificadores_publico (RPC pública, valida que el item sea
//     visible en la tienda del slug — anti-enumeration).
//   - Render: foto grande arriba, nombre/descripción/precio, una sección
//     por group con UI según `tipo`:
//        opcion       → radios (single-choice)
//        extra        → checkboxes (multi-choice con max_seleccion)
//        sin_con      → checkboxes "Sin X" (toggle)
//        aclaracion   → textarea (notas libres) — el group no tiene modifiers
//          que sumen al precio; usamos su nombre como label del textarea.
//   - Validación: si `requerido` y selección < `min_seleccion`, se marca
//     el group en rojo y se deshabilita el botón.
//   - Cantidad +/- + textarea notas globales.
//   - Botón "Agregar al carrito $X" con total dinámico (base + extras) × qty.
//   - Al confirmar, push al carritoStore con el line item incluyendo los
//     modificadores en el formato que ya acepta crearPedidoPublico.
//   - Volver a /tienda/:slug.
//
// El carrito (carritoStore.ts) ya soporta nativamente CarritoItem con
// `modificadores: { nombre, precio_extra }[]`. Solo necesitamos
// poblarlo bien acá.

import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useOutletContext } from 'react-router-dom';
import { toast } from 'sonner';
import { Minus, Plus, ChevronLeft } from 'lucide-react';
import {
  getItemPublico,
  getModificadoresPublico,
  type CatalogoPublicoItem,
  type ModifierGroupPublico,
  type ModifierPublico,
} from '@/services/tiendaService';
import { carritoStore, type CarritoItem } from './carritoStore';
import type { TiendaCtx } from './TiendaLayout';
import { formatARS } from '@/lib/format';
import { Skeleton } from '@/components/ui/skeleton';

export function TiendaItemDetalle() {
  const { localSlug, itemId } = useParams<{ localSlug: string; itemId: string }>();
  const { local } = useOutletContext<TiendaCtx>();
  const navigate = useNavigate();

  const [item, setItem] = useState<CatalogoPublicoItem | null>(null);
  const [groups, setGroups] = useState<ModifierGroupPublico[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Estado de selección por group_id. Para 'opcion' es modifier_id|null;
  // para 'extra' / 'sin_con' es Set<modifier_id>; para 'aclaracion' es string.
  const [selSingle, setSelSingle] = useState<Map<number, number | null>>(new Map());
  const [selMulti, setSelMulti] = useState<Map<number, Set<number>>>(new Map());
  const [selNota, setSelNota] = useState<Map<number, string>>(new Map());

  const [cantidad, setCantidad] = useState(1);
  const [notasGlobales, setNotasGlobales] = useState('');
  const [tocado, setTocado] = useState(false);

  // Cargar item + modifs en paralelo.
  useEffect(() => {
    if (!localSlug || !itemId) return;
    const idNum = Number(itemId);
    if (!Number.isFinite(idNum)) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getItemPublico(localSlug, idNum),
      getModificadoresPublico(localSlug, idNum),
    ]).then(([itemRes, modsRes]) => {
      if (cancelled) return;
      if (!itemRes.data) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      setItem(itemRes.data);
      setGroups(modsRes.data);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [localSlug, itemId]);

  // ── Selectors ──────────────────────────────────────────────────────────
  function toggleSingle(groupId: number, modId: number, max: number | null) {
    setTocado(true);
    setSelSingle((prev) => {
      const next = new Map(prev);
      const cur = next.get(groupId);
      // Si ya está seleccionado y max_seleccion permite des-seleccionar (no requerido), lo limpia.
      // Caso típico opcion: max=1, min=1 → siempre obligatorio → no des-elegible.
      // Pero soportamos toggle si max>=1 y no requerido.
      next.set(groupId, cur === modId ? null : modId);
      // max se ignora para single (siempre 1 por definición).
      void max;
      return next;
    });
  }

  function toggleMulti(groupId: number, modId: number, max: number | null) {
    setTocado(true);
    setSelMulti((prev) => {
      const next = new Map(prev);
      const cur = new Set(next.get(groupId) ?? []);
      if (cur.has(modId)) {
        cur.delete(modId);
      } else {
        if (max != null && cur.size >= max) {
          toast.warning(`Máximo ${max} opciones`);
          return prev;
        }
        cur.add(modId);
      }
      next.set(groupId, cur);
      return next;
    });
  }

  function setNotaGroup(groupId: number, val: string) {
    setTocado(true);
    setSelNota((prev) => {
      const next = new Map(prev);
      next.set(groupId, val);
      return next;
    });
  }

  // ── Validación ─────────────────────────────────────────────────────────
  const erroresPorGroup = useMemo(() => {
    const errs = new Map<number, string>();
    for (const g of groups) {
      if (!g.requerido) continue;
      let count = 0;
      if (g.tipo === 'opcion') {
        count = selSingle.get(g.modifier_group_id) ? 1 : 0;
      } else if (g.tipo === 'extra' || g.tipo === 'sin_con') {
        count = (selMulti.get(g.modifier_group_id)?.size) ?? 0;
      } else if (g.tipo === 'aclaracion') {
        count = (selNota.get(g.modifier_group_id) ?? '').trim().length > 0 ? 1 : 0;
      }
      if (count < g.min_seleccion) {
        errs.set(
          g.modifier_group_id,
          g.min_seleccion === 1 ? 'Elegí una opción' : `Elegí al menos ${g.min_seleccion}`,
        );
      }
    }
    return errs;
  }, [groups, selSingle, selMulti, selNota]);

  const valido = erroresPorGroup.size === 0;

  // ── Cálculo precio ─────────────────────────────────────────────────────
  const extrasTotal = useMemo(() => {
    let total = 0;
    for (const g of groups) {
      if (g.tipo === 'opcion') {
        const id = selSingle.get(g.modifier_group_id);
        if (id != null) {
          const m = g.modifiers.find((x) => x.modifier_id === id);
          if (m) total += Number(m.precio_extra) || 0;
        }
      } else if (g.tipo === 'extra' || g.tipo === 'sin_con') {
        const ids = selMulti.get(g.modifier_group_id);
        if (ids) {
          for (const id of ids) {
            const m = g.modifiers.find((x) => x.modifier_id === id);
            if (m) total += Number(m.precio_extra) || 0;
          }
        }
      }
    }
    return total;
  }, [groups, selSingle, selMulti]);

  const precioUnitario = (item ? Number(item.precio) || 0 : 0) + extrasTotal;
  const totalLinea = precioUnitario * cantidad;

  // ── Agregar al carrito ─────────────────────────────────────────────────
  function agregarAlCarrito() {
    if (!item || !valido || !localSlug) return;

    // Armamos los modificadores en el formato que crearPedidoPublico espera:
    // { nombre, precio_extra }. Incluye las notas de aclaracion como
    // "Sin sal: poca", para que aparezcan en la comanda de cocina.
    const modificadores: { nombre: string; precio_extra: number }[] = [];

    for (const g of groups) {
      if (g.tipo === 'opcion') {
        const id = selSingle.get(g.modifier_group_id);
        if (id != null) {
          const m = g.modifiers.find((x) => x.modifier_id === id);
          if (m) modificadores.push({ nombre: m.nombre, precio_extra: Number(m.precio_extra) || 0 });
        }
      } else if (g.tipo === 'extra' || g.tipo === 'sin_con') {
        const ids = selMulti.get(g.modifier_group_id);
        if (ids) {
          // Ordenamos por orden del modifier para que sea estable en la comanda.
          const ordered = g.modifiers
            .filter((m) => ids.has(m.modifier_id))
            .sort((a, b) => a.orden - b.orden);
          for (const m of ordered) {
            const prefix = g.tipo === 'sin_con' ? '' : ''; // el nombre ya viene "Sin X" o "Con X" del catálogo
            modificadores.push({ nombre: `${prefix}${m.nombre}`, precio_extra: Number(m.precio_extra) || 0 });
          }
        }
      } else if (g.tipo === 'aclaracion') {
        const txt = (selNota.get(g.modifier_group_id) ?? '').trim();
        if (txt.length > 0) {
          modificadores.push({ nombre: `${g.nombre}: ${txt}`, precio_extra: 0 });
        }
      }
    }

    const carritoActual = carritoStore.get(localSlug);
    const next: typeof carritoActual = { ...carritoActual };

    // Para items con modificadores NO mergeamos con líneas previas — cada
    // configuración es única, igual que Uber Eats / Rappi.
    const lineItem: CarritoItem = {
      item_id: item.item_id,
      nombre: item.nombre,
      emoji: item.emoji,
      precio: Number(item.precio) || 0,
      cantidad,
      modificadores,
      notas: notasGlobales.trim(),
    };

    next.items = [...next.items, lineItem];
    carritoStore.set(next);

    toast.success(`Agregado: ${item.nombre}${cantidad > 1 ? ` ×${cantidad}` : ''}`, { duration: 1500 });
    navigate(`/tienda/${localSlug}`);
  }

  // ── Render ─────────────────────────────────────────────────────────────
  if (notFound) {
    return (
      <div className="max-w-md mx-auto p-12 text-center">
        <div className="text-5xl mb-4">🤷</div>
        <h2 className="text-xl font-medium text-foreground">Producto no disponible</h2>
        <p className="text-sm text-foreground/60 mt-3">
          Este producto ya no figura en la carta de {local.nombre}.
        </p>
        <button
          type="button"
          onClick={() => navigate(`/tienda/${localSlug}`)}
          className="mt-6 inline-flex items-center gap-2 px-5 h-11 rounded-md bg-foreground text-background text-sm font-medium hover:opacity-90"
        >
          Volver a la carta
        </button>
      </div>
    );
  }

  if (loading || !item) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <Skeleton className="h-7 w-32 mb-6" />
        <Skeleton className="w-full aspect-square rounded-2xl mb-6" />
        <Skeleton className="h-8 w-72 mb-3" />
        <Skeleton className="h-4 w-full mb-2" />
        <Skeleton className="h-4 w-3/4 mb-8" />
        <Skeleton className="h-16 w-full mb-4" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto pb-40">
      {/* Back */}
      <button
        type="button"
        onClick={() => navigate(`/tienda/${localSlug}`)}
        className="m-4 inline-flex items-center gap-1 text-sm text-foreground/70 hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" />
        Volver
      </button>

      {/* Hero foto */}
      <div className="relative aspect-square w-full bg-gray-100 sm:rounded-2xl sm:mx-4 sm:w-auto overflow-hidden">
        {item.foto_url ? (
          <img src={item.foto_url} alt={item.nombre} className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-gray-100 to-gray-200">
            {item.emoji ? <span className="text-8xl">{item.emoji}</span> : <span className="text-7xl opacity-30">🍽️</span>}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="px-5 py-6">
        <h1 className="text-2xl sm:text-3xl font-medium tracking-tight">{item.nombre}</h1>
        {item.descripcion && (
          <p className="text-sm text-foreground/70 mt-3 leading-relaxed">{item.descripcion}</p>
        )}
        <div className="mt-4 text-lg font-medium">{formatARS(Number(item.precio) || 0)}</div>
      </div>

      {/* Groups */}
      <div className="space-y-3 sm:space-y-4">
        {groups.map((g) => {
          const err = erroresPorGroup.get(g.modifier_group_id);
          const showErr = tocado && err;
          return (
            <section
              key={g.modifier_group_id}
              className={[
                'mx-2 sm:mx-4 rounded-xl border bg-white',
                showErr ? 'border-red-300' : 'border-gray-200',
              ].join(' ')}
            >
              <header className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium text-foreground">{g.nombre}</div>
                  {g.descripcion && <div className="text-xs text-foreground/60 mt-0.5">{g.descripcion}</div>}
                </div>
                <div className="text-xs text-foreground/60 flex-shrink-0">
                  {g.requerido
                    ? <span className="text-red-600">Obligatorio</span>
                    : g.max_seleccion != null
                      ? <span>Hasta {g.max_seleccion}</span>
                      : <span>Opcional</span>}
                </div>
              </header>

              {showErr && (
                <div className="px-5 py-2 text-xs text-red-700 bg-red-50 border-b border-red-200">{err}</div>
              )}

              {/* Body por tipo */}
              {g.tipo === 'aclaracion' ? (
                <div className="p-4">
                  <textarea
                    value={selNota.get(g.modifier_group_id) ?? ''}
                    onChange={(e) => setNotaGroup(g.modifier_group_id, e.target.value)}
                    maxLength={200}
                    rows={2}
                    placeholder="Ej: bien cocido, sin cebolla, etc."
                    className="w-full text-sm border border-gray-200 rounded-md p-3 focus:outline-none focus:ring-2 focus:ring-foreground/10"
                  />
                </div>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {g.modifiers.map((m) => (
                    <ModifierRow
                      key={m.modifier_id}
                      group={g}
                      modifier={m}
                      selected={
                        g.tipo === 'opcion'
                          ? selSingle.get(g.modifier_group_id) === m.modifier_id
                          : (selMulti.get(g.modifier_group_id)?.has(m.modifier_id) ?? false)
                      }
                      onToggle={() => {
                        if (g.tipo === 'opcion') toggleSingle(g.modifier_group_id, m.modifier_id, g.max_seleccion);
                        else toggleMulti(g.modifier_group_id, m.modifier_id, g.max_seleccion);
                      }}
                    />
                  ))}
                  {g.modifiers.length === 0 && (
                    <li className="px-5 py-4 text-sm text-foreground/50">No hay opciones disponibles.</li>
                  )}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      {/* Notas globales */}
      <div className="mx-2 sm:mx-4 mt-3 sm:mt-4 rounded-xl border border-gray-200 bg-white p-4">
        <label className="text-xs font-medium text-foreground/70 mb-2 block">Notas para la cocina (opcional)</label>
        <textarea
          value={notasGlobales}
          onChange={(e) => setNotasGlobales(e.target.value)}
          maxLength={300}
          rows={2}
          placeholder="Aclaraciones generales"
          className="w-full text-sm border border-gray-200 rounded-md p-3 focus:outline-none focus:ring-2 focus:ring-foreground/10"
        />
      </div>

      {/* Footer fijo con cantidad + total + agregar */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-4 z-20">
        <div className="max-w-3xl mx-auto flex items-center gap-3 sm:gap-4">
          {/* Cantidad */}
          <div className="flex items-center gap-2 border border-gray-300 rounded-full h-11 px-2">
            <button
              type="button"
              onClick={() => setCantidad((c) => Math.max(1, c - 1))}
              aria-label="Disminuir"
              className="h-8 w-8 rounded-full hover:bg-gray-100 flex items-center justify-center"
            >
              <Minus className="h-4 w-4" />
            </button>
            <span className="min-w-[20px] text-center text-sm font-medium tabular-nums">{cantidad}</span>
            <button
              type="button"
              onClick={() => setCantidad((c) => Math.min(99, c + 1))}
              aria-label="Aumentar"
              className="h-8 w-8 rounded-full hover:bg-gray-100 flex items-center justify-center"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>

          {/* Botón agregar */}
          <button
            type="button"
            onClick={() => { setTocado(true); agregarAlCarrito(); }}
            disabled={!valido}
            className={[
              'flex-1 h-11 rounded-full text-sm font-medium px-5',
              'flex items-center justify-between gap-3',
              valido
                ? 'bg-foreground text-background hover:opacity-90'
                : 'bg-gray-200 text-foreground/40 cursor-not-allowed',
            ].join(' ')}
          >
            <span>Agregar al carrito</span>
            <span className="tabular-nums">{formatARS(totalLinea)}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Row de modifier (radio o checkbox según tipo del group) ────────────
interface RowProps {
  group: ModifierGroupPublico;
  modifier: ModifierPublico;
  selected: boolean;
  onToggle: () => void;
}

function ModifierRow({ group, modifier, selected, onToggle }: RowProps) {
  const esRadio = group.tipo === 'opcion';
  return (
    <li>
      <label className="flex items-center justify-between px-5 py-3 cursor-pointer hover:bg-gray-50">
        <span className="flex items-center gap-3 min-w-0">
          {esRadio ? (
            <span className={[
              'h-5 w-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center',
              selected ? 'border-foreground' : 'border-gray-300',
            ].join(' ')}>
              {selected && <span className="h-2.5 w-2.5 rounded-full bg-foreground" />}
            </span>
          ) : (
            <span className={[
              'h-5 w-5 rounded border-2 flex-shrink-0 flex items-center justify-center',
              selected ? 'border-foreground bg-foreground' : 'border-gray-300',
            ].join(' ')}>
              {selected && <span className="text-background text-xs leading-none">✓</span>}
            </span>
          )}
          <input
            type={esRadio ? 'radio' : 'checkbox'}
            checked={selected}
            onChange={onToggle}
            className="sr-only"
          />
          <span className="text-sm text-foreground truncate">{modifier.nombre}</span>
        </span>
        {modifier.precio_extra > 0 && (
          <span className="text-sm text-foreground/70 tabular-nums flex-shrink-0">
            +{formatARS(modifier.precio_extra)}
          </span>
        )}
      </label>
    </li>
  );
}
