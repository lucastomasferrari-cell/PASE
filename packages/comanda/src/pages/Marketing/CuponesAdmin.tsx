// CuponesAdmin — gestión de cupones de descuento por local.
//
// Lista + form de creación inline. Modal de edición.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Ticket, Plus, Copy, Trash2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { listCupones, crearCupon, eliminarCupon, actualizarCupon, type Cupon } from '@/services/cuponesService';
import { formatARS } from '@/lib/format';

export function CuponesAdmin() {
  const { user } = useAuth();
  const [localActivo] = useLocalActivo(user);
  const [cupones, setCupones] = useState<Cupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [crearOpen, setCrearOpen] = useState(false);

  // Form
  const [form, setForm] = useState({
    code: '',
    descripcion: '',
    tipo: 'porcentaje' as 'porcentaje' | 'monto_fijo',
    valor: '10',
    capDescuento: '',
    fechaDesde: '',
    fechaHasta: '',
    montoMinCompra: '',
    maxUsos: '',
    maxUsosPorCliente: '1',
    soloPrimeraCompra: false,
  });

  const reload = useCallback(async () => {
    setRefreshing(true);
    const { data, error } = await listCupones(localActivo ?? undefined);
    if (error) toast.error(error);
    else setCupones(data);
    setRefreshing(false);
    setLoading(false);
  }, [localActivo]);

  useEffect(() => { void reload(); }, [reload]);

  function reset() {
    setForm({
      code: '', descripcion: '', tipo: 'porcentaje', valor: '10',
      capDescuento: '', fechaDesde: '', fechaHasta: '', montoMinCompra: '',
      maxUsos: '', maxUsosPorCliente: '1', soloPrimeraCompra: false,
    });
  }

  async function handleCrear() {
    if (form.code.trim().length < 3) { toast.error('Código mínimo 3 chars'); return; }
    const valor = parseFloat(form.valor);
    if (!Number.isFinite(valor) || valor <= 0) { toast.error('Valor inválido'); return; }
    if (form.tipo === 'porcentaje' && valor > 100) { toast.error('Porcentaje máximo 100'); return; }

    const { error } = await crearCupon({
      localId: localActivo ?? undefined,
      code: form.code,
      descripcion: form.descripcion || undefined,
      tipo: form.tipo,
      valor,
      capDescuento: form.capDescuento ? parseFloat(form.capDescuento) : undefined,
      fechaDesde: form.fechaDesde || undefined,
      fechaHasta: form.fechaHasta || undefined,
      montoMinCompra: form.montoMinCompra ? parseFloat(form.montoMinCompra) : undefined,
      maxUsos: form.maxUsos ? parseInt(form.maxUsos) : undefined,
      maxUsosPorCliente: form.maxUsosPorCliente ? parseInt(form.maxUsosPorCliente) : undefined,
      soloPrimeraCompra: form.soloPrimeraCompra,
    });
    if (error) { toast.error(error); return; }
    toast.success(`Cupón ${form.code.toUpperCase()} creado`);
    reset();
    setCrearOpen(false);
    void reload();
  }

  async function handleToggleActivo(c: Cupon) {
    const { error } = await actualizarCupon(c.id, { activo: !c.activo });
    if (error) toast.error(error);
    else void reload();
  }

  async function handleEliminar(c: Cupon) {
    if (!confirm(`¿Eliminar cupón ${c.code}?`)) return;
    const { error } = await eliminarCupon(c.id);
    if (error) toast.error(error);
    else {
      toast.success('Cupón eliminado');
      void reload();
    }
  }

  function copyCode(code: string) {
    void navigator.clipboard.writeText(code).then(() => toast.success(`Código ${code} copiado`));
  }

  if (loading) return <div className="p-12 text-center text-foreground/60">Cargando cupones…</div>;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-medium flex items-center gap-2">
            <Ticket className="h-6 w-6" />
            Cupones
          </h1>
          <p className="text-sm text-foreground/60 mt-1">
            Códigos de descuento que el cliente pega en checkout
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => reload()} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
          <Button size="sm" onClick={() => { reset(); setCrearOpen(true); }}>
            <Plus className="h-4 w-4 mr-1.5" /> Nuevo cupón
          </Button>
        </div>
      </div>

      {cupones.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Ticket className="h-12 w-12 mx-auto text-foreground/30 mb-3" />
            <p className="font-medium">Sin cupones</p>
            <p className="text-sm text-foreground/60 mt-2">
              Creá tu primer cupón. El cliente lo pega en el checkout y aplica al total.
            </p>
            <Button className="mt-6" onClick={() => setCrearOpen(true)}>
              <Plus className="h-4 w-4 mr-1.5" /> Primer cupón
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {cupones.map((c) => (
            <Card key={c.id} className={c.activo ? '' : 'opacity-60'}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <button onClick={() => copyCode(c.code)} className="font-mono font-bold text-lg hover:bg-gray-100 px-1.5 rounded">
                        {c.code} <Copy className="h-3 w-3 inline ml-0.5 text-foreground/40" />
                      </button>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${c.activo ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
                        {c.activo ? 'activo' : 'inactivo'}
                      </span>
                    </div>
                    {c.descripcion && <p className="text-xs text-foreground/60 mt-1">{c.descripcion}</p>}
                    <div className="text-sm mt-2">
                      <strong>
                        {c.tipo === 'porcentaje' ? `${c.valor}% off` : `${formatARS(Number(c.valor))} off`}
                      </strong>
                      {c.cap_descuento && c.tipo === 'porcentaje' && (
                        <span className="text-xs text-foreground/60"> (máx {formatARS(Number(c.cap_descuento))})</span>
                      )}
                    </div>
                    <div className="text-xs text-foreground/60 mt-1 space-y-0.5">
                      {c.monto_min_compra && <div>Mín compra: {formatARS(Number(c.monto_min_compra))}</div>}
                      {c.solo_primera_compra && <div>⚡ Solo primera compra</div>}
                      <div>
                        Usos: {c.usos_actuales}
                        {c.max_usos ? ` / ${c.max_usos}` : ''}
                        {c.max_usos_por_cliente && ` · ${c.max_usos_por_cliente}/cliente`}
                      </div>
                      {c.fecha_hasta && (
                        <div>Vence: {new Date(c.fecha_hasta).toLocaleDateString('es-AR')}</div>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Button variant="ghost" size="sm" onClick={() => handleToggleActivo(c)} className="h-7 text-xs">
                      {c.activo ? 'Desactivar' : 'Activar'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleEliminar(c)} className="text-red-700 h-7 text-xs">
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Dialog crear */}
      <Dialog open={crearOpen} onOpenChange={setCrearOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Nuevo cupón</DialogTitle>
            <DialogDescription>Configurá las condiciones del cupón</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>Código (lo que pega el cliente)</Label>
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                     placeholder="VERANO10" className="font-mono uppercase mt-1" />
            </div>
            <div className="col-span-2">
              <Label>Descripción (visible solo a vos)</Label>
              <Input value={form.descripcion} onChange={(e) => setForm({ ...form, descripcion: e.target.value })}
                     placeholder="Promo verano 2026" className="mt-1" />
            </div>
            <div>
              <Label>Tipo</Label>
              <Select value={form.tipo} onValueChange={(v) => setForm({ ...form, tipo: v as 'porcentaje' | 'monto_fijo' })}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="porcentaje">% descuento</SelectItem>
                  <SelectItem value="monto_fijo">$ descuento fijo</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Valor</Label>
              <Input type="number" step="0.01" value={form.valor}
                     onChange={(e) => setForm({ ...form, valor: e.target.value })}
                     placeholder={form.tipo === 'porcentaje' ? '10' : '500'}
                     className="mt-1" />
            </div>
            {form.tipo === 'porcentaje' && (
              <div className="col-span-2">
                <Label>Tope máximo descuento ($, opcional)</Label>
                <Input type="number" step="0.01" value={form.capDescuento}
                       onChange={(e) => setForm({ ...form, capDescuento: e.target.value })}
                       placeholder="ej: 1000 → no descontar más de $1000"
                       className="mt-1" />
              </div>
            )}
            <div>
              <Label>Desde (opcional)</Label>
              <Input type="datetime-local" value={form.fechaDesde}
                     onChange={(e) => setForm({ ...form, fechaDesde: e.target.value })}
                     className="mt-1" />
            </div>
            <div>
              <Label>Hasta (opcional)</Label>
              <Input type="datetime-local" value={form.fechaHasta}
                     onChange={(e) => setForm({ ...form, fechaHasta: e.target.value })}
                     className="mt-1" />
            </div>
            <div>
              <Label>Mínimo compra ($)</Label>
              <Input type="number" step="0.01" value={form.montoMinCompra}
                     onChange={(e) => setForm({ ...form, montoMinCompra: e.target.value })}
                     placeholder="0" className="mt-1" />
            </div>
            <div>
              <Label>Máx usos totales</Label>
              <Input type="number" value={form.maxUsos}
                     onChange={(e) => setForm({ ...form, maxUsos: e.target.value })}
                     placeholder="ilimitado" className="mt-1" />
            </div>
            <div className="col-span-2 flex items-center gap-2 mt-1">
              <input type="checkbox" id="primera" checked={form.soloPrimeraCompra}
                     onChange={(e) => setForm({ ...form, soloPrimeraCompra: e.target.checked })} />
              <Label htmlFor="primera" className="cursor-pointer text-sm">
                Solo para clientes nuevos (1ra compra)
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCrearOpen(false)}>Cancelar</Button>
            <Button onClick={handleCrear}>Crear cupón</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
