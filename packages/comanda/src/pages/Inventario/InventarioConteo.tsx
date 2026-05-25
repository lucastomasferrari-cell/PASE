// InventarioConteo — conteo físico de inventario.
//
// Flujo:
//   1. Dueño/encargado clickea "Iniciar conteo" → snapshot del stock teórico.
//   2. Se imprime / muestra una lista por ubicación con espacio para anotar.
//   3. Se carga el conteo real insumo por insumo (cantidad contada).
//   4. Al finalizar: por cada línea con diferencia != 0, se inserta movimiento
//      tipo 'conteo' que la corrige.
//
// Patrón Toast Inventory Count: lista grande con input al lado. Si scroll
// es mucho, agrupamos por `insumos.ubicacion` (cámara fría, almacén seco).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ClipboardCheck, RefreshCw, Save, ChevronLeft, AlertCircle, Check,
  Eye, EyeOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import {
  listConteos, iniciarConteoFisico, listConteoLineas, cargarConteoLinea, finalizarConteoFisico,
  type StockConteo, type StockConteoLinea,
} from '@/services/insumosService';
import { formatARS } from '@/lib/format';

export function InventarioConteo() {
  const { user } = useAuth();
  const [localActivo] = useLocalActivo(user);
  const navigate = useNavigate();
  const [conteos, setConteos] = useState<StockConteo[]>([]);
  const [activeConteo, setActiveConteo] = useState<StockConteo | null>(null);
  const [lineas, setLineas] = useState<StockConteoLinea[]>([]);
  const [iniciando, setIniciando] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingLine, setSavingLine] = useState<number | null>(null);
  const [finalizando, setFinalizando] = useState(false);
  const [notasIniciales, setNotasIniciales] = useState('');
  // Conteo CIEGO: por default el usuario que cuenta NO ve el stock teórico
  // ni la diferencia mientras carga. Esto es el requisito del doc original:
  // "El empleado ve la lista de nombres pero el campo de Cantidad está vacío.
  // No puede ver el teórico". Sin esto, el empleado puede "dibujar" para
  // que coincida.
  //
  // FIX 25-may: la "Brecha de Eficiencia" (cuánta plata se perdió en el
  // conteo) solo la ve el DUEÑO según spec del doc original. Antes el
  // manager también la veía — ahora solo admin (= dueño en POS).
  // Manager y otros roles pueden cargar/finalizar conteos pero no ven el
  // dato financiero de la diferencia. Razón: la decisión de "¿hay fuga?"
  // es del dueño, no operativa.
  const esDueno = user?.rol_pos === 'admin';
  const [revelarTeoricos, setRevelarTeoricos] = useState(false);
  // mostrarTeorico (durante conteo activo): solo dueño puede revelar
  // teóricos en vivo para auditar. Manager queda en modo ciego siempre.
  const mostrarTeorico = esDueno && revelarTeoricos;

  const reload = useCallback(async () => {
    if (!localActivo) return;
    const { data, error } = await listConteos(localActivo);
    if (error) toast.error(error);
    else {
      setConteos(data);
      const open = data.find((c) => c.estado === 'abierto');
      if (open && !activeConteo) {
        setActiveConteo(open);
      }
    }
    setLoading(false);
  }, [localActivo, activeConteo]);

  useEffect(() => { void reload(); }, [reload]);

  // Cargar líneas cuando se selecciona un conteo
  useEffect(() => {
    if (!activeConteo) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await listConteoLineas(activeConteo.id);
      if (cancelled) return;
      if (error) toast.error(error);
      else setLineas(data);
    })();
    return () => { cancelled = true; };
  }, [activeConteo]);

  async function handleIniciar() {
    if (!localActivo) return;
    setIniciando(true);
    const { id, error } = await iniciarConteoFisico(localActivo, notasIniciales.trim() || undefined);
    setIniciando(false);
    if (error || !id) {
      toast.error(error || 'No pude iniciar conteo');
      return;
    }
    toast.success('Conteo iniciado');
    setNotasIniciales('');
    void reload();
  }

  async function handleCargarLinea(linea: StockConteoLinea, contado: number, notas?: string) {
    if (!activeConteo) return;
    setSavingLine(linea.insumo_id);
    const { error } = await cargarConteoLinea({
      conteoId: activeConteo.id,
      insumoId: linea.insumo_id,
      stockContado: contado,
      notas,
    });
    setSavingLine(null);
    if (error) {
      toast.error(error);
      return;
    }
    // Actualizar línea local
    setLineas((prev) => prev.map((l) =>
      l.insumo_id === linea.insumo_id
        ? { ...l, stock_contado: contado, diferencia: contado - l.stock_teorico, notas: notas ?? l.notas, contado_at: new Date().toISOString() }
        : l,
    ));
  }

  async function handleFinalizar() {
    if (!activeConteo) return;
    const lineasContadas = lineas.filter((l) => l.stock_contado != null).length;
    const lineasSinContar = lineas.length - lineasContadas;
    if (lineasContadas === 0) {
      toast.error('No cargaste ninguna cantidad — no hay nada para finalizar.');
      return;
    }
    if (lineasSinContar > 0) {
      if (!confirm(`Quedan ${lineasSinContar} insumos sin contar. Si finalizás, esos NO se ajustan (siguen con su stock teórico).\n\n¿Continuar igual?`)) {
        return;
      }
    }
    setFinalizando(true);
    const { data, error } = await finalizarConteoFisico(activeConteo.id);
    setFinalizando(false);
    if (error) {
      toast.error(error);
      return;
    }
    // Spec original del dueño: "Si la diferencia es negativa y no hay
    // mermas cargadas, el sistema dispara una Notificación Roja de
    // Posible Fuga". Si la pérdida supera $5k, mostramos alert
    // PROMINENTE además del toast (lo ve solo el dueño porque la pantalla
    // de finalizar solo la usa quien tiene permiso del módulo).
    //
    // Fix 25-may: por ahora alert visual prominente (no push real al celu
    // — eso requiere infra cross-service bot IG). El umbral $5k cubre
    // pérdidas significativas sin spam por diferencias de redondeo.
    const diffNeta = Number(data?.diferencia_valor ?? 0);
    const UMBRAL_FUGA = -5000;  // pérdida >$5k considera "posible fuga"
    if (diffNeta < UMBRAL_FUGA) {
      // Alert MUY visible (no solo toast). Toast como backup. Para que el
      // dueño NO siga su día sin haberlo registrado.
      toast.error(
        `🚨 POSIBLE FUGA detectada — pérdida ${formatARS(Math.abs(diffNeta))}. ` +
        `Revisá los ${data?.ajustes ?? 0} ajustes en el historial.`,
        { duration: 15000 }, // 15s, no se va solo
      );
      // Alert nativo bloqueante — fuerza al dueño a "ver" el dato antes de
      // continuar. Es feo pero efectivo (no se pierde en el feed de toasts).
      setTimeout(() => {
        alert(
          `⚠️ POSIBLE FUGA DETECTADA\n\n` +
          `El conteo terminó con ${data?.ajustes ?? 0} ajustes y una pérdida de ${formatARS(Math.abs(diffNeta))}.\n\n` +
          `Esto supera el umbral normal — revisá:\n` +
          `• ¿Hay mermas no declaradas en cocina?\n` +
          `• ¿Alguien movió mercadería sin registrar?\n` +
          `• ¿La cocina porcionó más de lo que dicen las recetas?\n\n` +
          `Las diferencias quedaron registradas en el historial.`,
        );
      }, 500); // pequeño delay para que el toast se vea primero
    } else {
      toast.success(`Conteo finalizado: ${data?.ajustes ?? 0} ajustes aplicados (diferencia neta ${formatARS(diffNeta)})`);
    }
    setActiveConteo(null);
    setLineas([]);
    void reload();
  }

  // Agrupar líneas por ubicación
  const grupos = useMemo(() => {
    const map = new Map<string, StockConteoLinea[]>();
    for (const l of lineas) {
      const ub = l.insumo_ubicacion ?? 'Sin ubicación';
      if (!map.has(ub)) map.set(ub, []);
      map.get(ub)!.push(l);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [lineas]);

  const lineasConDiff = lineas.filter((l) => l.stock_contado != null && l.diferencia !== 0);
  const valorDiff = lineasConDiff.reduce(
    (sum, l) => sum + (Number(l.diferencia) * Number(l.insumo_costo ?? 0)),
    0,
  );

  if (loading) return <div className="p-12 text-center text-foreground/60">Cargando…</div>;

  // ── Vista lista de conteos (cuando no hay uno seleccionado)
  if (!activeConteo) {
    return (
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate('/inventario/alertas')}>
            <ChevronLeft className="h-4 w-4 mr-1" /> Volver a inventario
          </Button>
        </div>
        <div>
          <h1 className="text-2xl font-medium flex items-center gap-2">
            <ClipboardCheck className="h-6 w-6" />
            Conteo físico de inventario
          </h1>
          <p className="text-sm text-foreground/60 mt-1">
            Auditoría periódica: contás insumo por insumo y el sistema ajusta automáticamente las diferencias.
          </p>
        </div>

        <Card>
          <CardContent className="p-4 space-y-3">
            <h2 className="font-medium">Iniciar nuevo conteo</h2>
            <Textarea
              placeholder="Notas opcionales (ej: conteo mensual fin de mes, conteo después de inventario perdido por corte de luz)"
              value={notasIniciales}
              onChange={(e) => setNotasIniciales(e.target.value)}
              rows={2}
            />
            <Button onClick={handleIniciar} disabled={iniciando}>
              {iniciando ? 'Iniciando…' : 'Iniciar conteo físico'}
            </Button>
          </CardContent>
        </Card>

        <div>
          <h2 className="font-medium mb-2">Historial</h2>
          {conteos.length === 0 ? (
            <p className="text-sm text-foreground/60">Sin conteos previos.</p>
          ) : (
            <div className="space-y-2">
              {conteos.map((c) => (
                <Card key={c.id} className={c.estado === 'abierto' ? 'border-amber-300' : ''}>
                  <CardContent className="p-3 flex items-center justify-between">
                    <div>
                      <div className="font-medium text-sm">
                        Conteo #{c.id} ·{' '}
                        <span className={c.estado === 'abierto' ? 'text-amber-700' : c.estado === 'finalizado' ? 'text-green-700' : 'text-gray-700'}>
                          {c.estado === 'abierto' ? 'ABIERTO' : c.estado === 'finalizado' ? 'finalizado' : 'cancelado'}
                        </span>
                      </div>
                      <p className="text-xs text-foreground/60 mt-0.5">
                        {new Date(c.iniciado_at).toLocaleString('es-AR')} ·{' '}
                        {c.total_insumos} insumos · {c.total_ajustes} ajustes
                        {/* FIX 25-may: el valor financiero de la diferencia
                            ("brecha de eficiencia") solo lo ve el dueño, según
                            spec. Manager/encargado ven cantidad de ajustes pero
                            no el monto perdido. */}
                        {esDueno && Number(c.valor_diferencia) !== 0 && (
                          <> · diferencia <strong>{formatARS(Number(c.valor_diferencia))}</strong></>
                        )}
                      </p>
                      {c.notas && <p className="text-xs text-foreground/70 mt-1">{c.notas}</p>}
                    </div>
                    <Button
                      variant={c.estado === 'abierto' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setActiveConteo(c)}
                    >
                      {c.estado === 'abierto' ? 'Continuar' : 'Ver'}
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Vista conteo activo (cargando datos)
  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setActiveConteo(null)}>
            <ChevronLeft className="h-4 w-4 mr-1" /> Conteos
          </Button>
          <div>
            <h1 className="text-lg font-medium">Conteo #{activeConteo.id}</h1>
            <p className="text-xs text-foreground/60">
              {activeConteo.estado === 'abierto' ? 'Abierto' : 'Finalizado'} ·{' '}
              {new Date(activeConteo.iniciado_at).toLocaleString('es-AR')} ·{' '}
              {lineas.filter((l) => l.stock_contado != null).length} / {lineas.length} insumos contados
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Toggle conteo ciego (solo DUEÑO puede revelar teórico
              mientras se cuenta — fix 25-may según spec original).
              Manager / encargados / empleados siempre van ciegos. */}
          {esDueno && activeConteo.estado === 'abierto' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRevelarTeoricos(!revelarTeoricos)}
              title={revelarTeoricos
                ? "Ocultar teóricos (modo auditor)"
                : "Mostrar teóricos (modo dueño)"}
            >
              {revelarTeoricos ? <EyeOff className="h-4 w-4 mr-1.5" /> : <Eye className="h-4 w-4 mr-1.5" />}
              {revelarTeoricos ? 'Ocultar teóricos' : 'Ver teóricos'}
            </Button>
          )}
          {activeConteo.estado === 'abierto' && (
            <Button onClick={handleFinalizar} disabled={finalizando}>
              <Save className="h-4 w-4 mr-1.5" />
              {finalizando ? 'Finalizando…' : 'Finalizar conteo'}
            </Button>
          )}
        </div>
      </div>

      {/* Mensaje informativo cuando conteo ciego está activo */}
      {!mostrarTeorico && activeConteo.estado === 'abierto' && (
        <Card className="border-blue-200 bg-blue-50">
          <CardContent className="p-3 text-sm flex items-start gap-3">
            <EyeOff className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" />
            <div>
              <strong className="text-blue-900">Conteo ciego activado</strong>
              <p className="text-xs text-blue-800/70 mt-0.5">
                Cargá la cantidad real de cada insumo sin mirar el stock que tiene cargado el sistema.
                El resultado se compara automáticamente al cerrar el conteo.
                {esDueno && ' Si querés ver el teórico, usá el botón "Ver teóricos".'}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Resumen diferencia neta — solo visible cuando se revelan teóricos */}
      {mostrarTeorico && lineasConDiff.length > 0 && (
        <Card className={Math.abs(valorDiff) > 1000 ? 'border-amber-300 bg-amber-50' : ''}>
          <CardContent className="p-3 text-sm flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600" />
            <div className="flex-1">
              <strong>{lineasConDiff.length}</strong> insumo(s) con diferencia detectada.
              Valor neto: <strong>{formatARS(valorDiff)}</strong>{' '}
              ({valorDiff > 0 ? 'sobrante' : 'faltante'} vs teórico).
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabla por ubicación */}
      {grupos.map(([ubicacion, items]) => (
        <Card key={ubicacion}>
          <CardContent className="p-0">
            <div className="px-3 py-2 bg-gray-50 border-b text-xs uppercase tracking-wide font-medium text-foreground/70">
              {ubicacion} ({items.length})
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="p-2 px-3 font-medium text-foreground/60">Insumo</th>
                  {mostrarTeorico && <th className="p-2 px-3 font-medium text-foreground/60 text-right">Teórico</th>}
                  <th className="p-2 px-3 font-medium text-foreground/60 text-right">Contado</th>
                  {mostrarTeorico && <th className="p-2 px-3 font-medium text-foreground/60 text-right">Diferencia</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((l) => (
                  <ConteoLineaRow
                    key={l.insumo_id}
                    linea={l}
                    saving={savingLine === l.insumo_id}
                    onSave={(c, n) => handleCargarLinea(l, c, n)}
                    readOnly={activeConteo.estado !== 'abierto'}
                    mostrarTeorico={mostrarTeorico}
                  />
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── Row con input cantidad ───────────────────────────────────────────

function ConteoLineaRow({ linea, saving, onSave, readOnly, mostrarTeorico }: {
  linea: StockConteoLinea;
  saving: boolean;
  onSave: (contado: number, notas?: string) => void;
  readOnly: boolean;
  mostrarTeorico: boolean;
}) {
  const [valor, setValor] = useState(linea.stock_contado?.toString() ?? '');
  const dirty = linea.stock_contado == null
    ? valor !== ''
    : valor !== linea.stock_contado.toString();

  function commit() {
    const n = parseFloat(valor);
    if (!Number.isFinite(n) || n < 0) return;
    onSave(n);
  }

  const diff = Number(linea.diferencia);
  const hayContado = linea.stock_contado != null;

  return (
    <tr className="border-b last:border-0 hover:bg-gray-50/50">
      <td className="p-2 px-3">
        <span className="font-medium">{linea.insumo_nombre}</span>
        <span className="text-xs text-foreground/40 ml-2">({linea.insumo_unidad})</span>
        {linea.notas && <span className="text-xs text-foreground/60 ml-2">({linea.notas})</span>}
      </td>
      {mostrarTeorico && (
        <td className="p-2 px-3 text-right tabular-nums text-foreground/60">
          {Number(linea.stock_teorico).toFixed(2)} {linea.insumo_unidad}
        </td>
      )}
      <td className="p-2 px-3 text-right">
        {/* FIX 25-may: input con sufijo de unidad VISIBLE (spec original
            del dueño: "obligá a poner Kilos, no cajones"). Antes la
            unidad solo aparecía al lado del nombre — fácil confundir
            "cargué 5" pensando 5 cajones cuando son 5 kg. Ahora el
            input lleva el sufijo pegado, imposible no verlo. */}
        <div className="flex items-center justify-end gap-1">
          <div className="relative">
            <Input
              type="number"
              step="0.01"
              min="0"
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              onBlur={() => { if (dirty) commit(); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
              disabled={readOnly}
              className="w-28 h-8 text-right tabular-nums pr-9"
              placeholder={`0 ${linea.insumo_unidad}`}
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-foreground/50 font-medium pointer-events-none">
              {linea.insumo_unidad}
            </span>
          </div>
          {hayContado && !dirty && <Check className="h-3.5 w-3.5 text-green-600" />}
          {saving && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
        </div>
      </td>
      {mostrarTeorico && (
        <td className="p-2 px-3 text-right tabular-nums">
          {hayContado ? (
            <span className={diff === 0 ? 'text-foreground/40' : diff > 0 ? 'text-green-700' : 'text-red-700'}>
              {diff > 0 ? '+' : ''}{diff.toFixed(2)} {linea.insumo_unidad}
            </span>
          ) : '—'}
        </td>
      )}
    </tr>
  );
}
