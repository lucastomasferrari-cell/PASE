// Admin Console — superadmin del ecosistema. Shell "Cocina.OS" (17-jul-2026):
// launcher de una columna (sin sidebar), status bar con dot dorado "System Live"
// + OPERATOR + reloj vivo + notificaciones + logout; hero de terminal
// root@admin:~# console.os; navegación por tabs mono; scanline CRT.
// Fuente de verdad del look: PASE/cocina/index.html.

import { useEffect, useMemo, useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { LogOut, Shield, RefreshCw } from 'lucide-react';
import { signOut, useAuth } from './lib/auth';
import { PushToggle } from './components/PushToggle';
import { Login } from './pages/Login';
import { Soporte } from './pages/Soporte';
import { Tenants } from './pages/Tenants';
import { TenantFeaturesDetalle } from './pages/TenantFeaturesDetalle';
import { TenantBilling } from './pages/TenantBilling';
import { TenantsFeaturesMatriz } from './pages/TenantsFeaturesMatriz';
import { Pagos } from './pages/Pagos';
import { Metricas } from './pages/Metricas';
import { cn } from './lib/cn';

const NAV = [
  { to: '/soporte',          num: '01', label: 'Soporte',   end: true },
  { to: '/tenants',          num: '02', label: 'Tenants',   end: true },
  { to: '/tenants/features', num: '03', label: 'Funciones', end: true },
  { to: '/pagos',            num: '04', label: 'Pagos',     end: true },
  { to: '/metricas',         num: '05', label: 'Métricas',  end: true },
] as const;

function nowHHMMSS(): string {
  const d = new Date();
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function App() {
  const auth = useAuth();
  const [horaLive, setHoraLive] = useState<string>(() => nowHHMMSS());

  useEffect(() => {
    const id = window.setInterval(() => setHoraLive(nowHHMMSS()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const operator = useMemo(() => {
    const email = auth.status === 'authenticated' ? auth.user.email : '';
    const base = (email ?? '').split('@')[0] ?? '';
    return base ? base.toUpperCase() : 'SUPERADMIN';
  }, [auth]);

  if (auth.status === 'loading') {
    return (
      <div className="min-h-screen grid place-items-center bg-admin-bg">
        <div className="scanline" />
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-admin-gold glow-dot animate-pulse" />
            <span className="mono text-[10px] font-medium tracking-[0.2em] text-admin-gold uppercase">Iniciando sistema</span>
          </div>
          <div className="mono text-3xl font-bold tracking-tight text-admin-text">
            console<span className="text-admin-gold">.</span><span className="text-admin-muted font-light text-xl">os</span>
          </div>
        </div>
      </div>
    );
  }

  if (auth.status === 'unauthenticated') return <Login />;
  if (auth.status === 'forbidden') return <Login reason={auth.reason} />;

  return (
    <div className="min-h-screen flex flex-col bg-admin-bg">
      <div className="scanline" />

      {/* Status bar. */}
      <nav className="status-bar sticky top-0 z-40 px-4 sm:px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-admin-gold glow-dot animate-pulse" />
            <span className="mono text-[10px] font-medium tracking-[0.2em] text-admin-gold uppercase">System Live</span>
          </div>
          <div className="hidden md:flex gap-4 mono text-[10px] text-admin-muted">
            <span className="flex items-center gap-1.5"><Shield className="h-3 w-3 text-admin-accent" /> SECURITY: SUPERADMIN</span>
            <span className="flex items-center gap-1.5"><RefreshCw className="h-3 w-3" /> SYNC: OK</span>
          </div>
        </div>

        <div className="flex items-center gap-3 sm:gap-4">
          <span className="mono text-[10px] text-admin-muted hidden sm:block" title={auth.user.email}>
            OPERATOR: <span className="text-admin-accent">{operator}</span>
          </span>
          <div className="h-4 w-px bg-admin-border-strong" />
          <PushToggle userId={auth.user.id} />
          <button onClick={() => { void signOut(); }} className="text-admin-muted hover:text-admin-danger inline-flex items-center gap-1.5 transition-colors" title="Cerrar sesión">
            <LogOut className="h-4 w-4" /> <span className="mono text-[10px] hidden lg:inline">TERMINATE</span>
          </button>
          <div className="h-4 w-px bg-admin-border-strong" />
          <span className="mono text-[11px] font-medium tabular-nums">{horaLive}</span>
        </div>
      </nav>

      <main className="flex-1 min-w-0 w-full max-w-[1200px] mx-auto px-4 sm:px-6 pt-8 pb-12">
        {/* Hero de terminal. */}
        <header className="mb-8 sm:mb-10 pl-1 sm:pl-2">
          <div className="mono flex items-baseline gap-2 mb-2 flex-wrap">
            <span className="text-admin-accent opacity-70">root@admin:~#</span>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
              console<span className="text-admin-gold">.</span><span className="text-admin-muted font-light text-lg sm:text-xl">os</span>
            </h1>
            <span className="cursor" />
          </div>
          <div className="mono text-[10px] text-admin-muted opacity-60 flex flex-col gap-0.5 border-l border-admin-border-strong pl-4">
            <p>&gt; AUTH_GATE: SUPERADMIN</p>
            <p>&gt; TENANT_REGISTRY: MOUNTED</p>
            <p>&gt; CONTROL_PLANE: LIVE</p>
          </div>
        </header>

        {/* Tabs de módulos. */}
        <nav className="flex gap-5 sm:gap-6 mb-10 sm:mb-12 border-b border-admin-border-strong pb-1 overflow-x-auto whitespace-nowrap scrollbar-hide">
          {NAV.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.end}
              className={({ isActive }) =>
                cn(
                  'mono text-[11px] tracking-[0.2em] uppercase pb-2 transition-colors',
                  isActive
                    ? 'font-semibold text-admin-accent border-b-2 border-admin-accent'
                    : 'font-medium text-admin-muted hover:text-admin-text',
                )
              }
            >
              {it.num} / {it.label}
            </NavLink>
          ))}
        </nav>

        {/* Contenido ruteado. */}
        <Routes>
          <Route path="/" element={<Navigate to="/soporte" replace />} />
          <Route path="/soporte" element={<Soporte />} />
          <Route path="/tenants" element={<Tenants />} />
          <Route path="/tenants/features" element={<TenantsFeaturesMatriz />} />
          <Route path="/tenants/:tenantId/features" element={<TenantFeaturesDetalle />} />
          <Route path="/tenants/:id/billing" element={<TenantBilling />} />
          <Route path="/pagos" element={<Pagos />} />
          <Route path="/metricas" element={<Metricas />} />
          <Route path="*" element={<Navigate to="/soporte" replace />} />
        </Routes>
      </main>
    </div>
  );
}
