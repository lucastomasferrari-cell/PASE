import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Delete, ShieldCheck } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { verificarPin, getEmpleado } from '@/services/empleadosService';
import { useAuthPos } from '@/lib/authPos';
import type { RolPos } from '@/types/database';
import { cn } from '@/lib/utils';

// Roles POS con acceso al panel de administración.
// Cajero + bartender NO tienen acceso — necesitan un PIN de manager+.
const ROLES_ADMIN: RolPos[] = ['encargado', 'manager', 'dueno'];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAuthorized: () => void;
}

// Dialog que pide PIN de manager/encargado/dueno para autorizar acceso a admin.
// Se muestra cuando el empleado actual del POS (cajero/bartender) toca el
// botón Admin del sidebar. NO cambia el empleado activo — es un override
// puntual solo para navegar.
export function AdminAccessDialog({ open, onOpenChange, onAuthorized }: Props) {
  const { empleado } = useAuthPos();
  const [pin, setPin] = useState('');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (open) setPin('');
  }, [open]);

  async function validar(pinCompleto: string) {
    if (!empleado) return;
    setChecking(true);
    const { empleadoId, error } = await verificarPin(empleado.local_id, pinCompleto);
    if (error || !empleadoId) {
      setChecking(false);
      setPin('');
      toast.error('PIN incorrecto');
      return;
    }
    const { data: emp, error: empErr } = await getEmpleado(empleadoId);
    if (empErr || !emp) {
      setChecking(false);
      toast.error('No se pudo verificar el rol');
      return;
    }
    if (!emp.rol_pos || !ROLES_ADMIN.includes(emp.rol_pos)) {
      setChecking(false);
      setPin('');
      toast.error('Ese PIN no tiene acceso a Administración');
      return;
    }
    setChecking(false);
    toast.success(`Bienvenido a Admin, ${emp.nombre}`);
    onAuthorized();
  }

  function pressDigit(d: string) {
    if (checking) return;
    const next = (pin + d).slice(0, 4);
    setPin(next);
    if (next.length === 4) void validar(next);
  }
  function pressDelete() {
    if (checking) return;
    setPin((p) => p.slice(0, -1));
  }

  const digits = ['1','2','3','4','5','6','7','8','9'];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Acceso a Administración
          </DialogTitle>
          <DialogDescription>
            Ingresá el PIN de un usuario con acceso admin (encargado, manager o dueño).
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-center gap-2 py-2">
          {[0,1,2,3].map((i) => (
            <div
              key={i}
              className={cn(
                'w-3 h-3 rounded-full border-2 transition-all',
                pin.length > i ? 'bg-primary border-primary' : 'border-border',
              )}
            />
          ))}
        </div>

        <div className="grid grid-cols-3 gap-2">
          {digits.map((d) => (
            <Button
              key={d}
              variant="outline"
              size="lg"
              className="h-14 text-lg font-semibold"
              onClick={() => pressDigit(d)}
              disabled={checking}
            >
              {d}
            </Button>
          ))}
          <div />
          <Button
            variant="outline"
            size="lg"
            className="h-14 text-lg font-semibold"
            onClick={() => pressDigit('0')}
            disabled={checking}
          >
            0
          </Button>
          <Button
            variant="ghost"
            size="lg"
            className="h-14"
            onClick={pressDelete}
            disabled={checking || pin.length === 0}
          >
            <Delete className="h-5 w-5" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
