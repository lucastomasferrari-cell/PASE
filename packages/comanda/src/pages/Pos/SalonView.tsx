import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useAuthPos } from '../../lib/authPos';
import { useLocalActivo } from '../../lib/localActivo';
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

  const reload = useCallback(async () => {
    if (localId === null) return;
    setLoading(true);
    const { data, error: err } = await listMesasConVentas(localId);
    if (err) setError(err);
    setMesas(data);
    setLoading(false);
  }, [localId]);

  useEffect(() => { reload(); }, [reload]);

  const zonas = useMemo(() => {
    const set = new Set<string>();
    for (const m of mesas) if (m.zona) set.add(m.zona);
    return Array.from(set).sort();
  }, [mesas]);

  const mesasFiltradas = useMemo(() => {
    if (zona === null) return mesas;
    return mesas.filter((m) => m.zona === zona);
  }, [mesas, zona]);

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
          </header>

          {error && (
            <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
          )}

          {loading ? (
            <div className="py-8 text-center text-muted-foreground">Cargando mesas…</div>
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

function MesaTile({ mesa, onClick }: { mesa: MesaConVenta; onClick: () => void }) {
  const colors = mesaColors(mesa.estado);
  const radius = mesa.forma === 'redondo' ? 'rounded-full' : mesa.forma === 'rectangular' ? 'rounded-lg' : 'rounded-2xl';
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'p-3 border-2 min-h-[120px] flex flex-col justify-center items-center text-center',
        'transition-all hover:scale-105 hover:shadow-sm',
        radius,
        colors.bg,
        colors.fg,
        colors.border,
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
            <div className="text-[10px] opacity-70">
              {relativoCorto(mesa.venta_abierta_at)}
            </div>
          )}
        </>
      )}
    </button>
  );
}

function mesaColors(estado: string): { bg: string; fg: string; border: string } {
  if (estado === 'libre')   return { bg: 'bg-success/10', fg: 'text-success', border: 'border-success/30' };
  if (estado === 'ocupada') return { bg: 'bg-warning/10', fg: 'text-warning', border: 'border-warning/30' };
  if (estado === 'hold')    return { bg: 'bg-destructive/10', fg: 'text-destructive', border: 'border-destructive/30' };
  return { bg: 'bg-muted', fg: 'text-muted-foreground', border: 'border-border' };
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
