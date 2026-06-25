import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, CheckCircle2, AlertTriangle, TrendingUp, TrendingDown, Calculator, Hash, Info, ClipboardList } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAuthPos } from '../../lib/authPos';
import { useLocalActivo } from '../../lib/localActivo';
import { usePermiso } from '../../lib/usePermiso';
import {
  getTurnoAbierto, totalesPorMetodo, cerrarTurno, type TotalesPorMetodo,
} from '../../services/turnosCajaService';
import { listEmpleadosLocal } from '../../services/empleadosService';
import { crearParteOperativo } from '../../services/parteOperativoService';
import type { TurnoCaja, EmpleadoPos } from '../../types/database';
import { formatARS, formatHoraAR } from '../../lib/format';
import { MoneyInput } from '../../components/MoneyInput';
import { DenominacionesInput, emptyBreakdown, type EfectivoBreakdown } from '../../components/DenominacionesInput';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export function CajaCerrar() {
  const { user } = useAuth();
  const { empleado } = useAuthPos();
  const [localId] = useLocalActivo(user);
  const navigate = useNavigate();
  // Cierre CIEGO por default (Tier 2a, modelo Toast): solo quien tiene este
  // permiso ve el esperado/totales por método ANTES de declarar. El resto
  // cuenta el efectivo físico a ciegas; la diferencia la devuelve la RPC
  // después de cerrar (igual para todos).
  const puedeVerEsperado = usePermiso('comanda.caja.ver_esperado_cierre');

  const [turno, setTurno] = useState<TurnoCaja | null>(null);
  const [totales, setTotales] = useState<TotalesPorMetodo[]>([]);
  const [loading, setLoading] = useState(true);
  const [montoEfectivoDeclarado, setMontoEfectivoDeclarado] = useState(0);
  const [notas, setNotas] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Cash Management: modo rápido (input único) vs modo denominaciones.
  const [modo, setModo] = useState<'rapido' | 'denominaciones'>('rapido');
  const [breakdown, setBreakdown] = useState<EfectivoBreakdown>(() => emptyBreakdown());

  // Parte operativo del turno
  const [empleadosLocal, setEmpleadosLocal] = useState<EmpleadoPos[]>([]);
  const [empleadosFalta, setEmpleadosFalta] = useState<string[]>([]);
  const [empleadosTarde, setEmpleadosTarde] = useState<string[]>([]);
  const [reclamos, setReclamos] = useState('');
  const [comentarioTurno, setComentarioTurno] = useState('');

  useEffect(() => {
    if (localId === null) return;
    let cancelled = false;
    (async () => {
      const [turnoR, empleadosR] = await Promise.all([
        getTurnoAbierto(localId),
        listEmpleadosLocal(localId),
      ]);
      if (cancelled) return;
      setTurno(turnoR.data);
      setEmpleadosLocal(empleadosR.data);
      if (turnoR.data && puedeVerEsperado) {
        const tot = await totalesPorMetodo(turnoR.data.id);
        if (cancelled) return;
        setTotales(tot.data);
      } else {
        setTotales([]);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [localId, puedeVerEsperado]);

  if (loading) return <Centered>Cargando…</Centered>;
  if (!turno) return <Centered>No hay turno abierto.</Centered>;
  if (!empleado) return <Centered>Sesión POS requerida.</Centered>;

  // `totalesPorMetodo` YA incluye la apertura (tipo='apertura', signo +)
  // sumada al monto efectivo. NO sumar turno.monto_inicial otra vez (bug
  // detectado 2026-05-15 — daba doble inicial al cerrar).
  const calculadoEfectivo = Number(totales.find((t) => t.metodo === 'efectivo')?.total ?? 0);
  // Movimientos del turno NETOS (sin la apertura) — solo para display.
  const movimientosEfectivoNetos = calculadoEfectivo - Number(turno.monto_inicial);
  // En modo denominaciones, el total declarado viene del breakdown.
  const declarado = modo === 'denominaciones' ? breakdown.total : montoEfectivoDeclarado;
  const diferencia = declarado - calculadoEfectivo;
  const difState = difStateFor(diferencia);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!empleado || !turno) return;
    setSaving(true);
    setError(null);

    // Parte operativo: guardar si tiene algún contenido.
    const tieneParteDatos = empleadosFalta.length > 0 || empleadosTarde.length > 0
      || reclamos.trim() || comentarioTurno.trim();
    if (tieneParteDatos) {
      await crearParteOperativo({
        localId: turno.local_id,
        turnoId: turno.id,
        empleadosFalta,
        empleadosTarde,
        reclamos: reclamos.trim() || null,
        comentario: comentarioTurno.trim() || null,
        cerradoPor: empleado.id,
      });
      // Error no bloqueante: el cierre continúa aunque el parte falle.
    }

    const breakdownArg = modo === 'denominaciones' ? breakdown : null;
    const { error: err } = await cerrarTurno(
      turno.id, empleado.id, declarado, notas.trim() || null, breakdownArg,
    );
    setSaving(false);
    if (err) { setError(err); return; }
    window.dispatchEvent(new Event('comanda:turno-changed'));
    navigate('/caja/abrir', { replace: true });
  }

  return (
    <div className="container max-w-2xl py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Cerrar caja</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Turno #{turno.numero} · abierto {formatHoraAR(turno.abierto_at)}
        </p>
      </header>

      {/* Totales del turno — solo visibles con permiso ver_esperado_cierre.
          Sin permiso: cierre CIEGO (el cajero cuenta sin conocer el esperado). */}
      {puedeVerEsperado ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-xs text-muted-foreground uppercase tracking-wide font-medium">
              Totales del turno (sistema)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm">
              <Row label="Apertura (efectivo)" valor={formatARS(turno.monto_inicial)} />
              <Row
                label={`Movimientos efectivo netos del turno`}
                valor={(movimientosEfectivoNetos >= 0 ? '+ ' : '− ') + formatARS(Math.abs(movimientosEfectivoNetos))}
              />
              {totales
                .filter((t) => t.metodo !== 'efectivo')
                .map((t) => (
                  <Row key={t.metodo} label={`${t.metodo} (${t.cantidad} mov., no en caja)`} valor={formatARS(t.total)} />
                ))}
              <Row
                label="Esperado en efectivo al cierre"
                valor={formatARS(calculadoEfectivo)}
                highlight
              />
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="mb-6 p-3 rounded-md border border-border bg-muted/40 text-sm text-muted-foreground flex items-start gap-3">
          <Info className="h-5 w-5 flex-shrink-0 mt-0.5" />
          <span>Contá el efectivo físico y cargalo. La diferencia se calcula al cerrar.</span>
        </div>
      )}

      {/* Form */}
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <Label>Efectivo en caja al cierre (lo que contás físicamente)</Label>
            <div className="inline-flex rounded-md border border-border overflow-hidden">
              <button
                type="button"
                onClick={() => setModo('rapido')}
                className={cn(
                  'px-3 h-8 text-xs font-medium inline-flex items-center gap-1.5',
                  modo === 'rapido' ? 'bg-primary text-primary-foreground' : 'bg-background',
                )}
              >
                <Hash className="h-3.5 w-3.5" />
                Rápido
              </button>
              <button
                type="button"
                onClick={() => setModo('denominaciones')}
                className={cn(
                  'px-3 h-8 text-xs font-medium inline-flex items-center gap-1.5 border-l border-border',
                  modo === 'denominaciones' ? 'bg-primary text-primary-foreground' : 'bg-background',
                )}
              >
                <Calculator className="h-3.5 w-3.5" />
                Por denominaciones
              </button>
            </div>
          </div>

          {modo === 'rapido' ? (
            <MoneyInput value={montoEfectivoDeclarado} onChange={setMontoEfectivoDeclarado} autoFocus />
          ) : (
            <DenominacionesInput value={breakdown} onChange={setBreakdown} disabled={saving} />
          )}
        </div>

        {/* Diferencia con semáforo — revela el esperado, así que solo con
            permiso. Sin permiso, la diferencia la informa la RPC al cerrar. */}
        {puedeVerEsperado && (
          <div
            className={cn(
              'p-3 rounded-md border text-sm font-medium flex items-start gap-3',
              difState.classes,
            )}
          >
            <difState.Icon className="h-5 w-5 flex-shrink-0 mt-0.5" />
            <div>
              <div>
                Diferencia:{' '}
                <span className="tabular-nums ml-1">
                  {diferencia > 0 ? '+' : ''}{formatARS(diferencia)}
                </span>
              </div>
              <div className="text-xs font-normal mt-0.5 opacity-80">{difState.label}</div>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="notas">Notas del cierre (opcional)</Label>
          <Textarea
            id="notas"
            value={notas}
            onChange={(e) => setNotas(e.target.value)}
            rows={3}
          />
        </div>

        {/* ── Parte operativo del turno ─────────────────────────────── */}
        <div className="border-t border-border pt-4 space-y-4">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Parte del turno</span>
            <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground uppercase tracking-wide">
              Opcional
            </span>
          </div>

          {empleadosLocal.length > 0 && (
            <>
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Empleados con falta</Label>
                <EmpleadosPicker
                  empleados={empleadosLocal}
                  seleccionados={empleadosFalta}
                  onChange={setEmpleadosFalta}
                  color="red"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Llegadas tarde</Label>
                <EmpleadosPicker
                  empleados={empleadosLocal}
                  seleccionados={empleadosTarde}
                  onChange={setEmpleadosTarde}
                  color="amber"
                />
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label htmlFor="reclamos" className="text-xs text-muted-foreground">Reclamos o quejas de clientes</Label>
            <Textarea
              id="reclamos"
              value={reclamos}
              onChange={(e) => setReclamos(e.target.value)}
              rows={2}
              placeholder="Ej: mesa 5 esperó mucho, pedido mal cobrado…"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="comentario-turno" className="text-xs text-muted-foreground">Comentario general del turno</Label>
            <Textarea
              id="comentario-turno"
              value={comentarioTurno}
              onChange={(e) => setComentarioTurno(e.target.value)}
              rows={2}
              placeholder="Ej: turno tranquilo, cocina rápida, faltó mozarrella…"
            />
          </div>
        </div>

        {error && (
          <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
        )}

        <div className="flex gap-2 justify-end">
          <Button type="button" variant="outline" onClick={() => navigate('/caja')} disabled={saving}>
            Volver
          </Button>
          <Button type="submit" variant="destructive" disabled={saving}>
            {saving ? 'Cerrando…' : 'Confirmar cierre'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Row({ label, valor, highlight }: { label: string; valor: string; highlight?: boolean }) {
  return (
    <div
      className={cn(
        'flex justify-between py-2 border-b border-border last:border-b-0',
        highlight && 'font-semibold pt-3 mt-1 border-t border-border bg-warning/5 px-2 -mx-2 rounded',
      )}
    >
      <span>{label}</span>
      <span className="tabular-nums">{valor}</span>
    </div>
  );
}

interface DifState {
  classes: string;
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
}

function difStateFor(d: number): DifState {
  if (Math.abs(d) < 0.01) {
    return {
      classes: 'bg-success/10 text-success border-success/20',
      Icon: CheckCircle2,
      label: 'Coincide con el sistema',
    };
  }
  if (Math.abs(d) < 500) {
    return {
      classes: 'bg-warning/10 text-warning border-warning/30',
      Icon: AlertTriangle,
      label: d > 0 ? 'Sobra plata respecto al sistema' : 'Falta plata respecto al sistema',
    };
  }
  return {
    classes: 'bg-destructive/10 text-destructive border-destructive/20',
    Icon: d > 0 ? TrendingUp : TrendingDown,
    label: d > 0 ? 'Sobra plata respecto al sistema' : 'Falta plata respecto al sistema',
  };
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="container max-w-md py-12">
      <Card>
        <CardContent className="py-12 text-center">
          <Lock className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-muted-foreground">{children}</p>
        </CardContent>
      </Card>
    </div>
  );
}

// Selector de empleados por pills — tap para seleccionar/deseleccionar
function EmpleadosPicker({
  empleados,
  seleccionados,
  onChange,
  color,
}: {
  empleados: EmpleadoPos[];
  seleccionados: string[];
  onChange: (ids: string[]) => void;
  color: 'red' | 'amber';
}) {
  function toggle(id: string) {
    onChange(
      seleccionados.includes(id)
        ? seleccionados.filter((s) => s !== id)
        : [...seleccionados, id],
    );
  }
  const selSet = new Set(seleccionados);
  return (
    <div className="flex flex-wrap gap-1.5">
      {empleados.map((e) => {
        const sel = selSet.has(e.id);
        return (
          <button
            key={e.id}
            type="button"
            onClick={() => toggle(e.id)}
            className={cn(
              'px-2.5 py-1 text-xs rounded-full border transition-colors',
              sel && color === 'red'
                ? 'bg-red-100 border-red-300 text-red-700 font-medium'
                : sel && color === 'amber'
                ? 'bg-amber-100 border-amber-300 text-amber-700 font-medium'
                : 'bg-background border-border text-muted-foreground hover:border-foreground/30',
            )}
          >
            {e.apellido} {e.nombre}
          </button>
        );
      })}
    </div>
  );
}
