import { useEffect, useState, useCallback } from 'react';
import { Star, Trophy, Phone, Mail, Award } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/Badge';
import { Input } from '@/components/ui/input';
import { formatARS } from '@/lib/format';
import { useDebouncedValue } from '@pase/shared/utils';
import { cn } from '@/lib/utils';

// Fidelidad básica — top clientes por total_gastado / total_pedidos.
// total_gastado y total_pedidos vienen del CRM (F1.2). Hoy 0 hasta que
// el job futuro los rellena. Por ahora también listamos clientes VIP
// como categoría destacada (toggle manual en CRM).
//
// Toast tiene un engine de loyalty con puntos, recompensas, campañas.
// Esta versión MVP es solo lista ordenable — el engine completo va en
// fase futura.

interface ClienteFidelidad {
  id: number;
  nombre: string | null;
  apellido: string | null;
  telefono: string;
  email: string | null;
  vip: boolean;
  total_pedidos: number;
  total_gastado: number;
  ultimo_pedido_at: string | null;
  zona: string | null;
}

type Orden = 'gastado' | 'pedidos' | 'reciente';

export function FidelidadLista() {
  const { user } = useAuth();
  const [clientes, setClientes] = useState<ClienteFidelidad[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [orden, setOrden] = useState<Orden>('gastado');
  const [onlyVip, setOnlyVip] = useState(false);

  const reload = useCallback(async () => {
    if (!user?.tenant_id) return;
    setLoading(true);
    let q = db.from('clientes')
      .select('id, nombre, apellido, telefono, email, vip, total_pedidos, total_gastado, ultimo_pedido_at, zona')
      .eq('tenant_id', user.tenant_id)
      .is('deleted_at', null);

    if (debouncedSearch.trim()) {
      q = q.or(`nombre.ilike.%${debouncedSearch}%,apellido.ilike.%${debouncedSearch}%,telefono.ilike.%${debouncedSearch}%`);
    }
    if (onlyVip) q = q.eq('vip', true);

    if (orden === 'gastado') q = q.order('total_gastado', { ascending: false, nullsFirst: false });
    else if (orden === 'pedidos') q = q.order('total_pedidos', { ascending: false, nullsFirst: false });
    else q = q.order('ultimo_pedido_at', { ascending: false, nullsFirst: false });

    const { data } = await q.limit(200);
    setClientes((data ?? []) as ClienteFidelidad[]);
    setLoading(false);
  }, [user?.tenant_id, debouncedSearch, orden, onlyVip]);

  useEffect(() => { reload(); }, [reload]);

  const top3 = clientes.slice(0, 3);

  return (
    <div className="container py-6 max-w-5xl">
      <header className="mb-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Programa de fidelidad</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Top clientes por gasto. Los más frecuentes merecen un trato especial.
          </p>
        </div>
      </header>

      {/* Top 3 destacados */}
      {top3.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          {top3.map((c, idx) => {
            const icons = [
              <Trophy key={0} className="h-6 w-6 text-amber-500" />,
              <Award key={1} className="h-6 w-6 text-slate-400" />,
              <Award key={2} className="h-6 w-6 text-orange-700" />,
            ];
            return (
              <Card key={c.id} className={cn(
                'border-2',
                idx === 0 ? 'border-amber-400 bg-amber-50/40 dark:bg-amber-950/20' :
                idx === 1 ? 'border-slate-300 bg-slate-50/40 dark:bg-slate-900/40' :
                'border-orange-300 bg-orange-50/40 dark:bg-orange-950/20',
              )}>
                <CardContent className="p-4 flex items-center gap-3">
                  {icons[idx]}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">
                      {[c.nombre, c.apellido].filter(Boolean).join(' ') || c.telefono}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {c.total_pedidos} pedido{c.total_pedidos === 1 ? '' : 's'} · {c.zona ?? 'sin zona'}
                    </div>
                    <div className="text-lg font-bold tabular-nums mt-0.5">
                      {formatARS(c.total_gastado)}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Filtros */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Input
          placeholder="Buscar por nombre, apellido o teléfono"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm h-11"
        />
        <div className="flex gap-1 ml-auto">
          {(['gastado','pedidos','reciente'] as Orden[]).map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => setOrden(o)}
              className={cn(
                'px-3 h-9 rounded-md border text-xs font-medium',
                orden === o ? 'bg-primary text-primary-foreground border-primary' : 'border-border bg-background',
              )}
            >
              {o === 'gastado' ? 'Más gasto' : o === 'pedidos' ? 'Más pedidos' : 'Más reciente'}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setOnlyVip(!onlyVip)}
            className={cn(
              'px-3 h-9 rounded-md border text-xs font-medium inline-flex items-center gap-1',
              onlyVip ? 'bg-amber-500 text-white border-amber-500' : 'border-border bg-background',
            )}
          >
            <Star className="h-3.5 w-3.5" />
            Solo VIP
          </button>
        </div>
      </div>

      {/* Tabla */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-12 text-center text-muted-foreground">Cargando…</div>
          ) : clientes.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground italic">
              {search ? 'Sin matches.' : 'Sin clientes cargados. Cargá clientes desde Clientes → Lista o se crean automáticos en pedidos.'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs text-muted-foreground uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-2">#</th>
                  <th className="text-left px-4 py-2">Cliente</th>
                  <th className="text-left px-4 py-2">Contacto</th>
                  <th className="text-right px-4 py-2">Pedidos</th>
                  <th className="text-right px-4 py-2">Total gastado</th>
                  <th className="text-left px-4 py-2">Último</th>
                </tr>
              </thead>
              <tbody>
                {clientes.map((c, idx) => (
                  <tr key={c.id} className="border-t border-border hover:bg-muted/30">
                    <td className="px-4 py-3 text-muted-foreground tabular-nums">{idx + 1}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {c.vip && <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-500" />}
                        <span className="font-medium">{[c.nombre, c.apellido].filter(Boolean).join(' ') || '(sin nombre)'}</span>
                      </div>
                      {c.zona && <Badge variant="gray">{c.zona}</Badge>}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <div className="flex items-center gap-1"><Phone className="h-3 w-3 text-muted-foreground" />{c.telefono}</div>
                      {c.email && <div className="flex items-center gap-1 text-muted-foreground mt-0.5"><Mail className="h-3 w-3" />{c.email}</div>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{c.total_pedidos}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-semibold">{formatARS(c.total_gastado)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {c.ultimo_pedido_at ? new Date(c.ultimo_pedido_at).toLocaleDateString('es-AR') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center mt-4">
        Los contadores total_pedidos y total_gastado los actualiza un job futuro.
        Hoy quedan en 0 hasta el primer recalculo. Engine de puntos + campañas viene en fase posterior.
      </p>
    </div>
  );
}
