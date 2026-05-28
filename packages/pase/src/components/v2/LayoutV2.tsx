// PASE V2 — Layout (sidebar + topbar + main)
//
// Layout único para todas las pantallas /v2/*. Reemplaza al Layout viejo
// solo en las rutas v2 — el sistema viejo (/equipo, /caja, etc) sigue
// usando el sidebar viejo en Layout.tsx hasta que termine la migración.
//
// Reglas:
// - Paleta v2 estricta (celeste + dorado + blanco + grises)
// - Sin emojis, iconos Lucide line
// - Sidebar fijo izquierda 220px (desktop) / drawer (mobile)
// - Topbar con selector de local + tenant info + user menu
// - Sin animaciones gratuitas

import { useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import type { Local, Tenant } from "../../types";
import {
  Home, Wallet, ShoppingCart, DollarSign, Receipt, Users,
  TrendingUp, Briefcase, Target, FileBarChart, Wrench, Settings,
  UserCog, Building2, Menu, X, LogOut, ChevronDown,
} from "lucide-react";

const WrenchIcon = Wrench;

interface NavItem {
  path: string;
  label: string;
  icon: ReactNode;
  section: "Operación" | "Dirección" | "Sistema";
}

const NAV_ITEMS: NavItem[] = [
  { path: "/v2/inicio",    label: "Inicio",       icon: <Home size={15} />,        section: "Operación" },
  { path: "/v2/caja",      label: "Caja",         icon: <Wallet size={15} />,      section: "Operación" },
  { path: "/v2/ventas",    label: "Ventas",       icon: <DollarSign size={15} />,  section: "Operación" },
  { path: "/v2/compras",   label: "Compras",      icon: <ShoppingCart size={15} />, section: "Operación" },
  { path: "/v2/gastos",    label: "Gastos",       icon: <Receipt size={15} />,     section: "Operación" },
  { path: "/v2/equipo",    label: "Equipo",       icon: <Users size={15} />,       section: "Operación" },
  { path: "/v2/stock",     label: "Stock",        icon: <TrendingUp size={15} />,  section: "Operación" },

  { path: "/v2/negocio",   label: "Negocio",      icon: <Briefcase size={15} />,   section: "Dirección" },
  { path: "/v2/finanzas",  label: "Finanzas",     icon: <Building2 size={15} />,   section: "Dirección" },
  { path: "/v2/objetivos", label: "Objetivos",    icon: <Target size={15} />,      section: "Dirección" },
  { path: "/v2/reportes",  label: "Reportes",     icon: <FileBarChart size={15} />, section: "Dirección" },

  { path: "/v2/herramientas", label: "Herramientas", icon: <WrenchIcon size={15} />, section: "Sistema" },
  { path: "/v2/ajustes",   label: "Ajustes",      icon: <Settings size={15} />,    section: "Sistema" },
  { path: "/v2/usuarios",  label: "Usuarios",     icon: <UserCog size={15} />,     section: "Sistema" },
];

interface LayoutV2Props {
  children: ReactNode;
  locales: Local[];
  localActivo: number | null;
  setLocalActivo: (id: number | null) => void;
  tenant: Tenant | null;
  onLogout: () => void | Promise<void>;
}

export function LayoutV2({
  children, locales, localActivo, setLocalActivo, tenant, onLogout,
}: LayoutV2Props) {
  const { user } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navigate = useNavigate();

  if (!user) return <>{children}</>;

  const sections = Array.from(new Set(NAV_ITEMS.map(i => i.section)));
  const localActual = locales.find(l => l.id === localActivo);

  return (
    <div className="v2" style={{
      display: "flex",
      minHeight: "100vh",
      background: "var(--v2-bg)",
      color: "var(--v2-text)",
    }}>
      {/* === HAMBURGUESA MOBILE === */}
      <button
        onClick={() => setDrawerOpen(true)}
        style={{
          display: "none",
          position: "fixed",
          top: 12, left: 12, zIndex: 1100,
          background: "var(--v2-bg-3)",
          border: "1px solid var(--v2-border)",
          color: "var(--v2-text)",
          padding: "8px 10px",
          borderRadius: "var(--v2-radius-sm)",
          cursor: "pointer",
        }}
        className="v2-mobile-only"
        aria-label="Menú"
      >
        <Menu size={18} />
      </button>

      {/* === OVERLAY mobile === */}
      {drawerOpen && (
        <div
          onClick={() => setDrawerOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 999,
          }}
        />
      )}

      {/* === SIDEBAR === */}
      <aside
        className={`v2-sidebar ${drawerOpen ? "open" : ""}`}
        style={{
          width: 220,
          background: "var(--v2-bg-2)",
          borderRight: "1px solid var(--v2-border)",
          padding: "var(--v2-space-5) var(--v2-space-3)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--v2-space-5)",
          position: "sticky",
          top: 0,
          height: "100vh",
          overflowY: "auto",
          flexShrink: 0,
        }}
      >
        {/* Brand */}
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 var(--v2-space-2)",
        }}>
          <div>
            <div style={{
              fontFamily: "var(--v2-font-body)",
              fontSize: "22px",
              fontWeight: 500,
              color: "var(--v2-text-strong)",
              letterSpacing: "-0.04em",
              lineHeight: 1,
            }}>
              pase<span style={{ color: "var(--v2-dorado)" }}>.</span>
            </div>
            <div style={{
              fontSize: "10px",
              color: "var(--v2-text-subtle)",
              letterSpacing: "0.05em",
              marginTop: 2,
            }}>
              aliado gastronómico
            </div>
          </div>
          <button
            onClick={() => setDrawerOpen(false)}
            style={{
              display: "none",
              background: "transparent",
              border: "none",
              color: "var(--v2-text-muted)",
              cursor: "pointer",
            }}
            className="v2-mobile-only"
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        {/* Selector local */}
        {locales.length > 0 && (
          <div style={{
            padding: "var(--v2-space-2) var(--v2-space-2)",
          }}>
            <select
              value={localActivo ?? ""}
              onChange={e => setLocalActivo(Number(e.target.value))}
              style={{
                width: "100%",
                background: "var(--v2-bg-3)",
                border: "1px solid var(--v2-border)",
                borderRadius: "var(--v2-radius-sm)",
                color: "var(--v2-text)",
                padding: "8px 10px",
                fontSize: "var(--v2-fs-sm)",
                fontFamily: "var(--v2-font-body)",
                cursor: "pointer",
                outline: "none",
              }}
            >
              {locales.map(l => (
                <option key={l.id} value={l.id}>{l.nombre}</option>
              ))}
            </select>
          </div>
        )}

        {/* Nav */}
        <nav style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--v2-space-4)",
          flex: 1,
        }}>
          {sections.map(sec => (
            <div key={sec}>
              <div className="v2-eyebrow" style={{
                padding: "0 var(--v2-space-2)",
                marginBottom: "var(--v2-space-2)",
                fontSize: "10px",
              }}>
                {sec}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {NAV_ITEMS.filter(i => i.section === sec).map(item => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    onClick={() => setDrawerOpen(false)}
                    end
                    style={({ isActive }) => ({
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--v2-space-3)",
                      padding: "8px var(--v2-space-2)",
                      borderRadius: "var(--v2-radius-sm)",
                      textDecoration: "none",
                      fontSize: "var(--v2-fs-sm)",
                      fontWeight: isActive ? 600 : 500,
                      color: isActive ? "var(--v2-celeste)" : "var(--v2-text-muted)",
                      background: isActive ? "var(--v2-celeste-dim)" : "transparent",
                      transition: "all var(--v2-tr-fast)",
                    })}
                  >
                    {item.icon}
                    {item.label}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* User */}
        <div style={{
          borderTop: "1px solid var(--v2-border)",
          padding: "var(--v2-space-3) var(--v2-space-2) 0",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--v2-space-2)",
        }}>
          <div style={{ overflow: "hidden", flex: 1 }}>
            <div style={{
              fontSize: "var(--v2-fs-sm)",
              fontWeight: 600,
              color: "var(--v2-text-strong)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}>
              {user.nombre}
            </div>
            <div style={{
              fontSize: "var(--v2-fs-xs)",
              color: "var(--v2-text-subtle)",
              textTransform: "capitalize",
            }}>
              {user.rol}
            </div>
          </div>
          <button
            onClick={() => onLogout()}
            style={{
              background: "transparent",
              border: "1px solid var(--v2-border)",
              color: "var(--v2-text-muted)",
              padding: "6px 8px",
              borderRadius: "var(--v2-radius-sm)",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
            }}
            aria-label="Cerrar sesión"
            title="Cerrar sesión"
          >
            <LogOut size={14} />
          </button>
        </div>
      </aside>

      {/* === MAIN === */}
      <main style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
      }}>
        {/* Topbar */}
        <div style={{
          height: 48,
          borderBottom: "1px solid var(--v2-border)",
          background: "var(--v2-bg-2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 var(--v2-space-5)",
          position: "sticky",
          top: 0,
          zIndex: 50,
        }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--v2-space-3)",
          }}>
            <span style={{
              fontSize: "10px",
              fontWeight: 700,
              background: "var(--v2-celeste-dim)",
              color: "var(--v2-celeste)",
              border: "1px solid rgba(110, 181, 255, 0.30)",
              padding: "2px 7px",
              borderRadius: "4px",
              letterSpacing: "0.5px",
            }}>
              V2 BETA
            </span>
            {tenant && (
              <span style={{
                fontSize: "var(--v2-fs-xs)",
                color: "var(--v2-text-subtle)",
              }}>
                {tenant.nombre}
              </span>
            )}
            {localActual && (
              <>
                <span style={{ color: "var(--v2-text-subtle)" }}>·</span>
                <span style={{
                  fontSize: "var(--v2-fs-xs)",
                  color: "var(--v2-text)",
                  fontWeight: 600,
                }}>
                  {localActual.nombre}
                </span>
              </>
            )}
          </div>

          <button
            onClick={() => navigate("/inicio")}
            style={{
              background: "transparent",
              border: "1px solid var(--v2-border)",
              color: "var(--v2-text-muted)",
              padding: "4px 10px",
              borderRadius: "var(--v2-radius-sm)",
              cursor: "pointer",
              fontSize: "var(--v2-fs-xs)",
              fontFamily: "var(--v2-font-body)",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
            title="Volver al sistema viejo"
          >
            <ChevronDown size={12} style={{ transform: "rotate(90deg)" }} />
            Sistema viejo
          </button>
        </div>

        {/* Contenido */}
        <div style={{
          flex: 1,
          padding: "var(--v2-space-6)",
          maxWidth: "100%",
          minWidth: 0,
        }}>
          {children}
        </div>
      </main>

      {/* === Mobile responsive === */}
      <style>{`
        @media (max-width: 768px) {
          .v2-mobile-only { display: inline-flex !important; }
          .v2-sidebar {
            position: fixed !important;
            left: -260px;
            top: 0;
            z-index: 1000;
            transition: left var(--v2-tr-base);
          }
          .v2-sidebar.open {
            left: 0;
          }
        }
      `}</style>
    </div>
  );
}
