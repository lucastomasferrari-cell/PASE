import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Send, CreditCard, Package } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

// Pantalla principal de venta. Catálogo izq + check der.
// Sprint 2 simplificado: sin modifiers dialog, sin payment rico (1 solo método),
// sin coursing visual avanzado (botón "Mandar curso 1" directo).
// Refactor de layout queda para Sprint 3 (split-screen 60/40 con tooltip, etc).

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

  if (loading) {
    return <div className="py-12 text-center text-muted-foreground">Cargando…</div>;
  }
  if (!venta) {
    return <div className="py-12 text-center text-destructive">Venta no encontrada</div>;
  }
  if (!empleado) {
    return <div className="py-12 text-center text-muted-foreground">Sesión POS requerida</div>;
  }

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
    <div className="grid grid-cols-[1fr_380px] min-h-[calc(100vh-60px)]">
      {/* CATÁLOGO IZQUIERDA */}
      <div className="p-4 overflow-y-auto border-r border-border bg-card">
        <div className="mb-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Buscar producto…" />
        </div>
        <div className="flex gap-1 mb-3 flex-wrap">
          <GrupoTab active={grupoSel === null} onClick={() => setGrupoSel(null)}>Todos</GrupoTab>
          {grupos.map((g) => (
            <GrupoTab key={g.id} active={grupoSel === g.id} onClick={() => setGrupoSel(g.id)}>
              {g.emoji ?? ''} {g.nombre}
            </GrupoTab>
          ))}
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
          {catalogoFiltrado.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => addItem(it)}
              disabled={!editable}
              className={cn(
                'p-2 border border-border rounded-lg bg-background text-center min-h-[100px]',
                'transition-colors hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed',
                'flex flex-col items-center justify-center',
              )}
            >
              <div className="text-3xl">{it.emoji ?? <Package className="h-7 w-7 text-muted-foreground" />}</div>
              <div className="text-sm font-semibold mt-1 line-clamp-2">{it.nombre}</div>
              <div className="text-xs text-success mt-0.5 tabular-nums">{formatARS(it.precio_madre)}</div>
            </button>
          ))}
        </div>
      </div>

      {/* CHECK DERECHA */}
      <aside className="bg-muted/40 border-l border-border flex flex-col">
        <div className="p-3 border-b border-border bg-card">
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Volver
            </Button>
            <strong className="text-base">#{venta.numero_local}</strong>
            <Badge variant={estadoBadge(venta.estado)}>{venta.estado}</Badge>
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {venta.modo === 'salon' && venta.mesa_id && 'Mesa · '}
            {venta.cliente_nombre ?? 'Sin cliente'} · abierta {relativoCorto(venta.abierta_at)}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {items.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground text-sm">
              Sin items todavía. Tocá productos del catálogo para agregar.
            </div>
          ) : (
            items.map((it) => (
              <CheckRow
                key={it.id}
                item={it}
                catalogo={catalogo}
                onQty={(n) => changeQty(it, n)}
                editable={editable}
              />
            ))
          )}
        </div>

        <div className="p-3 border-t border-border bg-card">
          <Row label="Subtotal" value={formatARS(venta.subtotal)} />
          {venta.descuento_total > 0 && (
            <Row label="Descuento" value={'−' + formatARS(venta.descuento_total)} />
          )}
          {venta.propina > 0 && <Row label="Propina" value={formatARS(venta.propina)} />}
          <Row label="Total" value={formatARS(venta.total)} bold />

          <div className="grid grid-cols-2 gap-2 mt-3">
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={mandar}
              disabled={!editable}
            >
              <Send className="h-4 w-4 mr-2" />
              Mandar
            </Button>
            <Button
              type="button"
              variant="success"
              size="lg"
              onClick={() => setShowCobro(true)}
              disabled={!editable || venta.total <= 0}
            >
              <CreditCard className="h-4 w-4 mr-2" />
              Cobrar
            </Button>
          </div>
        </div>

        {error && (
          <div className="m-3 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
            {error}
          </div>
        )}
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

function GrupoTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 h-9 rounded-md text-xs font-medium transition-colors',
        active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {children}
    </button>
  );
}

