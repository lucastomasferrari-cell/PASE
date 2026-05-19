import { useEffect, useState, useCallback } from 'react';
import { listTickets, getTicket, type Ticket } from '@/lib/tickets';
import { TicketsList, type ListFilters } from '@/components/TicketsList';
import { TicketDetail } from '@/components/TicketDetail';

export function Soporte() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [filters, setFilters] = useState<ListFilters>({
    tab: 'abiertos',
    estado: 'abierto',
    sistema: 'todos',
    prioridad: 'todos',
    agentStatus: 'todos',
  });
  const [counts, setCounts] = useState({ abiertos: 0, prs: 0, todos: 0 });

  const loadList = useCallback(async () => {
    setLoading(true);
    // Lista con el filtro activo.
    const [
      filteredRes,
      abiertosRes,
      prsRes,
      todosRes,
    ] = await Promise.all([
      listTickets({
        estado: filters.estado,
        sistema: filters.sistema,
        prioridad: filters.prioridad,
        agentStatus: filters.agentStatus,
      }),
      // Contadores: queries livianas solo para count.
      listTickets({ estado: 'abierto' }),
      listTickets({ agentStatus: 'pr_opened' }),
      listTickets({}),
    ]);
    setTickets(filteredRes.data);
    setCounts({
      abiertos: abiertosRes.data.length,
      prs: prsRes.data.length,
      todos: todosRes.data.length,
    });
    setLoading(false);
  }, [filters]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    let cancelled = false;
    void getTicket(selectedId).then(({ data }) => {
      if (!cancelled) setSelected(data);
    });
    return () => { cancelled = true; };
  }, [selectedId]);

  const handleChange = useCallback(async () => {
    if (selectedId) {
      const { data } = await getTicket(selectedId);
      setSelected(data);
    }
    await loadList();
  }, [selectedId, loadList]);

  // En mobile mostramos lista O detalle, no ambos. Si hay selección, oculta
  // lista. Botón "Atrás" en el detalle vuelve a la lista.
  return (
    <div className="md:-mx-8 md:-my-6 flex h-[calc(100vh-0px)]">
      <div className={selectedId ? 'hidden md:flex md:w-96' : 'flex w-full md:w-96'}>
        <TicketsList
          tickets={tickets}
          selectedId={selectedId}
          onSelect={setSelectedId}
          loading={loading}
          filters={filters}
          setFilters={setFilters}
          counts={counts}
        />
      </div>
      {selected ? (
        <TicketDetail
          ticket={selected}
          onChange={handleChange}
          onBack={() => setSelectedId(null)}
        />
      ) : (
        <div className="flex-1 hidden md:flex items-center justify-center text-admin-muted text-sm">
          {tickets.length === 0
            ? 'No hay tickets que coincidan con los filtros.'
            : 'Seleccioná un ticket de la lista.'}
        </div>
      )}
    </div>
  );
}
