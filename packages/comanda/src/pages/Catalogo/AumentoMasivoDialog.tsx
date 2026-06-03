import { useRef, useState } from 'react';
import type { Usuario } from '../../types/auth';
import type { Canal, ItemGrupo } from '../../types/database';
import { aumentoMasivo, aumentoMasivoPorCanal } from '../../services/preciosService';
import { translateError } from '../../lib/errors';
import { validarPorcentaje } from '../../lib/validate';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

interface Props {
  user: Usuario;
  grupos: ItemGrupo[];
  // F6 Pricing canal (2026-06-02): si la pantalla pasa canales y hay uno
  // pre-seleccionado, el dialog muestra el modo "solo canal" en vez de
  // "precio madre". Aceptamos null para mantener compat retro.
  canales?: Canal[];
  canalIdPreseleccionado?: number | null;
  totalItems: number;
  onClose: () => void;
  onDone: (result: { itemsAfectados: number; preciosRecalculados: number }) => void;
}

// Modo "madre" sube el precio_madre y recalcula los canales atados.
// Modo "canal" sube SOLO el canal elegido sin tocar el madre — útil
// cuando Rappi te aumenta la comisión y querés trasladarlo solo ahí.
type Modo = 'madre' | 'canal';

export function AumentoMasivoDialog({
  user, grupos, canales = [], canalIdPreseleccionado = null,
  totalItems, onClose, onDone,
}: Props) {
  const [modo, setModo] = useState<Modo>(canalIdPreseleccionado !== null ? 'canal' : 'madre');
  const [canalId, setCanalId] = useState<number | null>(canalIdPreseleccionado);
  const [grupoId, setGrupoId] = useState<number | null>(null);
  const [porcentaje, setPorcentaje] = useState<number>(10);
  const [redondeoA, setRedondeoA] = useState<number>(1);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const itemsPreview = grupoId === null ? totalItems : null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (savingRef.current) return;
    const eP = validarPorcentaje(porcentaje);
    if (eP) { setError(eP); return; }
    if (!user.tenant_id) { setError('Sin tenant'); return; }
    if (modo === 'canal' && canalId === null) { setError('Elegí un canal'); return; }
    savingRef.current = true;
    setSaving(true); setError(null);
    try {
      if (modo === 'madre') {
        const { data, error: err } = await aumentoMasivo({
          tenantId: user.tenant_id,
          localId: null,
          grupoId,
          porcentaje,
          redondeoA,
        });
        if (err || !data) { setError(translateError({ message: err ?? 'Error' })); return; }
        onDone(data);
      } else {
        // Modo canal — adaptamos result a la firma onDone.
        const { data, error: err } = await aumentoMasivoPorCanal({
          tenantId: user.tenant_id,
          canalId: canalId as number,
          localId: null,
          grupoId,
          porcentaje,
          redondeoA,
        });
        if (err || !data) { setError(translateError({ message: err ?? 'Error' })); return; }
        // preciosRecalculados = actualizados + creados (UI ya lo muestra como total)
        onDone({
          itemsAfectados: data.itemsAfectados,
          preciosRecalculados: data.preciosActualizados + data.preciosCreados,
        });
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Aumento masivo de precios</DialogTitle>
          <DialogDescription>
            {modo === 'madre'
              ? 'Sube el precio madre y recalcula los precios de los canales atados. La edición manual queda pisada.'
              : 'Sube SOLO el canal elegido (sin tocar el precio madre). Útil para trasladar comisiones de Rappi/PeYa.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          {canales.length > 0 && (
            <div className="space-y-2">
              <Label>Alcance</Label>
              <Select value={modo} onValueChange={(v) => setModo(v as Modo)}>
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="madre">Precio madre + canales atados (todos)</SelectItem>
                  <SelectItem value="canal">Sólo un canal específico</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {modo === 'canal' && (
            <div className="space-y-2">
              <Label>Canal</Label>
              <Select
                value={canalId === null ? '' : String(canalId)}
                onValueChange={(v) => setCanalId(v === '' ? null : Number(v))}
              >
                <SelectTrigger className="h-11">
                  <SelectValue placeholder="Elegir canal…" />
                </SelectTrigger>
                <SelectContent>
                  {canales.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.emoji ?? ''} {c.nombre}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label>Grupo a afectar</Label>
            <Select
              value={grupoId === null ? '_all' : String(grupoId)}
              onValueChange={(v) => setGrupoId(v === '_all' ? null : Number(v))}
            >
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_all">Todos los grupos</SelectItem>
                {grupos.map((g) => (
                  <SelectItem key={g.id} value={String(g.id)}>
                    {g.emoji ?? ''} {g.nombre}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="porcentaje">Porcentaje (positivo o negativo)</Label>
            <Input
              id="porcentaje"
              type="number"
              step="0.01"
              value={porcentaje}
              onChange={(e) => setPorcentaje(Number(e.target.value))}
              required
              autoFocus
              className="h-11 tabular-nums"
            />
            <p className="text-xs text-muted-foreground">Ej: 15 = +15%, -5 = -5%</p>
          </div>

          <div className="space-y-2">
            <Label>Redondear a</Label>
            <Select value={String(redondeoA)} onValueChange={(v) => setRedondeoA(Number(v))}>
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Al peso</SelectItem>
                <SelectItem value="10">Decena</SelectItem>
                <SelectItem value="100">Centena</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {itemsPreview !== null && (
            <div className="p-3 rounded-md bg-muted text-sm">
              Aproximadamente <strong>{itemsPreview}</strong> items afectados.
            </div>
          )}

          {error && (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Aplicando…' : 'Aplicar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
