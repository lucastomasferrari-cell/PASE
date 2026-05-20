// InventarioAlertas — pantalla principal de inventario.
//
// 3 tabs:
//   - Alertas:    insumos con stock_actual < stock_minimo (urgente)
//   - Rotación:   qué se consume / se pierde en los últimos 30 días
//   - Movimientos: historial completo de todos los movimientos
//
// Acciones inline:
//   - Botón "Ajustar stock" sobre cualquier insumo → AjusteStockDialog
//   - Botón "Ver historial" → drawer con movimientos del insumo

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, RefreshCw, TrendingDown, TrendingUp, History, Package,
  ChevronRight, Plus, ClipboardCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatARS } from '@/lib/format';
import {
  listAlertasStock, listRotacionStock, listMovimientosInsumo,
  type AlertaStock, type RotacionStock, type InsumoMovimiento,
} from '@/services/insumosService';
import { AjusteStockDialog } from '@/components/dialogs/AjusteStockDialog';

const NIVEL_LABELS: Record<AlertaStock['alerta_nivel'], { label: string; color: string }> = {
  agotado:    { label: '🔴 Agotado',     color: 'bg-red-100 text-red-800' },
  bajo:       { label: '🟡 Stock bajo',  color: 'bg-amber-100 text-amber-800' },
  sobrestock: { label: '🔵 Sobrestock',  color: 'bg-sky-100 text-sky-800' },
  ok:         { label: '🟢 OK',          color: 'bg-green-100 text-green-800' },
};

const TIPO_LABELS: Record<InsumoMovimiento['tipo'], { label: string; color: string }> = {
  entrada_compra:     { label: 'Compra',     color: 'text-green-700' },
  entrada_ajuste:     { label: 'Entrada manual', color: 'text-green-600' },
  entrada_devolucion: { label: 'Devolución', color: 'text-green-600' },
  salida_venta:       { label: 'Venta',      color: 'text-blue-600' },
  salida_ajuste:      { label: 'Salida manual', color: 'text-gray-600' },
  merma:              { label: 'Merma',      color: 'text-amber-700' },
  robo:               { label: 'Robo',       color: 'text-red-700' },
  donacion:           { label: 'Donación',   color: 'text-purple-700' },
  conteo:             { label: 'Conteo ajuste', color: 'text-sky-700' },
  inicial:            { label: 'Carga inicial', color: 'text-gray-500' },
};

