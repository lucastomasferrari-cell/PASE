// AjusteStockDialog — registrar ajuste manual de stock con motivo.
//
// Tipos de ajuste:
//   - merma:           perdido por vencimiento / rotura accidental
//   - robo:            faltante por robo. REQUIERE manager_id.
//   - donacion:        regalado a staff/caridad. REQUIERE manager_id.
//   - entrada_ajuste:  encontré más de lo que decía el sistema (raro)
//   - salida_ajuste:   falta sin razón conocida (uso interno, etc)

import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ajustarStockInsumo, type TipoAjusteManual } from '@/services/insumosService';

const TIPOS: Array<{ value: TipoAjusteManual; label: string; descripcion: string; signo: '+' | '-'; requiereManager: boolean }> = [
  { value: 'merma',           label: 'Merma',           descripcion: 'Vencimiento, rotura accidental, descomposición.', signo: '-', requiereManager: false },
  { value: 'robo',            label: 'Robo / faltante', descripcion: 'Faltante sin justificar. Requiere PIN de manager.', signo: '-', requiereManager: true },
  { value: 'donacion',        label: 'Donación',        descripcion: 'Regalado a staff o caridad.', signo: '-', requiereManager: true },
  { value: 'salida_ajuste',   label: 'Salida (otro)',   descripcion: 'Uso interno, prueba de receta, etc.', signo: '-', requiereManager: false },
  { value: 'entrada_ajuste',  label: 'Entrada (otro)',  descripcion: 'Encontré más de lo que decía el sistema, corrección manual.', signo: '+', requiereManager: false },
];

export function AjusteStockDialog({
  open, onOpenChange, insumoId, insumoNombre, unidad, stockActual, onApplied,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  insumoId: number | null;
  insumoNombre: string;
  unidad: string;
  stockActual: number;
  onApplied?: () => void;
}) {
  const [tipo, setTipo] = useState<TipoAjusteManual>('merma');
  const [cantidad, setCantidad] = useState('');
  const [motivo, setMotivo] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const tipoConfig = TIPOS.find((t) => t.value === tipo)!;
  const cantNum = parseFloat(cantidad);
  const cantConSigno = tipoConfig.signo === '-' ? -Math.abs(cantNum) : Math.abs(cantNum);
  const stockDespues = stockActual + (Number.isFinite(cantConSigno) ? cantConSigno : 0);

  function reset() {
    setTipo('merma');
    setCantidad('');
    setMotivo('');
  }

  async function handleSubmit() {
    if (!insumoId) return;
    if (!Number.isFinite(cantNum) || cantNum <= 0) {
      toast.error('Cantidad inválida (poné un número mayor a 0)');
      return;
    }
    if (motivo.trim().length < 3) {
      toast.error('Motivo demasiado corto');
      return;
    }
    if (tipoConfig.requiereManager) {
      // TODO sprint próximo: integrar ManagerOverrideDialog para pedir PIN.
      // Por ahora, se acepta sin manager_id y se confía en el motivo.
      // El RPC lo rechaza si manager_id es null para tipos robo/donacion.
      toast.error('Esta operación requiere validación de manager (TODO sprint próximo). Usá un ajuste tipo "Salida (otro)" como workaround temporal.');
      return;
    }

    setSubmitting(true);
    const { error } = await ajustarStockInsumo({
      insumoId,
      cantidad: cantConSigno,
      tipo,
      motivo: motivo.trim(),
    });
    setSubmitting(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(`Stock ajustado: ${insumoNombre} → ${stockDespues.toFixed(2)} ${unidad}`);
    reset();
    onOpenChange(false);
    onApplied?.();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ajustar stock</DialogTitle>
          <DialogDescription>
            {insumoNombre} · Stock actual: <strong>{stockActual.toFixed(2)} {unidad}</strong>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="tipo">Tipo de ajuste</Label>
            <Select value={tipo} onValueChange={(v) => setTipo(v as TipoAjusteManual)}>
              <SelectTrigger id="tipo" className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIPOS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    <span className="font-mono mr-2">{t.signo}</span> {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-foreground/60 mt-1">{tipoConfig.descripcion}</p>
          </div>

          <div>
            <Label htmlFor="cantidad">Cantidad ({unidad})</Label>
            <Input
              id="cantidad"
              type="number"
              step="0.01"
              min="0"
              value={cantidad}
              onChange={(e) => setCantidad(e.target.value)}
              placeholder="0.00"
              className="mt-1"
              autoFocus
            />
            <p className="text-xs text-foreground/60 mt-1">
              Stock después: <strong>{stockDespues.toFixed(2)} {unidad}</strong>
              {stockDespues < 0 && (
                <span className="ml-2 inline-flex items-center gap-1 text-amber-700">
                  <AlertTriangle className="h-3 w-3" /> quedará negativo
                </span>
              )}
            </p>
          </div>

          <div>
            <Label htmlFor="motivo">Motivo (obligatorio)</Label>
            <Textarea
              id="motivo"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Ej: tomate vencido, descongelado, accidente con bandeja..."
              className="mt-1"
              rows={3}
            />
          </div>

          {tipoConfig.requiereManager && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-900">
              <strong>Atención:</strong> este tipo requiere validación de manager (PIN). Feature en próximo sprint.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || !cantidad || motivo.trim().length < 3 || tipoConfig.requiereManager}
          >
            {submitting ? 'Aplicando…' : 'Aplicar ajuste'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
