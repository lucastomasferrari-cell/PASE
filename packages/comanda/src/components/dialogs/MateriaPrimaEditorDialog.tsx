import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { CurrencyInput } from '@/components/CurrencyInput';
import { db } from '@/lib/supabase';
import {
  createMateriaPrima, updateMateriaPrima, calcCostoEfectivo,
  type MateriaPrima,
} from '@/services/materiasPrimasService';
import { formatARS } from '@/lib/format';

interface Insumo { id: number; nombre: string; unidad: string }
interface Proveedor { id: number; nombre: string }

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  editing: MateriaPrima | null;
  onSaved: () => void;
}

const UNIDADES = ['kg', 'g', 'L', 'ml', 'un', 'porcion', 'docena', 'caja', 'bolsa'];

export function MateriaPrimaEditorDialog({ open, onOpenChange, tenantId, editing, onSaved }: Props) {
  const [nombre, setNombre] = useState('');
  const [proveedorId, setProveedorId] = useState<number | null>(null);
  const [insumoId, setInsumoId] = useState<number | null>(null);
  const [unidad, setUnidad] = useState<string>('kg');
  const [factor, setFactor] = useState<number>(1);
  const [precio, setPrecio] = useState<number>(0);
  const [notas, setNotas] = useState('');
  const [activa, setActiva] = useState(true);
  const [saving, setSaving] = useState(false);

  const [insumos, setInsumos] = useState<Insumo[]>([]);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);

  useEffect(() => {
    if (!open) return;
    // Cargar listas
    void db.from('insumos').select('id, nombre, unidad').is('deleted_at', null).order('nombre')
      .then(({ data }) => setInsumos((data ?? []) as Insumo[]));
    void db.from('proveedores').select('id, nombre').order('nombre')
      .then(({ data }) => setProveedores((data ?? []) as Proveedor[]));

    // Estado inicial
    if (editing) {
      setNombre(editing.nombre);
      setProveedorId(editing.proveedor_id);
      setInsumoId(editing.insumo_id);
      setUnidad(editing.unidad_compra);
      setFactor(Number(editing.factor_conversion));
      setPrecio(Number(editing.precio_actual ?? 0));
      setNotas(editing.notas ?? '');
      setActiva(editing.activa);
    } else {
      setNombre(''); setProveedorId(null); setInsumoId(null);
      setUnidad('kg'); setFactor(1); setPrecio(0); setNotas('');
      setActiva(true);
    }
    setSaving(false);
  }, [open, editing]);

  const costoEfectivo = calcCostoEfectivo({ precio_actual: precio, factor_conversion: factor });
  const canSubmit = nombre.trim().length > 0 && insumoId !== null && factor > 0;

  async function guardar() {
    if (!canSubmit || !insumoId) {
      toast.error('Completá los datos requeridos (nombre + insumo + factor > 0)');
      return;
    }
    // Validación bloqueante: precio = 0 al crear nueva MP es trampa — el
    // trigger recalc costo_insumo va a usar 0 → costo del insumo cae a 0.
    // Permitirlo solo cuando se está EDITANDO (legítimo "precio aún no se sabe").
    if (!editing && precio <= 0) {
      const ok = confirm(
        'No cargaste precio (precio = 0).\n\n' +
        'El costo de esta materia prima va a quedar en NULL y NO va a sumar al ' +
        'costo del insumo unificado hasta que cargues uno (manual o vía factura).\n\n' +
        '¿Crear igual?'
      );
      if (!ok) return;
    }
    setSaving(true);
    const input = {
      nombre: nombre.trim(),
      proveedor_id: proveedorId,
      insumo_id: insumoId,
      unidad_compra: unidad,
      factor_conversion: factor,
      precio_actual: precio > 0 ? precio : null,
      notas: notas.trim() || null,
      activa,
    };
    const res = editing
      ? await updateMateriaPrima(editing.id, input)
      : await createMateriaPrima(tenantId, input);
    setSaving(false);
    if (res.error) { toast.error(res.error); return; }
    toast.success(editing ? 'Materia prima actualizada' : 'Materia prima creada');
    onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 shrink-0">
          <DialogTitle>{editing ? 'Editar' : 'Nueva'} materia prima</DialogTitle>
          <DialogDescription>
            Lo que comprás del proveedor. Se vincula a un insumo unificado del catálogo.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 min-h-0">

        {/* Nombre */}
        <div className="space-y-2">
          <Label htmlFor="nom">Nombre comercial</Label>
          <Input
            id="nom"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Ej: Trucha entera c/vísceras Pescadería SA"
          />
        </div>

        {/* Insumo unificado (FK) */}
        <div className="space-y-2">
          <Label>Insumo unificado al que pertenece *</Label>
          <Select value={insumoId?.toString() ?? ''} onValueChange={(v) => setInsumoId(Number(v))}>
            <SelectTrigger><SelectValue placeholder="Elegí un insumo" /></SelectTrigger>
            <SelectContent className="max-h-72">
              {insumos.map((i) => (
                <SelectItem key={i.id} value={String(i.id)}>
                  {i.nombre} ({i.unidad})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Si no existe el insumo, creálo primero en Catálogo → Insumos. Acá lo enlazás.
          </p>
        </div>

        {/* Proveedor */}
        <div className="space-y-2">
          <Label>Proveedor</Label>
          <Select value={proveedorId?.toString() ?? 'null'} onValueChange={(v) => setProveedorId(v === 'null' ? null : Number(v))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value="null">— Sin proveedor específico —</SelectItem>
              {proveedores.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>{p.nombre}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Unidad + factor */}
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-2">
            <Label>Unidad compra</Label>
            <Select value={unidad} onValueChange={setUnidad}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {UNIDADES.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="factor">Factor conversión</Label>
            <Input
              id="factor"
              type="number"
              step="0.01"
              min={0.01}
              value={factor}
              onChange={(e) => setFactor(Number(e.target.value) || 0)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground -mt-2">
          Factor = unidades de insumo por cada unidad de compra (ej: 1 cajón de 12 unidades → factor 12).
          La merma/rendimiento no va acá: vive en la línea de receta y se aplica al consumir.
        </p>

        {/* Precio */}
        <div className="space-y-2">
          <Label>Precio último de compra (por {unidad})</Label>
          <CurrencyInput value={precio} onChange={setPrecio} />
          <p className="text-xs text-muted-foreground">
            Si dejás vacío, se cargará automático al ingresar una factura con esta materia prima.
          </p>
        </div>

        {/* Costo efectivo preview */}
        {costoEfectivo && (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">Costo efectivo del insumo</div>
            <div className="text-2xl font-bold tabular-nums">{formatARS(costoEfectivo)}</div>
            <div className="text-xs text-muted-foreground">
              {formatARS(precio)} ÷ {factor} = {formatARS(costoEfectivo)} por unidad de insumo
            </div>
          </div>
        )}

        {/* Notas + activa */}
        <div className="space-y-2">
          <Label htmlFor="notas">Notas (opcional)</Label>
          <Textarea id="notas" value={notas} onChange={(e) => setNotas(e.target.value)} rows={2} />
        </div>
        <div className="flex items-center justify-between">
          <Label>Activa (cuenta en el promedio del insumo)</Label>
          <Switch checked={activa} onCheckedChange={setActiva} />
        </div>
        </div>

        <DialogFooter className="px-6 py-4 border-t shrink-0 gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancelar</Button>
          <Button onClick={guardar} disabled={!canSubmit || saving}>
            {saving ? 'Guardando…' : (editing ? 'Guardar cambios' : 'Crear materia prima')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
