import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Users, Wallet, Equal, TrendingUp, Calculator } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { db } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/Badge';
import { Input } from '@/components/ui/input';
import { formatARS } from '@/lib/format';
import { cn } from '@/lib/utils';

// Tips Manager — versión calculadora simple (sin persistencia de reparto).
// El cajero ve las propinas del turno actual y cuánto le toca a cada empleado.
// Reglas soportadas:
//   - Igualitaria: total / N empleados activos.
//   - Por horas: requiere registrar horas (deuda futura).
//   - Por ventas: propinas distribuidas según cuánto vendió cada cajero.

type Regla = 'igualitaria' | 'por_ventas';

interface PropinaPorCajero {
  cajero_id: string;
  cajero_nombre: string;
  ventas: number;
  total_propinas: number;
}

interface Empleado {
  id: string;
  nombre: string;
  apellido: string | null;
  rol_pos: string | null;
}

interface TurnoAbierto {
  id: number;
  numero: number;
  abierto_at: string;
}

export function PropinasReparto() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [turno, setTurno] = useState<TurnoAbierto | null>(null);
  const [propinas, setPropinas] = useState<PropinaPorCajero[]>([]);
  const [empleados, setEmpleados] = useState<Empleado[]>([]);
  const [seleccionados, setSeleccionados] = useState<Set<string>>(new Set());
  const [regla, setRegla] = useState<Regla>('igualitaria');
  const [loading, setLoading] = useState(true);
  const [pctCocina, setPctCocina] = useState(20); // % del pool que va a cocina

  const reload = useCallback(async () => {
    if (!localId) return;
    setLoading(true);
    try {
      const { data: t } = await db.from('turnos_caja')
        .select('id, numero, abierto_at')
        .eq('local_id', localId)
        .eq('estado', 'abierto')
        .limit(1).maybeSingle();
      setTurno((t as TurnoAbierto | null) ?? null);

      if (t) {
        // Propinas por cajero del turno actual: ventas.propina sumado por cajero_id
        const { data: ventas } = await db.from('ventas_pos')
          .select('cajero_id, propina')
          .eq('turno_caja_id', (t as { id: number }).id)
          .eq('estado', 'cobrada')
          .is('deleted_at', null);

        const porCajero = new Map<string, { ventas: number; propinas: number }>();
        for (const v of (ventas ?? []) as Array<{ cajero_id: string | null; propina: number | null }>) {
          if (!v.cajero_id) continue;
          const cur = porCajero.get(v.cajero_id) ?? { ventas: 0, propinas: 0 };
          cur.ventas += 1;
          cur.propinas += Number(v.propina ?? 0);
          porCajero.set(v.cajero_id, cur);
        }
        // Resolver nombres
        const ids = Array.from(porCajero.keys());
        if (ids.length > 0) {
          const { data: emps } = await db.from('rrhh_empleados')
            .select('id, nombre, apellido')
            .in('id', ids);
          const nombres = new Map<string, string>();
          for (const e of (emps ?? []) as Array<{ id: string; nombre: string; apellido: string | null }>) {
            nombres.set(e.id, [e.apellido, e.nombre].filter(Boolean).join(' '));
          }
          const arr: PropinaPorCajero[] = Array.from(porCajero.entries()).map(([cid, v]) => ({
            cajero_id: cid,
            cajero_nombre: nombres.get(cid) ?? cid,
            ventas: v.ventas,
            total_propinas: v.propinas,
          }));
          setPropinas(arr);
        } else {
          setPropinas([]);
        }
      } else {
        setPropinas([]);
      }

      // Empleados POS activos del local
      const { data: emps } = await db.from('rrhh_empleados')
        .select('id, nombre, apellido, rol_pos')
        .eq('local_id', localId)
        .eq('activo', true)
        .eq('pos_activo', true)
        .order('nombre');
      setEmpleados((emps ?? []) as Empleado[]);
      // Default: seleccionar todos
      setSeleccionados(new Set((emps ?? []).map((e: { id: string }) => e.id)));
    } catch (e) {
      toast.error('Error cargando propinas: ' + (e instanceof Error ? e.message : 'desconocido'));
    } finally {
      setLoading(false);
    }
  }, [localId]);

  useEffect(() => { reload(); }, [reload]);

  const totalPropinas = propinas.reduce((s, p) => s + p.total_propinas, 0);
  const empleadosSel = empleados.filter((e) => seleccionados.has(e.id));

  // Reparto según regla
  function calcularReparto(): Array<{ empleado: Empleado; monto: number; detalle: string }> {
    if (empleadosSel.length === 0 || totalPropinas === 0) return [];

    if (regla === 'igualitaria') {
      const porUno = totalPropinas / empleadosSel.length;
      return empleadosSel.map((e) => ({
        empleado: e,
        monto: porUno,
        detalle: `${formatARS(totalPropinas)} ÷ ${empleadosSel.length}`,
      }));
    }

    // por_ventas: propinas se asignan al cajero que las generó
    // + un % al pool cocina dividido entre empleados con rol_pos 'cocinero'/'manager'
    const cocineros = empleadosSel.filter((e) => e.rol_pos === 'cocinero' || e.rol_pos === 'bartender');
    const noCocineros = empleadosSel.filter((e) => e.rol_pos !== 'cocinero' && e.rol_pos !== 'bartender');

    const poolCocina = totalPropinas * (pctCocina / 100);
    const restantePool = totalPropinas - poolCocina;

    const result: Array<{ empleado: Empleado; monto: number; detalle: string }> = [];

    // Cocina: divide poolCocina entre cocineros
    if (cocineros.length > 0) {
      const porUno = poolCocina / cocineros.length;
      for (const c of cocineros) {
        result.push({
          empleado: c,
          monto: porUno,
          detalle: `${pctCocina}% pool ÷ ${cocineros.length} cocineros`,
        });
      }
    }

    // No-cocina: cada uno se lleva lo que generó (proporcional al pool restante)
    const totalNoCocineros = noCocineros.reduce((s, e) => {
      const p = propinas.find((x) => x.cajero_id === e.id);
      return s + (p?.total_propinas ?? 0);
    }, 0);

    for (const e of noCocineros) {
      const p = propinas.find((x) => x.cajero_id === e.id);
      const generadas = p?.total_propinas ?? 0;
      let monto = 0;
      if (totalNoCocineros > 0 && cocineros.length > 0) {
        // Si hay pool de cocina, el resto se redistribuye proporcional a lo generado
        monto = (generadas / totalNoCocineros) * restantePool;
      } else if (cocineros.length === 0) {
        // Sin pool cocina, cada cajero se lleva lo suyo
        monto = generadas;
      } else {
        monto = (generadas / totalNoCocineros) * restantePool;
      }
      result.push({
        empleado: e,
        monto,
        detalle: `${formatARS(generadas)} generadas → ${formatARS(monto)} neto`,
      });
    }

    return result.sort((a, b) => b.monto - a.monto);
  }

  function toggleEmpleado(id: string) {
    setSeleccionados((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (loading) {
    return <div className="container py-8 text-center text-muted-foreground">Cargando…</div>;
  }

  if (!turno) {
    return (
      <div className="container max-w-md py-12 text-center">
        <Card>
          <CardContent className="py-12">
            <div className="text-4xl mb-3">💰</div>
            <h2 className="text-lg font-semibold mb-2">Sin turno abierto</h2>
            <p className="text-sm text-muted-foreground">
              Las propinas se calculan sobre el turno activo. Abrí caja primero.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const reparto = calcularReparto();

  return (
    <div className="container max-w-3xl py-6 space-y-4">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Reparto de propinas</h1>
        <p className="text-sm text-muted-foreground">
          Turno #{turno.numero} · calculadora (no persiste el reparto, es referencia)
        </p>
      </header>

      {/* Total a repartir */}
      <Card>
        <CardContent className="p-5 flex items-center gap-4">
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-lg bg-primary/10">
            <Wallet className="h-6 w-6 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs uppercase text-muted-foreground">Total propinas del turno</div>
            <div className="text-3xl font-bold tabular-nums">{formatARS(totalPropinas)}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {propinas.length} cajero{propinas.length === 1 ? '' : 's'} con propinas registradas
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Regla */}
      <Card>
        <CardContent className="p-4">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Cómo repartir</h3>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setRegla('igualitaria')}
              className={cn(
                'h-12 rounded-md border-2 flex items-center justify-center gap-2 text-sm font-medium',
                regla === 'igualitaria' ? 'border-primary bg-primary/5 text-primary' : 'border-border bg-background',
              )}
            >
              <Equal className="h-4 w-4" />
              Igualitaria
            </button>
            <button
              type="button"
              onClick={() => setRegla('por_ventas')}
              className={cn(
                'h-12 rounded-md border-2 flex items-center justify-center gap-2 text-sm font-medium',
                regla === 'por_ventas' ? 'border-primary bg-primary/5 text-primary' : 'border-border bg-background',
              )}
            >
              <TrendingUp className="h-4 w-4" />
              Por ventas + pool cocina
            </button>
          </div>
          {regla === 'por_ventas' && (
            <div className="mt-3 flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">% al pool cocina:</span>
              <Input
                type="number"
                min={0}
                max={100}
                value={pctCocina}
                onChange={(e) => setPctCocina(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
                className="w-20 h-8"
              />
              <span className="text-muted-foreground">%</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Empleados — toggle quien entra al reparto */}
      <Card>
        <CardContent className="p-4">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" /> Empleados que participan ({empleadosSel.length}/{empleados.length})
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {empleados.map((e) => {
              const activo = seleccionados.has(e.id);
              return (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => toggleEmpleado(e.id)}
                  className={cn(
                    'h-12 rounded-md border-2 flex flex-col items-start justify-center px-3 transition-colors',
                    activo ? 'border-primary bg-primary/5' : 'border-border opacity-50',
                  )}
                >
                  <div className="text-sm font-medium truncate w-full">{e.nombre} {e.apellido ?? ''}</div>
                  <div className="text-[10px] text-muted-foreground">{e.rol_pos ?? 'sin rol'}</div>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Resultado */}
      <Card>
        <CardContent className="p-0">
          <div className="px-4 py-2.5 border-b bg-success/10 flex items-center gap-2">
            <Calculator className="h-4 w-4 text-success" />
            <h2 className="text-sm font-semibold">Reparto sugerido</h2>
          </div>
          {reparto.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground italic">
              {totalPropinas === 0
                ? 'No hay propinas registradas en este turno.'
                : 'Seleccioná al menos un empleado.'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs text-muted-foreground uppercase">
                <tr>
                  <th className="text-left px-4 py-2">Empleado</th>
                  <th className="text-right px-4 py-2">Detalle cálculo</th>
                  <th className="text-right px-4 py-2">Le toca</th>
                </tr>
              </thead>
              <tbody>
                {reparto.map((r) => (
                  <tr key={r.empleado.id} className="border-t">
                    <td className="px-4 py-3">
                      <div className="font-medium">{r.empleado.nombre} {r.empleado.apellido ?? ''}</div>
                      <Badge variant="gray">{r.empleado.rol_pos ?? 'sin rol'}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-muted-foreground">{r.detalle}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-semibold">{formatARS(r.monto)}</td>
                  </tr>
                ))}
                <tr className="border-t bg-muted/20 font-semibold">
                  <td className="px-4 py-3" colSpan={2}>Total repartido</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatARS(reparto.reduce((s, r) => s + r.monto, 0))}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center">
        Esto es una calculadora. El monto se entrega manualmente al cierre. El historial de repartos viene en una versión futura.
      </p>
    </div>
  );
}
