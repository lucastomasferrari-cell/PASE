// CuponesAdmin — gestión de cupones de descuento por local.
//
// Lista + dialog crear/editar. Soporta filtros por items + canales
// (F5 Chunk B — 2026-06-02).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Ticket, Plus, Copy, Trash2, RefreshCw, Pencil } from 'lucide-react';
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
import {
  listCupones, crearCupon, eliminarCupon, actualizarCupon,
  type Cupon, type CanalCupon,
} from '@/services/cuponesService';
import { listItems, type ItemConGrupo } from '@/services/itemsService';
import { formatARS } from '@/lib/format';

const CANALES_DISPONIBLES: { value: CanalCupon; label: string }[] = [
  { value: 'tienda_online', label: 'Tienda online' },
  { value: 'menu_qr', label: 'Menu QR mesa' },
  { value: 'pos', label: 'POS local (mostrador/salón)' },
  { value: 'marketplace', label: 'Marketplace público' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'rappi', label: 'Rappi' },
  { value: 'pedidosya', label: 'PedidosYa' },
];

interface FormState {
  code: string;
  descripcion: string;
  tipo: 'porcentaje' | 'monto_fijo';
  valor: string;
  capDescuento: string;
  fechaDesde: string;
  fechaHasta: string;
  montoMinCompra: string;
  maxUsos: string;
  maxUsosPorCliente: string;
  soloPrimeraCompra: boolean;
  // F5 Chunk B
  restringirItems: boolean;
  itemsAplicablesIds: number[];
  restringirCanales: boolean;
  canalesAplicables: CanalCupon[];
}

const FORM_VACIO: FormState = {
  code: '', descripcion: '', tipo: 'porcentaje', valor: '10',
  capDescuento: '', fechaDesde: '', fechaHasta: '', montoMinCompra: '',
  maxUsos: '', maxUsosPorCliente: '1', soloPrimeraCompra: false,
  restringirItems: false, itemsAplicablesIds: [],
  restringirCanales: false, canalesAplicables: [],
};

function cuponToForm(c: Cupon): FormState {
  return {
    code: c.code,
    descripcion: c.descripcion ?? '',
    tipo: c.tipo,
    valor: String(c.valor),
    capDescuento: c.cap_descuento != null ? String(c.cap_descuento) : '',
    fechaDesde: c.fecha_desde ? c.fecha_desde.slice(0, 16) : '',
    fechaHasta: c.fecha_hasta ? c.fecha_hasta.slice(0, 16) : '',
    montoMinCompra: c.monto_min_compra != null ? String(c.monto_min_compra) : '',
    maxUsos: c.max_usos != null ? String(c.max_usos) : '',
    maxUsosPorCliente: c.max_usos_por_cliente != null ? String(c.max_usos_por_cliente) : '1',
    soloPrimeraCompra: c.solo_primera_compra,
    restringirItems: !!c.items_aplicables_ids?.length,
    itemsAplicablesIds: c.items_aplicables_ids ?? [],
    restringirCanales: !!c.canales_aplicables?.length,
    canalesAplicables: c.canales_aplicables ?? [],
  };
}