export function InventarioAlertas() {
  const [alertas, setAlertas] = useState<AlertaStock[]>([]);
  const [rotacion, setRotacion] = useState<RotacionStock[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [ajusteOpen, setAjusteOpen] = useState(false);
  const [insumoAjuste, setInsumoAjuste] = useState<{ id: number; nombre: string; unidad: string; stock: number } | null>(null);
  const [movimientosOpen, setMovimientosOpen] = useState(false);
  const [movimientos, setMovimientos] = useState<InsumoMovimiento[]>([]);
  const [insumoMovs, setInsumoMovs] = useState<{ id: number; nombre: string; unidad: string } | null>(null);

  const reload = useCallback(async () => {
    setRefreshing(true);
    const [a, r] = await Promise.all([
      listAlertasStock(),
      listRotacionStock(),
    ]);
    if (a.error) toast.error(a.error);
    else setAlertas(a.data);
    if (r.error) toast.error(r.error);
    else setRotacion(r.data);
    setRefreshing(false);
    setLoading(false);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  function abrirAjuste(a: AlertaStock) {
    setInsumoAjuste({
      id: a.id,
      nombre: a.nombre,
      unidad: a.unidad,
      stock: Number(a.stock_actual),
    });
    setAjusteOpen(true);
  }

  async function abrirMovimientos(insumoId: number, nombre: string, unidad: string) {
    setInsumoMovs({ id: insumoId, nombre, unidad });
    setMovimientosOpen(true);
    const { data, error } = await listMovimientosInsumo(insumoId, { limit: 200 });
    if (error) toast.error(error);
    else setMovimientos(data);
  }

  if (loading) return <div className="p-12 text-center text-foreground/60">Cargando inventario…</div>;

  const counts = {
    agotado: alertas.filter((a) => a.alerta_nivel === 'agotado').length,
    bajo:    alertas.filter((a) => a.alerta_nivel === 'bajo').length,
    sobrestock: alertas.filter((a) => a.alerta_nivel === 'sobrestock').length,
  };

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-medium flex items-center gap-2">
            <Package className="h-6 w-6" />
            Inventario
          </h1>
          <p className="text-sm text-foreground/60 mt-1">
            Stock actual de insumos · alertas · rotación 30 días
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/inventario/conteo">
            <Button variant="outline" size="sm">
              <ClipboardCheck className="h-4 w-4 mr-1.5" />
              Conteo físico
            </Button>
          </Link>
          <Button variant="outline" size="sm" onClick={() => reload()} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Resumen rápido */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-red-100 flex items-center justify-center">
              <AlertTriangle className="h-5 w-5 text-red-700" />
            </div>
            <div>
              <div className="text-xs uppercase text-foreground/60">Agotados</div>
              <div className="text-2xl font-semibold">{counts.agotado}</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-amber-100 flex items-center justify-center">
              <TrendingDown className="h-5 w-5 text-amber-700" />
            </div>
            <div>
              <div className="text-xs uppercase text-foreground/60">Stock bajo</div>
              <div className="text-2xl font-semibold">{counts.bajo}</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-sky-100 flex items-center justify-center">
              <TrendingUp className="h-5 w-5 text-sky-700" />
            </div>
            <div>
              <div className="text-xs uppercase text-foreground/60">Sobrestock</div>
              <div className="text-2xl font-semibold">{counts.sobrestock}</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="alertas" className="w-full">
        <TabsList>
          <TabsTrigger value="alertas">Alertas ({alertas.length})</TabsTrigger>
          <TabsTrigger value="rotacion">Rotación 30 días</TabsTrigger>
        </TabsList>

        <TabsContent value="alertas" className="mt-4">
          {alertas.length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center">
                <Package className="h-10 w-10 mx-auto text-green-500 mb-3" />
                <p className="font-medium">Todo OK</p>
                <p className="text-sm text-foreground/60 mt-1">
                  No hay alertas de stock — todos los insumos están en niveles aceptables.
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="p-2 px-3 font-medium text-foreground/60">Insumo</th>
                    <th className="p-2 px-3 font-medium text-foreground/60 text-right">Stock</th>
                    <th className="p-2 px-3 font-medium text-foreground/60 text-right">Mínimo</th>
                    <th className="p-2 px-3 font-medium text-foreground/60 text-right">Días est.</th>
                    <th className="p-2 px-3 font-medium text-foreground/60">Estado</th>
                    <th className="p-2 px-3 font-medium text-foreground/60"></th>
                  </tr>
                </thead>
                <tbody>
                  {alertas.map((a) => {
                    const lvl = NIVEL_LABELS[a.alerta_nivel];
                    const dias = a.dias_estimados_restantes;
                    return (
                      <tr key={a.id} className="border-b last:border-0 hover:bg-gray-50">
                        <td className="p-2 px-3">
                          <div className="flex items-center gap-1.5">
                            {a.emoji && <span>{a.emoji}</span>}
                            <span className="font-medium">{a.nombre}</span>
                          </div>
                        </td>
                        <td className="p-2 px-3 text-right tabular-nums">
                          {Number(a.stock_actual).toFixed(2)} {a.unidad}
                        </td>
                        <td className="p-2 px-3 text-right text-foreground/60 tabular-nums">
                          {a.stock_minimo != null ? `${Number(a.stock_minimo).toFixed(2)} ${a.unidad}` : '—'}
                        </td>
                        <td className="p-2 px-3 text-right text-foreground/60 tabular-nums">
                          {dias != null && Number.isFinite(Number(dias)) ? `${Math.floor(Number(dias))}d` : '—'}
                        </td>
                        <td className="p-2 px-3">
                          <span className={`text-xs px-2 py-0.5 rounded-md font-medium ${lvl.color}`}>{lvl.label}</span>
                        </td>
                        <td className="p-2 px-3 text-right whitespace-nowrap">
                          <Button variant="ghost" size="sm" onClick={() => abrirAjuste(a)}>
                            <Plus className="h-3.5 w-3.5 mr-1" /> Ajustar
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => abrirMovimientos(a.id, a.nombre, a.unidad)}>
                            <History className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="rotacion" className="mt-4">
          <Card>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="p-2 px-3 font-medium text-foreground/60">Insumo</th>
                  <th className="p-2 px-3 font-medium text-foreground/60 text-right">Consumido 30d</th>
                  <th className="p-2 px-3 font-medium text-foreground/60 text-right">Perdido</th>
                  <th className="p-2 px-3 font-medium text-foreground/60 text-right">Comprado</th>
                  <th className="p-2 px-3 font-medium text-foreground/60 text-right">$ Costo consumido</th>
                  <th className="p-2 px-3"></th>
                </tr>
              </thead>
              <tbody>
                {rotacion.map((r) => (
                  <tr key={r.insumo_id} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="p-2 px-3 font-medium">{r.nombre}</td>
                    <td className="p-2 px-3 text-right tabular-nums">{Number(r.consumido_30d).toFixed(2)} {r.unidad}</td>
                    <td className="p-2 px-3 text-right tabular-nums text-amber-700">
                      {Number(r.perdido_30d) > 0 ? `${Number(r.perdido_30d).toFixed(2)} ${r.unidad}` : '—'}
                    </td>
                    <td className="p-2 px-3 text-right tabular-nums">{Number(r.comprado_30d).toFixed(2)} {r.unidad}</td>
                    <td className="p-2 px-3 text-right tabular-nums font-medium">{formatARS(Number(r.valor_consumido_30d))}</td>
                    <td className="p-2 px-3 text-right">
                      <Button variant="ghost" size="sm" onClick={() => abrirMovimientos(r.insumo_id, r.nombre, r.unidad)}>
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Dialog ajuste */}
      <AjusteStockDialog
        open={ajusteOpen}
        onOpenChange={setAjusteOpen}
        insumoId={insumoAjuste?.id ?? null}
        insumoNombre={insumoAjuste?.nombre ?? ''}
        unidad={insumoAjuste?.unidad ?? ''}
        stockActual={insumoAjuste?.stock ?? 0}
        onApplied={reload}
      />

      {/* Drawer historial movimientos */}
      {movimientosOpen && insumoMovs && (
        <div className="fixed inset-0 bg-black/30 z-40 flex justify-end" onClick={() => setMovimientosOpen(false)}>
          <div className="bg-white w-full max-w-lg h-full overflow-y-auto p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-medium">Historial: {insumoMovs.nombre}</h2>
                <p className="text-xs text-foreground/60">Últimos 200 movimientos</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setMovimientosOpen(false)}>✕</Button>
            </div>
            {movimientos.length === 0 ? (
              <p className="text-sm text-foreground/60 py-8 text-center">Sin movimientos.</p>
            ) : (
              <div className="space-y-1.5">
                {movimientos.map((m) => {
                  const cfg = TIPO_LABELS[m.tipo];
                  const positive = Number(m.cantidad) > 0;
                  return (
                    <div key={m.id} className="border rounded-md p-2.5 text-xs hover:bg-gray-50">
                      <div className="flex items-center justify-between mb-1">
                        <span className={`font-medium ${cfg.color}`}>{cfg.label}</span>
                        <span className={positive ? 'text-green-700 font-mono' : 'text-red-700 font-mono'}>
                          {positive ? '+' : ''}{Number(m.cantidad).toFixed(2)} {insumoMovs.unidad}
                        </span>
                      </div>
                      <div className="text-foreground/60 flex items-center justify-between">
                        <span>{new Date(m.created_at).toLocaleString('es-AR')}</span>
                        <span>Resultó: {Number(m.stock_despues).toFixed(2)}</span>
                      </div>
                      {m.motivo && <p className="text-foreground/70 mt-1">{m.motivo}</p>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
