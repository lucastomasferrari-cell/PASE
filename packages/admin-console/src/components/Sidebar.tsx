import { NavLink } from 'react-router-dom';
import { LifeBuoy, Building2, Wallet, BarChart3, LogOut } from 'lucide-react';
import { signOut } from '@/lib/auth';
import type { AdminUser } from '@/lib/auth';
import { cn } from '@/lib/cn';

interface Props {
  user: AdminUser;
}

const NAV = [
  { to: '/soporte',  label: 'Soporte',  icon: LifeBuoy,  badge: null },
  { to: '/tenants',  label: 'Tenants',  icon: Building2, badge: 'soon' },
  { to: '/pagos',    label: 'Pagos',    icon: Wallet,    badge: 'soon' },
  { to: '/metricas', label: 'Métricas', icon: BarChart3, badge: 'soon' },
] as const;

export function Sidebar({ user }: Props) {
  return (
    <aside className="w-56 shrink-0 bg-admin-surface border-r border-admin-border flex flex-col">
      <div className="px-4 py-5 border-b border-admin-border">
        <div className="text-xs uppercase tracking-wider text-admin-muted">PASE</div>
        <div className="text-base font-semibold text-admin-text mt-0.5">Admin Console</div>
      </div>
      <nav className="flex-1 py-3 px-2 space-y-0.5">
        {NAV.map(({ to, label, icon: Icon, badge }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors',
                isActive
                  ? 'bg-admin-accent/15 text-admin-accent'
                  : 'text-admin-text hover:bg-admin-border/40',
              )
            }
          >
            <Icon className="w-4 h-4 shrink-0" />
            <span className="flex-1">{label}</span>
            {badge === 'soon' && (
              <span className="text-[9px] uppercase tracking-wider text-admin-muted bg-admin-border px-1.5 py-0.5 rounded">
                soon
              </span>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-admin-border p-3 text-xs">
        <div className="text-admin-muted">Logueado como</div>
        <div className="text-admin-text truncate" title={user.email}>
          {user.nombre || user.email}
        </div>
        <button
          type="button"
          onClick={() => { void signOut(); }}
          className="mt-2 flex items-center gap-1.5 text-admin-muted hover:text-admin-danger transition-colors"
        >
          <LogOut className="w-3.5 h-3.5" />
          Cerrar sesión
        </button>
      </div>
    </aside>
  );
}
