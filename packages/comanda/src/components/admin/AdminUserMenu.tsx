import { useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/lib/auth';
import { db } from '@/lib/supabase';

// Menú de usuario del PANEL ADMIN. A diferencia de UserAvatarMenu (que depende
// del empleado POS/PIN y en el admin no aparece), este usa la sesión Supabase
// (useAuth → user de comanda_usuarios). Sirve para que en el admin siempre se
// vea CON QUÉ CUENTA estás logueado y puedas cerrar sesión — antes no había
// forma de saberlo ni de salir si entraste por email sin PIN.
export function AdminUserMenu() {
  const { user } = useAuth();
  const navigate = useNavigate();

  if (!user) return null;

  const nombre = user.nombre || user.email || 'Usuario';
  const initial = nombre[0]?.toUpperCase() ?? '?';

  async function cerrarSesion() {
    await db.auth.signOut();
    navigate('/login', { replace: true });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-full pl-1 pr-2 h-9 hover:bg-muted transition-colors touch-target"
          aria-label="Menú de usuario"
        >
          <span className="w-7 h-7 rounded-full bg-primary text-primary-foreground font-medium text-sm flex items-center justify-center shrink-0">
            {initial}
          </span>
          <span className="hidden md:block text-sm text-muted-foreground max-w-[140px] truncate">
            {nombre}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>
          <div className="text-sm font-medium truncate">{user.nombre || user.email}</div>
          {user.email && user.email !== user.nombre && (
            <div className="text-xs text-muted-foreground truncate">{user.email}</div>
          )}
          <div className="text-xs text-muted-foreground capitalize">{user.rol_pos}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={cerrarSesion}
          className="text-destructive focus:text-destructive"
        >
          <LogOut className="h-4 w-4 mr-2" /> Cerrar sesión
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
