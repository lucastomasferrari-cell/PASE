// Comensales (CRM) — sección del panel admin de MESA (etapa 3).
// Lista de clientes del tenant, buscable, con su info de contacto, marca VIP
// e historial. Click en un cliente → sus últimas reservas.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Search, Star, Phone, Mail, ChevronDown, ChevronUp } from 'lucide-react';
import { listClientes, type Cliente } from '@/lib/clientesService';
import { listReservasByCliente, type Reserva } from '@/lib/reservasService';

function nombreCliente(c: Cliente) {
  return [c.nombre, c.apellido].filter(Boolean).join(' ').trim() || c.telefono || 'Sin nombre';
}
function fechaCorta(iso: string) {
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: '2-digit' });
}

export function AdminComensales() {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [search, setSearch] = useState('');
  const [cargando, setCargando] = useState(true);
  const [abierto, setAbierto] = useState<number | null>(null);

  const reload = useCallback(async (s: string) => {
    setCargando(true);
    const { data, error } = await listClientes({ search: s, limit: 100 });
    if (error) toast.error('No se pudieron cargar los comensales: ' + error);
    setClientes(data);
    setCargando(false);
  }, []);

  useEffect(() => { void reload(''); }, [reload]);

  // Debounce de la búsqueda.
  useEffect(() => {
    const t = setTimeout(() => { void reload(search); }, 300);
    return () => clearTimeout(t);
  }, [search, reload]);

  return (
    <div className="mt-6 space-y-4 max-w-3xl">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-muted" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre o teléfono…"
          className="w-full rounded-xl border border-ink/15 bg-white pl-9 pr-3 py-2.5 text-sm"
        />
      </div>

      {cargando ? (
        <div className="py-16 text-center text-ink-muted">Cargando…</div>
      ) : clientes.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card py-16 text-center">
          <p className="font-medium">{search ? 'Sin resultados' : 'Todavía no hay comensales cargados'}</p>
          <p className="text-sm text-ink-muted mt-1">Se cargan solos cuando un cliente reserva o pide.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {clientes.map((c) => (
            <ClienteCard key={c.id} cliente={c} abierto={abierto === c.id}
                         onToggle={() => setAbierto((x) => x === c.id ? null : c.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ClienteCard({ cliente, abierto, onToggle }: { cliente: Cliente; abierto: boolean; onToggle: () => void }) {
  const [reservas, setReservas] = useState<Reserva[] | null>(null);

  useEffect(() => {
    if (abierto && reservas === null) {
      void listReservasByCliente(cliente.id).then((r) => setReservas(r.data));
    }
  }, [abierto, reservas, cliente.id]);

  return (
    <div className="rounded-2xl bg-white border border-ink/5 shadow-card overflow-hidden">
      <button onClick={onToggle} className="w-full p-4 flex items-center gap-3 text-left hover:bg-brand-50/40">
        <div className="w-10 h-10 rounded-full bg-brand-100 text-brand-700 grid place-items-center font-medium text-sm shrink-0">
          {(nombreCliente(cliente)[0] ?? '?').toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{nombreCliente(cliente)}</span>
            {cliente.vip && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200 inline-flex items-center gap-0.5">
                <Star className="h-2.5 w-2.5" /> VIP
              </span>
            )}
          </div>
          <div className="text-xs text-ink-muted flex items-center gap-3 mt-0.5">
            {cliente.telefono && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{cliente.telefono}</span>}
            {cliente.email && <span className="inline-flex items-center gap-1 truncate"><Mail className="h-3 w-3" />{cliente.email}</span>}
          </div>
        </div>
        <div className="text-right shrink-0">
          {cliente.total_pedidos != null && (
            <div className="text-xs text-ink-soft">{cliente.total_pedidos} pedido{cliente.total_pedidos !== 1 ? 's' : ''}</div>
          )}
          {cliente.ultimo_pedido_at && (
            <div className="text-[11px] text-ink-muted">últ: {fechaCorta(cliente.ultimo_pedido_at)}</div>
          )}
        </div>
        {abierto ? <ChevronUp className="h-4 w-4 text-ink-muted" /> : <ChevronDown className="h-4 w-4 text-ink-muted" />}
      </button>

      {abierto && (
        <div className="px-4 pb-4 border-t border-ink/5 pt-3">
          {cliente.notas && <p className="text-xs text-ink-soft italic mb-2">{cliente.notas}</p>}
          <p className="text-xs font-medium text-ink-muted mb-1.5">Historial de reservas</p>
          {reservas === null ? (
            <p className="text-xs text-ink-muted">Cargando…</p>
          ) : reservas.length === 0 ? (
            <p className="text-xs text-ink-muted">Sin reservas registradas.</p>
          ) : (
            <ul className="space-y-1">
              {reservas.map((r) => (
                <li key={r.id} className="text-xs flex items-center justify-between gap-2 py-1 border-b border-ink/5 last:border-0">
                  <span>{fechaCorta(r.fecha_hora)} · {r.personas}p</span>
                  <span className="text-ink-muted">{r.estado}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
