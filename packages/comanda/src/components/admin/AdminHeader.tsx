import { Menu, Bell, ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ThemeToggle';
import { UserAvatarMenu } from '@/components/UserAvatarMenu';
import { AdminBreadcrumb } from './AdminBreadcrumb';

interface Props {
  // Callback que abre el drawer del sidebar en mobile.
  onOpenSidebar?: () => void;
}

// Header sticky del admin: hamburguesa (mobile), breadcrumb, notificaciones
// stub. El avatar vive en el sidebar (footer) en este sprint para evitar
// duplicar el dropdown.
//
// Nota: el buscador global se sacó (27-jun) — era un stub con placeholder
// confuso ("Buscar items, mesas, empleados…" sonaba a POS). Cuando se
// implemente buscador real, se agrega de vuelta con placeholder admin-aware.
export function AdminHeader({ onOpenSidebar }: Props) {
  const navigate = useNavigate();
  return (
    <header className="sticky top-0 z-20 bg-card border-b border-border h-14 flex items-center px-4 gap-2">
      {/* Hamburguesa mobile */}
      {onOpenSidebar && (
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          onClick={onOpenSidebar}
          aria-label="Abrir menú"
        >
          <Menu className="h-5 w-5" />
        </Button>
      )}

      {/* Breadcrumb (ocupa todo el ancho) */}
      <div className="flex-1 min-w-0">
        <AdminBreadcrumb />
      </div>

      {/* Cluster derecho: Volver al POS · tema · notificaciones · usuario */}
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 shrink-0"
        onClick={() => navigate('/pos')}
      >
        <ArrowLeft className="h-4 w-4" />
        <span className="hidden sm:inline">Volver al POS</span>
      </Button>

      <ThemeToggle />

      <Button
        variant="ghost"
        size="icon"
        onClick={() => toast.info('Notificaciones', {
          description: 'Próximamente — alertas de pedidos nuevos, cierres de turno, errores de impresora, etc.',
        })}
        aria-label="Notificaciones"
        className="relative"
      >
        <Bell className="h-4 w-4" />
      </Button>

      <UserAvatarMenu />
    </header>
  );
}
