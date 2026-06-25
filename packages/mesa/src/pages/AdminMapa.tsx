// Mapa de mesas en vivo — sección del panel admin de MESA (etapa 2).
// Vista read-only del plano del salón con colores de estado en tiempo real
// (libre / ocupada por ticket / en mesa por reserva / reservada pronto).
// La edición de posiciones (drag-drop) queda en COMANDA → Config → Mesas.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Users, Clock, RefreshCw } from 'lucide-react';
import {
  listMesas, estadoMesasLive,
  type Mesa, type MesaEstadoLive, type EstadoMesaLive,
} from '@/lib/mesasService';

interface Props { localId: number; }

const CANVAS_W = 900;
const CANVAS_H = 540;

const ESTADO_STYLE: Record<EstadoMesaLive, { border: string; bg: string; text: string; dot: string }> = {
  libre:            { border: 'border-emerald-400', bg: 'bg-emerald-50', text: 'text-emerald-800', dot: 'bg-emerald-400' },
  ocupada_ticket:   { border: 'border-red-400',     bg: 'bg-red-50',     text: 'text-red-800',     dot: 'bg-red-400'     },
  ocupada_reserva:  { border: 'border-indigo-400',  bg: 'bg-indigo-50',  text: 'text-indigo-800',  dot: 'bg-indigo-400'  },
  reservada_pronto: { border: 'border-amber-400',   bg: 'bg-amber-50',   text: 'text-amber-800',   dot: 'bg-amber-400'   },
};

const ESTADO_LABEL: Record<EstadoMesaLive, string> = {
  libre: 'Libre',
  ocupada_ticket: 'Ocupada (ticket)',
  ocupada_reserva: 'En mesa (reserva)',
  reservada_pronto: 'Reservada pronto',
};

function mesaSize(m: Mesa): { w: number; h: number } {
  const w = m.ancho > 0 ? m.ancho : (m.forma === 'rectangular' ? 110 : 80);
  const h = m.alto  > 0 ? m.alto  : (m.forma === 'rectangular' ?  65 : 80);
  return { w, h };
}

function relativoCorto(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'recién';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h${min % 60 ? ` ${min % 60}m` : ''}`;
}

export function AdminMapa({ localId }: Props) {
  const [mesas, setMesas] = useState<Mesa[]>([]);
  const [estados, setEstados] = useState<Map<number, MesaEstadoLive>>(new Map());
  const [cargando, setCargando] = useState(true);

  const reload = useCallback(async () => {
    const [m, e] = await Promise.all([listMesas(localId), estadoMesasLive(localId)]);
    if (m.error) toast.error('No se pudieron cargar las mesas: ' + m.error);
    setMesas(m.data);
    setEstados(new Map(e.data.map((x) => [x.mesa_id, x])));
    setCargando(false);
  }, [localId]);

  useEffect(() => { setCargando(true); void reload(); }, [reload]);

  // Refresco en vivo cada 30s.
  useEffect(() => {
    const id = setInterval(() => { void reload(); }, 30000);
    return () => clearInterval(id);
  }, [reload]);

  const ubicadas = useMemo(() => mesas.filter((m) => m.pos_x !== null), [mesas]);
  const sinUbicar = useMemo(() => mesas.filter((m) => m.pos_x === null), [mesas]);

  const conteo = useMemo(() => {
    const c: Record<EstadoMesaLive, number> = { libre: 0, ocupada_ticket: 0, ocupada_reserva: 0, reservada_pronto: 0 };
    for (const m of mesas) c[estados.get(m.id)?.estado_live ?? 'libre']++;
    return c;
  }, [mesas, estados]);

  if (cargando) return <div className="py-16 text-center text-ink-muted">Cargando plano…</div>;

  if (mesas.length === 0) {
    return (
      <div className="mt-6 rounded-2xl bg-white border border-ink/5 shadow-card py-16 text-center">
        <p className="font-medium">Este local no tiene mesas cargadas</p>
        <p className="text-sm text-ink-muted mt-1">Se crean y se ubican en el plano desde COMANDA → Configuración → Mesas.</p>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-3">
      {/* Leyenda + contadores + refresco */}
      <div className="flex items-center gap-4 text-xs text-ink-muted flex-wrap">
        {(Object.entries(ESTADO_STYLE) as [EstadoMesaLive, (typeof ESTADO_STYLE)[EstadoMesaLive]][]).map(([k, s]) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${s.dot}`} />
            {ESTADO_LABEL[k]} <span className="font-medium text-ink-soft">({conteo[k]})</span>
          </span>
        ))}
        <button onClick={() => void reload()} className="ml-auto inline-flex items-center gap-1 text-ink-soft hover:text-ink">
          <RefreshCw className="h-3.5 w-3.5" /> Actualizar
        </button>
      </div>

      {/* Canvas */}
      <div className="border border-ink/10 rounded-xl overflow-auto bg-white">
        <div
          className="relative bg-[radial-gradient(circle,_#C5E0F4_1px,_transparent_1px)] bg-[size:24px_24px]"
          style={{ width: CANVAS_W, height: CANVAS_H, minWidth: CANVAS_W }}
        >
          {ubicadas.map((m) => (
            <div key={m.id} className="absolute" style={{ left: m.pos_x ?? 0, top: m.pos_y ?? 0 }}>
              <MesaToken mesa={m} estado={estados.get(m.id) ?? null} />
            </div>
          ))}
        </div>
      </div>

      {/* Sin ubicar */}
      {sinUbicar.length > 0 && (
        <div className="rounded-lg border border-dashed border-ink/15 p-3">
          <p className="text-xs font-medium text-ink-muted mb-2">Sin ubicar en el plano (ubicalas desde COMANDA)</p>
          <div className="flex flex-wrap gap-2">
            {sinUbicar.map((m) => <MesaToken key={m.id} mesa={m} estado={estados.get(m.id) ?? null} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function MesaToken({ mesa, estado }: { mesa: Mesa; estado: MesaEstadoLive | null }) {
  const { w, h } = mesaSize(mesa);
  const esLive = estado?.estado_live ?? 'libre';
  const s = ESTADO_STYLE[esLive];

  return (
    <div
      className={`flex flex-col items-center justify-center border-2 select-none ${s.border} ${s.bg} ${s.text} ${
        mesa.forma === 'redondo' ? 'rounded-full' : 'rounded-lg'
      }`}
      style={{ width: w, height: h }}
      title={estado?.reserva_nombre ? `Reserva: ${estado.reserva_nombre}` : ESTADO_LABEL[esLive]}
    >
      <span className="text-xs font-bold leading-tight">{mesa.numero}</span>
      {mesa.capacidad != null && (
        <span className="flex items-center gap-0.5 text-[10px] opacity-70 mt-0.5">
          <Users className="h-2.5 w-2.5" />{mesa.capacidad}
        </span>
      )}
      {estado && esLive !== 'libre' && (
        <span className="text-[10px] mt-0.5 opacity-80 leading-none text-center px-0.5 w-full truncate">
          {esLive === 'ocupada_ticket' && estado.venta_abierta_at ? (
            <span className="flex items-center justify-center gap-0.5">
              <Clock className="h-2.5 w-2.5 flex-shrink-0" />{relativoCorto(estado.venta_abierta_at)}
            </span>
          ) : estado.reserva_nombre ? estado.reserva_nombre.split(' ')[0] : null}
        </span>
      )}
    </div>
  );
}
