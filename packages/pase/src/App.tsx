import { useState, useEffect, lazy, Suspense } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { db } from "./lib/supabase";
import { AuthProvider, necesitaElegirLocal, getPermisos } from "./lib/auth";
import { getDefaultRoute, LEGACY_REDIRECTS } from "./lib/sidebar-nav";
import type { Usuario, UsuarioRow, Local, Tenant } from "./types";
import { Sidebar, css } from "./components/Layout";
import Login from "./pages/Login";

// F5 (plan sunny-creek): code-splitting por página. Login queda eager porque
// es entry point para users sin sesión.
const ForcePasswordChange = lazy(() => import("./pages/ForcePasswordChange"));
const SeleccionarLocalModal = lazy(() => import("./components/SeleccionarLocalModal"));
const Ventas = lazy(() => import("./pages/Ventas"));
const Compras = lazy(() => import("./pages/Compras"));
const Caja = lazy(() => import("./pages/Caja"));
const EERR = lazy(() => import("./pages/EERR"));
const Contador = lazy(() => import("./pages/herramientas/ContadorIVA"));
const ImportarMaxirest = lazy(() => import("./pages/ImportarMaxirest"));
const Gastos = lazy(() => import("./pages/Gastos"));
const Usuarios = lazy(() => import("./pages/Usuarios"));
const Blindaje = lazy(() => import("./pages/herramientas/Blindaje"));
const PruebaConciliacion1 = lazy(() => import("./pages/herramientas/PruebaConciliacion1"));
const PruebaConciliacion2 = lazy(() => import("./pages/herramientas/PruebaConciliacion2"));
const ConciliacionBancaria = lazy(() => import("./pages/ConciliacionBancaria").then(m => ({ default: m.ConciliacionBancaria })));
const RRHHPage = lazy(() => import("./pages/RRHH"));
const Tenants = lazy(() => import("./pages/Tenants"));
const DesignSystem = lazy(() => import("./pages/DesignSystem"));
const Finanzas = lazy(() => import("./pages/Finanzas"));
const Negocio = lazy(() => import("./pages/Negocio"));
const Objetivos = lazy(() => import("./pages/Objetivos"));
const Ajustes = lazy(() => import("./pages/Ajustes"));
const DashboardHome = lazy(() => import("./dashboards/DashboardHome").then(m => ({ default: m.DashboardHome })));
const SettingsDashboards = lazy(() => import("./dashboards/SettingsDashboards"));

// Loader full-page (mismo look-and-feel que authLoading) para los
// early-returns lazy.
const FullPageLoader = () => (
  <div className="login-wrap">
    <div className="login-bg"/>
    <div className="login-card" style={{textAlign:"center",padding:40}}>Cargando...</div>
  </div>
);
// Loader inline para las rutas — la sidebar ya está montada, solo
// cargamos la página en el área principal.
const PageLoader = () => <div className="loading">Cargando...</div>;

// Solo superadmin lee/escribe esta key.
const TENANT_OVERRIDE_KEY = "pase_tenant_override__superadmin_only";

// ────────────────────────────────────────────────────────────────────
// Hash-route de dev: preview del sistema de diseño aislado.
// ────────────────────────────────────────────────────────────────────
export default function App() {
  if (typeof window !== "undefined" && window.location.hash === "#/design-system") {
    return (
      <Suspense fallback={<div style={{ padding: 40, fontFamily: "var(--pase-font)" }}>Cargando…</div>}>
        <DesignSystem />
      </Suspense>
    );
  }
  return <AppMain />;
}

// ────────────────────────────────────────────────────────────────────
// Redirect al primer item permitido para este user. Sustituye los slugs
// 'dashboard' / 'inicio' / '@default' en LEGACY_REDIRECTS.
// ────────────────────────────────────────────────────────────────────
function DefaultRedirect({ user }: { user: Usuario | null }) {
  // Sesión 16-may: todos los usuarios autenticados caen en /inicio (dashboard
  // personalizado por rol). Sin usuario → ajustes (fallback histórico).
  // El default route por rol queda como respaldo si /inicio falla.
  if (user) return <Navigate to="/inicio" replace />;
  return <Navigate to={getDefaultRoute(user)} replace />;
}

