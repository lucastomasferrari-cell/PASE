import { useEffect, useState, useCallback } from 'react';
import { listTickets, getTicket, type Ticket, type ListFilters } from '@/lib/tickets';
import { TicketsList } from '@/components/TicketsList';
import { TicketDetail } from '@/components/TicketDetail';

export function Soporte() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [filters, setFilters] = useState<Required<ListFilters>>({
    estado: 'abierto',
    sistema: 'todos',
    prioridad: 'todos',
  });

  const loadList = useCallback(async () => {
    setLoading(true);
    const { data } = await listTickets(filters);
    setTickets(data);
    setLoading(false);
    // Si no había selección, seleccionar primero. Si la selección actual ya
    // no está en la lista filtrada, NO descartarla (puede ser el ticket que
    // acabamos de cerrar y queremos ver la confirmación).
    if (!selectedId && data.length > 0 && data[0]) {
      setSelectedId(data[0].id);
    }
  }, [filters, selectedId]);

  // Carga lista al montar y cada vez que cambian filtros.
  useEffect(() => {
    void loadList();
  }, [loadList]);

  // Carga detalle cuando cambia selectedId.
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

  // Cuando el detalle cambia (responder/cerrar/etc), refrescamos lista +
  // detalle para que se vean los updates.
  const handleChange = useCallback(async () => {
    if (selectedId) {
      const { data } = await getTicket(selectedId);
      setSelected(data);
    }
    await loadList();
  }, [selectedId, loadList]);

  return (
    <div className="-mx-8 -my-6 flex h-[calc(100vh-0px)]">
      <TicketsList
        tickets={tickets}
        selectedId={selectedId}
        onSelect={setSelectedId}
        loading={loading}
        filters={filters}
        setFilters={(f) => setFilters({ ...filters, ...f })}
      />
      {selected ? (
        <TicketDetail ticket={selected} onChange={handleChange} />
      ) : (
        <div className="flex-1 flex items-center justify-center text-admin-muted text-sm">
          {tickets.length === 0
            ? 'No hay tickets que coincidan con los filtros.'
            : 'Seleccioná un ticket de la lista.'}
        </div>
      )}
    </div>
  );
}