export function CuponesAdmin() {
  const { user } = useAuth();
  const [localActivo] = useLocalActivo(user);
  const [cupones, setCupones] = useState<Cupon[]>([]);
  const [items, setItems] = useState<ItemConGrupo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editandoId, setEditandoId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(FORM_VACIO);
  const [searchItem, setSearchItem] = useState('');

  const reload = useCallback(async () => {
    setRefreshing(true);
    const { data, error } = await listCupones(localActivo ?? undefined);
    if (error) toast.error(error);
    else setCupones(data);
    setRefreshing(false);
    setLoading(false);
  }, [localActivo]);

  useEffect(() => { void reload(); }, [reload]);

  // F5 Chunk B: cargar items del tenant para multiselect (solo cuando se necesita).
  useEffect(() => {
    if (items.length > 0 || !user?.tenant_id) return;
    void (async () => {
      const { data } = await listItems({ tenantId: user.tenant_id });
      setItems(data);
    })();
  }, [user?.tenant_id, items.length]);

  function abrirCrear() {
    setForm(FORM_VACIO);
    setEditandoId(null);
    setSearchItem('');
    setDialogOpen(true);
  }

  function abrirEditar(c: Cupon) {
    setForm(cuponToForm(c));
    setEditandoId(c.id);
    setSearchItem('');
    setDialogOpen(true);
  }

  async function handleGuardar() {
    if (form.code.trim().length < 3) { toast.error('Código mínimo 3 chars'); return; }
    const valor = parseFloat(form.valor);
    if (!Number.isFinite(valor) || valor <= 0) { toast.error('Valor inválido'); return; }
    if (form.tipo === 'porcentaje' && valor > 100) { toast.error('Porcentaje máximo 100'); return; }
    if (form.restringirItems && form.itemsAplicablesIds.length === 0) {
      toast.error('Marcaste "restringir items" pero no elegiste ninguno');
      return;
    }
    if (form.restringirCanales && form.canalesAplicables.length === 0) {
      toast.error('Marcaste "restringir canales" pero no elegiste ninguno');
      return;
    }

    const payloadComun = {
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
      itemsAplicablesIds: form.restringirItems ? form.itemsAplicablesIds : undefined,
      canalesAplicables: form.restringirCanales ? form.canalesAplicables : undefined,
    };

    if (editandoId !== null) {
      // UPDATE — pasamos el patch crudo (snake_case alineado con la columna DB)
      const { error } = await actualizarCupon(editandoId, {
        code: form.code.trim().toUpperCase(),
        descripcion: form.descripcion || null,
        tipo: form.tipo,
        valor,
        cap_descuento: form.capDescuento ? parseFloat(form.capDescuento) : null,
        fecha_desde: form.fechaDesde || null,
        fecha_hasta: form.fechaHasta || null,
        monto_min_compra: form.montoMinCompra ? parseFloat(form.montoMinCompra) : null,
        max_usos: form.maxUsos ? parseInt(form.maxUsos) : null,
        max_usos_por_cliente: form.maxUsosPorCliente ? parseInt(form.maxUsosPorCliente) : null,
        solo_primera_compra: form.soloPrimeraCompra,
        items_aplicables_ids: form.restringirItems && form.itemsAplicablesIds.length > 0
          ? form.itemsAplicablesIds : null,
        canales_aplicables: form.restringirCanales && form.canalesAplicables.length > 0
          ? form.canalesAplicables : null,
      });
      if (error) { toast.error(error); return; }
      toast.success(`Cupón ${form.code.toUpperCase()} actualizado`);
    } else {
      const { error } = await crearCupon({
        localId: localActivo ?? undefined,
        ...payloadComun,
      });
      if (error) { toast.error(error); return; }
      toast.success(`Cupón ${form.code.toUpperCase()} creado`);
    }
    setDialogOpen(false);
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

  // F5 Chunk B: filtrado de items para multiselect (búsqueda en vivo)
  const itemsFiltrados = useMemo(() => {
    const q = searchItem.trim().toLowerCase();
    if (!q) return items.slice(0, 100); // cap visual
    return items.filter((it) => it.nombre.toLowerCase().includes(q)).slice(0, 100);
  }, [items, searchItem]);

  function toggleItem(itemId: number) {
    setForm((f) => ({
      ...f,
      itemsAplicablesIds: f.itemsAplicablesIds.includes(itemId)
        ? f.itemsAplicablesIds.filter((id) => id !== itemId)
        : [...f.itemsAplicablesIds, itemId],
    }));
  }

  function toggleCanal(canal: CanalCupon) {
    setForm((f) => ({
      ...f,
      canalesAplicables: f.canalesAplicables.includes(canal)
        ? f.canalesAplicables.filter((c) => c !== canal)
        : [...f.canalesAplicables, canal],
    }));
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
          <Button size="sm" onClick={abrirCrear}>
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
            <Button className="mt-6" onClick={abrirCrear}>
              <Plus className="h-4 w-4 mr-1.5" /> Primer cupón
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {cupones.map((c) => {
            const itemsCount = c.items_aplicables_ids?.length ?? 0;
            const canalesCount = c.canales_aplicables?.length ?? 0;
            return (
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
                        {/* F5 Chunk B: badges de restricciones */}
                        {itemsCount > 0 && (
                          <div className="inline-block text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 font-medium mt-1 mr-1">
                            🍱 Solo {itemsCount} item{itemsCount !== 1 ? 's' : ''}
                          </div>
                        )}
                        {canalesCount > 0 && (
                          <div className="inline-block text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 font-medium mt-1">
                            🌐 {canalesCount} canal{canalesCount !== 1 ? 'es' : ''}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      <Button variant="ghost" size="sm" onClick={() => abrirEditar(c)} className="h-7 text-xs">
                        <Pencil className="h-3 w-3" />
                      </Button>
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
            );
          })}
        </div>
      )}

      {/* Dialog crear/editar */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editandoId !== null ? `Editar cupón ${form.code}` : 'Nuevo cupón'}</DialogTitle>
            <DialogDescription>Configurá las condiciones del cupón</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>Código (lo que pega el cliente)</Label>
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                     placeholder="VERANO10" className="font-mono uppercase mt-1"
                     disabled={editandoId !== null} />
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

            {/* F5 Chunk B: restricción por canales */}
            <div className="col-span-2 pt-3 border-t">
              <div className="flex items-center gap-2">
                <input type="checkbox" id="restcan" checked={form.restringirCanales}
                       onChange={(e) => setForm({ ...form, restringirCanales: e.target.checked })} />
                <Label htmlFor="restcan" className="cursor-pointer text-sm font-medium">
                  Limitar a canales específicos
                </Label>
              </div>
              {form.restringirCanales && (
                <div className="mt-2 ml-6 grid grid-cols-2 gap-1.5">
                  {CANALES_DISPONIBLES.map((c) => (
                    <label key={c.value} className="flex items-center gap-1.5 text-xs cursor-pointer">
                      <input type="checkbox" checked={form.canalesAplicables.includes(c.value)}
                             onChange={() => toggleCanal(c.value)} />
                      {c.label}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* F5 Chunk B: restricción por items */}
            <div className="col-span-2 pt-3 border-t">
              <div className="flex items-center gap-2">
                <input type="checkbox" id="restit" checked={form.restringirItems}
                       onChange={(e) => setForm({ ...form, restringirItems: e.target.checked })} />
                <Label htmlFor="restit" className="cursor-pointer text-sm font-medium">
                  Limitar a items específicos
                </Label>
              </div>
              {form.restringirItems && (
                <div className="mt-2 ml-6">
                  <Input
                    placeholder="Buscar item por nombre…"
                    value={searchItem}
                    onChange={(e) => setSearchItem(e.target.value)}
                    className="mb-2 h-8 text-xs"
                  />
                  <div className="max-h-40 overflow-y-auto border border-border rounded p-2 space-y-1">
                    {items.length === 0 ? (
                      <p className="text-xs text-foreground/50 italic">Cargando items…</p>
                    ) : itemsFiltrados.length === 0 ? (
                      <p className="text-xs text-foreground/50 italic">Sin coincidencias.</p>
                    ) : itemsFiltrados.map((it) => (
                      <label key={it.id} className="flex items-center gap-1.5 text-xs cursor-pointer hover:bg-gray-50 px-1 py-0.5 rounded">
                        <input type="checkbox" checked={form.itemsAplicablesIds.includes(it.id)}
                               onChange={() => toggleItem(it.id)} />
                        {it.nombre}
                        {it.precio_madre != null && (
                          <span className="text-foreground/50 ml-auto">{formatARS(Number(it.precio_madre))}</span>
                        )}
                      </label>
                    ))}
                  </div>
                  {form.itemsAplicablesIds.length > 0 && (
                    <p className="text-xs text-foreground/60 mt-1">
                      {form.itemsAplicablesIds.length} item{form.itemsAplicablesIds.length !== 1 ? 's' : ''} seleccionado{form.itemsAplicablesIds.length !== 1 ? 's' : ''}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
            <Button onClick={handleGuardar}>
              {editandoId !== null ? 'Guardar cambios' : 'Crear cupón'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
