// InventarioTransferencias — préstamos de mercadería entre locales.
//
// Caso de uso (Lucas): "se hacen prestamos entre locales, mercadería".
// Pantalla con:
//   - Lista de últimas transferencias (origen → destino, fecha, cantidad, valor)
//   - Botón "Nueva transferencia" → dialog con form
//   - Filtros por insumo, local origen/destino
//
// Atómico server-side via fn_transferir_stock_local.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import {
  ArrowRightLeft, Plus, RefreshCw, ChevronLeft, Package,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { db } from '@/lib/supabase';
import { formatARS } from '@/lib/format';
import { translateError } from '@/lib/errors';

interface Transferencia {
  id: number;
  insumo_id: number;
  insumo_nombre: string;
  insumo_unidad: string;
  local_origen_id: number;
  local_origen_nombre: string;
  local_destino_id: number;
  local_destino_nombre: string;
  cantidad: number;
  costo_unitario: number | null;
  valor_total: number;
  motivo: string | null;
  created_at: string;
}

interface InsumoOpcion {
  id: number;
  nombre: string;
  unidad: string;
  stock_actual: number;
  costo_actual: number | null;
}

interface LocalOpcion {
  id: number;
  nombre: string;
}

export function InventarioTransferencias() {
  const { user } = useAuth();
  const [localActivo] = useLocalActivo(user);
  const [transfs, setTransfs] = useState<Transferencia[]>([]);
  const [insumos, setInsumos] = useState<InsumoOpcion[]>([]);
  const [locales, setLocales] = useState<LocalOpcion[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);

  // Form
  const [form, setForm] = useState({
    insumo_id: '',
    local_destino_id: '',
    cantidad: '',
    motivo: '',
  });
  const [submitting, setSubmitting] = useState(false);

  const reload = useCallback(async () => {
    setRefreshing(true);
    const [t, i, l] = await Promise.all([
      // Transferencias visibles
      // eslint-disable-next-line pase-local/require-apply-local-scope -- vista filtra por RLS
      db.from('v_stock_transferencias')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200),
      // Insumos disponibles para transferir
      // eslint-disable-next-line pase-local/require-apply-local-scope -- master data filtrada por RLS
      db.from('insumos')
        .select('id, nombre, unidad, stock_actual, costo_actual')
        .eq('activo', true)
        .is('deleted_at', null)
        .gt('stock_actual', 0)
        .order('nombre'),
      // Locales del tenant
      // eslint-disable-next-line pase-local/require-apply-local-scope -- locales filtrados por tenant
      db.from('locales').select('id, nombre').order('nombre'),
    ]);
    if (t.error) toast.error(t.error.message);
    else setTransfs((t.data ?? []) as Transferencia[]);
    if (i.error) toast.error(i.error.message);
    else setInsumos((i.data ?? []) as InsumoOpcion[]);
    if (l.error) toast.error(l.error.message);
    else setLocales((l.data ?? []) as LocalOpcion[]);
    setRefreshing(false);
    setLoading(false);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const localOrigenNombre = useMemo(() => {
    return locales.find((l) => l.id === localActivo)?.nombre ?? `Local ${localActivo}`;
  }, [locales, localActivo]);

  const localesDestino = locales.filter((l) => l.id !== localActivo);
  const insumoSeleccionado = insumos.find((i) => i.id === Number(form.insumo_id));
  const cantidadNum = parseFloat(form.cantidad);
  const valorEstimado = insumoSeleccionado && Number.isFinite(cantidadNum)
    ? cantidadNum * Number(insumoSeleccionado.costo_actual ?? 0)
    : 0;
  const excedeStock = insumoSeleccionado && Number.isFinite(cantidadNum)
    ? cantidadNum > Number(insumoSeleccionado.stock_actual)
    : false;

  function reset() {
    setForm({ insumo_id: '', local_destino_id: '', cantidad: '', motivo: '' });
  }

  async function handleSubmit() {
    if (!localActivo) { toast.error('Sin local activo'); return; }
    if (!form.insumo_id) { toast.error('Elegí un insumo'); return; }
    if (!form.local_destino_id) { toast.error('Elegí local destino'); return; }
    const c = parseFloat(form.cantidad);
    if (!Number.isFinite(c) || c <= 0) { toast.error('Cantidad inválida'); return; }
    if (excedeStock) { toast.error('Cantidad excede stock disponible'); return; }

    setSubmitting(true);
    const { error } = await db.rpc('fn_transferir_stock_local', {
      p_insumo_id: Number(form.insumo_id),
      p_local_origen_id: localActivo,
      p_local_destino_id: Number(form.local_destino_id),
      p_cantidad: c,
      p_motivo: form.motivo || null,
    });
    setSubmitting(false);
    if (error) {
      toast.error(translateError(error));
      return;
    }
    toast.success('Transferencia registrada');
    reset();
    setOpen(false);
    void reload();
  }

  if (loading) return <div className="p-12 text-center text-foreground/60">Cargando transferencias…</div>;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <Link to="/inventario/alertas">
            <Button variant="ghost" size="sm">
              <ChevronLeft className="h-4 w-4 mr-1" /> Inventario
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-medium flex items-center gap-2">
              <ArrowRightLeft className="h-6 w-6" />
              Transferencias entre locales
            </h1>
            <p className="text-sm text-foreground/60 mt-1">
              Préstamos de mercadería · saliendo de <strong>{localOrigenNombre}</strong>
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => reload()} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
          <Button size="sm" onClick={() => { reset(); setOpen(true); }} disabled={!localActivo}>
            <Plus className="h-4 w-4 mr-1.5" /> Nueva transferencia
          </Button>
        </div>
      </div>

      {/* Tabla */}
      {transfs.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <ArrowRightLeft className="h-12 w-12 mx-auto text-foreground/30 mb-3" />
            <p className="font-medium">Sin transferencias</p>
            <p className="text-sm text-foreground/60 mt-2">
              Cuando prestes mercadería entre locales, las verás acá.
            </p>
            <Button className="mt-6" onClick={() => setOpen(true)} disabled={!localActivo}>
              <Plus className="h-4 w-4 mr-1.5" /> Primera transferencia
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b">
                <th className="p-2 px-3 font-medium text-foreground/60">Fecha</th>
                <th className="p-2 px-3 font-medium text-foreground/60">Insumo</th>
                <th className="p-2 px-3 font-medium text-foreground/60">De → A</th>
                <th className="p-2 px-3 font-medium text-foreground/60 text-right">Cantidad</th>
                <th className="p-2 px-3 font-medium text-foreground/60 text-right">Valor</th>
                <th className="p-2 px-3 font-medium text-foreground/60">Motivo</th>
              </tr>
            </thead>
            <tbody>
              {transfs.map((t) => (
                <tr key={t.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="p-2 px-3 text-xs text-foreground/70">
                    {new Date(t.created_at).toLocaleString('es-AR', {
                      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                    })}
                  </td>
                  <td className="p-2 px-3 font-medium">{t.insumo_nombre}</td>
                  <td className="p-2 px-3 text-xs">
                    <span className="text-red-700">{t.local_origen_nombre}</span>
                    <span className="text-foreground/40 mx-1.5">→</span>
                    <span className="text-green-700">{t.local_destino_nombre}</span>
                  </td>
                  <td className="p-2 px-3 text-right tabular-nums">
                    {Number(t.cantidad).toFixed(2)} {t.insumo_unidad}
                  </td>
                  <td className="p-2 px-3 text-right tabular-nums">
                    {Number(t.valor_total) > 0 ? formatARS(Number(t.valor_total)) : '—'}
                  </td>
                  <td className="p-2 px-3 text-xs text-foreground/70 max-w-xs truncate">
                    {t.motivo ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Dialog nueva transferencia */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nueva transferencia</DialogTitle>
            <DialogDescription>
              Mover stock desde <strong>{localOrigenNombre}</strong> a otro local
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <Label htmlFor="insumo">Insumo</Label>
              <Select value={form.insumo_id} onValueChange={(v) => setForm({ ...form, insumo_id: v })}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Elegí un insumo…" />
                </SelectTrigger>
                <SelectContent>
                  {insumos.map((i) => (
                    <SelectItem key={i.id} value={String(i.id)}>
                      <span className="inline-flex items-center gap-1.5">
                        <Package className="h-3 w-3 text-foreground/50" />
                        {i.nombre}
                        <span className="text-foreground/50 text-xs">
                          (stock: {Number(i.stock_actual).toFixed(2)} {i.unidad})
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="destino">Local destino</Label>
              <Select value={form.local_destino_id} onValueChange={(v) => setForm({ ...form, local_destino_id: v })}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Elegí destino…" />
                </SelectTrigger>
                <SelectContent>
                  {localesDestino.map((l) => (
                    <SelectItem key={l.id} value={String(l.id)}>{l.nombre}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="cantidad">
                Cantidad {insumoSeleccionado && `(${insumoSeleccionado.unidad})`}
              </Label>
              <Input
                id="cantidad"
                type="number"
                step="0.01"
                min="0"
                value={form.cantidad}
                onChange={(e) => setForm({ ...form, cantidad: e.target.value })}
                className="mt-1"
                placeholder="0.00"
              />
              {insumoSeleccionado && form.cantidad && (
                <p className={`text-xs mt-1 ${excedeStock ? 'text-red-700' : 'text-foreground/60'}`}>
                  {excedeStock
                    ? `⚠ Excede stock disponible (${Number(insumoSeleccionado.stock_actual).toFixed(2)} ${insumoSeleccionado.unidad})`
                    : `Valor estimado: ${formatARS(valorEstimado)}`}
                </p>
              )}
            </div>

            <div>
              <Label htmlFor="motivo">Motivo (opcional)</Label>
              <Textarea
                id="motivo"
                value={form.motivo}
                onChange={(e) => setForm({ ...form, motivo: e.target.value })}
                placeholder="Ej: faltaba para el servicio de la noche, devolución del préstamo del viernes"
                rows={2}
                className="mt-1"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>Cancelar</Button>
            <Button
              onClick={handleSubmit}
              disabled={submitting || !form.insumo_id || !form.local_destino_id || !form.cantidad || excedeStock}
            >
              {submitting ? 'Transfiriendo…' : 'Transferir'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
