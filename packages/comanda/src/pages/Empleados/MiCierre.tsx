import { useEffect, useState } from 'react';
import { useAuthPos } from '@/lib/authPos';
import { getMiCierre, type CierreMozo } from '@/services/miCierreService';
import { formatARS } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Receipt, Clock, Users, TrendingUp, RefreshCw } from 'lucide-react';

// Pantalla "Mi cierre del día" — shift report del mozo logueado.
// Muestra breakdown de cobros por método del día actual (puede expandirse
// a rango personalizado en iteración futura).

export function MiCierreView() {
  const { empleado } = useAuthPos();
  const [cierre, setCierre] = useState<CierreMozo | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    if (!empleado?.id) return;
    setLoading(true);
    setErr(null);
    const { data, error } = await getMiCierre(empleado.id);
    if (error) {
      setErr(error);
      setLoading(false);
      return;
    }
    setCierre(data);
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- load async, sync con DB en mount.
  useEffect(() => { void load(); }, [empleado?.id]);

  if (loading) {
    return <div className="p-6 text-muted-foreground">Cargando…</div>;
  }
  if (err) {
    return <div className="p-6 text-destructive">{err}</div>;
  }
  if (!empleado) {
    return <div className="p-6 text-muted-foreground">Logueate primero al POS para ver tu cierre.</div>;
  }
  if (!cierre || cierre.ventas_cobradas === 0) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-xl font-semibold">Mi cierre del día</h1>
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Receipt className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Todavía no cobraste ninguna venta hoy.</p>
            <p className="text-xs mt-2">Cuando empieces a cobrar, vas a ver acá tu shift report en vivo.</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={load}>
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refrescar
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Mi cierre del día</h1>
          <p className="text-sm text-muted-foreground">{empleado.nombre}</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refrescar
        </Button>
      </div>

      {/* KPIs principales */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Receipt className="h-3.5 w-3.5" /> VENTAS
            </div>
            <div className="text-2xl font-semibold tabular-nums">{cierre.ventas_cobradas}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <TrendingUp className="h-3.5 w-3.5" /> TOTAL COBRADO
            </div>
            <div className="text-2xl font-semibold tabular-nums">{formatARS(cierre.total_cobrado)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Users className="h-3.5 w-3.5" /> MESAS
            </div>
            <div className="text-2xl font-semibold tabular-nums">{cierre.mesas_atendidas}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <TrendingUp className="h-3.5 w-3.5" /> TICKET PROMEDIO
            </div>
            <div className="text-2xl font-semibold tabular-nums">{formatARS(cierre.ticket_promedio)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Breakdown por método */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Por método de cobro</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <MetodoRow label="Efectivo" monto={cierre.efectivo} total={cierre.total_cobrado} />
          <MetodoRow label="Crédito" monto={cierre.credito} total={cierre.total_cobrado} extra={cierre.credito_cuotas > 0 ? `${cierre.credito_cuotas} en cuotas` : undefined} />
          <MetodoRow label="Débito" monto={cierre.debito} total={cierre.total_cobrado} />
          <MetodoRow label="QR (MP / MODO)" monto={cierre.qr} total={cierre.total_cobrado} />
          <MetodoRow label="Transferencia" monto={cierre.transferencia} total={cierre.total_cobrado} />
          {cierre.otros > 0 && <MetodoRow label="Otros" monto={cierre.otros} total={cierre.total_cobrado} />}
        </CardContent>
      </Card>

      {/* Horarios */}
      {cierre.primer_cobro && cierre.ultimo_cobro && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tu turno</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-sm">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              Primer cobro: <strong>{new Date(cierre.primer_cobro).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</strong>
              <span className="text-muted-foreground mx-1">·</span>
              Último: <strong>{new Date(cierre.ultimo_cobro).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</strong>
            </div>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground italic">
        Resumen calculado en vivo. Cualquier venta nueva que cobres se refleja al refrescar.
      </p>
    </div>
  );
}

function MetodoRow({ label, monto, total, extra }: { label: string; monto: number; total: number; extra?: string }) {
  if (monto <= 0) return null;
  const pct = total > 0 ? (monto / total) * 100 : 0;
  return (
    <div className="flex items-center justify-between text-sm">
      <div className="flex items-center gap-2">
        <span>{label}</span>
        {extra && <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{extra}</span>}
      </div>
      <div className="flex items-baseline gap-3">
        <span className="text-xs text-muted-foreground tabular-nums">{pct.toFixed(0)}%</span>
        <span className="font-semibold tabular-nums">{formatARS(monto)}</span>
      </div>
    </div>
  );
}
