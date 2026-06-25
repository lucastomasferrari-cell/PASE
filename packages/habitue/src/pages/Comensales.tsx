// Comensales — el CRM de Habitué. Base de clientes del tenant: búsqueda,
// filtros (VIP / acepta marketing), alta, export CSV, VIP toggle, borrar, y
// perfil con historial de reservas + stats (visitas / no-shows).

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Search, Star, Phone, Mail, ChevronDown, ChevronUp, Plus, Download, X, Trash2, Megaphone } from 'lucide-react';
import { listClientes, createCliente, updateCliente, eliminarCliente, type Cliente } from '@/lib/clientesService';
import { listReservasByCliente, type Reserva } from '@/lib/reservasService';
import { getConsumoCliente, type ConsumoCliente } from '@/lib/consumoService';

interface Props { tenantId: string; }
type Filtro = 'todos' | 'vip' | 'marketing';

function nombreCliente(c: Cliente) {
  return [c.nombre, c.apellido].filter(Boolean).join(' ').trim() || c.telefono || 'Sin nombre';
}
function fechaCorta(iso: string) {
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: '2-digit' });
}
function money(n: number | null) {
  if (n == null) return null;
  return n.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
}

export function Comensales({ tenantId }: Props) {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [search, setSearch] = useState('');
  const [filtro, setFiltro] = useState<Filtro>('todos');
  const [cargando, setCargando] = useState(true);
  const [abierto, setAbierto] = useState<number | null>(null);
  const [creando, setCreando] = useState(false);

  const reload = useCallback(async (s: string, f: Filtro) => {
    setCargando(true);
    const { data, error } = await listClientes({
      search: s, limit: 300, onlyVip: f === 'vip', onlyMarketing: f === 'marketing',
    });
    if (error) toast.error('No se pudieron cargar los comensales: ' + error);
    setClientes(data);
    setCargando(false);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { void reload(search, filtro); }, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [search, filtro, reload]);

  async function toggleVip(c: Cliente) {
    const nuevo = !c.vip;
    setClientes((prev) => prev.map((x) => x.id === c.id ? { ...x, vip: nuevo } : x));
    const { error } = await updateCliente(c.id, { vip: nuevo });
    if (error) { toast.error(error); void reload(search, filtro); }
  }

  async function borrar(c: Cliente) {
    if (!window.confirm(`¿Borrar a ${nombreCliente(c)}?`)) return;
    setClientes((prev) => prev.filter((x) => x.id !== c.id));
    const { error } = await eliminarCliente(c.id);
    if (error) { toast.error(error); void reload(search, filtro); }
    else toast.success('Comensal borrado');
  }

  function exportarCSV() {
    const headers = ['Nombre', 'Apellido', 'Teléfono', 'Email', 'VIP', 'Marketing', 'Pedidos', 'Gastado', 'Último'];
    const rows = clientes.map((c) => [
      c.nombre ?? '', c.apellido ?? '', c.telefono ?? '', c.email ?? '',
      c.vip ? 'Sí' : '', c.acepta_marketing ? 'Sí' : '',
      String(c.total_pedidos ?? 0), String(c.total_gastado ?? 0),
      c.ultimo_pedido_at ? fechaCorta(c.ultimo_pedido_at) : '',
    ]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `comensales-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const FILTROS: { key: Filtro; label: string }[] = [
    { key: 'todos', label: 'Todos' },
    { key: 'vip', label: '★ VIP' },
    { key: 'marketing', label: 'Aceptan marketing' },
  ];

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-muted" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nombre, teléfono o email…"
                 className="w-full rounded-lg border border-ink/15 bg-white pl-9 pr-3 py-2.5 text-sm" />
        </div>
        <button onClick={exportarCSV} disabled={clientes.length === 0}
                className="rounded-lg border border-ink/15 bg-white hover:bg-ink/5 px-3 py-2.5 text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50">
          <Download className="h-4 w-4" /> Exportar
        </button>
        <button onClick={() => setCreando(true)}
                className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-3.5 py-2.5 text-sm font-medium inline-flex items-center gap-1.5">
          <Plus className="h-4 w-4" /> Nuevo
        </button>
      </div>

      <div className="flex gap-2 flex-wrap">
        {FILTROS.map((f) => (
          <button key={f.key} onClick={() => setFiltro(f.key)}
                  className={`rounded-full px-3.5 py-1.5 text-sm font-medium border transition-colors ${
                    filtro === f.key ? 'bg-brand-500 text-white border-brand-500' : 'border-ink/15 bg-white hover:border-brand-300'
                  }`}>
            {f.label}
          </button>
        ))}
        {!cargando && <span className="text-sm text-ink-muted self-center ml-auto">{clientes.length} comensales</span>}
      </div>

      {cargando ? (
        <div className="py-16 text-center text-ink-muted">Cargando…</div>
      ) : clientes.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card py-16 text-center">
          <p className="font-medium">{search || filtro !== 'todos' ? 'Sin resultados' : 'Todavía no hay comensales'}</p>
          <p className="text-sm text-ink-muted mt-1">Se cargan solos cuando un cliente reserva o pide, o cargá uno con "Nuevo".</p>
        </div>
      ) : (
        <div className="space-y-2">
          {clientes.map((c) => (
            <ClienteCard key={c.id} cliente={c} abierto={abierto === c.id}
                         onToggle={() => setAbierto((x) => x === c.id ? null : c.id)}
                         onToggleVip={() => void toggleVip(c)} onBorrar={() => void borrar(c)} />
          ))}
        </div>
      )}

      {creando && (
        <FormCliente
          onClose={() => setCreando(false)}
          onSave={async (input) => {
            const { error } = await createCliente(tenantId, input);
            if (error) { toast.error(error); return; }
            toast.success('Comensal agregado');
            setCreando(false);
            void reload(search, filtro);
          }}
        />
      )}
    </div>
  );
}

function ClienteCard({ cliente, abierto, onToggle, onToggleVip, onBorrar }: {
  cliente: Cliente; abierto: boolean; onToggle: () => void; onToggleVip: () => void; onBorrar: () => void;
}) {
  const [reservas, setReservas] = useState<Reserva[] | null>(null);
  const [consumo, setConsumo] = useState<ConsumoCliente | null>(null);
  useEffect(() => {
    if (abierto && reservas === null) void listReservasByCliente(cliente.id).then((r) => setReservas(r.data));
    if (abierto && consumo === null) void getConsumoCliente(cliente.telefono).then((r) => setConsumo(r.data));
  }, [abierto, reservas, consumo, cliente.id, cliente.telefono]);

  const stats = reservas ? {
    visitas: reservas.filter((r) => r.estado === 'finalizada' || r.estado === 'sentada').length,
    noShows: reservas.filter((r) => r.estado === 'no_show').length,
  } : null;

  return (
    <div className="rounded-2xl bg-white border border-ink/5 shadow-card overflow-hidden">
      <div className="w-full p-4 flex items-center gap-3">
        <button onClick={onToggleVip} title={cliente.vip ? 'Quitar VIP' : 'Marcar VIP'} className="shrink-0">
          <Star className={`h-5 w-5 ${cliente.vip ? 'text-brand-400 fill-brand-400' : 'text-ink/20 hover:text-brand-300'}`} />
        </button>
        <button onClick={onToggle} className="flex-1 flex items-center gap-3 text-left min-w-0">
          <div className="w-10 h-10 rounded-full bg-brand-100 text-brand-700 grid place-items-center font-medium text-sm shrink-0">
            {(nombreCliente(cliente)[0] ?? '?').toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{nombreCliente(cliente)}</span>
              {cliente.acepta_marketing && <Megaphone className="h-3.5 w-3.5 text-brand-500 shrink-0" />}
            </div>
            <div className="text-xs text-ink-muted flex items-center gap-3 mt-0.5">
              {cliente.telefono && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{cliente.telefono}</span>}
              {cliente.email && <span className="inline-flex items-center gap-1 truncate"><Mail className="h-3 w-3" />{cliente.email}</span>}
            </div>
          </div>
          <div className="text-right shrink-0 hidden sm:block">
            {cliente.total_gastado != null && cliente.total_gastado > 0 && (
              <div className="text-xs font-medium text-ink">{money(cliente.total_gastado)}</div>
            )}
            {cliente.ultimo_pedido_at && <div className="text-[11px] text-ink-muted">últ: {fechaCorta(cliente.ultimo_pedido_at)}</div>}
          </div>
          {abierto ? <ChevronUp className="h-4 w-4 text-ink-muted shrink-0" /> : <ChevronDown className="h-4 w-4 text-ink-muted shrink-0" />}
        </button>
      </div>

      {abierto && (
        <div className="px-4 pb-4 border-t border-ink/5 pt-3">
          <div className="grid grid-cols-3 gap-2 mb-3">
            <Mini label="Pedidos" valor={String(cliente.total_pedidos ?? 0)} />
            <Mini label="Gastado" valor={money(cliente.total_gastado) ?? '—'} />
            <Mini label="Visitas" valor={stats ? String(stats.visitas) : '…'} />
          </div>
          {cliente.notas && <p className="text-xs text-ink-soft italic mb-2">{cliente.notas}</p>}

          {consumo && consumo.topItems.length > 0 && (
            <div className="mb-3">
              <p className="text-xs font-medium text-ink-muted mb-1.5">Qué pide ({consumo.pedidos} pedidos)</p>
              <div className="flex flex-wrap gap-1.5">
                {consumo.topItems.map((it) => (
                  <span key={it.nombre} className="text-xs bg-brand-50 border border-brand-200 text-brand-800 rounded-full px-2.5 py-0.5">
                    {it.nombre} <span className="text-brand-500">×{it.cantidad}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          <p className="text-xs font-medium text-ink-muted mb-1.5">Historial de reservas</p>
          {reservas === null ? (
            <p className="text-xs text-ink-muted">Cargando…</p>
          ) : reservas.length === 0 ? (
            <p className="text-xs text-ink-muted">Sin reservas registradas.</p>
          ) : (
            <ul className="space-y-1">
              {reservas.slice(0, 10).map((r) => (
                <li key={r.id} className="text-xs flex items-center justify-between gap-2 py-1 border-b border-ink/5 last:border-0">
                  <span>{fechaCorta(r.fecha_hora)} · {r.personas}p</span>
                  <span className="text-ink-muted">{r.estado}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="pt-3 mt-1 border-t border-ink/5">
            <button onClick={onBorrar} className="text-xs text-red-600 hover:text-red-700 inline-flex items-center gap-1.5">
              <Trash2 className="h-3.5 w-3.5" /> Borrar comensal
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Mini({ label, valor }: { label: string; valor: string }) {
  return (
    <div className="rounded-lg bg-brand-50/60 p-2 text-center">
      <div className="text-base font-semibold text-ink truncate">{valor}</div>
      <div className="text-[11px] text-ink-muted">{label}</div>
    </div>
  );
}

function FormCliente({ onClose, onSave }: {
  onClose: () => void;
  onSave: (input: { nombre?: string; apellido?: string; telefono: string; email?: string; notas?: string; acepta_marketing?: boolean }) => void;
}) {
  const [nombre, setNombre] = useState('');
  const [apellido, setApellido] = useState('');
  const [telefono, setTelefono] = useState('');
  const [email, setEmail] = useState('');
  const [notas, setNotas] = useState('');
  const [marketing, setMarketing] = useState(true);
  const [guardando, setGuardando] = useState(false);

  async function submit() {
    if (!telefono.trim()) { toast.error('El teléfono es obligatorio'); return; }
    setGuardando(true);
    await onSave({
      nombre: nombre.trim() || undefined, apellido: apellido.trim() || undefined,
      telefono: telefono.trim(), email: email.trim() || undefined,
      notas: notas.trim() || undefined, acepta_marketing: marketing,
    });
    setGuardando(false);
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl shadow-card p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-display text-xl font-semibold">Nuevo comensal</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-ink/5 text-ink-soft"><X className="h-5 w-5" /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Nombre</label>
            <input value={nombre} onChange={(e) => setNombre(e.target.value)} autoFocus className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Apellido</label>
            <input value={apellido} onChange={(e) => setApellido(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-soft">Teléfono *</label>
          <input value={telefono} onChange={(e) => setTelefono(e.target.value)} inputMode="tel" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="+54 11 …" />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-soft">Email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-soft">Notas</label>
          <input value={notas} onChange={(e) => setNotas(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="Preferencias, alergias…" />
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} className="h-4 w-4" />
          Acepta recibir promociones
        </label>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 rounded-lg border border-ink/15 py-2.5 text-sm font-medium hover:bg-ink/5">Cancelar</button>
          <button onClick={() => void submit()} disabled={guardando}
                  className="flex-1 rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2.5 text-sm font-medium disabled:opacity-60">
            {guardando ? 'Guardando…' : 'Agregar'}
          </button>
        </div>
      </div>
    </div>
  );
}
