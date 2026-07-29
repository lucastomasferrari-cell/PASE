import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { modificarItem } from '@/services/ventasService';
import type { VentaPosItem } from '@/types/database';

// Aclaración por item (sin sal, punto jugoso, sin cebolla…) antes de comandar.
// Se guarda en item.notas y viaja a cocina cuando se manda el curso.
// Compartido entre el POS normal (VentaScreen) y el handheld del mozo.
export function ItemNotaDialog({ item, nombre, onClose, onSaved }: {
  item: VentaPosItem;
  nombre: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(item.notas ?? '');
  const [saving, setSaving] = useState(false);

  async function guardar() {
    setSaving(true);
    const { error } = await modificarItem(item.id, { notas: draft.trim() || null });
    setSaving(false);
    if (error) { toast.error(error); return; }
    toast.success('Aclaración guardada');
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-3" onClick={onClose}>
      <div className="w-full max-w-sm bg-card rounded-xl p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-semibold">Aclaración · {nombre}</div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          rows={3}
          placeholder="Ej: sin sal, punto jugoso, sin cebolla…"
          className="w-full text-sm rounded-md border border-input bg-background p-2 resize-none"
        />
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button variant="success" onClick={guardar} disabled={saving}>{saving ? 'Guardando…' : 'Guardar'}</Button>
        </div>
      </div>
    </div>
  );
}
