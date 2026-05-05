import { useEffect, useMemo, useState, useCallback } from 'react';
import { Link2, Pencil, TrendingUp } from 'lucide-react';
import type { Usuario } from '../../types/auth';
import type { Canal, ItemGrupo, ItemPrecioCanal, Item } from '../../types/database';
import { listItems } from '../../services/itemsService';
import { listGrupos } from '../../services/gruposService';
import { listCanales } from '../../services/canalesService';
import { listPreciosPorTenant, setPrecioCelda } from '../../services/preciosService';
import { tienePermiso } from '../../lib/auth';
import { formatARS, parseARS, relativoCorto } from '../../lib/format';
import { SearchInput } from '../../components/SearchInput';
import { AumentoMasivoDialog } from './AumentoMasivoDialog';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface Props { user: Usuario }

export function ListaPreciosTab({ user }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [grupos, setGrupos] = useState<ItemGrupo[]>([]);
  const [canales, setCanales] = useState<Canal[]>([]);
  const [precios, setPrecios] = useState<ItemPrecioCanal[]>([]);
  const [search, setSearch] = useState('');
  const [grupoFilter, setGrupoFilter] = useState<string>('todos');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAumento, setShowAumento] = useState(false);
  const [lastChange, setLastChange] = useState<string | null>(null);

  const puedeEditar = tienePermiso(user, 'comanda.precios.editar');
  const puedeAumento = tienePermiso(user, 'comanda.precios.aumento_masivo');

  const reload = useCallback(async () => {
    setLoading(true);
    const [itRes, grRes, caRes, prRes] = await Promise.all([
      listItems({ tenantId: user.tenant_id }),
      listGrupos(user.tenant_id),
      listCanales(user.tenant_id, true),
      listPreciosPorTenant(user.tenant_id),
    ]);
    if (itRes.error) setError(itRes.error);
    setItems(itRes.data);
    setGrupos(grRes.data);
    setCanales(caRes.data);
    setPrecios(prRes.data);
    setLoading(false);
  }, [user.tenant_id]);

  useEffect(() => { reload(); }, [reload]);

  const itemsFiltrados = useMemo(() => {
    const grupoIdNum = grupoFilter === 'todos' ? null : Number(grupoFilter);
    return items.filter((i) => {
      if (grupoIdNum !== null && i.grupo_id !== grupoIdNum) return false;
      if (search.trim() && !i.nombre.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [items, search, grupoFilter]);

  const precioMap = useMemo(() => {
    const m = new Map<string, ItemPrecioCanal>();
    for (const p of precios) m.set(`${p.item_id}-${p.canal_id}`, p);
    return m;
  }, [precios]);

  function precioEfectivo(item: Item, canal: Canal): { valor: number; manual: boolean; existe: boolean } {
    const ipc = precioMap.get(`${item.id}-${canal.id}`);
    if (ipc) return { valor: Number(ipc.precio), manual: ipc.edicion_manual, existe: true };
    const ajustado = Number(item.precio_madre) * (1 + Number(canal.ajuste_madre_pct) / 100);
    const redondeado = Math.round(ajustado / canal.redondeo_a) * canal.redondeo_a;
    return { valor: redondeado, manual: false, existe: false };
  }

  return (
    <div>
      <div className="flex gap-3 items-center flex-wrap mb-4">
        <div className="flex-1 min-w-[240px]">
          <SearchInput value={search} onChange={setSearch} placeholder="Buscar item…" />
        </div>
        <Select value={grupoFilter} onValueChange={setGrupoFilter}>
          <SelectTrigger className="w-[200px] h-11">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos los grupos</SelectItem>
            {grupos.map((g) => (
              <SelectItem key={g.id} value={String(g.id)}>{g.emoji ?? ''} {g.nombre}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex-1 text-xs text-muted-foreground text-right">
          {itemsFiltrados.length} items
          {lastChange && <> · última modificación {relativoCorto(lastChange)}</>}
        </div>
        {puedeAumento && (
          <Button size="lg" onClick={() => setShowAumento(true)}>
            <TrendingUp className="h-5 w-5" />
            Aumento masivo
          </Button>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      <Card className="overflow-auto max-h-[70vh]">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-[1] bg-muted/40">
            <tr>
              <th className="text-left px-3 py-2 sticky left-0 z-[2] bg-muted/40 min-w-[180px] font-semibold text-xs uppercase tracking-wide text-muted-foreground border-b border-border">
                Item
              </th>
              <th className="text-right px-3 py-2 min-w-[120px] font-semibold text-xs uppercase tracking-wide text-primary bg-primary/5 border-l-2 border-primary/30 border-b border-border">
                <div className="flex items-center justify-end gap-1">
                  <Link2 className="h-3 w-3" />
                  Madre
                </div>
              </th>
              {canales.map((c) => (
                <th key={c.id} className="text-right px-3 py-2 min-w-[110px] font-semibold text-xs text-muted-foreground border-b border-border">
                  <div className="text-foreground">{c.emoji ?? ''} {c.nombre}</div>
                  <div className="text-[10px] font-normal text-muted-foreground">
                    {c.atado_madre ? (
                      <>
                        <Link2 className="h-2.5 w-2.5 inline mr-0.5" />
                        {c.ajuste_madre_pct >= 0 ? '+' : ''}{Number(c.ajuste_madre_pct)}%
                      </>
                    ) : (
                      <>
                        <Pencil className="h-2.5 w-2.5 inline mr-0.5" />
                        Indep
                      </>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={2 + canales.length} className="py-12 text-center text-muted-foreground">
                  Cargando…
                </td>
              </tr>
            )}
            {!loading && itemsFiltrados.length === 0 && (
              <tr>
                <td colSpan={2 + canales.length} className="py-12 text-center text-muted-foreground">
                  Sin items.
                </td>
              </tr>
            )}
            {itemsFiltrados.map((it) => (
              <tr key={it.id} className="border-t border-border">
                <td className="px-3 py-2 sticky left-0 z-[1] bg-card">
                  <span className="mr-1">{it.emoji ?? '📦'}</span>
                  {it.nombre}
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold bg-primary/5 border-l-2 border-primary/30">
                  {formatARS(it.precio_madre)}
                </td>
                {canales.map((c) => {
                  const ef = precioEfectivo(it, c);
                  return (
                    <PrecioCell
                      key={c.id}
                      item={it}
                      canal={c}
                      precio={ef.valor}
                      manual={ef.manual}
                      editable={puedeEditar}
                      onSaved={() => { setLastChange(new Date().toISOString()); reload(); }}
                      tenantId={user.tenant_id}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="mt-3 text-xs text-muted-foreground flex items-center gap-3 flex-wrap">
        <span className="inline-flex items-center gap-1">
          <Link2 className="h-3 w-3" /> atado al madre
        </span>
        <span>·</span>
        <span className="inline-flex items-center gap-1">
          <Pencil className="h-3 w-3 text-warning" /> editado a mano (sigue atado, próximo aumento masivo lo pisa)
        </span>
      </div>

      {showAumento && (
        <AumentoMasivoDialog
          user={user}
          grupos={grupos}
          totalItems={items.length}
          onClose={() => setShowAumento(false)}
          onDone={(r) => {
            setShowAumento(false);
            setLastChange(new Date().toISOString());
            reload();
            setError(null);
            alert(`Aumento aplicado: ${r.itemsAfectados} items, ${r.preciosRecalculados} precios recalculados.`);
          }}
        />
      )}
    </div>
  );
}

interface CellProps {
  item: Item;
  canal: Canal;
  precio: number;
  manual: boolean;
  editable: boolean;
  tenantId: string | null;
  onSaved: () => void;
}

function PrecioCell({ item, canal, precio, manual, editable, tenantId, onSaved }: CellProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(formatARS(precio));
  const [saving, setSaving] = useState(false);

  async function commit() {
    const n = parseARS(text);
    if (Number.isNaN(n) || n < 0) { setText(formatARS(precio)); setEditing(false); return; }
    if (!tenantId) { setEditing(false); return; }
    setSaving(true);
    const { error: err } = await setPrecioCelda(item.id, canal.id, n, tenantId, item.local_id);
    setSaving(false);
    setEditing(false);
    if (err) { alert(err); return; }
    onSaved();
  }

  if (editing) {
    return (
      <td className="px-2 py-1 bg-warning/10">
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') { setText(formatARS(precio)); setEditing(false); }
          }}
          className="w-full px-1 py-1 border border-warning rounded bg-background text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-warning"
        />
      </td>
    );
  }

  const isEdited = manual;
  return (
    <td
      className={cn(
        'px-3 py-2 text-right tabular-nums text-sm',
        isEdited ? 'bg-success/10 border border-success/30' : 'bg-muted/30',
        editable ? 'cursor-pointer' : 'cursor-default',
      )}
      onClick={() => editable && setEditing(true)}
      title={isEdited ? `${formatARS(precio)} · manual` : `${formatARS(precio)} · atado`}
    >
      {saving ? '…' : formatARS(precio)}
      <div className="text-[9px] mt-0.5 inline-flex items-center justify-end w-full gap-0.5">
        {isEdited ? (
          <>
            <Pencil className="h-2.5 w-2.5 text-success" />
            <span className="text-success">manual</span>
          </>
        ) : (
          <>
            <Link2 className="h-2.5 w-2.5 text-muted-foreground" />
            <span className="text-muted-foreground">atado</span>
          </>
        )}
      </div>
    </td>
  );
}
