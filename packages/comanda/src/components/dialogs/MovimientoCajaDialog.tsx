import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowDownToLine, ArrowUpFromLine, AlertTriangle } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MoneyInput } from '@/components/MoneyInput';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useAuthPos } from '@/lib/authPos';
import { useLocalActivo } from '@/lib/localActivo';
import { useAuth } from '@/lib/auth';
import { useIdempotencyKey } from '@/lib/idempotency';
import { registrarMovimiento } from '@/services/turnosCajaService';
import { ManagerOverrideDialog } from './ManagerOverrideDialog';
import { formatARS } from '@/lib/format';

export type TipoMovimiento = 'retiro' | 'deposito' | 'ajuste';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tipo: TipoMovimiento;
  onConfirmado: () => void;
}

// Sprint 7 HIGH #2: retiros > $5000 también requieren override (antes
// solo ajustes > $10k).
const UMBRAL_AJUSTE_OVERRIDE = 10_000;
const UMBRAL_RETIRO_OVERRIDE = 5_000;

export function MovimientoCajaDialog({ open, onOpenChange, tipo, onConfirmado }: Props) {
  const { user } = useAuth();
  const { empleado } = useAuthPos();
  const [localId] = useLocalActivo(user);
  const [monto, setMonto] = useState(0);
  const [metodo, setMetodo] = useState('efectivo');
  const [motivo, setMotivo] = useState('');
  const [showOverride, setShowOverride] = useState(false);
  const [saving, setSaving] = useState(false);
  // Sprint 7 BLOCKER #3: idempotency_key estable mientras el dialog
  // está abierto. Doble-click usa el mismo key → RPC retorna mismo
  // resultado sin re-ejecutar.
  const idempotencyKey = useIdempotencyKey(open ? 'open' : 'closed');

  useEffect(() => {
    if (open) { setMonto(0); setMotivo(''); setMetodo('efectivo'); setShowOverride(false); setSaving(false); }
  }, [open]);

  const requiereOverride =
    (tipo === 'ajuste' && Math.abs(monto) > UMBRAL_AJUSTE_OVERRIDE) ||
    (tipo === 'retiro' && Math.abs(monto) > UMBRAL_RETIRO_OVERRIDE);
  const motivoMinimo = requiereOverride ? 10 : 5;

  async function ejecutar(managerId?: string) {
    if (!empleado || localId === null) {
      toast.error('Sin sesión POS o local');
      return;
    }
    if (monto <= 0) { toast.error('Monto inválido'); return; }
    if (motivo.trim().length < motivoMinimo) {
      toast.error(`Motivo: mínimo ${motivoMinimo} caracteres`);
      return;
    }
    setSaving(true);
    const { error } = await registrarMovimiento(
      localId, empleado.id, tipo, monto, metodo, motivo.trim(),
      idempotencyKey, managerId ?? null,
    );
    setSaving(false);
    if (error) { toast.error(error); return; }
    toast.success(`${tituloLabel(tipo)} registrado`);
    onConfirmado();
    onOpenChange(false);
  }

  function intentarConfirmar() {
    if (motivo.trim().length < motivoMinimo) {
      toast.error(`Motivo: mínimo ${motivoMinimo} caracteres`);
      return;
    }
    if (requiereOverride) setShowOverride(true);
    else void ejecutar();
  }

  return (
    <>
      <Dialog open={open && !showOverride} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] flex flex-col p-0 gap-0">
          <DialogHeader className="px-6 pt-6 shrink-0">
            <div className="flex items-center gap-3 mb-1">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10">
                <IconPorTipo tipo={tipo} />
              </div>
              <div>
                <DialogTitle>{tituloLabel(tipo)}</DialogTitle>
                <DialogDescription>{descripcionPorTipo(tipo)}</DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 min-h-0">
          <div className="space-y-2">
            <Label>Monto</Label>
            <MoneyInput value={monto} onChange={setMonto} autoFocus />
          </div>

          <div className="space-y-2">
            <Label>Método</Label>
            <Select value={metodo} onValueChange={setMetodo}>
              <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="efectivo">💵 Efectivo</SelectItem>
                <SelectItem value="transferencia">🏦 Transferencia</SelectItem>
                <SelectItem value="otros">📝 Otros</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="motivo-mov">Motivo</Label>
            <Input
              id="motivo-mov"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder={placeholderPorTipo(tipo)}
              className="h-11"
            />
          </div>

          {requiereOverride && (
            <div className="rounded-md bg-warning/10 border border-warning/30 p-3 text-sm flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-warning mt-0.5 flex-shrink-0" />
              <span>
                {tipo === 'retiro'
                  ? `Retiro mayor a ${formatARS(UMBRAL_RETIRO_OVERRIDE)} requiere autorización de manager (PIN + motivo).`
                  : `Ajuste mayor a ${formatARS(UMBRAL_AJUSTE_OVERRIDE)} requiere autorización de manager.`}
              </span>
            </div>
          )}
          </div>

          <DialogFooter className="px-6 py-4 border-t shrink-0 gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={intentarConfirmar} disabled={saving || monto <= 0 || motivo.trim().length < motivoMinimo}>
              {saving ? 'Guardando…' : (requiereOverride ? 'Pedir autorización' : 'Confirmar')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ManagerOverrideDialog
        open={showOverride}
        onOpenChange={(o) => { setShowOverride(o); if (!o) onOpenChange(false); }}
        accion={`${tituloLabel(tipo)} grande`}
        descripcion={`${tituloLabel(tipo)} de ${formatARS(monto)} con motivo: "${motivo}".`}
        onAuthorized={async ({ managerId }) => { await ejecutar(managerId); }}
      />
    </>
  );
}

function tituloLabel(t: TipoMovimiento): string {
  return t === 'retiro' ? 'Retiro de caja' : t === 'deposito' ? 'Depósito a caja' : 'Ajuste de caja';
}
function descripcionPorTipo(t: TipoMovimiento): string {
  if (t === 'retiro') return 'Saca plata de la caja (pagos a proveedores, viáticos, etc.)';
  if (t === 'deposito') return 'Entra plata a la caja (refuerzo, propina depositada).';
  return 'Corrige diferencia detectada (puede ser positivo o negativo).';
}
function placeholderPorTipo(t: TipoMovimiento): string {
  if (t === 'retiro') return 'Pago proveedor, viático…';
  if (t === 'deposito') return 'Refuerzo turno tarde…';
  return 'Diferencia con conteo físico…';
}
function IconPorTipo({ tipo }: { tipo: TipoMovimiento }) {
  if (tipo === 'retiro') return <ArrowUpFromLine className="h-5 w-5 text-destructive" />;
  if (tipo === 'deposito') return <ArrowDownToLine className="h-5 w-5 text-success" />;
  return <AlertTriangle className="h-5 w-5 text-warning" />;
}
