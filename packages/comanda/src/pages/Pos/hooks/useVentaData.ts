import { useCallback, useEffect, useState } from 'react';
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
  items: VentaPosItem[];
  setItems: React.Dispatch<React.SetStateAction<VentaPosItem[]>>;
  catalogo: ItemConGrupo[];
  grupos: ItemGrupo[];
  loading: boolean;
  reloadFull: () => Promise<void>;
  reloadVenta: () => Promise<void>;
}

export function useVentaData(ventaId: number): UseVentaDataResult {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [venta, setVenta] = useState<VentaPos | null>(null);
  const [items, setItems] = useState<VentaPosItem[]>([]);
  const [catalogo, setCatalogo] = useState<ItemConGrupo[]>([]);
  const [grupos, setGrupos] = useState<ItemGrupo[]>([]);
  const [loading, setLoading] = useState(true);

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
    try {
      const [vRes, iRes] = await Promise.all([
        getVenta(ventaId),
        listVentasItems(ventaId),
      ]);
      if (vRes.error) toast.error(vRes.error);
      setVenta(vRes.data);
      setItems(iRes.data);
    } catch (err) {
      toast.error('Error cargando venta: ' + (err instanceof Error ? err.message : 'desconocido'));
    }
  }, [ventaId]);

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

  // Realtime: cocina marca listo o manager anula → solo refresca la venta
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

  return { venta, items, setItems, catalogo, grupos, loading, reloadFull, reloadVenta };
}
