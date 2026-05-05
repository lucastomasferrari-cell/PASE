import { useState } from 'react';
import type { Item } from '../../types/database';
import { marcarAgotado } from '../../services/itemsService';
import { translateError } from '../../lib/errors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

interface Props {
  item: Item;
  onClose: () => void;
  onDone: () => void;
}

export function AgotarDialog({ item, onClose, onDone }: Props) {
  const [motivo, setMotivo] = useState('');
  const [hasta, setHasta] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!motivo.trim()) { setError('El motivo es requerido'); return; }
    setSaving(true); setError(null);
    const hastaIso = hasta ? new Date(hasta).toISOString() : null;
    const { error: err } = await marcarAgotado(item.id, motivo.trim(), hastaIso);
    setSaving(false);
    if (err) { setError(translateError({ message: err })); return; }
    onDone();
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Marcar como agotado</DialogTitle>
          <DialogDescription>
            {item.emoji ?? '📦'} {item.nombre}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="motivo">Motivo *</Label>
            <Input
              id="motivo"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              required
              autoFocus
              placeholder="Sin stock, problema en cocina…"
              className="h-11"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="hasta">Reactivar automáticamente (opcional)</Label>
            <Input
              id="hasta"
              type="datetime-local"
              value={hasta}
              onChange={(e) => setHasta(e.target.value)}
              className="h-11"
            />
          </div>

          {error && (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button type="submit" variant="warning" disabled={saving}>
              {saving ? 'Marcando…' : 'Marcar agotado'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
