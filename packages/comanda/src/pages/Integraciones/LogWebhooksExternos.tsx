import { useCallback, useEffect, useState } from 'react';
import { Activity, CheckCircle2, XCircle, ExternalLink, Filter } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/Badge';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import { formatFechaAR, formatHoraAR } from '@/lib/format';
import { cn } from '@/lib/utils';

// Log de webhooks externos recibidos (Rappi, PedidosYa, MP, WhatsApp).
// Útil para debugging cuando un pedido externo no llega o se procesa raro.

interface LogRow {
  id: number;
  provider: string;
  external_id: string | null;
  payload: Record<string, unknown>;
  headers: Record<string, unknown> | null;
  venta_id: number | null;
  processed_at: string | null;
  error: string | null;
  created_at: string;
}

const PROVIDERS = ['todos', 'rappi', 'pedidos-ya', 'mp', 'whatsapp'] as const;
type ProviderFiltro = typeof PROVIDERS[number];

const PROVIDER_COLOR: Record<string, 'red' | 'violet' | 'green' | 'amber' | 'gray'> = {
  'rappi': 'red',
  'pedidos-ya': 'violet',
  'mp': 'green',
  'whatsapp': 'green',
};

export function LogWebhooksExternos() {
  const { user } = useAuth();
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtro, setFiltro] = useState<ProviderFiltro>('todos');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const reload = useCallback(async () => {
    if (!user?.tenant_id) return;
    setLoading(true);
    let q = db.from('pedidos_externos_log')
      .select('*')
      .eq('tenant_id', user.tenant_id)
      .order('created_at', { ascending: false })
      .limit(100);
    if (filtro !== 'todos') q = q.eq('provider', filtro);
    const { data } = await q;
    setLogs((data ?? []) as LogRow[]);
    setLoading(false);
  }, [user?.tenant_id, filtro]);

  useEffect(() => { reload(); }, [reload]);

  useRealtimeTable({ table: 'pedidos_externos_log', onChange: () => reload(), debounceMs: 2000 });

  return (
    <div className="container max-w-5xl py-6">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Activity className="h-6 w-6" />
          Log de webhooks externos
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Auditoría de pedidos recibidos por Rappi, PedidosYa, MercadoPago y otros partners.
        </p>
      </header>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Filter className="h-4 w-4 text-muted-foreground" />
        {PROVIDERS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setFiltro(p)}
            className={cn(
              'px-3 h-9 rounded-md border text-xs font-medium capitalize',
              filtro === p ? 'bg-primary text-primary-foreground border-primary' : 'border-border bg-background',
            )}
          >
            {p === 'todos' ? 'Todos' : p}
          </button>
        ))}
        <div className="ml-auto text-xs text-muted-foreground">
          {logs.length} {logs.length === 1 ? 'evento' : 'eventos'} (últimos 100)
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-12 text-center text-muted-foreground">Cargando…</div>
          ) : logs.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground italic">
              No hay webhooks recibidos aún. Cuando un partner externo envíe un pedido aparecerá acá.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs text-muted-foreground uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-2">Fecha</th>
                  <th className="text-left px-4 py-2">Provider</th>
                  <th className="text-left px-4 py-2">External ID</th>
                  <th className="text-center px-4 py-2">Venta creada</th>
                  <th className="text-left px-4 py-2">Estado</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => {
                  const isExpanded = expandedId === log.id;
                  return (
                    <>
                      <tr
                        key={log.id}
                        className="border-t cursor-pointer hover:bg-muted/20"
                        onClick={() => setExpandedId(isExpanded ? null : log.id)}
                      >
                        <td className="px-4 py-2.5 text-xs">
                          <div>{formatFechaAR(log.created_at)}</div>
                          <div className="text-muted-foreground">{formatHoraAR(log.created_at)}</div>
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge variant={PROVIDER_COLOR[log.provider] ?? 'gray'}>
                            {log.provider}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5 text-xs font-mono truncate max-w-xs">
                          {log.external_id ?? '—'}
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          {log.venta_id ? (
                            <span className="inline-flex items-center gap-1 text-xs text-primary">
                              <ExternalLink className="h-3 w-3" />
                              #{log.venta_id}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground italic">no creada</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {log.error ? (
                            <Badge variant="red">
                              <XCircle className="h-3 w-3 inline mr-0.5" />
                              Error
                            </Badge>
                          ) : log.venta_id ? (
                            <Badge variant="green">
                              <CheckCircle2 className="h-3 w-3 inline mr-0.5" />
                              OK
                            </Badge>
                          ) : (
                            <Badge variant="amber">Recibido</Badge>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr key={log.id + '-detail'} className="border-t bg-muted/10">
                          <td colSpan={5} className="px-4 py-3">
                            {log.error && (
                              <div className="mb-3 p-2 rounded bg-destructive/10 text-destructive text-xs">
                                <strong>Error:</strong> {log.error}
                              </div>
                            )}
                            <details>
                              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                                Ver payload (JSON)
                              </summary>
                              <pre className="mt-2 p-3 bg-muted rounded text-[10px] overflow-x-auto max-h-64">
                                {JSON.stringify(log.payload, null, 2)}
                              </pre>
                            </details>
                            {log.headers && (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                                  Headers
                                </summary>
                                <pre className="mt-2 p-3 bg-muted rounded text-[10px] overflow-x-auto max-h-32">
                                  {JSON.stringify(log.headers, null, 2)}
                                </pre>
                              </details>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center mt-4">
        Los webhooks llegan a <code>/api/tienda-mp?action=&lt;provider&gt;-webhook</code>.
        Si un pedido externo no aparece acá, el partner no está enviando el webhook (revisar URL configurada en su panel).
      </p>
    </div>
  );
}
