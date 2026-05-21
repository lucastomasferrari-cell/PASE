// MermasOneTap — pantalla "one-tap" para cargar mermas rápido.
//
// Visión PASE original: "El cocinero toca el ítem, pone la cantidad y
// selecciona el motivo".
//
// Flujo:
//   1. Vista principal: cards grandes con los motivos del catálogo
//      (agrupados por tipo: merma / donación / ajuste / robo).
//   2. Click en motivo → modal con:
//      - Top 10 insumos más mermados (chips clickeables, atajo)
//      - Dropdown completo de insumos del local
//      - Input cantidad (en unidad del insumo elegido)
//      - Input notas (opcional)
//      - Si tipo='robo' → input código manager (TOTP)
//   3. Confirmar → RPC fn_registrar_merma + toast OK + reset.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Trash2, AlertTriangle, Heart, Pencil, X, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { formatARS } from '@/lib/format';
import {
  listMotivos, listTop10Mermados, registrarMerma, precheckManagerCode,
  type MermaMotivo, type MermaTopInsumo,
} from '@/services/mermasService';
import { listInsumos } from '@/services/insumosService';
import type { Insumo } from '@/types/database';

// Agrupación visual de motivos por tipo
const TIPO_GROUPS = [
  { tipo: 'merma',          label: 'Merma',         icon: Trash2,         color: 'text-amber-700 bg-amber-50 border-amber-200' },
  { tipo: 'donacion',       label: 'Donación',      icon: Heart,          color: 'text-purple-700 bg-purple-50 border-purple-200' },
  { tipo: 'salida_ajuste',  label: 'Ajuste',        icon: Pencil,         color: 'text-gray-700 bg-gray-50 border-gray-200' },
  { tipo: 'robo',           label: 'Robo',          icon: AlertTriangle,  color: 'text-red-700 bg-red-50 border-red-200' },
] as const;

