import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, KeyRound, Lock, LogOut } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuthPos } from '@/lib/authPos';
import { db } from '@/lib/supabase';
import { CambiarPinDialog } from './CambiarPinDialog';

// Avatar dropdown que reemplaza los íconos sueltos del header viejo.
// Acciones:
//  - Cambiar cajero (logout POS, vuelve al PinPad).
//  - Cambiar PIN (abre CambiarPinDialog).
//  - Bloquear pantalla (logout POS, mismo que cambiar cajero).
//  - Cerrar sesión (logout POS + Supabase, vuelve a /login).
export function UserAvatarMenu() {
  const { empleado, logout: logoutPos } = useAuthPos();
  const navigate = useNavigate();
  const [cambiarPinOpen, setCambiarPinOpen] = useState(false);

  if (!empleado) return null;

  const initial = empleado.nombre?.[0]?.toUpperCase() ?? '?';

  async function logoutFull() {
    logoutPos();
    await db.auth.signOut();
    navigate('/login', { replace: true });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="w-9 h-9 rounded-full bg-primary text-primary-foreground font-medium text-sm hover:bg-primary-hover transition-colors touch-target flex items-center justify-center"
            aria-label="Menú de usuario"
          >
            {initial}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>
            <div className="text-sm font-medium">{empleado.nombre}</div>
            <div className="text-xs text-muted-foreground capitalize">{empleado.rol_pos}</div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={logoutPos}>
            <User className="h-4 w-4 mr-2" /> Cambiar cajero
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setCambiarPinOpen(true)}>
            <KeyRound className="h-4 w-4 mr-2" /> Cambiar PIN
          </DropdownMenuItem>
          <DropdownMenuItem onClick={logoutPos}>
            <Lock className="h-4 w-4 mr-2" /> Bloquear pantalla
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={logoutFull}
            className="text-destructive focus:text-destructive"
          >
            <LogOut className="h-4 w-4 mr-2" /> Cerrar sesión
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CambiarPinDialog
        open={cambiarPinOpen}
        onOpenChange={setCambiarPinOpen}
        empleadoId={empleado.id}
      />
    </>
  );
}
