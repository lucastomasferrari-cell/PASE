import { useEffect, useState, useCallback, useMemo } from 'react';
import { TrendingUp, TrendingDown, AlertTriangle, Calculator, Download, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { db } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/Badge';
import { formatARS } from '@/lib/format';
import { cn } from '@/lib/utils';

// Reporte CMV cruzado con ventas reales del período. Llama a la RPC
// fn_reporte_cmv(local_id, desde, hasta) que cruza:
//   ventas_pos × ventas_pos_items × recetas_versiones × insumos.costo_actual
//
// Métricas:
//   - Ingreso total por item
//   - Costo de mercaderia (calculado desde receta_version + insumo.costo)
//   - Margen bruto = ingreso - costo
//   - CMV % = costo / ingreso (target típico restaurant: 28-35%)
//   - Items sin receta (flag para configurar)

interface CmvRow {
  item_id: number;
  item_nombre: string;
  item_emoji: string | null;
  cantidad_vendida: number;
  ingreso_total: number;
  costo_total: number;
  costo_unitario_promedio: number;
  margen_total: number;
  cmv_pct: number;
  sin_receta_count: number;
}

interface AlertaCostoRow {
  insumo_id: number;
  insumo_nombre: string;
  insumo_emoji: string | null;
  costo_actual: number;
  costo_anterior: number | null;
  variacion_pct: number | null;
  ultima_variacion_at: string | null;
  alerta: boolean;
}

export function ReporteCMV() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [desde, setDesde] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [hasta, setHasta] = useState(() => new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<CmvRow[]>([]);
  const [rowsAnterior, setRowsAnterior] = useState<CmvRow[]>([]);
  const [alertasCosto, setAlertasCosto] = useState<AlertaCostoRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cmvTarget, setCmvTarget] = useState<number>(30); // % target

  const cargar = useCallback(async () => {
    if (localId === null) return;
    setLoading(true);
    setError(null);

    // Calcular rango del período anterior (mismos días, antes del desde)
    const dDesde = new Date(desde);
    const dHasta = new Date(hasta);
    const diasRango = Math.max(1, Math.round((dHasta.getTime() - dDesde.getTime()) / 86400000));
    const dHastaAnt = new Date(dDesde);
    dHastaAnt.setDate(dHastaAnt.getDate() - 1);
    const dDesdeAnt = new Date(dHastaAnt);
    dDesdeAnt.setDate(dDesdeAnt.getDate() - diasRango);

    const [actualRes, anteriorRes, alertasRes] = await Promise.all([
      db.rpc('fn_reporte_cmv', { p_local_id: localId, p_fecha_desde: desde, p_fecha_hasta: hasta }),
      db.rpc('fn_reporte_cmv', { p_local_id: localId, p_fecha_desde: dDesdeAnt.toISOString().slice(0, 10), p_fecha_hasta: dHastaAnt.toISOString().slice(0, 10) }),
      db.rpc('fn_insumos_con_alertas_costo', { p_dias: Math.max(diasRango, 7), p_umbral_pct: 15 }),
    ]);

    if (actualRes.error) {
      setError(actualRes.error.message);
      setRows([]);
      setRowsAnterior([]);
      setAlertasCosto([]);
    } else {
      setRows((actualRes.data ?? []) as CmvRow[]);
      setRowsAnterior((anteriorRes.data ?? []) as CmvRow[]);
      setAlertasCosto((alertasRes.data ?? []) as AlertaCostoRow[]);
    }
    setLoading(false);
  }, [localId, desde, hasta]);

  useEffect(() => { cargar(); }, [cargar]);

  const totales = useMemo(() => {
    let ingreso = 0, costo = 0, sinReceta = 0, margenNeg = 0;
    for (const r of rows) {
      ingreso += Number(r.ingreso_total);
      costo += Number(r.costo_total);
      if (r.sin_receta_count > 0) sinReceta++;
      if (Number(r.margen_total) < 0 && Number(r.costo_total) > 0) margenNeg++;
    }
    return {
      ingreso, costo,
      margen: ingreso - costo,
      cmvPct: ingreso > 0 ? (costo / ingreso) * 100 : 0,
      sinReceta,
      margenNeg,
    };
  }, [rows]);

  // Totales del período anterior (para comparativa)
  const totalesAnt = useMemo(() => {
    let ingreso = 0, costo = 0;
    for (const r of rowsAnterior) {
      ingreso += Number(r.ingreso_total);
      costo += Number(r.costo_total);
    }
    return {
      ingreso, costo,
      margen: ingreso - costo,
      cmvPct: ingreso > 0 ? (costo / ingreso) * 100 : 0,
    };
  }, [rowsAnterior]);

  // Helpers para deltas %
  function delta(actual: number, anterior: number): { pct: number; positivo: boolean } | null {
    if (anterior === 0) return null;
    const pct = ((actual - anterior) / Math.abs(anterior)) * 100;
    return { pct, positivo: pct >= 0 };
  }

  // Items con margen negativo (vendés a pérdida) — destacar arriba
  const itemsMargenNeg = useMemo(() =>
    rows.filter((r) => Number(r.margen_total) < 0 && Number(r.costo_total) > 0),
    [rows]);

  function exportarCSV() {
    const headers = ['Item', 'Cantidad', 'Ingreso', 'Costo', 'Costo unitario', 'Margen', 'CMV %', 'Sin receta'];
    const csvLines = [
      headers.join(','),
      ...rows.map((r) => [
        `"${r.item_nombre}"`,
        r.cantidad_vendida,
        r.ingreso_total.toFixed(2),
        r.costo_total.toFixed(2),
        r.costo_unitario_promedio.toFixed(2),
        r.margen_total.toFixed(2),
        (r.cmv_pct * 100).toFixed(2),
        r.sin_receta_count,
      ].join(',')),
    ];
    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cmv_${desde}_${hasta}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const cmvTone = totales.cmvPct <= cmvTarget ? 'success' : totales.cmvPct <= cmvTarget * 1.15 ? 'warning' : 'destructive';

  return (
    <div className="container max-w-6xl py-6 px-4 space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Calculator className="h-6 w-6" />
          Reporte CMV
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Costo de Mercadería Vendida cruzado con ventas reales del período.
          Calcula costo desde la receta snapshotteada al cobrar (no de la receta actual).
        </p>
      </header>

      {/* Filtros */}
      <Card>
        <CardContent className="p-4 flex items-end gap-3 flex-wrap">
          <div>
            <Label htmlFor="desde" className="text-xs">Desde</Label>
            <Input
              id="desde"
              type="date"
              value={desde}
              onChange={(e) => setDesde(e.target.value)}
              className="h-10 w-44"
            />
          </div>
          <div>
            <Label htmlFor="hasta" className="text-xs">Hasta</Label>
            <Input
              id="hasta"
              type="date"
              value={hasta}
              onChange={(e) => setHasta(e.target.value)}
              className="h-10 w-44"
            />
          </div>
          <div>
            <Label htmlFor="target" className="text-xs">Target CMV %</Label>
            <Input
              id="target"
              type="number"
              min={0}
              max={100}
              value={cmvTarget}
              onChange={(e) => setCmvTarget(Number(e.target.value) || 30)}
              className="h-10 w-24 tabular-nums"
            />
          </div>
          <Button onClick={cargar} disabled={loading} variant="outline">
            {loading ? 'Cargando…' : 'Actualizar'}
          </Button>
          <Button onClick={exportarCSV} disabled={rows.length === 0} variant="ghost" size="sm" className="ml-auto">
            <Download className="h-3.5 w-3.5 mr-1" />
            Exportar CSV
          </Button>
        </CardContent>
      </Card>

      {/* Error */}
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
          <div className="text-xs text-muted-foreground mt-2">
            Si dice "function fn_reporte_cmv does not exist", aplicá la migration 202605151990.
          </div>
        </div>
      )}

      {/* Resumen KPIs con delta vs período anterior */}
      {!loading && rows.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <KpiCard
            label="Ingreso"
            value={formatARS(totales.ingreso)}
            tone="primary"
            delta={delta(totales.ingreso, totalesAnt.ingreso)}
          />
          <KpiCard
            label="Costo merc."
            value={formatARS(totales.costo)}
            tone="primary"
            delta={delta(totales.costo, totalesAnt.costo)}
            invertDeltaTone  // costo subiendo = malo
          />
          <KpiCard
            label="Margen bruto"
            value={formatARS(totales.margen)}
            tone="success"
            delta={delta(totales.margen, totalesAnt.margen)}
          />
          <KpiCard
            label={`CMV % (target ${cmvTarget}%)`}
            value={`${totales.cmvPct.toFixed(1)}%`}
            tone={cmvTone}
            hint={cmvTone === 'success' ? 'Bajo target ✓' : cmvTone === 'warning' ? 'Cerca del límite' : 'Sobre target'}
            delta={delta(totales.cmvPct, totalesAnt.cmvPct)}
            invertDeltaTone  // CMV % subiendo = malo
          />
        </div>
      )}

      {/* Margen negativo: items que vendés a pérdida */}
      {!loading && itemsMargenNeg.length > 0 && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold flex items-center gap-2 text-destructive mb-2">
              <TrendingDown className="h-4 w-4" />
              {itemsMargenNeg.length} {itemsMargenNeg.length === 1 ? 'item se vende a pérdida' : 'items se venden a pérdida'}
            </h3>
            <p className="text-xs text-muted-foreground mb-3">
              El costo (basado en receta + insumos) supera el precio de venta. Revisá la receta o ajustá precio.
            </p>
            <div className="space-y-1">
              {itemsMargenNeg.slice(0, 5).map((r) => (
                <div key={r.item_id} className="flex items-center justify-between text-xs bg-background rounded p-2">
                  <span>{r.item_emoji ?? '📦'} {r.item_nombre}</span>
                  <span className="text-destructive font-medium tabular-nums">
                    {formatARS(r.margen_total)} ({(r.cmv_pct * 100).toFixed(0)}% CMV)
                  </span>
                </div>
              ))}
              {itemsMargenNeg.length > 5 && (
                <div className="text-[10px] text-muted-foreground text-center">
                  +{itemsMargenNeg.length - 5} más abajo en la tabla
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Alertas de costo de insumo (variación >= 15% en N días) */}
      {!loading && alertasCosto.filter((a) => a.alerta).length > 0 && (
        <Card className="border-warning/40 bg-warning/5">
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold flex items-center gap-2 text-warning mb-2">
              <AlertTriangle className="h-4 w-4" />
              Insumos con variación de costo significativa (≥15%)
            </h3>
            <p className="text-xs text-muted-foreground mb-3">
              Estos insumos cambiaron de precio. Si los usás en recetas, revisá si tenés que ajustar el precio del item.
            </p>
            <div className="space-y-1">
              {alertasCosto.filter((a) => a.alerta).slice(0, 10).map((a) => {
                const subio = Number(a.variacion_pct ?? 0) > 0;
                return (
                  <div key={a.insumo_id} className="flex items-center justify-between text-xs bg-background rounded p-2">
                    <span>{a.insumo_emoji ?? '🥬'} {a.insumo_nombre}</span>
                    <span className={cn('flex items-center gap-1 font-medium tabular-nums', subio ? 'text-destructive' : 'text-success')}>
                      {subio ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                      {Number(a.variacion_pct ?? 0).toFixed(1)}% · {formatARS(Number(a.costo_anterior ?? 0))} → {formatARS(Number(a.costo_actual))}
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabla */}
      {!loading && rows.length === 0 && !error && (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Sin ventas en el período seleccionado.
          </CardContent>
        </Card>
      )}

      {rows.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs text-muted-foreground uppercase tracking-wide">
                <tr>
                  <th className="text-left px-3 py-2">Item</th>
                  <th className="text-right px-3 py-2">Cant.</th>
                  <th className="text-right px-3 py-2">Ingreso</th>
                  <th className="text-right px-3 py-2">Costo</th>
                  <th className="text-right px-3 py-2">Costo u.</th>
                  <th className="text-right px-3 py-2">Margen</th>
                  <th className="text-right px-3 py-2">CMV %</th>
                  <th className="text-center px-3 py-2">Receta</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const cmvPct = r.cmv_pct * 100;
                  const cmvBadge = cmvPct === 0 ? 'gray' : cmvPct <= cmvTarget ? 'green' : cmvPct <= cmvTarget * 1.15 ? 'amber' : 'red';
                  return (
                    <tr key={r.item_id} className="border-t border-border">
                      <td className="px-3 py-2">
                        <span className="mr-2">{r.item_emoji ?? '📦'}</span>
                        {r.item_nombre}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{Number(r.cantidad_vendida).toFixed(0)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatARS(r.ingreso_total)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-destructive/80">
                        {r.costo_total > 0 ? formatARS(r.costo_total) : <span className="text-muted-foreground italic">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">
                        {r.costo_unitario_promedio > 0 ? formatARS(r.costo_unitario_promedio) : '—'}
                      </td>
                      <td className={cn('px-3 py-2 text-right tabular-nums font-medium', r.margen_total > 0 ? 'text-success' : '')}>
                        {formatARS(r.margen_total)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {cmvPct > 0 ? <Badge variant={cmvBadge}>{cmvPct.toFixed(1)}%</Badge> : <span className="text-xs text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2 text-center text-xs">
                        {r.sin_receta_count > 0 ? (
                          <Badge variant="amber" title={`${r.sin_receta_count} ventas sin receta snapshotteada`}>
                            <AlertTriangle className="h-3 w-3 inline mr-0.5" />
                            {r.sin_receta_count}
                          </Badge>
                        ) : (
                          <span className="text-success text-xs">✓</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Card className="border-dashed">
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Cómo se calcula
          </h3>
          <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
            <li>Al cobrar una venta, el sistema snapshottea la receta vigente de cada item con costos congelados.</li>
            <li>Este reporte recorre los snapshots, multiplica cantidad × costo_actual del insumo (no del snapshot) × (1 + merma%).</li>
            <li>Items sin receta configurada NO suman al costo — aparecen flagged con el contador "Sin receta".</li>
            <li>Para mejorar precisión: <strong>configurá recetas en Menú → Recetas</strong>.</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

function KpiCard({ label, value, hint, tone, delta, invertDeltaTone }: {
  label: string;
  value: string;
  hint?: string;
  tone: 'primary' | 'success' | 'warning' | 'destructive';
  // Delta vs período anterior: pct + signo. Mostrar ▲X% / ▼X%.
  delta?: { pct: number; positivo: boolean } | null;
  // Por default: positivo (subió) = verde. Para "costo" y "CMV%" lo invertimos
  // porque subir es malo.
  invertDeltaTone?: boolean;
}) {
  const toneClass = {
    primary: 'border-primary/20 bg-primary/5 text-primary',
    success: 'border-success/30 bg-success/5 text-success',
    warning: 'border-warning/30 bg-warning/5 text-warning',
    destructive: 'border-destructive/30 bg-destructive/5 text-destructive',
  }[tone];
  const deltaColor = delta
    ? (delta.positivo !== !!invertDeltaTone ? 'text-success' : 'text-destructive')
    : '';
  return (
    <div className={cn('rounded-md border p-3', toneClass)}>
      <div className="text-[10px] uppercase tracking-wide font-medium opacity-80">{label}</div>
      <div className="text-xl font-bold tabular-nums leading-tight mt-1">{value}</div>
      {delta && Number.isFinite(delta.pct) && (
        <div className={cn('text-[10px] font-medium mt-0.5 flex items-center gap-0.5', deltaColor)}
          title="vs período anterior de igual duración">
          {delta.positivo ? '▲' : '▼'}{Math.abs(delta.pct).toFixed(1)}% vs ant.
        </div>
      )}
      {hint && <div className="text-[10px] opacity-70 mt-1">{hint}</div>}
    </div>
  );
}
