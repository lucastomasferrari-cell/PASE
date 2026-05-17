import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layout } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAuthPos } from '../../lib/authPos';
import { useLocalActivo } from '../../lib/localActivo';
import { usePermiso } from '../../lib/usePermiso';
import { listMesasConVentas, type MesaConVenta } from '../../services/mesasService';
import { abrirVenta } from '../../services/ventasService';
import { listCanales } from '../../services/canalesService';
import { Stepper } from '../../components/Stepper';
import { formatARS, relativoCorto } from '../../lib/format';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { ComandasActivasPanel } from '@/components/ComandasActivasPanel';
import { SalonLayoutEditor } from './SalonLayoutEditor';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import { cn } from '@/lib/utils';

export function SalonView() {
  const { user } = useAuth();
  const { empleado } = useAuthPos();
  const [localId] = useLocalActivo(user);
  const navigate = useNavigate();

  const [mesas, setMesas] = useState<MesaConVenta[]>([]);
  const [zona, setZona] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [abrirDialog, setAbrirDialog] = useState<MesaConVenta | null>(null);
  const [editandoLayout, setEditandoLayout] = useState(false);
  const puedeEditarLayout = usePermiso('comanda.config.editar');

  // Tick cada 30s para refrescar relativoCorto + alertas de tiempo sin reconsultar
  // DB. El hook realtime cubre cambios de estado; este solo re-renderiza.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const reload = useCallback(async () => {
    if (localId === null) return;
    setLoading(true);
    const { data, error: err } = await listMesasConVentas(localId);
    if (err) setError(err);
    setMesas(data);
    setLoading(false);
  }, [localId]);

  useEffect(() => { reload(); }, [reload]);

  // F0.3 Realtime: cuando otra computadora cambia mesas o ventas_pos del
  // mismo local, refrescamos automático. Fallback a polling si Realtime
  // se desconecta (manejado por el hook).
  useRealtimeTable({ table: 'mesas', onChange: () => reload(), scopeByLocal: true });
  useRealtimeTable({ table: 'ventas_pos', onChange: () => reload(), scopeByLocal: true, extraFilter: 'modo=eq.salon' });

  const zonas = useMemo(() => {
    const set = new Set<string>();
    for (const m of mesas) if (m.zona) set.add(m.zona);
    return Array.from(set).sort();
  }, [mesas]);

  const mesasFiltradas = useMemo(() => {
    if (zona === null) return mesas;
    return mesas.filter((m) => m.zona === zona);
  }, [mesas, zona]);

  // Resumen del salón filtrado (lo que ve el cajero/encargado ahora)
  const resumen = useMemo(() => {
    let ocupadas = 0;
    let libres = 0;
    let cubiertos = 0;
    let minutosTotal = 0;
    const now = Date.now();
    for (const m of mesasFiltradas) {
      if (m.estado === 'libre') libres++;
      if (m.venta_abierta_id !== null) {
        ocupadas++;
        cubiertos += Number(m.venta_covers ?? 0);
        if (m.venta_abierta_at) {
          minutosTotal += Math.floor((now - new Date(m.venta_abierta_at).getTime()) / 60000);
        }
      }
    }
    return {
      ocupadas, libres, cubiertos,
      tiempoPromedio: ocupadas > 0 ? Math.floor(minutosTotal / ocupadas) : 0,
    };
  }, [mesasFiltradas]);

  if (!empleado) {
    return <div className="p-8 text-center text-muted-foreground">Sesión POS requerida.</div>;
  }

  return (
    <div className="flex h-full">
      {/* Panel izq: comandas activas (solo lg+ por espacio) */}
      <ComandasActivasPanel
        className="w-[240px] border-r border-border flex-shrink-0 hidden lg:flex"
        modos={['salon']}
      />

      {/* Centro: plano de mesas */}
      <div className="flex-1 min-w-0 overflow-auto">
        <div className="p-6">
          <header className="flex items-center gap-3 mb-5 flex-wrap">
            <h1 className="text-2xl font-bold tracking-tight">Salón</h1>
            <nav className="flex gap-1 ml-2">
              <ZoneButton active={zona === null} onClick={() => setZona(null)}>
                Todas ({mesas.length})
              </ZoneButton>
              {zonas.map((z) => (
                <ZoneButton key={z} active={zona === z} onClick={() => setZona(z)}>
                  {z}
                </ZoneButton>
              ))}
            </nav>
            {puedeEditarLayout && mesas.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditandoLayout(true)}
                className="ml-auto gap-1.5"
              >
                <Layout className="h-3.5 w-3.5" />
                Editar layout
              </Button>
            )}
          </header>

          {/* Leyenda color-status (F #9) — chips compactos arriba del plano */}
          {!loading && mesas.length > 0 && (
            <div className="mb-3 flex items-center gap-1.5 flex-wrap text-[10px]">
              <span className="text-muted-foreground uppercase tracking-wide font-medium mr-1">Colores:</span>
              <LeyendaChip bucket="reciente" />
              <LeyendaChip bucket="normal" />
              <LeyendaChip bucket="atencion" />
              <LeyendaChip bucket="urgente" />
            </div>
          )}

          {/* Resumen at-a-glance del salón (zona filtrada) */}
          {!loading && mesas.length > 0 && (
            <div className="mb-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
              <SummaryCard
                label="Ocupadas"
                value={`${resumen.ocupadas}`}
                hint={`${resumen.libres} libres`}
                tone="warning"
              />
              <SummaryCard
                label="Cubiertos"
                value={`${resumen.cubiertos}`}
                hint={resumen.ocupadas > 0 ? `${(resumen.cubiertos / resumen.ocupadas).toFixed(1)} por mesa` : 'sin mesas abiertas'}
                tone="primary"
              />
              <SummaryCard
                label="Tiempo prom."
                value={resumen.tiempoPromedio > 0 ? `${resumen.tiempoPromedio}'` : '—'}
                hint={resumen.tiempoPromedio > 60 ? 'Largo' : 'OK'}
                tone={resumen.tiempoPromedio > 90 ? 'destructive' : resumen.tiempoPromedio > 60 ? 'warning' : 'success'}
              />
              <SummaryCard
                label="Ocupación"
                value={mesasFiltradas.length > 0 ? `${Math.round((resumen.ocupadas / mesasFiltradas.length) * 100)}%` : '0%'}
                hint={`${mesasFiltradas.length} mesas`}
                tone="primary"
              />
            </div>
          )}

          {error && (
            <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
          )}

          {loading ? (
            <div className="py-8 text-center text-muted-foreground">Cargando mesas…</div>
          ) : mesasFiltradas.some((m) => m.pos_x !== null && m.pos_y !== null) ? (
            // Render absoluto: las mesas que tienen pos_x/pos_y van con
            // coordenadas, las que no tienen quedan abajo en grid auto.
            <PlanoCustom mesas={mesasFiltradas} onClick={(m) => {
              if (m.estado === 'libre') setAbrirDialog(m);
              else if (m.venta_abierta_id) navigate(`/pos/venta/${m.venta_abierta_id}`);
            }} />
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
              {mesasFiltradas.map((m) => (
                <MesaTile
                  key={m.id}
                  mesa={m}
                  onClick={() => {
                    if (m.estado === 'libre') setAbrirDialog(m);
                    else if (m.venta_abierta_id) navigate(`/pos/venta/${m.venta_abierta_id}`);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {abrirDialog && (
        <AbrirMesaDialog
          mesa={abrirDialog}
          empleadoId={empleado.id}
          localId={localId!}
          onClose={() => setAbrirDialog(null)}
          onAbierta={(ventaId) => {
            setAbrirDialog(null);
            navigate(`/pos/venta/${ventaId}`);
          }}
          onError={setError}
        />
      )}

      {editandoLayout && (
        <SalonLayoutEditor
          mesas={mesasFiltradas}
          onClose={() => setEditandoLayout(false)}
          onSaved={reload}
        />
      )}
    </div>
  );
}

// Plano custom: mesas posicionadas con pos_x/pos_y absolute. Las que NO
// tienen posición se renderizan en grid auto debajo. El user puede mezclar:
// algunas mesas en el plano, otras todavía sin posicionar.
function PlanoCustom({ mesas, onClick }: { mesas: MesaConVenta[]; onClick: (m: MesaConVenta) => void }) {
  const posicionadas = mesas.filter((m) => m.pos_x !== null && m.pos_y !== null);
  const sinPosicion = mesas.filter((m) => m.pos_x === null || m.pos_y === null);
  return (
    <div>
      <div className="relative bg-muted/20 border border-dashed border-border rounded-lg overflow-auto"
        style={{ minHeight: 400 }}>
        <div className="relative" style={{ width: 1600, height: 1200 }}>
          {posicionadas.map((m) => (
            <div
              key={m.id}
              style={{
                position: 'absolute',
                left: m.pos_x ?? 0,
                top: m.pos_y ?? 0,
                width: 96,
                height: 80,
              }}
            >
              <MesaTile mesa={m} onClick={() => onClick(m)} />
            </div>
          ))}
        </div>
      </div>
      {sinPosicion.length > 0 && (
        <div className="mt-4">
          <div className="text-xs text-muted-foreground mb-2">
            Sin posición ({sinPosicion.length}) — entrá a "Editar layout" para acomodar:
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
            {sinPosicion.map((m) => (
              <MesaTile key={m.id} mesa={m} onClick={() => onClick(m)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ZoneButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 h-9 rounded-md text-sm transition-colors',
        active
          ? 'bg-primary/10 text-primary font-medium'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {children}
    </button>
  );
}

function SummaryCard({ label, value, hint, tone }: {
  label: string; value: string; hint?: string; tone: 'primary' | 'success' | 'warning' | 'destructive';
}) {
  const toneClass = {
    primary: 'border-primary/20 bg-primary/5 text-primary',
    success: 'border-success/30 bg-success/5 text-success',
    warning: 'border-warning/30 bg-warning/5 text-warning',
    destructive: 'border-destructive/30 bg-destructive/5 text-destructive',
  }[tone];
  return (
    <div className={cn('rounded-md border p-2.5', toneClass)}>
      <div className="text-[10px] uppercase tracking-wide font-medium opacity-80">{label}</div>
      <div className="text-xl font-bold tabular-nums leading-tight mt-0.5">{value}</div>
      {hint && <div className="text-[10px] opacity-60 mt-0.5">{hint}</div>}
    </div>
  );
}

// Sprint 1 competitor F #9 — Color-status por tiempo en estado.
// 5 buckets visuales para mesas ocupadas, inspirado en Toast/TouchBistro:
// el encargado escanea el salón y al toque ve dónde hay mesas largas.
//
//   libre          → verde suave (disponible)
//   ocupada 0-20m  → verde (recién sentados, todo bien)
//   ocupada 20-40m → amarillo clarito (en curso normal)
//   ocupada 40-60m → amarillo más oscuro (chequear cuenta o pedir más)
//   ocupada >60m   → rojo pulsante (mucho tiempo, atender)
//   hold           → rojo (estado especial, no por tiempo)
type MesaBucket =
  | 'libre'
  | 'reciente'      // <20min ocupada
  | 'normal'        // 20-40m
  | 'atencion'      // 40-60m
  | 'urgente'       // >60m
  | 'hold'
  | 'otro';

const MESA_BUCKET_STYLES: Record<MesaBucket, { bg: string; fg: string; border: string; icon: string; label: string }> = {
  libre:    { bg: 'bg-success/10',     fg: 'text-success',     border: 'border-success/30',     icon: '',  label: 'Libre' },
  reciente: { bg: 'bg-success/15',     fg: 'text-success',     border: 'border-success/50',     icon: '🟢', label: 'Recién (1-20m)' },
  normal:   { bg: 'bg-yellow-50 dark:bg-yellow-900/15', fg: 'text-yellow-700 dark:text-yellow-200', border: 'border-yellow-300 dark:border-yellow-700/60', icon: '', label: 'En curso (20-40m)' },
  atencion: { bg: 'bg-amber-100 dark:bg-amber-900/30', fg: 'text-amber-800 dark:text-amber-200', border: 'border-amber-400 dark:border-amber-700', icon: '⏱', label: 'Atención (40-60m)' },
  urgente:  { bg: 'bg-destructive/15', fg: 'text-destructive', border: 'border-destructive ring-2 ring-destructive/40 animate-pulse', icon: '🚨', label: 'Urgente (>60m)' },
  hold:     { bg: 'bg-destructive/10', fg: 'text-destructive', border: 'border-destructive/30', icon: '', label: 'En hold' },
  otro:     { bg: 'bg-muted',          fg: 'text-muted-foreground', border: 'border-border',   icon: '', label: '—' },
};

function clasificarMesa(mesa: MesaConVenta): MesaBucket {
  if (mesa.estado === 'libre') return 'libre';
  if (mesa.estado === 'hold') return 'hold';
  if (mesa.estado === 'ocupada') {
    const min = mesa.venta_abierta_at
      ? Math.floor((Date.now() - new Date(mesa.venta_abierta_at).getTime()) / 60000)
      : 0;
    if (min < 20) return 'reciente';
    if (min < 40) return 'normal';
    if (min < 60) return 'atencion';
    return 'urgente';
  }
  return 'otro';
}

function LeyendaChip({ bucket }: { bucket: MesaBucket }) {
  const s = MESA_BUCKET_STYLES[bucket];
  return (
    <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded border', s.bg, s.fg, s.border.replace(/animate-pulse|ring-\d+|ring-destructive\/40/g, ''))}>
      {s.icon && <span>{s.icon}</span>}
      <span>{s.label}</span>
    </span>
  );
}

function MesaTile({ mesa, onClick }: { mesa: MesaConVenta; onClick: () => void }) {
  const bucket = clasificarMesa(mesa);
  const styles = MESA_BUCKET_STYLES[bucket];
  const radius = mesa.forma === 'redondo' ? 'rounded-full' : mesa.forma === 'rectangular' ? 'rounded-lg' : 'rounded-2xl';
  return (
    <button
      type="button"
      onClick={onClick}
      title={styles.label}
      className={cn(
        'p-3 border-2 min-h-[120px] flex flex-col justify-center items-center text-center relative',
        'transition-all hover:scale-105 hover:shadow-sm',
        radius,
        styles.bg,
        styles.fg,
        styles.border,
      )}
    >
      <div className="text-2xl font-bold">{mesa.numero}</div>
      {mesa.zona && <div className="text-[10px] opacity-70">{mesa.zona}</div>}
      {mesa.venta_abierta_id !== null && (
        <>
          <div className="text-sm font-semibold mt-1 tabular-nums">
            {formatARS(mesa.venta_total)}
          </div>
          {mesa.venta_abierta_at && (
            <div className={cn(
              'text-[10px] tabular-nums',
              bucket === 'urgente' && 'font-bold',
              bucket === 'atencion' && 'font-semibold',
            )}>
              {styles.icon && <span className="mr-0.5">{styles.icon}</span>}
              {relativoCorto(mesa.venta_abierta_at)}
            </div>
          )}
        </>
      )}
    </button>
  );
}

interface AbrirDialogProps {
  mesa: MesaConVenta;
  empleadoId: string;
  localId: number;
  onClose: () => void;
  onAbierta: (ventaId: number) => void;
  onError: (msg: string) => void;
}

function AbrirMesaDialog({ mesa, empleadoId, localId, onClose, onAbierta, onError }: AbrirDialogProps) {
  const [covers, setCovers] = useState(mesa.capacidad ?? 2);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const { data: canales } = await listCanales(null, true);
    const canal = canales.find((c) => c.slug === 'salon');
    if (!canal) { onError('No hay canal "salon" configurado'); setSaving(false); return; }
    const { ventaId, error } = await abrirVenta({
      localId, modo: 'salon', canalId: canal.id,
      mesaId: mesa.id, mozoId: empleadoId, cajeroId: empleadoId,
      covers,
    });
    setSaving(false);
    if (error || !ventaId) { onError(error ?? 'No se pudo abrir'); return; }
    onAbierta(ventaId);
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Abrir mesa {mesa.numero}</DialogTitle>
          {mesa.zona && <DialogDescription>{mesa.zona}</DialogDescription>}
        </DialogHeader>

        <form onSubmit={onSubmit}>
          <div className="space-y-2 py-2">
            <Label>Cantidad de personas</Label>
            <Stepper value={covers} onChange={setCovers} min={1} max={20} size="lg" />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button type="submit" variant="success" disabled={saving}>
              {saving ? 'Abriendo…' : 'Abrir mesa'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
