import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Truck, ShoppingBag, Phone, MapPin, Search, User, Plus } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { abrirVenta } from '@/services/ventasService';
import { listCanales } from '@/services/canalesService';
import { listClientes } from '@/services/clientesService';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import type { Canal, Cliente, TipoEntrega } from '@/types/database';
import { cn } from '@/lib/utils';

// Dialog para crear un pedido manual (cliente llamó por WhatsApp / teléfono).
// Toma datos del cliente + tipo entrega + canal, abre la venta en modo='pedidos'
// y navega a la pantalla de carga de items. El cobro pasa después en VentaScreen.

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (ventaId: number) => void;
}

export function NuevoPedidoDialog({ open, onOpenChange, onCreated }: Props) {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);

  const [tipoEntrega, setTipoEntrega] = useState<TipoEntrega>('delivery');
  const [canales, setCanales] = useState<Canal[]>([]);
  const [canalId, setCanalId] = useState<number | null>(null);
  const [telefono, setTelefono] = useState('');
  const [nombre, setNombre] = useState('');
  const [direccion, setDireccion] = useState('');
  const [aclaracion, setAclaracion] = useState('');
  const [notas, setNotas] = useState('');
  const [matches, setMatches] = useState<Cliente[]>([]);
  const [saving, setSaving] = useState(false);

  // Reset on open
  useEffect(() => {
    if (open) {
      setTipoEntrega('delivery');
      setTelefono(''); setNombre(''); setDireccion(''); setAclaracion(''); setNotas('');
      setMatches([]); setSaving(false);
    }
  }, [open]);

  // Cargar canales de modo "pedidos" cuando se abre
  useEffect(() => {
    if (!open || !user?.tenant_id) return;
    listCanales(user.tenant_id, true).then(({ data }) => {
      const pedidoChannels = data.filter((c) => c.modo_pos === 'pedidos');
      setCanales(pedidoChannels);
      // Default: WhatsApp si existe, sino el primero
      const wa = pedidoChannels.find((c) => c.slug === 'whatsapp');
      setCanalId(wa?.id ?? pedidoChannels[0]?.id ?? null);
    });
  }, [open, user?.tenant_id]);

  // Autocomplete por teléfono (debounced)
  const debouncedTel = useDebouncedValue(telefono, 300);
  useEffect(() => {
    if (!debouncedTel || debouncedTel.length < 3) { setMatches([]); return; }
    let cancelled = false;
    listClientes({ search: debouncedTel }).then(({ data }) => {
      if (cancelled) return;
      setMatches(data.slice(0, 5));
    });
    return () => { cancelled = true; };
  }, [debouncedTel]);

  function elegirCliente(c: Cliente) {
    setTelefono(c.telefono);
    setNombre([c.nombre, c.apellido].filter(Boolean).join(' '));
    setDireccion(c.direccion ?? '');
    setAclaracion(c.direccion_aclaracion ?? '');
    setMatches([]);
  }

  const isDelivery = tipoEntrega === 'delivery';
  const canSubmit = useMemo(() => {
    if (!telefono.trim() || !nombre.trim()) return false;
    if (!canalId) return false;
    if (isDelivery && !direccion.trim()) return false;
    return true;
  }, [telefono, nombre, canalId, isDelivery, direccion]);

  async function crear() {
    if (!canSubmit) {
      toast.error('Completá los datos requeridos');
      return;
    }
    if (localId === null) {
      toast.error('Seleccioná un local primero');
      return;
    }
    setSaving(true);
    const dirCompleta = isDelivery
      ? [direccion.trim(), aclaracion.trim()].filter(Boolean).join(' — ')
      : null;
    const { ventaId, error } = await abrirVenta({
      localId,
      modo: 'pedidos',
      canalId: canalId!,
      clienteNombre: nombre.trim(),
      clienteTelefono: telefono.trim(),
      clienteDireccion: dirCompleta,
      tipoEntrega,
      origen: 'pos',
    });
    setSaving(false);
    if (error || !ventaId) {
      toast.error(error ?? 'No se pudo crear el pedido');
      return;
    }
    toast.success('Pedido creado');
    onCreated(ventaId);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nuevo pedido</DialogTitle>
          <DialogDescription>
            Cargá los datos del cliente y elegí cómo lo recibe. Después cargás los items.
          </DialogDescription>
        </DialogHeader>

        {/* Tipo entrega */}
        <div className="space-y-2">
          <Label>Tipo de entrega</Label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setTipoEntrega('delivery')}
              className={cn(
                'h-14 rounded-md border-2 flex flex-col items-center justify-center gap-1 transition-colors',
                tipoEntrega === 'delivery'
                  ? 'border-primary bg-primary/5 text-primary'
                  : 'border-border bg-background hover:bg-accent',
              )}
            >
              <Truck className="h-5 w-5" />
              <span className="text-sm font-medium">Envío</span>
            </button>
            <button
              type="button"
              onClick={() => setTipoEntrega('retiro')}
              className={cn(
                'h-14 rounded-md border-2 flex flex-col items-center justify-center gap-1 transition-colors',
                tipoEntrega === 'retiro'
                  ? 'border-primary bg-primary/5 text-primary'
                  : 'border-border bg-background hover:bg-accent',
              )}
            >
              <ShoppingBag className="h-5 w-5" />
              <span className="text-sm font-medium">Retira</span>
            </button>
          </div>
        </div>

        {/* Canal */}
        <div className="space-y-2">
          <Label>Canal por donde entró el pedido</Label>
          {canales.length === 0 ? (
            <p className="text-xs text-muted-foreground">Cargando canales…</p>
          ) : (
            <Select value={canalId?.toString() ?? ''} onValueChange={(v) => setCanalId(Number(v))}>
              <SelectTrigger className="h-11"><SelectValue placeholder="Elegí canal" /></SelectTrigger>
              <SelectContent>
                {canales.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.emoji ?? ''} {c.nombre}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Teléfono + autocomplete CRM */}
        <div className="space-y-2 relative">
          <Label htmlFor="tel" className="flex items-center gap-1.5">
            <Phone className="h-3.5 w-3.5" /> Teléfono
          </Label>
          <Input
            id="tel"
            inputMode="tel"
            value={telefono}
            onChange={(e) => setTelefono(e.target.value)}
            placeholder="11 1234 5678"
            className="h-11"
          />
          {matches.length > 0 && (
            <div className="absolute z-10 top-full mt-1 left-0 right-0 bg-card border border-border rounded-md shadow-md max-h-44 overflow-y-auto">
              <div className="px-3 py-1.5 text-[10px] text-muted-foreground uppercase tracking-wide border-b border-border flex items-center gap-1">
                <Search className="h-3 w-3" /> Clientes existentes
              </div>
              {matches.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => elegirCliente(c)}
                  className="w-full px-3 py-2 text-left hover:bg-accent flex items-center gap-2 text-sm border-b border-border last:border-0"
                >
                  <User className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{c.nombre} {c.apellido ?? ''}</div>
                    <div className="truncate text-xs text-muted-foreground">{c.telefono} · {c.zona ?? 'sin zona'}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Nombre */}
        <div className="space-y-2">
          <Label htmlFor="nom">Nombre del cliente</Label>
          <Input
            id="nom"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Ej: Juan Pérez"
            className="h-11"
          />
        </div>

        {/* Dirección — solo si delivery */}
        {isDelivery && (
          <>
            <div className="space-y-2">
              <Label htmlFor="dir" className="flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5" /> Dirección de entrega
              </Label>
              <Input
                id="dir"
                value={direccion}
                onChange={(e) => setDireccion(e.target.value)}
                placeholder="Calle, número"
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="acl" className="text-xs text-muted-foreground">
                Aclaración (piso, depto, timbre)
              </Label>
              <Input
                id="acl"
                value={aclaracion}
                onChange={(e) => setAclaracion(e.target.value)}
                placeholder="Piso 4, dpto B, tocar timbre 2 veces"
                className="h-11"
              />
            </div>
          </>
        )}

        {/* Notas */}
        <div className="space-y-2">
          <Label htmlFor="not" className="text-xs text-muted-foreground">
            Notas para cocina (opcional)
          </Label>
          <Textarea
            id="not"
            value={notas}
            onChange={(e) => setNotas(e.target.value)}
            rows={2}
            placeholder="Sin cebolla, alergias, etc."
          />
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={crear} disabled={!canSubmit || saving}>
            <Plus className="h-4 w-4 mr-1" />
            {saving ? 'Creando…' : 'Continuar al pedido'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
