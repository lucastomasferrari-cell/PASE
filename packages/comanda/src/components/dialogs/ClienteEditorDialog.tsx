import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Star } from 'lucide-react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { createCliente, updateCliente } from '@/services/clientesService';
import type { Cliente } from '@/types/database';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cliente: Cliente | null; // null = crear nuevo
  tenantId: string;
  onSaved: () => void;
}

interface FormState {
  telefono: string;
  nombre: string;
  apellido: string;
  email: string;
  direccion: string;
  direccion_aclaracion: string;
  zona: string;
  notas: string;
  vip: boolean;
  acepta_marketing: boolean;
}

const EMPTY: FormState = {
  telefono: '', nombre: '', apellido: '', email: '',
  direccion: '', direccion_aclaracion: '', zona: '',
  notas: '', vip: false, acepta_marketing: false,
};

export function ClienteEditorDialog({ open, onOpenChange, cliente, tenantId, onSaved }: Props) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (open) {
      setForm(cliente ? {
        telefono: cliente.telefono,
        nombre: cliente.nombre ?? '',
        apellido: cliente.apellido ?? '',
        email: cliente.email ?? '',
        direccion: cliente.direccion ?? '',
        direccion_aclaracion: cliente.direccion_aclaracion ?? '',
        zona: cliente.zona ?? '',
        notas: cliente.notas ?? '',
        vip: cliente.vip,
        acepta_marketing: cliente.acepta_marketing,
      } : EMPTY);
    }
  }, [open, cliente]);

  const setField = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (savingRef.current) return;
    if (!form.telefono.trim()) {
      toast.error('El teléfono es obligatorio');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const payload = {
        telefono: form.telefono.trim(),
        nombre: form.nombre.trim() || null,
        apellido: form.apellido.trim() || null,
        email: form.email.trim() || null,
        direccion: form.direccion.trim() || null,
        direccion_aclaracion: form.direccion_aclaracion.trim() || null,
        zona: form.zona.trim() || null,
        notas: form.notas.trim() || null,
        vip: form.vip,
        acepta_marketing: form.acepta_marketing,
      };
      const r = cliente
        ? await updateCliente(cliente.id, payload)
        : await createCliente(tenantId, payload);
      if (r.error) {
        if (r.error.toLowerCase().includes('uniq_cliente') || r.error.toLowerCase().includes('duplicate')) {
          toast.error(`Ya existe un cliente con teléfono ${form.telefono}`);
        } else {
          toast.error(r.error);
        }
        return;
      }
      toast.success(cliente ? 'Cliente actualizado' : 'Cliente creado');
      onSaved();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            {cliente ? 'Editar cliente' : 'Nuevo cliente'}
            {form.vip && <Star className="h-4 w-4 text-warning fill-warning" />}
          </DialogTitle>
          <DialogDescription>
            {cliente
              ? 'Modificar datos del cliente. El teléfono es la identificación única.'
              : 'Crear cliente nuevo. El teléfono será su identificación única en este tenant.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Teléfono */}
          <div className="sm:col-span-1">
            <Label htmlFor="telefono">Teléfono *</Label>
            <Input
              id="telefono" value={form.telefono} onChange={(e) => setField('telefono', e.target.value)}
              placeholder="+54 11 1234-5678" disabled={!!cliente}
            />
            {cliente && <p className="text-xs text-muted-foreground mt-0.5">No se puede cambiar — es la identificación única.</p>}
          </div>

          {/* Email */}
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email" type="email" value={form.email} onChange={(e) => setField('email', e.target.value)}
              placeholder="cliente@email.com"
            />
          </div>

          {/* Nombre + Apellido */}
          <div>
            <Label htmlFor="nombre">Nombre</Label>
            <Input id="nombre" value={form.nombre} onChange={(e) => setField('nombre', e.target.value)} placeholder="Juan" />
          </div>
          <div>
            <Label htmlFor="apellido">Apellido</Label>
            <Input id="apellido" value={form.apellido} onChange={(e) => setField('apellido', e.target.value)} placeholder="Pérez" />
          </div>

          {/* Dirección + Zona */}
          <div className="sm:col-span-2">
            <Label htmlFor="direccion">Dirección</Label>
            <Input id="direccion" value={form.direccion} onChange={(e) => setField('direccion', e.target.value)} placeholder="Av. Corrientes 1234, CABA" />
          </div>
          <div>
            <Label htmlFor="direccion_aclaracion">Aclaración (portero / piso)</Label>
            <Input id="direccion_aclaracion" value={form.direccion_aclaracion} onChange={(e) => setField('direccion_aclaracion', e.target.value)} placeholder="2do C, portero ausente" />
          </div>
          <div>
            <Label htmlFor="zona">Zona</Label>
            <Input id="zona" value={form.zona} onChange={(e) => setField('zona', e.target.value)} placeholder="Villa Crespo" />
          </div>

          {/* Notas */}
          <div className="sm:col-span-2">
            <Label htmlFor="notas">Notas internas</Label>
            <Textarea
              id="notas" value={form.notas} onChange={(e) => setField('notas', e.target.value)}
              placeholder="Alérgico al maní, prefiere sin cebolla, etc."
              rows={2}
            />
          </div>

          {/* Toggles */}
          <label className="flex items-center gap-2 cursor-pointer">
            <Switch checked={form.vip} onCheckedChange={(v) => setField('vip', v)} />
            <span className="text-sm">Cliente VIP</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <Switch checked={form.acepta_marketing} onCheckedChange={(v) => setField('acepta_marketing', v)} />
            <span className="text-sm">Acepta marketing (email/SMS/WhatsApp)</span>
          </label>
        </div>

        <DialogFooter className="px-6 py-4 border-t shrink-0 gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving || !form.telefono.trim()}>
            {saving ? 'Guardando…' : cliente ? 'Guardar cambios' : 'Crear cliente'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
