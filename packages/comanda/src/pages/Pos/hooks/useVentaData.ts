import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
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
      const [vRes, iRes, cRes, gRes] = await Promise.all([
        getVenta(ventaId),
        listVentasItems(ventaId),
        listItems({ tenantId: user?.tenant_id ?? null }),
        listGrupos(user?.tenant_id ?? null),
      ]);
      if (vRes.error) toast.error(vRes.error);
      setVenta(vRes.data);
      setItems(iRes.data);
      setCatalogo(cRes.data);
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