function AppMain() {
  const [user, setUser] = useState<Usuario | null>(null);
  const [locales, setLocales] = useState<Local[]>([]);
  const [localActivo, setLocalActivo] = useState<number | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [tenantOverride, setTenantOverride] = useState<string | null>(null);
  // Bug #27: bloquea navegación mientras encargado con >1 local no elige uno.
  const [showLocalModal, setShowLocalModal] = useState(false);

  // Persistir localActivo en sessionStorage.
  useEffect(() => {
    if (localActivo != null) {
      sessionStorage.setItem("pase_local_activo", String(localActivo));
    } else {
      sessionStorage.removeItem("pase_local_activo");
    }
  }, [localActivo]);

  const refetchLocales = async () => {
    const { data } = await db.from("locales").select("*").order("id");
    setLocales(data || []);
  };

  useEffect(()=>{
    if (!user) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refetchLocales();
  },[user]);

  // Restaurar sesión al cargar.
  useEffect(()=>{
    const restore = async () => {
      try {
        const { data: { session } } = await db.auth.getSession();
        if (session?.user) {
          const { data: perfil } = await db.from("usuarios").select("*").eq("auth_id", session.user.id).single();
          if (perfil && perfil.activo !== false) {
            // eslint-disable-next-line react-hooks/immutability
            await applyLogin(perfil);
          } else {
            await db.auth.signOut();
          }
        }
      } catch { /* auth restore puede fallar (sin sesión / network) — no crítico */ }
      setAuthLoading(false);
    };
    restore();

    const { data: { subscription } } = db.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_OUT") {
        setUser(null);
        setLocalActivo(null);
        setShowLocalModal(false);
        setTenant(null);
        setTenantOverride(null);
        sessionStorage.removeItem("pase_user");
        sessionStorage.removeItem("pase_local_activo");
        sessionStorage.removeItem(TENANT_OVERRIDE_KEY);
        localStorage.removeItem("pase_uid");
        return;
      }
      if ((event === "SIGNED_IN" || event === "INITIAL_SESSION") && session?.user) {
        setUser(curr => {
          if (curr) return curr;
          db.from("usuarios").select("*").eq("auth_id", session.user.id).single().then(({ data: perfil }) => {
            if (perfil && perfil.activo !== false) applyLogin(perfil);
          });
          return curr;
        });
        return;
      }
      if (event === "TOKEN_REFRESHED" && session?.user) {
        refetchLocales();
        return;
      }
      if (event === "USER_UPDATED" && session?.user) {
        const { data: perfil } = await db.from("usuarios")
          .select("*").eq("auth_id", session.user.id).single();
        if (perfil) {
          setUser(curr => curr ? { ...curr, ...perfil } as Usuario : curr);
        }
        return;
      }
    });
    return () => subscription.unsubscribe();
  },[]);

  const applyLogin = async (u: UsuarioRow) => {
    const [{ data: permsData }, { data: locsData }] = await Promise.all([
      db.from("usuario_permisos").select("modulo_slug").eq("usuario_id", u.id),
      db.from("usuario_locales").select("local_id").eq("usuario_id", u.id),
    ]);
    const enriched: Usuario = {
      ...u,
      _permisos: (permsData || []).map((p: { modulo_slug: string }) => p.modulo_slug),
      _locales: (locsData || []).length ? (locsData || []).map((l: { local_id: number }) => l.local_id) : (u.locales || []),
    };
    setUser(enriched);
    sessionStorage.setItem("pase_user", JSON.stringify(enriched));
    // El routing ahora se maneja con React Router — la URL actual queda
    // si era válida; LegacyRedirects o el catch-all redirigen si no.

    if (enriched.rol !== "superadmin") {
      try { sessionStorage.removeItem(TENANT_OVERRIDE_KEY); } catch { /* idem */ }
    }
    const overrideUuid = enriched.rol === "superadmin" ? sessionStorage.getItem(TENANT_OVERRIDE_KEY) : null;
    const tenantUuidToLoad = overrideUuid || enriched.tenant_id;
    if (tenantUuidToLoad) {
      const { data: t } = await db.from("tenants").select("*").eq("id", tenantUuidToLoad).single();
      if (t) {
        setTenant(t as Tenant);
        setTenantOverride(overrideUuid);
      }
    } else {
      setTenant(null);
      setTenantOverride(null);
    }

    const storedRaw = sessionStorage.getItem("pase_local_activo");
    const stored = storedRaw ? parseInt(storedRaw) : null;
    const decision = necesitaElegirLocal(enriched, stored);
    if (decision.action === "setActivo") {
      setLocalActivo(decision.localId!);
      setShowLocalModal(false);
    } else if (decision.action === "showModal") {
      setLocalActivo(null);
      setShowLocalModal(true);
    } else {
      setShowLocalModal(false);
    }
  };

  const clearTenantOverride = () => {
    sessionStorage.removeItem(TENANT_OVERRIDE_KEY);
    window.location.reload();
  };

  const login = (u: UsuarioRow) => {
    applyLogin(u);
  };

  const logout = async () => {
    await db.auth.signOut();
  };

  const props: { user: Usuario; locales: Local[]; localActivo: number | null } = { user: user!, locales, localActivo };

  if (authLoading) return <><style>{css}</style><div className="login-wrap"><div className="login-bg"/><div className="login-card" style={{textAlign:"center",padding:40}}>Cargando...</div></div></>;

  if(!user) return <><style>{css}</style><Login onLogin={login}/></>;

  if (user.password_temporal) return <><style>{css}</style><Suspense fallback={<FullPageLoader/>}><ForcePasswordChange user={user} onDone={() => {
    if (!user) return;
    const updated: Usuario = { ...user, password_temporal: false };
    setUser(updated);
    sessionStorage.setItem("pase_user", JSON.stringify(updated));
  }}/></Suspense></>;

  if (showLocalModal) return <><style>{css}</style><Suspense fallback={<FullPageLoader/>}><SeleccionarLocalModal user={user} locales={locales} onConfirm={(id) => {
    setLocalActivo(id);
    setShowLocalModal(false);
  }}/></Suspense></>;

  return (
    <AuthProvider value={user}>
      <style>{css}</style>
      <div className="app">
        {/* Fondo decorativo */}
        <div style={{
          position: "fixed", inset: 0, zIndex: 0, overflow: "hidden", pointerEvents: "none"
        }}>
          <div style={{
            position: "absolute", top: "-20%", left: "10%",
            width: 600, height: 600, borderRadius: "50%",
            background: "radial-gradient(circle, rgba(168,137,58,0.12) 0%, transparent 70%)",
            filter: "blur(40px)"
          }}/>
          <div style={{
            position: "absolute", bottom: "-10%", right: "5%",
            width: 500, height: 500, borderRadius: "50%",
            background: "radial-gradient(circle, rgba(90,143,168,0.08) 0%, transparent 70%)",
            filter: "blur(40px)"
          }}/>
        </div>
        <div style={{position:"relative",zIndex:2}}>
          <Sidebar user={user}
            onLogout={logout}
            locales={locales} localActivo={localActivo} setLocalActivo={setLocalActivo}
            tenant={tenant} tenantOverride={tenantOverride} onClearOverride={clearTenantOverride}/>
        </div>
        <main className="main" style={{position:"relative",zIndex:1}}>
          <Suspense fallback={<PageLoader/>}>
            <Routes>
              {/* Root → primer item permitido (con user → /inicio) */}
              <Route path="/" element={<DefaultRedirect user={user} />} />

              {/* Dashboard personalizado por rol (sesión 16-may) */}
              <Route
                path="/inicio"
                element={
                  user ? (
                    <DashboardHome
                      usuario={{
                        id: user.id,
                        nombre: user.nombre,
                        rol: (user.rol as "dueno" | "admin" | "encargado" | "compras" | "cajero" | "superadmin"),
                        tenant_id: user.tenant_id ?? null,
                      }}
                      permisos={getPermisos(user)}
                      locales={locales}
                      localActivo={localActivo}
                    />
                  ) : (
                    <Navigate to="/" replace />
                  )
                }
              />
              <Route
                path="/ajustes/dashboards"
                element={
                  user?.tenant_id ? <SettingsDashboards tenantId={user.tenant_id} /> : <Navigate to="/inicio" replace />
                }
              />

              {/* Operación */}
              <Route path="/caja/*" element={<Caja {...props}/>} />
              <Route path="/compras/*" element={<Compras {...props}/>} />
              <Route path="/ventas" element={<Ventas {...props}/>} />

              {/* Dirección */}
              <Route path="/negocio" element={<Negocio user={user || undefined} locales={locales}/>} />
              <Route path="/finanzas" element={<Finanzas locales={locales}/>} />
              <Route path="/objetivos" element={<Objetivos/>} />
              <Route path="/reportes" element={<EERR {...props}/>} />

              {/* Herramientas */}
              <Route path="/equipo" element={<RRHHPage {...props}/>} />
              <Route path="/herramientas/contador-iva" element={<Contador {...props}/>} />
              <Route path="/herramientas/blindaje" element={<Blindaje {...props}/>} />
              <Route path="/herramientas/prueba-conciliacion-1" element={<PruebaConciliacion1 {...props}/>} />
              <Route path="/herramientas/prueba-conciliacion-2" element={<PruebaConciliacion2 {...props}/>} />
              <Route path="/herramientas/conciliacion-bancaria" element={<ConciliacionBancaria />} />

              {/* Sistema */}
              <Route path="/ajustes" element={<Ajustes/>} />

              {/* Accesibles internamente (no en sidebar top-level) */}
              <Route path="/gastos" element={<Gastos {...props}/>} />
              <Route path="/usuarios" element={<Usuarios {...props}/>} />
              <Route path="/maxirest" element={<ImportarMaxirest {...props}/>} />
              <Route path="/tenants" element={user.rol === "superadmin" ? <Tenants user={user as Usuario} /> : <DefaultRedirect user={user} />} />

              {/* Redirects de URLs viejas */}
              {Object.entries(LEGACY_REDIRECTS).map(([from, to]) => (
                <Route
                  key={from}
                  path={from}
                  element={
                    to === "@default"
                      ? <DefaultRedirect user={user} />
                      : <Navigate to={to} replace />
                  }
                />
              ))}

              {/* Catch-all → primer permitido */}
              <Route path="*" element={<NotFoundRedirect user={user} />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </AuthProvider>
  );
}

function NotFoundRedirect({ user }: { user: Usuario | null }) {
  const location = useLocation();
  // Si la URL incluye uno de los path prefixes válidos (ej. /compras/notas-credito),
  // dejamos que la ruta interna del componente la maneje. El catch-all solo se
  // dispara para paths completamente desconocidos.
  // Para evitar loop, sólo log y redirect a default.
  if (typeof console !== "undefined") {
    console.warn("[router] path no encontrado:", location.pathname);
  }
  return <DefaultRedirect user={user} />;
}
