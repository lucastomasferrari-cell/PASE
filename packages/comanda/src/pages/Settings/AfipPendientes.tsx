// AfipPendientes — pantalla para reintentar emisión de CAE en ventas online
// cuyo flujo automático (post-cobro MP) falló.
//
// Las ventas se marcan automáticamente con `afip_pendiente=true` desde el
// webhook server-side cuando AFIP rechaza la primera emisión. Esta pantalla
// las lista para que el operador las reintente manualmente.
//
// Si AFIP rechaza el reintento, queda registrado el último error en la
// columna `afip_ultimo_error`. Si emite OK, el flag se limpia y la fila
// desaparece de la lista.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Receipt, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  listarVentasAfipPendientes, reintentarAfipVenta,
  type VentaAfipPendiente,
} from '@/lib/afip/pendientes';

function formatARS(monto: number): string {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency', currency: 'ARS', maximumFractionDigits: 2,
  }).format(monto);
}

function formatFecha(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'short', timeStyle: 'short',
  }).format(new Date(iso));
}

export function AfipPendientes() {
  const [ventas, setVentas] = useState<VentaAfipPendiente[]>([]);
  const [cargando, setCargando] = useState(true);
  const [reintentando, setReintentando] = useState<number | null>(null);

  async function recargar() {
    setCargando(true);
    const { data, error } = await listarVentasAfipPendientes();
    if (error) {
      toast.error('No se pudo cargar la lista: ' + error);
      setVentas([]);
    } else {
      setVentas(data);
    }
    setCargando(false);
  }

  useEffect(() => {
    void recargar();
  }, []);

  async function onReintentar(ventaId: number) {
    setReintentando(ventaId);
    try {
      const r = await reintentarAfipVenta(ventaId);
      if (r.ok && r.result?.cae) {
        toast.success(`AFIP emitió OK. CAE ${r.result.cae} (N° ${r.result.numero}).`);
        // Sacarla de la lista (el server ya limpió el flag)
        setVentas((prev) => prev.filter((v) => v.id !== ventaId));
      } else {
        toast.error('AFIP rechazó de nuevo: ' + (r.error ?? 'desconocido'));
        // Recargar para ver el nuevo afip_ultimo_error / afip_ultimo_intento_at
        void recargar();
      }
    } finally {
      setReintentando(null);
    }
  }

  return (
    <div className="container mx-auto p-6 max-w-5xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium flex items-center gap-2">
            <Receipt className="h-6 w-6" />
            Facturas AFIP pendientes
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Ventas online que se cobraron pero la emisión de factura electrónica
            falló. Reintentá manualmente. Si AFIP sigue rechazando, revisá el mensaje
            de error.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={recargar} disabled={cargando}>
          <RefreshCw className={`h-4 w-4 mr-2 ${cargando ? 'animate-spin' : ''}`} />
          Recargar
        </Button>
      </div>

      {cargando ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            Cargando...
          </CardContent>
        </Card>
      ) : ventas.length === 0 ? (
        <Card>
          <CardContent className="py-10 flex flex-col items-center gap-2 text-center">
            <CheckCircle2 className="h-10 w-10 text-emerald-500" />
            <p className="text-base font-medium">No hay facturas pendientes</p>
            <p className="text-sm text-muted-foreground max-w-sm">
              Todas las ventas online cobradas tienen su CAE emitido. Si AFIP llega a
              fallar en alguna, aparecerá acá.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              {ventas.length} {ventas.length === 1 ? 'venta pendiente' : 'ventas pendientes'}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y">
              {ventas.map((v) => (
                <div key={v.id} className="p-4 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-start">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">Venta #{v.id}</span>
                      <span className="text-sm text-muted-foreground">
                        Local {v.local_id}
                      </span>
                      <span className="text-sm font-medium text-foreground">
                        {formatARS(Number(v.total))}
                      </span>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {v.cliente_nombre ?? 'Cliente sin nombre'}
                      {v.cliente_email ? ` · ${v.cliente_email}` : ''}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Último intento: {formatFecha(v.afip_ultimo_intento_at)} · Cobrada el {formatFecha(v.created_at)}
                    </div>
                    {v.afip_ultimo_error && (
                      <div className="text-xs text-red-600 dark:text-red-400 mt-2 bg-red-50 dark:bg-red-950/30 p-2 rounded border border-red-200 dark:border-red-900/40">
                        <span className="font-medium">Error AFIP:</span> {v.afip_ultimo_error}
                      </div>
                    )}
                  </div>
                  <div className="md:self-center">
                    <Button
                      size="sm"
                      onClick={() => void onReintentar(v.id)}
                      disabled={reintentando === v.id}
                    >
                      {reintentando === v.id ? (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                          Reintentando...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2" />
                          Reintentar AFIP
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