function CheckRow({ item, catalogo, onQty, editable }:
  { item: VentaPosItem; catalogo: ItemConGrupo[]; onQty: (n: number) => void; editable: boolean }) {
  const it = catalogo.find((c) => c.id === item.item_id);
  return (
    <div
      className={cn(
        'p-2 border-b border-border flex gap-2 items-start',
        item.estado === 'anulado' && 'opacity-40',
      )}
    >
      <div className="text-base">{it?.emoji ?? '📦'}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{it?.nombre ?? `Item #${item.item_id}`}</div>
        {item.notas && (
          <div className="text-xs text-warning italic">{item.notas}</div>
        )}
        <div className="text-xs text-muted-foreground mt-0.5">
          {formatARS(item.precio_unitario)} c/u · {item.estado}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">
        {editable && item.estado === 'hold' ? (
          <Stepper value={Number(item.cantidad)} onChange={onQty} min={0} max={99} />
        ) : (
          <span className="text-xs">x{item.cantidad}</span>
        )}
        <strong className="text-sm tabular-nums">{formatARS(item.subtotal)}</strong>
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div
      className={cn(
        'flex justify-between py-1',
        bold ? 'text-base font-semibold text-foreground' : 'text-sm font-normal text-muted-foreground',
      )}
    >
      <span>{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function estadoBadge(e: string): 'gray' | 'amber' | 'green' | 'red' | 'blue' {
  if (e === 'abierta') return 'gray';
  if (e === 'enviada') return 'amber';
  if (e === 'lista') return 'blue';
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

  const propinaPcts = [0, 0.10, 0.15, 0.20];

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cobrar venta #{venta.numero_local}</DialogTitle>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1 text-sm">
            <div className="flex justify-between py-1 border-b border-border">
              <span className="text-muted-foreground">Subtotal</span>
              <strong className="tabular-nums">{formatARS(venta.subtotal)}</strong>
            </div>
            {venta.descuento_total > 0 && (
              <div className="flex justify-between py-1">
                <span className="text-muted-foreground">Descuento</span>
                <span className="tabular-nums">−{formatARS(venta.descuento_total)}</span>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>Propina</Label>
            <div className="flex gap-2 items-center flex-wrap">
              {propinaPcts.map((p) => {
                const monto = Math.round((Number(venta.subtotal) - Number(venta.descuento_total)) * p);
                const sel = Math.abs(propina - monto) < 0.01;
                return (
                  <Button
                    key={p}
                    type="button"
                    variant={sel ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setPropina(monto)}
                    className="rounded-full"
                  >
                    {p === 0 ? 'Sin' : `${p * 100}%`}
                  </Button>
                );
              })}
              <div className="flex-1 min-w-[100px]">
                <MoneyInput value={propina} onChange={setPropina} />
              </div>
            </div>
          </div>

          <div className="p-3 rounded-md bg-primary/10 flex justify-between items-center text-base">
            <strong>Total</strong>
            <strong className="tabular-nums text-lg">{formatARS(totalConPropina)}</strong>
          </div>

          <div className="space-y-2">
            <Label>Método de cobro</Label>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))] gap-2">
              {metodos.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMetodoSlug(m.slug)}
                  className={cn(
                    'p-2 rounded-md text-sm border transition-colors h-11',
                    metodoSlug === m.slug
                      ? 'border-primary border-2 bg-primary/5'
                      : 'border-input bg-background hover:bg-accent',
                  )}
                >
                  {m.emoji} {m.nombre}
                </button>
              ))}
            </div>
          </div>

          {pideVuelto && (
            <div className="space-y-2">
              <Label>Monto entregado por el cliente</Label>
              <MoneyInput value={montoEntregado} onChange={setMontoEntregado} />
              {vuelto > 0 && (
                <div className="p-2 rounded-md bg-warning/10 text-warning text-sm border border-warning/30">
                  Vuelto: <strong className="tabular-nums">{formatARS(vuelto)}</strong>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button type="submit" variant="success" disabled={saving}>
              {saving ? 'Cobrando…' : `Cobrar ${formatARS(totalConPropina)}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
