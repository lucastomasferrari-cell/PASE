// InventarioTransferencias — préstamos de mercadería entre locales con
// flujo "En Tránsito".
//
// Visión PASE original: "El stock no sube en el Local B hasta que el
// encargado de ahí le da 'Aceptar Recepción'. Mientras tanto, esa
// mercadería está en estado 'En Tránsito'".
//
// 4 estados:
//   - en_transito: salió de origen, pendiente confirmar destino
//   - confirmada: destino recibió OK → stock sumado
//   - rechazada:  destino rechaza → stock devuelto a origen (con motivo)
//   - cancelada:  origen se arrepiente → stock devuelto a origen
//
// RPCs:
//   - fn_iniciar_traspaso         (origen → en_transito)
//   - fn_confirmar_recepcion_traspaso (destino acepta)
//   - fn_rechazar_recepcion_traspaso  (destino rechaza con motivo)
//   - fn_cancelar_traspaso        (cualquiera de los 2 mientras pendiente)
//
// Tabs:
//   - Pendientes: solo transferencias en_transito que involucran al local activo
//   - Historial:  todas las confirmadas/rechazadas/canceladas

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import {
  ArrowRightLeft, Plus, RefreshCw, ChevronLeft, Package, Check, X, Truck, Clock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { db } from '@/lib/supabase';
import { formatARS } from '@/lib/format';
import { translateError } from '@/lib/errors';

type EstadoTransf = 'en_transito' | 'confirmada' | 'rechazada' | 'cancelada';

interface Transferencia {
  id: number;
  estado: EstadoTransf;
  insumo_id: number;
  insumo_nombre: string;
  unidad: string;
  local_origen_id: number;
  local_origen_nombre: string;
  local_destino_id: number;
  local_destino_nombre: string;
  cantidad: number;
  costo_unitario: number | null;
  valor_total: number;
  motivo: string | null;
  rechazado_motivo: string | null;
  cancelado_motivo: string | null;
  usuario_origen_nombre: string | null;
  usuario_confirmador_nombre: string | null;
  created_at: string;
  fecha_confirmacion: string | null;
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

const ESTADO_BADGE: Record<EstadoTransf, { label: string; cls: string; icon: typeof Clock }> = {
  en_transito: { label: 'En tránsito', cls: 'bg-amber-100 text-amber-800 border-amber-300', icon: Truck },
  confirmada:  { label: 'Confirmada',  cls: 'bg-green-100 text-green-800 border-green-300', icon: Check },
  rechazada:   { label: 'Rechazada',   cls: 'bg-red-100 text-red-800 border-red-300', icon: X },
  cancelada:   { label: 'Cancelada',   cls: 'bg-gray-100 text-gray-700 border-gray-300', icon: X },
};

export function InventarioTransferencias() {
  const { user } = useAuth();
  const [localActivo] = useLocalActivo(user);
  const [transfs, setTransfs] = useState<Transferencia[]>([]);
  const [insumos, setInsumos] = useState<InsumoOpcion[]>([]);
  const [locales, setLocales] = useState<LocalOpcion[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);
  const [accion, setAccion] = useState<{ transf: Transferencia; tipo: 'rechazar' | 'cancelar' } | null>(null);
  const [accionMotivo, setAccionMotivo] = useState('');
  const [accionSubmitting, setAccionSubmitting] = useState(false);

  // Form de nueva transferencia
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
      // eslint-disable-next-line pase-local/require-apply-local-scope -- vista filtra por RLS
      db.from('v_stock_transferencias')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200),
      // eslint-disable-next-line pase-local/require-apply-local-scope -- master data filtrada por RLS
      db.from('insumos')
        .select('id, nombre, unidad, stock_actual, costo_actual')
        .eq('activo', true)
        .is('deleted_at', null)
        .gt('stock_actual', 0)
        .order('nombre'),
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

  // Particionar transferencias en pendientes y resto
  const pendientes = transfs.filter(t => t.estado === 'en_transito');
  const pendientesDeMiLocal = pendientes.filter(t =>
    t.local_origen_id === localActivo || t.local_destino_id === localActivo
  );
  const pendientesParaConfirmar = pendientes.filter(t => t.local_destino_id === localActivo);
  const historial = transfs.filter(t => t.estado !== 'en_transito');

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
    const { error } = await db.rpc('fn_iniciar_traspaso', {
      p_insumo_id: Number(form.insumo_id),
      p_local_origen_id: localActivo,
      p_local_destino_id: Number(form.local_destino_id),
      p_cantidad: c,
      p_motivo: form.motivo || null,
    });
    setSubmitting(false);
    if (error) { toast.error(translateError(error)); return; }

    toast.success('Transferencia enviada — pendiente confirmación del destino');
    reset();
    setOpen(false);
    void reload();
  }

  async function handleConfirmar(t: Transferencia) {
    const { error } = await db.rpc('fn_confirmar_recepcion_traspaso', {
      p_transferencia_id: t.id,
    });
    if (error) { toast.error(translateError(error)); return; }
    toast.success(`Recepción confirmada: ${Number(t.cantidad).toFixed(2)} ${t.unidad} de ${t.insumo_nombre}`);
    void reload();
  }

  async function handleAccionMotivada() {
    if (!accion) return;
    const motivo = accionMotivo.trim();
    if (accion.tipo === 'rechazar' && motivo.length < 3) {
      toast.error('Ingresá un motivo (mínimo 3 caracteres)');
      return;
    }
    setAccionSubmitting(true);
    const rpcName = accion.tipo === 'rechazar'
      ? 'fn_rechazar_recepcion_traspaso'
      : 'fn_cancelar_traspaso';
    const params = accion.tipo === 'rechazar'
      ? { p_transferencia_id: accion.transf.id, p_motivo: motivo }
      : { p_transferencia_id: accion.transf.id, p_motivo: motivo || null };
    const { error } = await db.rpc(rpcName, params);
    setAccionSubmitting(false);
    if (error) { toast.error(translateError(error)); return; }
    toast.success(accion.tipo === 'rechazar' ? 'Transferencia rechazada' : 'Transferencia cancelada');
    setAccion(null);
    setAccionMotivo('');
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
              Saliendo de <strong>{localOrigenNombre}</strong>. El destino tiene que confirmar la recepción antes de que entre al stock.
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

      {/* Banner de pendientes para confirmar (alta atención) */}
      {pendientesParaConfirmar.length > 0 && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="p-3 text-sm flex items-center gap-3">
            <Truck className="h-5 w-5 text-amber-600 shrink-0" />
            <div className="flex-1">
              <strong>{pendientesParaConfirmar.length} transferencia(s)</strong> esperando confirmación
              de recepción en {localOrigenNombre}.
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabs */}
      <Tabs defaultValue={pendientesDeMiLocal.length > 0 ? 'pendientes' : 'historial'}>
        <TabsList>
          <TabsTrigger value="pendientes">
            Pendientes
            {pendientesDeMiLocal.length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 bg-amber-200 text-amber-900 text-xs rounded-full">
                {pendientesDeMiLocal.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="historial">Historial ({historial.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="pendientes">
          {pendientesDeMiLocal.length === 0 ? (
            <Card><CardContent className="p-12 text-center">
              <Truck className="h-12 w-12 mx-auto text-foreground/30 mb-3" />
              <p className="font-medium">Sin pendientes</p>
              <p className="text-sm text-foreground/60 mt-2">
                Cuando enviés o esperés una transferencia, aparece acá.
              </p>
            </CardContent></Card>
          ) : (
            <div className="space-y-2">
              {pendientesDeMiLocal.map(t => (
                <TransferenciaCard
                  key={t.id}
                  t={t}
                  esDestino={t.local_destino_id === localActivo}
                  esOrigen={t.local_origen_id === localActivo}
                  onConfirmar={() => handleConfirmar(t)}
                  onRechazar={() => { setAccion({ transf: t, tipo: 'rechazar' }); setAccionMotivo(''); }}
                  onCancelar={() => { setAccion({ transf: t, tipo: 'cancelar' }); setAccionMotivo(''); }}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="historial">
          {historial.length === 0 ? (
            <Card><CardContent className="p-12 text-center text-sm text-foreground/60">
              Sin transferencias confirmadas todavía.
            </CardContent></Card>
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
                    <th className="p-2 px-3 font-medium text-foreground/60">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {historial.map((t) => {
                    const badge = ESTADO_BADGE[t.estado];
                    const Icon = badge.icon;
                    return (
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
                          {Number(t.cantidad).toFixed(2)} {t.unidad}
                        </td>
                        <td className="p-2 px-3 text-right tabular-nums">
                          {Number(t.valor_total) > 0 ? formatARS(Number(t.valor_total)) : '—'}
                        </td>
                        <td className="p-2 px-3">
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-xs ${badge.cls}`}>
                            <Icon className="h-3 w-3" />
                            {badge.label}
                          </span>
                          {t.rechazado_motivo && (
                            <div className="text-[10px] text-red-700 mt-0.5">{t.rechazado_motivo}</div>
                          )}
                          {t.cancelado_motivo && (
                            <div className="text-[10px] text-gray-600 mt-0.5">{t.cancelado_motivo}</div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* ─── Dialog nueva transferencia ─── */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nueva transferencia</DialogTitle>
            <DialogDescription>
              Mover stock desde <strong>{localOrigenNombre}</strong> a otro local. El destino tendrá que confirmar la recepción.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <Label>Insumo</Label>
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
              <Label>Local destino</Label>
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
              <Label>Cantidad {insumoSeleccionado && `(${insumoSeleccionado.unidad})`}</Label>
              <Input
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
              <Label>Motivo (opcional)</Label>
              <Textarea
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
              {submitting ? 'Enviando…' : 'Enviar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Dialog rechazar / cancelar (con motivo) ─── */}
      <Dialog open={accion !== null} onOpenChange={(v) => { if (!v) { setAccion(null); setAccionMotivo(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {accion?.tipo === 'rechazar' ? 'Rechazar recepción' : 'Cancelar transferencia'}
            </DialogTitle>
            <DialogDescription>
              {accion?.tipo === 'rechazar'
                ? `Rechazás recibir ${accion.transf.insumo_nombre}. El stock vuelve a ${accion.transf.local_origen_nombre}.`
                : `Cancelás la transferencia. El stock vuelve a ${accion?.transf.local_origen_nombre}.`}
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label>
              Motivo {accion?.tipo === 'rechazar' && <span className="text-red-700">*</span>}
            </Label>
            <Textarea
              value={accionMotivo}
              onChange={e => setAccionMotivo(e.target.value)}
              placeholder={accion?.tipo === 'rechazar'
                ? 'Ej: llegó dañado, mal porcionado, no era el insumo correcto'
                : 'Opcional'}
              rows={3}
              className="mt-1"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAccion(null); setAccionMotivo(''); }} disabled={accionSubmitting}>
              Volver
            </Button>
            <Button
              variant={accion?.tipo === 'rechazar' ? 'destructive' : 'default'}
              onClick={handleAccionMotivada}
              disabled={accionSubmitting || (accion?.tipo === 'rechazar' && accionMotivo.trim().length < 3)}
            >
              {accionSubmitting ? 'Guardando…' : (accion?.tipo === 'rechazar' ? 'Rechazar' : 'Cancelar transferencia')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Card de transferencia pendiente con acciones ─────────────────────

function TransferenciaCard({
  t, esDestino, esOrigen, onConfirmar, onRechazar, onCancelar,
}: {
  t: Transferencia;
  esDestino: boolean;
  esOrigen: boolean;
  onConfirmar: () => void;
  onRechazar: () => void;
  onCancelar: () => void;
}) {
  return (
    <Card className="border-amber-300 bg-amber-50/40">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Truck className="h-4 w-4 text-amber-700" />
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-xs bg-amber-100 text-amber-800 border-amber-300">
                En tránsito
              </span>
              <span className="text-xs text-foreground/60">
                {new Date(t.created_at).toLocaleString('es-AR', {
                  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                })}
              </span>
            </div>
            <div className="font-medium">{t.insumo_nombre}</div>
            <div className="text-sm text-foreground/70">
              <strong>{Number(t.cantidad).toFixed(2)} {t.unidad}</strong>
              {Number(t.valor_total) > 0 && (
                <span className="text-foreground/50 ml-2">· {formatARS(Number(t.valor_total))}</span>
              )}
            </div>
            <div className="text-xs mt-1">
              <span className="text-red-700">{t.local_origen_nombre}</span>
              <span className="text-foreground/40 mx-1.5">→</span>
              <span className="text-green-700">{t.local_destino_nombre}</span>
              {t.usuario_origen_nombre && (
                <span className="text-foreground/50 ml-2">por {t.usuario_origen_nombre}</span>
              )}
            </div>
            {t.motivo && (
              <div className="text-xs text-foreground/70 mt-1 italic">"{t.motivo}"</div>
            )}
          </div>
          <div className="flex flex-col gap-2 shrink-0">
            {esDestino && (
              <>
                <Button size="sm" onClick={onConfirmar}>
                  <Check className="h-3.5 w-3.5 mr-1.5" /> Confirmar recepción
                </Button>
                <Button size="sm" variant="outline" onClick={onRechazar}>
                  <X className="h-3.5 w-3.5 mr-1.5" /> Rechazar
                </Button>
              </>
            )}
            {esOrigen && !esDestino && (
              <Button size="sm" variant="outline" onClick={onCancelar}>
                <X className="h-3.5 w-3.5 mr-1.5" /> Cancelar envío
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
