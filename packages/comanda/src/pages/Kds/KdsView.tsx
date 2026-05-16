import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Volume2, VolumeX, Undo2, CheckCheck, EyeOff, Eye } from 'lucide-react';
import { toast, Toaster } from 'sonner';
import { getTickets, marcarListo, recall, type KdsTicket } from '@/services/kdsService';
import { ESTACIONES, type EstacionKds } from '@/services/kdsTokensService';
import { useVisiblePolling } from '@/lib/useVisiblePolling';

const POLL_MS = 10000;

const ESTACION_INFO: Record<string, { label: string; emoji: string }> = {
  cocina_caliente: { label: 'Cocina caliente', emoji: '🔥' },
  cocina_fria:     { label: 'Cocina fría',     emoji: '🥗' },
  barra:           { label: 'Barra',           emoji: '🍹' },
  postres:         { label: 'Postres',         emoji: '🍰' },
};

function urgenciaColor(seg: number): string {
  if (seg < 5 * 60) return 'bg-emerald-500';
  if (seg < 10 * 60) return 'bg-amber-500';
  return 'bg-red-600';
}

function formatearTimer(seg: number): string {
  const m = Math.floor(seg / 60);
  const s = seg % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function KdsView() {
  const { estacion } = useParams<{ estacion: string }>();
  const [search] = useSearchParams();
  const token = search.get('token') ?? '';
  const [tickets, setTickets] = useState<KdsTicket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloj, setReloj] = useState<string>(() => new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false }));
  const [sonido, setSonido] = useState(false);
  // Auto-hide: cards 100% listas hace más de N minutos se ocultan del feed
  // principal. La cocina puede mostrarlas con el toggle "Ver entregadas".
  // Recall sigue funcionando los primeros 60s (cubierto por estado='listo'
  // + segundos_desde_enviado < 60).
  const AUTO_HIDE_MIN = 5;
  const [mostrarOcultas, setMostrarOcultas] = useState(false);
  const conocidosRef = useRef<Set<number>>(new Set());

  const estacionValida = estacion && estacion in ESTACION_INFO;
  const info = estacionValida ? ESTACION_INFO[estacion] : null;
  const estacionTipo: EstacionKds | null = (ESTACIONES.find(e => e.id === estacion)?.id ?? null);

  const fetchTickets = useCallback(async () => {
    if (!token || !estacionValida) return;
    const { data, error: err } = await getTickets(token);
    if (err) { setError(err); return; }
    setError(null);
    // Sonar campanita en items nuevos.
    if (sonido) {
      const nuevos = data.filter(t => !conocidosRef.current.has(t.item_id));
      if (nuevos.length > 0 && conocidosRef.current.size > 0) beep();
    }
    conocidosRef.current = new Set(data.map(t => t.item_id));
    setTickets(data);
  }, [token, estacionValida, sonido]);

  // Sprint 7 PERF: useVisiblePolling pausa cuando la pestaña KDS está
  // oculta (cocinero abre otra app, navega a otra tab) y reanuda al
  // volver. Reduce queries desperdiciadas — KDS pollea cada 10s, en
  // turno de 8h con tab oculta serían ~2880 requests innecesarios/día.
  useEffect(() => { fetchTickets(); }, [fetchTickets]);
  useVisiblePolling(fetchTickets, POLL_MS);

  useEffect(() => {
    const t = setInterval(() => {
      setReloj(new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false }));
    }, 30000);
    return () => clearInterval(t);
  }, []);

  if (!estacionValida || !info || !estacionTipo) {
    return <KdsErrorScreen mensaje="Estación no reconocida en la URL." />;
  }
  if (!token) {
    return <KdsErrorScreen mensaje="Falta el token. Pedile al manager el QR de esta estación." />;
  }
  if (error) {
    return <KdsErrorScreen mensaje={`No se pudieron cargar los tickets: ${error}`} />;
  }
  if (tickets == null) {
    return <div className="min-h-screen bg-zinc-950 text-zinc-400 flex items-center justify-center text-sm">Cargando…</div>;
  }

  // Agrupar items por venta para emitir 1 card por venta con sus items.
  const ventasTodas = agruparPorVenta(tickets);

  // Tracking de cuándo cada venta pasó a estar 100% lista. Se actualiza
  // dentro del effect de abajo. Si todoListo y tiempo > AUTO_HIDE_MIN, la
  // ocultamos del feed principal (cocina puede mostrarlas con el toggle).
  // NOTA: el ref se inicializa una sola vez por mount del componente; al
  // refetch viene la nueva data, pero el ref persiste. Vamos a podar
  // entradas viejas en el effect.
  const listoDesdeRef = useRef<Map<number, number>>(new Map());
  useEffect(() => {
    const now = Date.now();
    const activas = new Set(ventasTodas.map((v) => v.venta_id));
    // Podar entradas que ya no aparecen
    for (const key of Array.from(listoDesdeRef.current.keys())) {
      if (!activas.has(key)) listoDesdeRef.current.delete(key);
    }
    // Registrar/actualizar el momento "primera vez 100% lista"
    for (const v of ventasTodas) {
      const todoListo = v.items.every((i) => i.estado === 'listo');
      if (todoListo && !listoDesdeRef.current.has(v.venta_id)) {
        listoDesdeRef.current.set(v.venta_id, now);
      } else if (!todoListo && listoDesdeRef.current.has(v.venta_id)) {
        // Si un item volvió de listo (recall), reseteamos el contador
        listoDesdeRef.current.delete(v.venta_id);
      }
    }
  }, [ventasTodas]);

  const ahora = Date.now();
  const { ventasVisibles, ventasOcultas } = useMemo(() => {
    const visibles: typeof ventasTodas = [];
    const ocultas: typeof ventasTodas = [];
    for (const v of ventasTodas) {
      const listoDesde = listoDesdeRef.current.get(v.venta_id);
      const minListo = listoDesde ? (ahora - listoDesde) / 60_000 : 0;
      if (listoDesde && minListo >= AUTO_HIDE_MIN) {
        ocultas.push(v);
      } else {
        visibles.push(v);
      }
    }
    return { ventasVisibles: visibles, ventasOcultas: ocultas };
  }, [ventasTodas, ahora, AUTO_HIDE_MIN]);

  // Re-render cada 30s para que las ventas que cumplen 5min se oculten sin
  // esperar al próximo poll. Cheap: solo cambia el `ahora`.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const ventas = mostrarOcultas ? ventasTodas : ventasVisibles;

  async function handleListo(itemId: number) {
    const { error: err } = await marcarListo(token, itemId);
    if (err) {
      toast.error('No se pudo marcar listo: ' + err);
      return;
    }
    fetchTickets();
  }

  async function handleRecall(itemId: number) {
    const { error: err } = await recall(token, itemId);
    if (err) {
      toast.error(err.includes('VENTANA') ? 'Pasaron más de 60 segundos, no se puede deshacer.' : err);
      return;
    }
    fetchTickets();
  }

  // "Listo todo" para una venta: marca todos los items pendientes en paralelo.
  // Útil cuando una mesa pide 4 cosas y salen todas juntas — evita 4 taps.
  async function handleListoTodo(items: KdsTicket[]) {
    const pendientes = items.filter((i) => i.estado !== 'listo');
    if (pendientes.length === 0) return;
    const results = await Promise.all(pendientes.map((i) => marcarListo(token, i.item_id)));
    const errores = results.filter((r) => r.error);
    if (errores.length > 0) {
      toast.error(`${errores.length} de ${pendientes.length} items no se pudieron marcar`);
    } else {
      toast.success(`${pendientes.length} items marcados listos`);
    }
    fetchTickets();
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <Toaster position="top-center" theme="dark" richColors closeButton />
      <header className="h-14 px-4 flex items-center justify-between bg-black border-b border-zinc-800 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{info.emoji}</span>
          <div>
            <div className="text-base font-semibold">{info.label}</div>
            <div className="text-[10px] text-zinc-400">{tickets.length} {tickets.length === 1 ? 'ticket' : 'tickets'}</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-2xl font-mono tabular-nums">{reloj}</span>
          {ventasOcultas.length > 0 && (
            <button
              type="button"
              onClick={() => setMostrarOcultas((v) => !v)}
              className="h-10 px-3 rounded-md bg-zinc-800 hover:bg-zinc-700 flex items-center gap-1.5 text-xs"
              aria-label={mostrarOcultas ? 'Ocultar entregadas' : 'Mostrar entregadas'}
              title={`${ventasOcultas.length} venta(s) lista(s) hace >${AUTO_HIDE_MIN} min`}
            >
              {mostrarOcultas ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              <span className="tabular-nums">{ventasOcultas.length}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setSonido(s => !s)}
            className="h-10 w-10 rounded-md bg-zinc-800 hover:bg-zinc-700 flex items-center justify-center"
            aria-label={sonido ? 'Silenciar' : 'Activar sonido'}
          >
            {sonido ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
          </button>
        </div>
      </header>

      {ventas.length === 0 ? (
        <div className="p-12 text-center text-zinc-500">
          <div className="text-6xl mb-2">🎉</div>
          <p className="text-lg">Sin tickets pendientes</p>
          <p className="text-xs mt-2">Cuando lleguen pedidos a esta estación van a aparecer acá.</p>
        </div>
      ) : (
        <div className="p-3 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          {ventas.map(v => {
            const segMax = Math.max(...v.items.map(i => i.segundos_desde_enviado));
            const todoListo = v.items.every(i => i.estado === 'listo');
            const colorHeader = todoListo ? 'bg-emerald-700' : urgenciaColor(segMax);
            return (
              <article key={v.venta_id} className={`rounded-lg overflow-hidden border bg-zinc-900 transition-opacity ${todoListo ? 'border-emerald-700 opacity-60' : 'border-zinc-800'}`}>
                <header className={`px-3 py-2 ${colorHeader} text-white flex items-center justify-between gap-2`}>
                  <div className="min-w-0 flex-1">
                    <div className="text-base font-semibold truncate">
                      #{v.venta_numero}
                      {v.mesa_numero && <span className="ml-2">· Mesa {v.mesa_numero}</span>}
                      {!v.mesa_numero && v.cliente_nombre && <span className="ml-2 text-sm">· {v.cliente_nombre}</span>}
                    </div>
                    {v.mozo_nombre && <div className="text-[10px] opacity-90 truncate">{v.mozo_nombre}</div>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="text-2xl font-mono tabular-nums">{formatearTimer(segMax)}</div>
                    {!todoListo && v.items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleListoTodo(v.items)}
                        className="bg-white/15 hover:bg-white/25 rounded px-2 h-8 flex items-center gap-1 text-xs font-semibold"
                        aria-label="Marcar todo listo"
                        title="Marcar todos los items de esta venta como listos"
                      >
                        <CheckCheck className="h-3.5 w-3.5" />
                        Todo
                      </button>
                    )}
                  </div>
                </header>
                <div className="p-3 space-y-2">
                  {v.items.map(it => (
                    <div key={it.item_id} className={`rounded-md p-2 ${it.estado === 'listo' ? 'bg-emerald-950 border border-emerald-700' : 'bg-zinc-800'}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-sm font-medium">
                          <span className="font-bold mr-1">{it.cantidad}×</span>
                          {it.item_emoji && <span className="mr-1">{it.item_emoji}</span>}
                          {it.item_nombre}
                        </div>
                        {it.estado === 'listo' && it.segundos_desde_enviado < 60 && (
                          <button
                            type="button"
                            onClick={() => handleRecall(it.item_id)}
                            className="text-xs flex items-center gap-1 text-amber-400 hover:text-amber-300"
                            aria-label="Deshacer"
                          >
                            <Undo2 className="h-3 w-3" /> Deshacer
                          </button>
                        )}
                      </div>
                      {Array.isArray(it.modificadores) && it.modificadores.length > 0 && (
                        <ul className="mt-1 ml-4 text-[11px] text-zinc-300 list-disc list-inside">
                          {it.modificadores.map((m, i) => <li key={i}>{m.nombre}</li>)}
                        </ul>
                      )}
                      {it.notas && (
                        <p className="mt-1 text-[11px] italic text-orange-300">📝 {it.notas}</p>
                      )}
                      {it.estado !== 'listo' && (
                        <button
                          type="button"
                          onClick={() => handleListo(it.item_id)}
                          className="mt-2 w-full h-12 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-semibold rounded-md text-base"
                        >
                          ✓ Listo
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface VentaAgrupada {
  venta_id: number;
  venta_numero: number;
  mesa_numero: string | null;
  cliente_nombre: string | null;
  mozo_nombre: string;
  items: KdsTicket[];
}

function agruparPorVenta(tickets: KdsTicket[]): VentaAgrupada[] {
  const mp = new Map<number, VentaAgrupada>();
  for (const t of tickets) {
    let g = mp.get(t.venta_id);
    if (!g) {
      g = {
        venta_id: t.venta_id,
        venta_numero: t.venta_numero,
        mesa_numero: t.mesa_numero,
        cliente_nombre: t.cliente_nombre,
        mozo_nombre: t.mozo_nombre,
        items: [],
      };
      mp.set(t.venta_id, g);
    }
    g.items.push(t);
  }
  return Array.from(mp.values()).sort((a, b) => Math.max(...b.items.map(i => i.segundos_desde_enviado))
    - Math.max(...a.items.map(i => i.segundos_desde_enviado)));
}

function beep(): void {
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = 880;
    gain.gain.value = 0.1;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, 150);
  } catch { /* user gesture not yet detected */ }
}

function KdsErrorScreen({ mensaje }: { mensaje: string }) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div className="text-5xl mb-3">⚠️</div>
        <h1 className="text-lg font-semibold">Token KDS inválido</h1>
        <p className="text-sm text-zinc-400 mt-2">{mensaje}</p>
      </div>
    </div>
  );
}
