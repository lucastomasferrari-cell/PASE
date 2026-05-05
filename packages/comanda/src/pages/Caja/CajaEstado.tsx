import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { DoorOpen, ArrowDownToLine, ArrowUpFromLine, Lock } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAuthPos } from '../../lib/authPos';
import { useLocalActivo } from '../../lib/localActivo';
import {
  getTurnoAbierto, listMovimientos, totalesPorMetodo, registrarMovimiento,
  type TotalesPorMetodo,
} from '../../services/turnosCajaService';
import type { TurnoCaja, MovimientoCaja } from '../../types/database';
import { formatARS, formatHoraAR, relativoCorto } from '../../lib/format';
import { Badge } from '../../components/Badge';
import { MoneyInput } from '../../components/MoneyInput';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

export function CajaEstado() {
  const { user } = useAuth();
  const { empleado } = useAuthPos();
  const [localId] = useLocalActivo(user);
  const navigate = useNavigate();

  const [turno, setTurno] = useState<TurnoCaja | null>(null);
  const [movs, setMovs] = useState<MovimientoCaja[]>([]);
  const [totales, setTotales] = useState<TotalesPorMetodo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [movDialog, setMovDialog] = useState<'retiro' | 'deposito' | null>(null);

  const reload = useCallback(async () => {
    if (localId === null) return;
    setLoading(true);
    const { data: t } = await getTurnoAbierto(localId);
    setTurno(t);
    if (t) {
      const [m, tot] = await Promise.all([listMovimientos(t.id), totalesPorMetodo(t.id)]);
      setMovs(m.data);
      setTotales(tot.data);
    }
    setLoading(false);
  }, [localId]);

  useEffect(() => { reload(); }, [reload]);

  if (loading) {
    return (
      <div className="container py-8">
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            Cargando…
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!turno) {
    return (
      <div className="container max-w-md py-12">
        <Card>
          <CardContent className="py-12 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-muted mb-4">
              <Lock className="h-8 w-8 text-muted-foreground" />
            </div>
            <h2 className="text-xl font-semibold mb-2">Caja cerrada</h2>
            <p className="text-sm text-muted-foreground mb-6">
              No hay turno abierto en este local.
            </p>
            <Button variant="success" size="lg" onClick={() => navigate('/caja/abrir')}>
              <DoorOpen className="h-5 w-5 mr-2" />
              Abrir caja
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container py-8">
      {/* Header */}
      <header className="flex items-center gap-3 mb-6 flex-wrap">
        <h1 className="text-3xl font-bold tracking-tight">Caja</h1>
        <Badge variant="green">Turno #{turno.numero} abierto</Badge>
        <span className="text-sm text-muted-foreground">
          desde {formatHoraAR(turno.abierto_at)} · {relativoCorto(turno.abierto_at)}
        </span>
        <div className="ml-auto flex gap-2 flex-wrap">
          <Button variant="outline" onClick={() => setMovDialog('retiro')}>
            <ArrowUpFromLine className="h-4 w-4 mr-2" />
            Retiro
          </Button>
          <Button variant="outline" onClick={() => setMovDialog('deposito')}>
            <ArrowDownToLine className="h-4 w-4 mr-2" />
            Depósito
          </Button>
          <Button variant="destructive" onClick={() => navigate('/caja/cerrar')}>
            Cerrar caja
          </Button>
        </div>
      </header>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      {/* Cards de totales */}
      <section className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-8">
        <TotalCard title="Monto inicial" valor={formatARS(turno.monto_inicial)} subtitle="al abrir" />
        {totales.map((t) => (
          <TotalCard
            key={t.metodo}
            title={t.metodo}
            valor={formatARS(t.total)}
            subtitle={`${t.cantidad} mov.`}
          />
        ))}
      </section>

      {/* Movimientos */}
      <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
        Movimientos del turno ({movs.length})
      </h2>
      {movs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Sin movimientos.
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[100px_120px_140px_140px_1fr] gap-4 px-6 py-3 border-b border-border bg-muted/40 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            <div>Hora</div>
            <div>Tipo</div>
            <div>Método</div>
            <div className="text-right">Monto</div>
            <div>Motivo</div>
          </div>
          {movs.map((m, idx) => (
            <div
              key={m.id}
              className={`grid grid-cols-[100px_120px_140px_140px_1fr] gap-4 px-6 py-3 items-center text-sm ${
                idx !== movs.length - 1 ? 'border-b border-border' : ''
              }`}
            >
              <div className="text-muted-foreground">{formatHoraAR(m.created_at)}</div>
              <div><Badge variant={tipoBadgeVariant(m.tipo)}>{m.tipo}</Badge></div>
              <div>{m.metodo}</div>
              <div className="text-right tabular-nums font-medium">{formatARS(m.monto)}</div>
              <div className="text-muted-foreground truncate">{m.motivo ?? '—'}</div>
            </div>
          ))}
        </Card>
      )}

      {movDialog && (
        <MovimientoDialog
          tipo={movDialog}
          onClose={() => setMovDialog(null)}
          onDone={() => { setMovDialog(null); reload(); }}
          localId={localId!}
          empleadoId={empleado?.id ?? ''}
          onError={setError}
        />
      )}
    </div>
  );
}

function TotalCard({ title, valor, subtitle }: { title: string; valor: string; subtitle: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium">{title}</div>
        <div className="text-2xl font-bold tabular-nums mt-1">{valor}</div>
        <div className="text-xs text-muted-foreground mt-1">{subtitle}</div>
      </CardContent>
    </Card>
  );
}

function tipoBadgeVariant(t: string): 'green' | 'red' | 'gray' | 'amber' {
  if (t === 'venta' || t === 'deposito' || t === 'apertura') return 'green';
  if (t === 'retiro' || t === 'venta_anulada') return 'red';
  if (t === 'ajuste') return 'amber';
  return 'gray';
}

interface MovDialogProps {
  tipo: 'retiro' | 'deposito';
  localId: number;
  empleadoId: string;
  onClose: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}

function MovimientoDialog({ tipo, localId, empleadoId, onClose, onDone, onError }: MovDialogProps) {
  const [monto, setMonto] = useState(0);
  const [motivo, setMotivo] = useState('');
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (monto <= 0 || !motivo.trim()) return;
    setSaving(true);
    const { error: err } = await registrarMovimiento(
      localId, empleadoId, tipo, monto, 'efectivo', motivo.trim(),
    );
    setSaving(false);
    if (err) { onError(err); return; }
    onDone();
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {tipo === 'retiro' ? 'Retiro de caja' : 'Depósito a caja'}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Monto</Label>
            <MoneyInput value={monto} onChange={setMonto} autoFocus />
          </div>

          <div className="space-y-2">
            <Label htmlFor="motivo">Motivo</Label>
            <Input
              id="motivo"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              required
              placeholder={
                tipo === 'retiro'
                  ? 'Pago proveedor, viático, etc.'
                  : 'Refuerzo, propina depositada, etc.'
              }
              className="h-11"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving || monto <= 0 || !motivo.trim()}>
              {saving ? 'Guardando…' : 'Confirmar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
