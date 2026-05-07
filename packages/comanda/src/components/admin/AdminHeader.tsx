import { useState } from 'react';
import { Menu, Search, Bell } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { AdminBreadcrumb } from './AdminBreadcrumb';

interface Props {
  // Callback que abre el drawer del sidebar en mobile.
  onOpenSidebar?: () => void;
}

// Header sticky del admin: hamburguesa (mobile), buscador stub,
// notificaciones stub, breadcrumb. El avatar vive en el sidebar
// (footer) en este sprint para evitar duplicar el dropdown.
export function AdminHeader({ onOpenSidebar }: Props) {
  const [searchValue, setSearchValue] = useState('');

  return (
    <header className="sticky top-0 z-20 bg-card border-b border-border h-14 flex items-center px-4 gap-3">
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

      {/* Buscador stub: input visual sin handler real */}
      <div className="hidden md:flex items-center gap-2 flex-1 max-w-md">
        <div className="relative w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            type="search"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            onFocus={() => toast.info('Buscador global', {
              description: 'Próximamente — vas a poder buscar items, mesas, empleados, ventas desde acá.',
            })}
            placeholder="Buscar items, mesas, empleados…"
            className="w-full h-9 pl-9 pr-3 rounded-md border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
          />
        </div>
      </div>

      {/* Breadcrumb (oculta en mobile cuando hay buscador para no apretar) */}
      <div className="hidden lg:block flex-1">
        <AdminBreadcrumb />
      </div>

      {/* Spacer mobile (cuando NO hay buscador) */}
      <div className="md:hidden flex-1">
        <AdminBreadcrumb />
      </div>

      {/* Notificaciones stub */}
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
    </header>
  );
}
