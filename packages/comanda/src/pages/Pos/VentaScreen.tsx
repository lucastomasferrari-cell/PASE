import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useAuthPos } from '../../lib/authPos';
import { listItems, type ItemConGrupo } from '../../services/itemsService';
import { listGrupos } from '../../services/gruposService';
import {
  getVenta, listVentasItems, agregarItem, modificarItem, mandarCurso,
} from '../../services/ventasService';
import { listMetodosCobroActivos } from '../../services/configService';
import { cobrar, newIdempotencyKey } from '../../services/pagosService';
import type { VentaPos, VentaPosItem, ItemGrupo, MetodoCobro } from '../../types/database';
import { Badge } from '../../components/Badge';
import { SearchInput } from '../../components/SearchInput';
import { Stepper } from '../../components/Stepper';
import { MoneyInput } from '../../components/MoneyInput';
import { formatARS, relativoCorto } from '../../lib/format';

// Pantalla principal de venta. Catálogo izq + check der.
// Sprint 2 simplificado: sin modifiers dialog, sin payment rico (1 solo método),
// sin coursing visual avanzado (botón "Mandar curso 1" directo).

export function VentaScreen() {
  const { ventaId: idStr } = useParams<{ ventaId: string }>();
  const ventaId = Number(idStr);
  const { user } = useAuth();
  const { empleado } = useAuthPos();
  const navigate = useNavigate();

  const [venta, setVenta] = useState<VentaPos | null>(null);
  const [items, setItems] = useState<VentaPosItem[]>([]);
  const [catalogo, setCatalogo] = useState<ItemConGrupo[]>([]);
  const [grupos, setGrupos] = useState<ItemGrupo[]>([]);
  const [grupoSel, setGrupoSel] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCobro, setShowCobro] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const [vRes, iRes, cRes, gRes] = await Promise.all([
      getVenta(ventaId),
      listVentasItems(ventaId),
      listItems({ tenantId: user?.tenant_id ?? null }),
      listGrupos(user?.tenant_id ?? null),
    ]);
    if (vRes.error) setError(vRes.error);
    setVenta(vRes.data);
    setItems(iRes.data);
    setCatalogo(cRes.data);
    setGrupos(gRes.data);
    setLoading(false);
  }, [ventaId, user?.tenant_id]);

  useEffect(() => { reload(); }, [reload]);

  const catalogoFiltrado = useMemo(() => {
    return catalogo.filter((it) => {
      if (it.estado !== 'disponible') return false;
      if (!it.visible_pos) return false;
      if (grupoSel !== null && it.grupo_id !== grupoSel) return false;
      if (search.trim() && !it.nombre.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [catalogo, grupoSel, search]);

  if (loading) return <div style={{ padding: 32, textAlign: 'center', color: '#6B7280' }}>Cargando…</div>;
  if (!venta) return <div style={{ padding: 32, textAlign: 'center', color: '#DC2626' }}>Venta no encontrada</div>;
  if (!empleado) return <div style={{ padding: 32, textAlign: 'center', color: '#6B7280' }}>Sesión POS requerida</div>;

  const editable = venta.estado !== 'cobrada' && venta.estado !== 'anulada';

  async function addItem(it: ItemConGrupo) {
    if (!editable) return;
    const { error: err } = await agregarItem({
      ventaId, itemId: it.id, cantidad: 1, curso: 1, cargadoPor: empleado!.id,
    });
    if (err) { setError(err); return; }
    reload();
  }

  async function changeQty(itemRow: VentaPosItem, qty: number) {
    if (qty <= 0) return;
    const { error: err } = await modificarItem(itemRow.id, { cantidad: qty });
    if (err) { setError(err); return; }
    reload();
  }

  async function mandar() {
    const { error: err } = await mandarCurso(ventaId, 1);
    if (err) { setError(err); return; }
    reload();
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 0, minHeight: 'calc(100vh - 50px)' }}>
      {/* CATÁLOGO IZQUIERDA */}
      <div style={{ padding: 16, overflowY: 'auto', borderRight: '1px solid #E5E7EB', background: '#FFFFFF' }}>
        <div style={{ marginBottom: 12 }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Buscar producto…" />
        </div>
        <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => setGrupoSel(null)}
            style={grupoSel === null ? tabActive : tab}>Todos</button>
          {grupos.map((g) => (
            <button key={g.id} type="button" onClick={() => setGrupoSel(g.id)}
              style={grupoSel === g.id ? tabActive : tab}>
              {g.emoji ?? ''} {g.nombre}
            </button>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
          {catalogoFiltrado.map((it) => (
            <button
              key={it.id} type="button" onClick={() => addItem(it)}
              disabled={!editable}
              style={tile}
            >
              <div style={{ fontSize: 28 }}>{it.emoji ?? '📦'}</div>
              <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{it.nombre}</div>
              <div style={{ fontSize: 12, color: '#059669', marginTop: 2 }}>{formatARS(it.precio_madre)}</div>
            </button>
          ))}
        </div>
      </div>

      {/* CHECK DERECHA */}
      <aside style={{ background: '#F9FAFB', borderLeft: '1px solid #E5E7EB', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 12, borderBottom: '1px solid #E5E7EB' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" onClick={() => navigate(-1)} style={btnSm}>← Volver</button>
            <strong>#{venta.numero_local}</strong>
            <Badge variant={estadoBadge(venta.estado)}>{venta.estado}</Badge>
          </div>
          <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>
            {venta.modo === 'salon' && venta.mesa_id && `Mesa · `}
            {venta.cliente_nombre ?? 'Sin cliente'} · abierta {relativoCorto(venta.abierta_at)}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          {items.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#9CA3AF', fontSize: 13 }}>
              Sin items todavía. Tocá productos del catálogo para agregar.
            </div>
          ) : (
            items.map((it) => (
              <CheckRow key={it.id} item={it} catalogo={catalogo}
                onQty={(n) => changeQty(it, n)} editable={editable} />
            ))
          )}
        </div>

        <div style={{ padding: 12, borderTop: '1px solid #E5E7EB', background: '#FFFFFF' }}>
          <Row label="Subtotal" value={formatARS(venta.subtotal)} />
          {venta.descuento_total > 0 && <Row label="Descuento" value={'−' + formatARS(venta.descuento_total)} />}
          {venta.propina > 0 && <Row label="Propina" value={formatARS(venta.propina)} />}
          <Row label="Total" value={formatARS(venta.total)} bold />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
            <button type="button" onClick={mandar} disabled={!editable}
              style={btnSecondary}>Mandar curso 1</button>
            <button type="button" onClick={() => setShowCobro(true)}
              disabled={!editable || venta.total <= 0} style={btnPrimary}>Cobrar</button>
          </div>
        </div>

        {error && <div style={{ ...errBox, margin: 12 }}>{error}</div>}
      </aside>

      {showCobro && (
        <CobroDialog
          venta={venta}
          empleadoId={empleado.id}
          onClose={() => setShowCobro(false)}
          onCobrado={() => {
            setShowCobro(false);
            reload();
            // Si es salón → volver al plano
            setTimeout(() => navigate(venta.modo === 'salon' ? '/pos/salon' : '/pos/mostrador'), 800);
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function CheckRow({ item, catalogo, onQty, editable }:
  { item: VentaPosItem; catalogo: ItemConGrupo[]; onQty: (n: number) => void; editable: boolean }) {
  const it = catalogo.find((c) => c.id === item.item_id);
  return (
    <div style={{ padding: 8, borderBottom: '1px solid #F3F4F6', display: 'flex', gap: 8, alignItems: 'flex-start', opacity: item.estado === 'anulado' ? 0.4 : 1 }}>
      <div style={{ fontSize: 16 }}>{it?.emoji ?? '📦'}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{it?.nombre ?? `Item #${item.item_id}`}</div>
        {item.notas && <div style={{ fontSize: 11, color: '#D97706', fontStyle: 'italic' }}>{item.notas}</div>}
        <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
          {formatARS(item.precio_unitario)} c/u · {item.estado}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        {editable && item.estado === 'hold' ? (
          <Stepper value={Number(item.cantidad)} onChange={onQty} min={0} max={99} />
        ) : (
          <span style={{ fontSize: 12 }}>x{item.cantidad}</span>
        )}
        <strong style={{ fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>{formatARS(item.subtotal)}</strong>
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: bold ? 16 : 13, fontWeight: bold ? 600 : 400 }}>
      <span style={{ color: bold ? '#111827' : '#6B7280' }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function estadoBadge(e: string): 'gray' | 'amber' | 'green' | 'red' | 'blue' {
  if (e === 'abierta') return 'gray';
  if (e === 'enviada') return 'amber';
  if (e === 'lista')   return 'blue';
  if (e === 'cobrada') return 'green';
  if (e === 'anulada') return 'red';
  return 'gray';
}

interface CobroProps {
  venta: VentaPos;
  empleadoId: string;
  onClose: () => void;
  onCobrado: () => void;
  onError: (msg: string) => void;
}

function CobroDialog({ venta, empleadoId, onClose, onCobrado, onError }: CobroProps) {
  const [metodos, setMetodos] = useState<MetodoCobro[]>([]);
  const [metodoSlug, setMetodoSlug] = useState<string>('efectivo');
  const [propina, setPropina] = useState(0);
  const [montoEntregado, setMontoEntregado] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listMetodosCobroActivos(venta.local_id).then((r) => {
      setMetodos(r.data);
      if (r.data.length > 0 && r.data[0]) setMetodoSlug(r.data[0].slug);
    });
  }, [venta.local_id]);

  const totalConPropina = Number(venta.subtotal) - Number(venta.descuento_total) + propina;
  const metodoSel = metodos.find((m) => m.slug === metodoSlug);
  const pideVuelto = metodoSel?.pide_vuelto ?? false;
  const vuelto = pideVuelto && montoEntregado >= totalConPropina ? montoEntregado - totalConPropina : 0;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const monto = totalConPropina;
    const pago = {
      metodo: metodoSlug,
      monto,
      idempotency_key: newIdempotencyKey(),
      vuelto: pideVuelto ? vuelto : null,
    };
    const { error: err } = await cobrar(venta.id, [pago], propina, empleadoId);
    setSaving(false);
    if (err) { onError(err); return; }
    onCobrado();
  }

  return (
    <div role="dialog" style={overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form onSubmit={onSubmit} style={modal}>
        <h3 style={{ margin: 0, fontSize: 18, marginBottom: 16 }}>Cobrar venta #{venta.numero_local}</h3>

        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #E5E7EB' }}>
          <span>Subtotal</span><strong>{formatARS(venta.subtotal)}</strong>
        </div>
        {venta.descuento_total > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
            <span>Descuento</span><span>−{formatARS(venta.descuento_total)}</span>
          </div>
        )}

        <label style={{ display: 'block', fontSize: 13, marginTop: 12, marginBottom: 12 }}>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>Propina</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {[0, 0.10, 0.15, 0.20].map((p) => {
              const monto = Math.round((Number(venta.subtotal) - Number(venta.descuento_total)) * p);
              const sel = Math.abs(propina - monto) < 0.01;
              return (
                <button key={p} type="button" onClick={() => setPropina(monto)}
                  style={{ ...chip, background: sel ? '#2563EB' : '#FFFFFF', color: sel ? '#FFFFFF' : '#374151' }}>
                  {p === 0 ? 'Sin' : `${p * 100}%`}
                </button>
              );
            })}
            <div style={{ flex: 1 }}>
              <MoneyInput value={propina} onChange={setPropina} />
            </div>
          </div>
        </label>

        <div style={{ padding: 8, background: '#F0F9FF', borderRadius: 6, marginBottom: 16, fontSize: 16, display: 'flex', justifyContent: 'space-between' }}>
          <strong>Total</strong>
          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{formatARS(totalConPropina)}</strong>
        </div>

        <label style={{ display: 'block', fontSize: 13, marginBottom: 16 }}>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>Método de cobro</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 6 }}>
            {metodos.map((m) => (
              <button key={m.id} type="button" onClick={() => setMetodoSlug(m.slug)}
                style={{
                  padding: 8, border: metodoSlug === m.slug ? '2px solid #2563EB' : '1px solid #D1D5DB',
                  borderRadius: 6, background: '#FFFFFF', cursor: 'pointer', fontSize: 13,
                }}>
                {m.emoji} {m.nombre}
              </button>
            ))}
          </div>
        </label>

        {pideVuelto && (
          <label style={{ display: 'block', fontSize: 13, marginBottom: 16 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>Monto entregado por el cliente</div>
            <MoneyInput value={montoEntregado} onChange={setMontoEntregado} />
            {vuelto > 0 && (
              <div style={{ marginTop: 6, padding: 8, background: '#FEF3C7', borderRadius: 6, fontSize: 14 }}>
                Vuelto: <strong>{formatARS(vuelto)}</strong>
              </div>
            )}
          </label>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={btnSecondary} disabled={saving}>Cancelar</button>
          <button type="submit" disabled={saving} style={btnPrimary}>
            {saving ? 'Cobrando…' : `Cobrar ${formatARS(totalConPropina)}`}
          </button>
        </div>
      </form>
    </div>
  );
}

const tab: React.CSSProperties = { padding: '4px 10px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, color: '#6B7280', borderRadius: 6 };
const tabActive: React.CSSProperties = { ...tab, background: '#EEF2FF', color: '#1E40AF', fontWeight: 600 };
const tile: React.CSSProperties = { padding: 8, border: '1px solid #E5E7EB', borderRadius: 8, background: '#FFFFFF', cursor: 'pointer', textAlign: 'center', minHeight: 100, fontFamily: 'inherit' };
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const modal: React.CSSProperties = { background: '#FFFFFF', borderRadius: 8, padding: 24, maxWidth: 480, width: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' };
const btnPrimary: React.CSSProperties = { padding: '10px 16px', border: 'none', borderRadius: 6, background: '#10B981', color: '#FFFFFF', cursor: 'pointer', fontSize: 14, fontWeight: 500 };
const btnSecondary: React.CSSProperties = { padding: '6px 14px', border: '1px solid #D1D5DB', borderRadius: 6, background: '#FFFFFF', cursor: 'pointer', fontSize: 14 };
const btnSm: React.CSSProperties = { padding: '4px 10px', border: '1px solid #D1D5DB', borderRadius: 4, background: '#FFFFFF', cursor: 'pointer', fontSize: 12 };
const chip: React.CSSProperties = { padding: '6px 10px', border: '1px solid #D1D5DB', borderRadius: 999, cursor: 'pointer', fontSize: 12 };
const errBox: React.CSSProperties = { padding: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, fontSize: 13 };
