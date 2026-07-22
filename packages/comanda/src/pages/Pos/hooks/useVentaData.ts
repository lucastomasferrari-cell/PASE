import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { db } from '../../../lib/supabase';
import { useAuth } from '../../../lib/auth';
import { listItems, type ItemConGrupo } from '../../../services/itemsService';
import { listGrupos } from '../../../services/gruposService';
import { getVenta, listVentasItems } from '../../../services/ventasService';
import type { VentaPos, VentaPosItem, ItemGrupo } from '../../../types/database';
import { useRealtimeTable } from '../../../lib/useRealtimeTable';
import { listenReconcile } from '../../../lib/sync/idReconciliation';

export interface UseVentaDataResult {
  venta: VentaPos | null;
  setVenta: React.Dispatch<React.SetStateAction<VentaPos | null>>;
  items: VentaPosItem[];
  setItems: React.Dispatch<React.SetStateAction<VentaPosItem[]>>;
  catalogo: ItemConGrupo[];
  grupos: ItemGrupo[];
  loading: boolean;
  reloadFull: () => Promise<void>;
  reloadVenta: () => Promise<void>;
  /** UI optimista: muestra la fila YA con un id temporal negativo (que devuelve) mientras el server confirma. */
  addOptimistic: (row: Omit<VentaPosItem, 'id'>) => number;
  /** Reconcilia la fila optimista: tempId→realId si ok, o la saca si el RPC falló (realId null). */
  reconcileAdd: (tempId: number, realId: number | null) => void;
}

// Filtra y precia el catálogo según el CANAL de la venta (salón, mostrador,
// delivery…). item_precios_canal define `vendible` (si el item se ofrece en ese
// canal) y `precio` (precio del canal). Antes el POS mostraba TODOS los items al
// precio_madre → en salón aparecían productos solo-delivery. El cobro ya usa el
// precio del canal (fn_agregar_item_comanda); esto alinea la PANTALLA.
// Degradación segura: si el canal no tiene precios cargados, no se filtra nada
// (mismo fallback a precio_madre que hace el RPC).
async function filtrarCatalogoPorCanal(
  catalogo: ItemConGrupo[],
  canalId: number | null,
  localId: number | null,
): Promise<ItemConGrupo[]> {
  if (!canalId) return catalogo;
  let q = db.from('item_precios_canal')
    .select('item_id, precio, vendible, local_id')
    .eq('canal_id', canalId)
    .is('deleted_at', null);
  q = localId != null ? q.or(`local_id.eq.${localId},local_id.is.null`) : q.is('local_id', null);
  const { data: precios, error } = await q;
  if (error || !precios || precios.length === 0) return catalogo;
  // Mapa item_id → precio/vendible del canal, prefiriendo la fila por-local
  // sobre la global (local_id null).
  const map = new Map<number, { precio: number; vendible: boolean; esLocal: boolean }>();
  for (const p of precios as Array<{ item_id: number; precio: number | string; vendible: boolean; local_id: number | null }>) {
    const esLocal = localId != null && p.local_id === localId;
    const prev = map.get(p.item_id);
    if (!prev || (esLocal && !prev.esLocal)) {
      map.set(p.item_id, { precio: Number(p.precio), vendible: !!p.vendible, esLocal });
    }
  }
  return catalogo
    .filter((it) => { const m = map.get(it.id); return !m || m.vendible; })
    .map((it) => { const m = map.get(it.id); return m ? { ...it, precio_madre: m.precio } : it; });
}

