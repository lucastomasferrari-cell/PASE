import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useAuthPos } from '../../lib/authPos';
import { useLocalActivo } from '../../lib/localActivo';
import { listMesasConVentas, type MesaConVenta } from '../../services/mesasService';
import { abrirVenta } from '../../services/ventasService';
import { listCanales } from '../../services/canalesService';
import { Stepper } from '../../components/Stepper';
import { formatARS, relativoCorto } from '../../lib/format';

export function SalonView() {
  const { user } = useAuth();
  const { empleado } = useAuthPos();
  const [localId] = useLocalActivo(user);
  const navigate = useNavigate();

  const [mesas, setMesas] = useState<MesaConVenta[]>([]);
  const [zona, setZona] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [abrirDialog, setAbrirDialog] = useState<MesaConVenta | null>(null);

  const reload = useCallback(async () => {
    if (localId === null) return;
    setLoading(true);
    const { data, error: err } = await listMesasConVentas(localId);
    if (err) setError(err);
    setMesas(data);
    setLoading(false);
  }, [localId]);

  useEffect(() => { reload(); }, [reload]);

  const zonas = useMemo(() => {
    const set = new Set<string>();
    for (const m of mesas) if (m.zona) set.add(m.zona);
    return Array.from(set).sort();
  }, [mesas]);

  const mesasFiltradas = useMemo(() => {
    if (zona === null) return mesas;
    return mesas.filter((m) => m.zona === zona);
  }, [mesas, zona]);

  if (loading) return <div style={{ padding: 32, textAlign: 'center', color: '#6B7280' }}>Cargando mesas…</div>;
  if (!empleado) return <div style={{ padding: 32, textAlign: 'center', color: '#6B7280' }}>Sesión POS requerida.</div>;

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '20px 16px' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Salón</h2>
        <nav style={{ display: 'flex', gap: 4 }}>
          <button type="button" onClick={() => setZona(null)} style={zona === null ? tabActive : tab}>
            Todas ({mesas.length})
          </button>
          {zonas.map((z) => (
            <button key={z} type="button" onClick={() => setZona(z)} style={zona === z ? tabActive : tab}>
              {z}
            </button>
          ))}
        </nav>
      </header>

      {error && <div style={errBox}>{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
        {mesasFiltradas.map((m) => (
          <MesaTile
            key={m.id}
            mesa={m}
            onClick={() => {
              if (m.estado === 'libre') setAbrirDialog(m);
              else if (m.venta_abierta_id) navigate(`/pos/venta/${m.venta_abierta_id}`);
            }}
          />
        ))}
      </div>

      {abrirDialog && (
        <AbrirMesaDialog
          mesa={abrirDialog}
          empleadoId={empleado.id}
          localId={localId!}
          onClose={() => setAbrirDialog(null)}
          onAbierta={(ventaId) => {
            setAbrirDialog(null);
            navigate(`/pos/venta/${ventaId}`);
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function MesaTile({ mesa, onClick }: { mesa: MesaConVenta; onClick: () => void }) {
  const colors = mesaColors(mesa.estado);
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: 12,
        border: `2px solid ${colors.border}`,
        borderRadius: mesa.forma === 'redondo' ? '50%' : mesa.forma === 'rectangular' ? 8 : 12,
        background: colors.bg,
        cursor: 'pointer',
        minHeight: 100,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        textAlign: 'center',
        fontFamily: 'system-ui',
      }}
    >
      <div style={{ fontSize: 24, fontWeight: 700, color: colors.fg }}>{mesa.numero}</div>
      {mesa.zona && <div style={{ fontSize: 10, color: colors.fg, opacity: 0.7 }}>{mesa.zona}</div>}
      {mesa.venta_abierta_id !== null && (
        <>
          <div style={{ fontSize: 13, marginTop: 4, color: colors.fg, fontWeight: 600 }}>
            {formatARS(mesa.venta_total)}
          </div>
          {mesa.venta_abierta_at && (
            <div style={{ fontSize: 10, color: colors.fg, opacity: 0.7 }}>
              {relativoCorto(mesa.venta_abierta_at)}
            </div>
          )}
        </>
      )}
    </button>
  );
}

function mesaColors(estado: string): { bg: string; fg: string; border: string } {
  if (estado === 'libre')    return { bg: '#D1FAE5', fg: '#065F46', border: '#6EE7B7' };
  if (estado === 'ocupada')  return { bg: '#FEF3C7', fg: '#92400E', border: '#FCD34D' };
  if (estado === 'hold')     return { bg: '#FEE2E2', fg: '#991B1B', border: '#FCA5A5' };
  return                          { bg: '#F3F4F6', fg: '#6B7280', border: '#D1D5DB' };
}

interface AbrirDialogProps {
  mesa: MesaConVenta;
  empleadoId: string;
  localId: number;
  onClose: () => void;
  onAbierta: (ventaId: number) => void;
  onError: (msg: string) => void;
}

function AbrirMesaDialog({ mesa, empleadoId, localId, onClose, onAbierta, onError }: AbrirDialogProps) {
  const [covers, setCovers] = useState(mesa.capacidad ?? 2);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    // Resolver canal: para Salón usamos el canal slug='salon' del tenant del local
    const { data: canales } = await listCanales(null, true);
    const canal = canales.find((c) => c.slug === 'salon');
    if (!canal) { onError('No hay canal "salon" configurado'); setSaving(false); return; }

    const { ventaId, error } = await abrirVenta({
      localId, modo: 'salon', canalId: canal.id,
      mesaId: mesa.id, mozoId: empleadoId, cajeroId: empleadoId,
      covers,
    });
    setSaving(false);
    if (error || !ventaId) { onError(error ?? 'No se pudo abrir'); return; }
    onAbierta(ventaId);
  }

  return (
    <div role="dialog" style={overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form onSubmit={onSubmit} style={modal}>
        <h3 style={{ margin: 0, fontSize: 18 }}>Abrir mesa {mesa.numero}</h3>
        <p style={{ margin: '4px 0 16px', fontSize: 13, color: '#6B7280' }}>{mesa.zona}</p>

        <label style={{ display: 'block', fontSize: 13, marginBottom: 16 }}>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>Cantidad de personas</div>
          <Stepper value={covers} onChange={setCovers} min={1} max={20} />
        </label>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={btnSecondary} disabled={saving}>Cancelar</button>
          <button type="submit" disabled={saving} style={btnPrimary}>
            {saving ? 'Abriendo…' : 'Abrir mesa'}
          </button>
        </div>
      </form>
    </div>
  );
}

const tab: React.CSSProperties = { padding: '6px 12px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, color: '#6B7280', borderRadius: 6 };
const tabActive: React.CSSProperties = { ...tab, background: '#EEF2FF', color: '#1E40AF', fontWeight: 600 };
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const modal: React.CSSProperties = { background: '#FFFFFF', borderRadius: 8, padding: 24, maxWidth: 360, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' };
const btnPrimary: React.CSSProperties = { padding: '8px 16px', border: 'none', borderRadius: 6, background: '#10B981', color: '#FFFFFF', cursor: 'pointer', fontSize: 14, fontWeight: 500 };
const btnSecondary: React.CSSProperties = { padding: '6px 14px', border: '1px solid #D1D5DB', borderRadius: 6, background: '#FFFFFF', cursor: 'pointer', fontSize: 14 };
const errBox: React.CSSProperties = { padding: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, fontSize: 13, marginBottom: 12 };