export function MermasOneTap() {
  const { user } = useAuth();
  const [localActivo] = useLocalActivo(user);
  const [motivos, setMotivos] = useState<MermaMotivo[]>([]);
  const [top10, setTop10] = useState<MermaTopInsumo[]>([]);
  const [insumos, setInsumos] = useState<Insumo[]>([]);
  const [loading, setLoading] = useState(true);
  const [motivoActivo, setMotivoActivo] = useState<MermaMotivo | null>(null);

  const reload = useCallback(async () => {
    if (!localActivo) return;
    setLoading(true);
    const [m, t, i] = await Promise.all([
      listMotivos(),
      listTop10Mermados(localActivo),
      listInsumos({ localId: localActivo, onlyActivos: true }),
    ]);
    if (m.error) toast.error(m.error);
    else setMotivos(m.data);
    if (!t.error) setTop10(t.data);
    if (!i.error) setInsumos(i.data);
    setLoading(false);
  }, [localActivo]);

  useEffect(() => { void reload(); }, [reload]);

  // Agrupar motivos por tipo
  const motivosPorTipo = TIPO_GROUPS.map(g => ({
    ...g,
    motivos: motivos.filter(m => m.tipo_movimiento === g.tipo),
  }));

  if (loading) return <div className="p-12 text-center text-foreground/60">Cargando…</div>;

  if (!localActivo) {
    return (
      <div className="p-12 text-center">
        <p className="text-foreground/60">Elegí un local activo para cargar mermas.</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-medium flex items-center gap-2">
          <Trash2 className="h-6 w-6" />
          Cargar merma
        </h1>
        <p className="text-sm text-foreground/60 mt-1">
          Tocá el motivo, después elegís el insumo y la cantidad.
          Esto limpia el stock real para que el CMV sea verdad.
        </p>
      </div>

      {/* ─── Top 10 mermados (atajo) ─── */}
      {top10.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-foreground/70 mb-2">
            🏆 Top 10 más mermados (últimos 30 días)
          </h2>
          <div className="flex flex-wrap gap-2">
            {top10.map(t => (
              <button
                key={t.insumo_id}
                className="px-3 py-1.5 rounded-full text-xs border border-gray-200 bg-white hover:bg-gray-50 hover:border-amber-300 transition-colors"
                title={`${t.veces_mermado} mermas · ${formatARS(Number(t.valor_total))} en 30d · última: ${new Date(t.ultima_merma).toLocaleDateString('es-AR')}`}
              >
                <span className="font-medium">{t.insumo_nombre}</span>
                <span className="text-foreground/40 ml-1.5">×{t.veces_mermado}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ─── Cards de motivos agrupados por tipo ─── */}
      <div className="space-y-6">
        {motivosPorTipo.map(g => {
          if (g.motivos.length === 0) return null;
          return (
            <div key={g.tipo}>
              <h2 className="text-sm font-medium text-foreground/70 mb-2 flex items-center gap-1.5">
                <g.icon className="h-4 w-4" />
                {g.label}
                {g.tipo === 'robo' && (
                  <span className="text-xs text-red-600 font-normal">(requiere manager)</span>
                )}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                {g.motivos.map(m => (
                  <button
                    key={m.id}
                    onClick={() => setMotivoActivo(m)}
                    className={`p-4 rounded-xl border-2 ${g.color} hover:scale-[1.02] transition-transform text-left`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="text-3xl shrink-0">{m.emoji || '📋'}</div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">{m.nombre}</div>
                        {m.descripcion && (
                          <div className="text-xs opacity-70 mt-0.5 line-clamp-2">{m.descripcion}</div>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* ─── Dialog de carga ─── */}
      {motivoActivo && (
        <MermaDialog
          motivo={motivoActivo}
          insumos={insumos}
          top10={top10}
          localActivo={localActivo}
          onClose={() => setMotivoActivo(null)}
          onSuccess={() => {
            setMotivoActivo(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

// ─── Dialog ──────────────────────────────────────────────────────────

function MermaDialog({
  motivo, insumos, top10, localActivo, onClose, onSuccess,
}: {
  motivo: MermaMotivo;
  insumos: Insumo[];
  top10: MermaTopInsumo[];
  localActivo: number;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [insumoId, setInsumoId] = useState<number | null>(null);
  const [cantidad, setCantidad] = useState('');
  const [notas, setNotas] = useState('');
  const [managerCode, setManagerCode] = useState('');  // TOTP cuando robo
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);

  const insumoSel = insumos.find(i => i.id === insumoId);
  const esRobo = motivo.tipo_movimiento === 'robo';

  const insumosFiltrados = insumos.filter(i =>
    !search || i.nombre.toLowerCase().includes(search.toLowerCase())
  );

  async function handleSubmit() {
    if (!insumoId) { toast.error('Elegí el insumo'); return; }
    const cant = parseFloat(cantidad);
    if (!Number.isFinite(cant) || cant <= 0) { toast.error('Cantidad inválida'); return; }

    let overrideCode: string | undefined;

    // Si es robo: pre-validar código TOTP antes de gastarlo
    if (esRobo) {
      const code = managerCode.trim();
      if (!/^\d{6}$/.test(code)) {
        toast.error('El código del manager debe ser de 6 dígitos');
        return;
      }
      // Precheck no consume el código — útil para feedback rápido. Si pasa,
      // se manda a la RPC final que SÍ lo consume (anti-reuse).
      const { ok, error: pcErr } = await precheckManagerCode(code);
      if (!ok) {
        toast.error(pcErr || 'Código inválido');
        return;
      }
      overrideCode = code;
    }

    setSaving(true);
    const { error } = await registrarMerma({
      insumoId,
      localId: localActivo,
      cantidad: cant,
      motivoId: motivo.id,
      notas: notas.trim() || undefined,
      overrideCode,
    });
    setSaving(false);

    if (error) { toast.error(error); return; }

    toast.success(`${motivo.nombre} cargada: ${cant} ${insumoSel?.unidad ?? ''} de ${insumoSel?.nombre}`);
    onSuccess();
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <Card
        className="w-full sm:max-w-lg max-h-[90vh] overflow-auto rounded-t-2xl sm:rounded-2xl"
        onClick={e => e.stopPropagation()}
      >
        <CardContent className="p-5 space-y-4">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3">
              <div className="text-3xl">{motivo.emoji || '📋'}</div>
              <div>
                <h3 className="text-lg font-medium">{motivo.nombre}</h3>
                {motivo.descripcion && (
                  <p className="text-xs text-foreground/60 mt-0.5">{motivo.descripcion}</p>
                )}
              </div>
            </div>
            <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Top 10 atajo (solo si no eligió todavía) */}
          {!insumoId && top10.length > 0 && (
            <div>
              <Label className="text-xs text-foreground/60">Insumos más mermados</Label>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {top10.slice(0, 8).map(t => (
                  <button
                    key={t.insumo_id}
                    onClick={() => setInsumoId(t.insumo_id)}
                    className="px-2.5 py-1 rounded-full text-xs border border-gray-200 bg-white hover:bg-amber-50 hover:border-amber-300 transition-colors"
                  >
                    {t.insumo_nombre}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Búsqueda + lista de insumos */}
          {!insumoId ? (
            <div>
              <Label htmlFor="search-insumo">Buscar insumo</Label>
              <div className="relative mt-1">
                <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground/40" />
                <Input
                  id="search-insumo"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Ej: salmón, papa, vino..."
                  className="pl-8"
                  autoFocus
                />
              </div>
              <div className="mt-2 max-h-56 overflow-auto border rounded-lg divide-y">
                {insumosFiltrados.slice(0, 50).map(i => (
                  <button
                    key={i.id}
                    onClick={() => setInsumoId(i.id)}
                    className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center justify-between"
                  >
                    <div>
                      <div className="font-medium text-sm">{i.nombre}</div>
                      <div className="text-xs text-foreground/50">
                        Stock: {Number(i.stock_actual ?? 0).toFixed(2)} {i.unidad}
                      </div>
                    </div>
                    <div className="text-xs text-foreground/40">{i.unidad}</div>
                  </button>
                ))}
                {insumosFiltrados.length === 0 && (
                  <div className="px-3 py-4 text-sm text-foreground/50 text-center">
                    Sin resultados
                  </div>
                )}
              </div>
            </div>
          ) : (
            // ─── Insumo elegido: form ───
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 bg-amber-50 rounded-lg border border-amber-200">
                <div>
                  <div className="text-xs text-foreground/60">Insumo</div>
                  <div className="font-medium">{insumoSel?.nombre}</div>
                  <div className="text-xs text-foreground/50">
                    Stock actual: {Number(insumoSel?.stock_actual ?? 0).toFixed(2)} {insumoSel?.unidad}
                  </div>
                </div>
                <button onClick={() => setInsumoId(null)} className="text-xs text-amber-700 underline">
                  Cambiar
                </button>
              </div>

              <div>
                <Label htmlFor="cantidad">Cantidad ({insumoSel?.unidad})</Label>
                <Input
                  id="cantidad"
                  type="number"
                  step="0.01"
                  min="0"
                  value={cantidad}
                  onChange={e => setCantidad(e.target.value)}
                  placeholder="0.00"
                  autoFocus
                  className="text-lg tabular-nums"
                />
              </div>

              <div>
                <Label htmlFor="notas">Notas (opcional)</Label>
                <Textarea
                  id="notas"
                  value={notas}
                  onChange={e => setNotas(e.target.value)}
                  placeholder="Ej: pescado entregado feo, cliente devolvió plato, etc."
                  rows={2}
                />
              </div>

              {esRobo && (
                <div className="p-3 bg-red-50 rounded-lg border border-red-200 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-red-900">
                    <AlertTriangle className="h-4 w-4" />
                    Acción requiere autorización del manager
                  </div>
                  <Input
                    type="text"
                    value={managerCode}
                    onChange={e => setManagerCode(e.target.value)}
                    placeholder="Código TOTP del manager (6 dígitos)"
                    maxLength={6}
                    className="font-mono text-center text-lg tracking-widest"
                  />
                  <p className="text-xs text-red-800/70">
                    Pedile al dueño/admin que abra Códigos Manager en PASE y te dicte el código actual.
                  </p>
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <Button variant="outline" onClick={onClose} disabled={saving} className="flex-1">
                  Cancelar
                </Button>
                <Button onClick={handleSubmit} disabled={saving || !cantidad} className="flex-1">
                  {saving ? 'Guardando…' : 'Confirmar'}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