export function useVentaData(ventaId: number): UseVentaDataResult {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [venta, setVenta] = useState<VentaPos | null>(null);
  const [items, setItems] = useState<VentaPosItem[]>([]);
  const [catalogo, setCatalogo] = useState<ItemConGrupo[]>([]);
  const [grupos, setGrupos] = useState<ItemGrupo[]>([]);
  const [loading, setLoading] = useState(true);

  // UI optimista (2026-06-22): al tocar un producto la fila aparece al instante
  // con un id temporal negativo, sin esperar el round-trip del INSERT + refetch.
  // - pendingAddsRef: filas optimistas que el server todavía NO materializó.
  //   reloadVenta las preserva (no las pisa) hasta que el refetch las trae.
  // - reloadSeqRef: guard de secuencia. Un refetch viejo que resuelve tarde NO
  //   puede pisar uno más nuevo (era la causa del "tocá otro para ver el anterior").
  const pendingAddsRef = useRef<Map<number, VentaPosItem>>(new Map());
  const reloadSeqRef = useRef(0);
  const tempIdRef = useRef(-1);

  // Sprint optim egress 2026-05-16 (sesión 2): separar reload full vs light.
  // - reloadFull: trae venta + items + catálogo (200 items × 30cols) + grupos.
  //   Solo al MOUNT — ~150-250KB de data.
  // - reloadVenta: solo la venta + sus items. Trigger desde Realtime cuando
  //   cocina marca listo o manager edita. Mucho más liviano (~10-20KB).
  const reloadFull = useCallback(async () => {
    setLoading(true);
    try {
      // 1) Venta primero — necesitamos su local para resolver la MARCA.
      const vRes = await getVenta(ventaId);
      if (vRes.error) toast.error(vRes.error);
      setVenta(vRes.data);

      // 2) Menú por marca: la marca sale del local de la venta. Si no se puede
      //    resolver (offline, local sin marca) → marcaId null → el catálogo NO
      //    filtra por marca (comportamiento previo: todo el tenant).
      let marcaId: number | null = null;
      const localId = vRes.data?.local_id ?? null;
      if (localId) {
        try {
          const { data: locRow } = await db.from('locales').select('marca_id').eq('id', localId).maybeSingle();
          marcaId = (locRow?.marca_id as number | null) ?? null;
        } catch { /* sin red → marcaId null → sin filtro */ }
      }

      // 3) Resto en paralelo. Modelo maestro+import: el POS lee el menú de ESTA
      //    sucursal (local_id = localId) — sus copias importadas/editadas. Si no
      //    hay local (offline), cae al filtro por marca (fallback previo).
      const canalId = (vRes.data as { canal_id?: number | null } | null)?.canal_id ?? null;
      const [iRes, cRes, gRes] = await Promise.all([
        listVentasItems(ventaId),
        listItems({ tenantId: user?.tenant_id ?? null, localId, marcaId }),
        listGrupos(user?.tenant_id ?? null, marcaId, { localId }),
      ]);
      setItems(iRes.data);
      setCatalogo(await filtrarCatalogoPorCanal(cRes.data, canalId, localId));
      setGrupos(gRes.data);
    } catch (err) {
      toast.error('Error cargando datos: ' + (err instanceof Error ? err.message : 'desconocido'));
    } finally {
      setLoading(false);
    }
  }, [ventaId, user?.tenant_id]);

  // Light: solo refresca la venta y sus items. NO recarga el catálogo
  // (que cambia muy poco) ni los grupos. Usado por Realtime + acciones
  // internas que solo afectan la venta actual.
  const reloadVenta = useCallback(async () => {
    const seq = ++reloadSeqRef.current;
    try {
      const [vRes, iRes] = await Promise.all([
        getVenta(ventaId),
        listVentasItems(ventaId),
      ]);
      // Guard: si mientras esperábamos arrancó otra recarga (realtime, otro toque),
      // descartamos esta respuesta vieja — la nueva manda.
      if (seq !== reloadSeqRef.current) return;
      if (vRes.error) toast.error(vRes.error);
      setVenta(vRes.data);

      // Merge no destructivo con las filas optimistas pendientes:
      // las que el server ya materializó dejan de estar pendientes; las que
      // todavía no aparecen en el refetch se preservan encima.
      const server = iRes.data;
      const serverIds = new Set(server.map((i) => i.id));
      for (const id of [...pendingAddsRef.current.keys()]) {
        if (serverIds.has(id)) pendingAddsRef.current.delete(id);
      }
      const pendientes = [...pendingAddsRef.current.values()].filter((p) => !serverIds.has(p.id));
      setItems(pendientes.length ? [...server, ...pendientes] : server);
    } catch (err) {
      toast.error('Error cargando venta: ' + (err instanceof Error ? err.message : 'desconocido'));
    }
  }, [ventaId]);

  // UI optimista: agrega la fila al instante y devuelve su id temporal (negativo).
  const addOptimistic = useCallback((row: Omit<VentaPosItem, 'id'>): number => {
    const tempId = tempIdRef.current--;
    const full = { ...row, id: tempId } as VentaPosItem;
    pendingAddsRef.current.set(tempId, full);
    setItems((prev) => [...prev, full]);
    return tempId;
  }, []);

  // Reconcilia la fila optimista contra el resultado del RPC.
  const reconcileAdd = useCallback((tempId: number, realId: number | null) => {
    const row = pendingAddsRef.current.get(tempId);
    pendingAddsRef.current.delete(tempId);
    if (realId == null || !row) {
      // RPC falló (o ya no está) → sacamos la fila optimista.
      setItems((prev) => prev.filter((i) => i.id !== tempId));
      return;
    }
    const real = { ...row, id: realId };
    pendingAddsRef.current.set(realId, real);
    setItems((prev) => {
      // Si un refetch/realtime ya trajo la fila canónica (realId), evitamos
      // duplicar: descartamos la optimista en vez de mapearla.
      if (prev.some((i) => i.id === realId && i.id !== tempId)) {
        pendingAddsRef.current.delete(realId);
        return prev.filter((i) => i.id !== tempId);
      }
      return prev.map((i) => (i.id === tempId ? real : i));
    });
  }, []);

  // Load inicial al mount
  useEffect(() => { reloadFull(); }, [reloadFull]);

  // Fase 4.3: si la venta abierta era tempId (negativo) y el sync confirma,
  // navegamos al id real para que la URL no quede con un valor negativo.
  useEffect(() => {
    return listenReconcile((ev) => {
      if (ev.kind === 'venta' && ev.tempId === ventaId) {
        navigate(`/pos/venta/${ev.realId}`, { replace: true });
      }
    });
  }, [ventaId, navigate]);

  // Realtime: cocina marca listo o manager anula → solo refresca la venta.
  //
  // NOTA offline-first (2026-06-02): si ventaId < 0 la venta es local-only
  // (todavía no sincronizada). No tiene sentido suscribirse a Supabase
  // Realtime con ese id — no existe en server. El sync engine eventualmente
  // hace push y emite evento `comanda:reconcile-id`, que ya escuchamos
  // arriba para navegar al id real. Una vez navegado, este hook se re-monta
  // con el id positivo y la subscription Realtime arranca normal.
  useRealtimeTable({
    table: 'ventas_pos',
    onChange: () => reloadVenta(),
    extraFilter: Number.isFinite(ventaId) && ventaId > 0 ? `id=eq.${ventaId}` : undefined,
    enabled: Number.isFinite(ventaId) && ventaId > 0,
  });
  useRealtimeTable({
    table: 'ventas_pos_items',
    onChange: () => reloadVenta(),
    extraFilter: Number.isFinite(ventaId) && ventaId > 0 ? `venta_id=eq.${ventaId}` : undefined,
    enabled: Number.isFinite(ventaId) && ventaId > 0,
  });

  return { venta, setVenta, items, setItems, catalogo, grupos, loading, reloadFull, reloadVenta, addOptimistic, reconcileAdd };
}
