import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Plus, Search, Star, Phone, Mail, MapPin } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { listClientes, softDeleteCliente } from '@/services/clientesService';
import type { Cliente } from '@/types/database';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { formatARS } from '@/lib/format';
import { ClienteEditorDialog } from '@/components/dialogs/ClienteEditorDialog';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { cn } from '@/lib/utils';

// F1.2 — Lista de clientes (CRM básico).
// Reemplaza al stub /clientes/lista. Diseño sobrio (paleta internal — el
// AdminLayout aplica data-surface="internal" en F1.8).
//
// Limitaciones MVP:
// - Sin paginación real (100 por página). Si el tenant supera, agregar
//   infinite scroll después.
// - total_pedidos/total_gastado quedan en 0 hasta que el job de Fase futura
//   los llene (cross-ref con ventas_pos.cliente_id).
// - Sin métricas avanzadas (recencia, segmentación). Eso es Fase 2.

export function ClientesLista() {
  const { user } = useAuth();
  const tenantId = user?.tenant_id ?? null;

  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [onlyVip, setOnlyVip] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingCliente, setEditingCliente] = useState<Cliente | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const r = await listClientes({ search: debouncedSearch.trim() || undefined, onlyVip });
    if (r.error) toast.error(r.error);
    else setClientes(r.data);
    setLoading(false);
  }, [debouncedSearch, onlyVip]);

  useEffect(() => { reload(); }, [reload]);

  const handleNuevo = () => {
    setEditingCliente(null);
    setEditorOpen(true);
  };

  const handleEditar = (cliente: Cliente) => {
    setEditingCliente(cliente);
    setEditorOpen(true);
  };

  const handleEliminar = async (cliente: Cliente) => {
    if (!confirm(`¿Eliminar cliente "${cliente.nombre || cliente.telefono}"? (soft delete)`)) return;
    const r = await softDeleteCliente(cliente.id);
    if (r.error) toast.error(r.error);
    else { toast.success('Cliente eliminado'); reload(); }
  };

  if (!tenantId) {
    return <div className="container py-8 text-muted-foreground">Cargando sesión…</div>;
  }

  return (
    <div className="container py-6">
      <header className="mb-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Clientes</h1>
          <p className="text-sm text-muted-foreground mt-1">
            CRM básico — clientes del tenant, con historial cruzable contra ventas.
          </p>
        </div>
        <Button onClick={handleNuevo}>
          <Plus className="h-4 w-4 mr-1.5" />
          Nuevo cliente
        </Button>
      </header>

      {/* Toolbar: search + filtros */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por teléfono, nombre o apellido"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={onlyVip} onCheckedChange={setOnlyVip} />
          Solo VIP
        </label>
        <div className="ml-auto text-sm text-muted-foreground">
          {loading ? 'Cargando…' : `${clientes.length} cliente${clientes.length === 1 ? '' : 's'}`}
        </div>
      </div>

      {/* Tabla */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-12 text-center text-muted-foreground">Cargando…</div>
          ) : clientes.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-muted-foreground mb-3">
                {search ? `No hay clientes que matcheen "${search}"` : 'No hay clientes todavía.'}
              </p>
              {!search && (
                <Button variant="outline" onClick={handleNuevo}>
                  <Plus className="h-4 w-4 mr-1.5" />
                  Crear el primero
                </Button>
              )}
            </div>
          ) : (
            <table className="w-full">
              <thead className="border-b bg-muted/30">
                <tr>
                  <th className="text-left text-xs font-medium uppercase tracking-wider px-4 py-2.5 text-muted-foreground">Cliente</th>
                  <th className="text-left text-xs font-medium uppercase tracking-wider px-4 py-2.5 text-muted-foreground">Contacto</th>
                  <th className="text-left text-xs font-medium uppercase tracking-wider px-4 py-2.5 text-muted-foreground">Pedidos</th>
                  <th className="text-right text-xs font-medium uppercase tracking-wider px-4 py-2.5 text-muted-foreground">Total gastado</th>
                  <th className="text-left text-xs font-medium uppercase tracking-wider px-4 py-2.5 text-muted-foreground">Último pedido</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {clientes.map((c) => (
                  <tr
                    key={c.id}
                    className="hover:bg-muted/30 cursor-pointer transition-colors"
                    onClick={() => handleEditar(c)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 min-w-0">
                        {c.vip && <Star className="h-3.5 w-3.5 text-warning fill-warning flex-shrink-0" />}
                        <div className="min-w-0">
                          <div className="font-medium text-sm truncate">
                            {(c.nombre || c.apellido) ? `${c.nombre ?? ''} ${c.apellido ?? ''}`.trim() : <span className="italic text-muted-foreground">Sin nombre</span>}
                          </div>
                          {c.zona && <div className="text-xs text-muted-foreground">{c.zona}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Phone className="h-3 w-3" />
                        <span className="tabular-nums">{c.telefono}</span>
                      </div>
                      {c.email && (
                        <div className="flex items-center gap-1.5 text-muted-foreground text-xs mt-0.5">
                          <Mail className="h-3 w-3" />
                          <span className="truncate max-w-[180px]">{c.email}</span>
                        </div>
                      )}
                      {c.direccion && (
                        <div className="flex items-center gap-1.5 text-muted-foreground text-xs mt-0.5">
                          <MapPin className="h-3 w-3 flex-shrink-0" />
                          <span className="truncate max-w-[180px]">{c.direccion}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm tabular-nums">{c.total_pedidos}</td>
                    <td className="px-4 py-3 text-sm tabular-nums text-right font-medium">
                      {formatARS(Number(c.total_gastado))}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {c.ultimo_pedido_at
                        ? new Date(c.ultimo_pedido_at).toLocaleDateString('es-AR')
                        : <span className="italic">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); handleEliminar(c); }}
                        className={cn('text-destructive opacity-60 hover:opacity-100')}
                        title="Eliminar"
                      >
                        Eliminar
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Dialog editor */}
      <ClienteEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        cliente={editingCliente}
        tenantId={tenantId}
        onSaved={() => { setEditorOpen(false); reload(); }}
      />
    </div>
  );
}
