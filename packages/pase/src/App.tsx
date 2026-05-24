import { useState, useEffect, lazy, Suspense } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { db } from "./lib/supabase";
import { initConsoleCapture } from "./lib/consoleCapture";
// Capturar errores de consola desde el boot, ANTES de cualquier otro código.
// Los errores capturados se incluyen en tickets de soporte para que el agent
// auto-fix tenga contexto del browser cuando diagnostica.
initConsoleCapture();
import { AuthProvider, necesitaElegirLocal, getPermisos, tienePermiso } from "./lib/auth";
import { getDefaultRoute, LEGACY_REDIRECTS } from "./lib/sidebar-nav";
import type { Usuario, UsuarioRow, Local, Tenant } from "./types";
import { Sidebar, css } from "./components/Layout";
import { SoporteWidget } from "./components/SoporteWidget";
import Login from "./pages/Login";
// Nota 2026-05-20: el chunk load error está cubierto via listener global en
// main.tsx (installChunkLoadErrorHandler) + ErrorBoundary. NO usamos un
// wrapper custom sobre React.lazy() — el wrapper introducía un re-render
// extra que causaba inconsistencia de hooks en /equipo (React error #310).
// El listener global es suficiente porque captura el error en
// `unhandledrejection`, antes de que React intente renderizar el fallback.

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
const RolesPermisos = lazy(() => import("./pages/RolesPermisos"));
const Blindaje = lazy(() => import("./pages/herramientas/Blindaje"));
const ConciliacionBancaria = lazy(() => import("./pages/ConciliacionBancaria").then(m => ({ default: m.ConciliacionBancaria })));
const RRHHPage = lazy(() => import("./pages/RRHH"));
const Tenants = lazy(() => import("./pages/Tenants"));
const DesignSystem = lazy(() => import("./pages/DesignSystem"));
const Finanzas = lazy(() => import("./pages/Finanzas"));
const Rentabilidad = lazy(() => import("./pages/Rentabilidad"));
const MensajeriaIG = lazy(() => import("./pages/MensajeriaIG"));
const Negocio = lazy(() => import("./pages/Negocio"));
const Objetivos = lazy(() => import("./pages/Objetivos"));
const Ajustes = lazy(() => import("./pages/Ajustes"));
const Importar = lazy(() => import("./pages/Importar"));
const LectorExtractoMP = lazy(() => import("./pages/LectorExtractoMP"));
// Reservas import sacado 2026-05-18 — la ruta /reservas redirige a /inicio
// (ver más abajo). El archivo Reservas.tsx queda en el código por si se
// reintroduce o se migra a COMANDA.
// const Reservas = lazy(() => import("./pages/Reservas"));
const CodigosManager = lazy(() => import("./pages/CodigosManager"));
const ConfiguracionNotificaciones = lazy(() => import("./pages/ConfiguracionNotificaciones"));
const UsuariosComanda = lazy(() => import("./pages/UsuariosComanda"));
const HerramientasHub = lazy(() => import("./pages/HerramientasHub"));
const DashboardHome = lazy(() => import("./dashboards/DashboardHome").then(m => ({ default: m.DashboardHome })));
const SettingsDashboards = lazy(() => import("./dashboards/SettingsDashboards"));

// Loader full-page con el logo "pase." centrado + barra de progreso
// animada en celeste. Reemplazó al "Cargando..." crudo (2026-05-17).
const FullPageLoader = () => (
  <div className="pase-loader-fullpage">
    <div className="pase-loader-brand">
      pase<span style={{color:"var(--pase-gold)"}}>.</span>
    </div>
    <div className="pase-loader-sub">aliado gastronómico</div>
    <div className="pase-loader-bar"><div className="pase-loader-bar-fill"/></div>
    <style>{`
      .pase-loader-fullpage {
        position: fixed; inset: 0;
        background: var(--pase-bg, #0E1726);
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        gap: 8px;
        z-index: 9999;
        font-family: "Inter", system-ui, sans-serif;
      }
      .pase-loader-brand {
        font-size: 38px; font-weight: 500;
        color: var(--pase-text, #F0F4F8);
        letter-spacing: -0.035em;
        line-height: 1;
      }
      .pase-loader-sub {
        font-size: 11px;
        color: var(--pase-text-muted, #93A8C2);
        letter-spacing: 0.04em;
        margin-bottom: 24px;
      }
      .pase-loader-bar {
        width: 180px; height: 2px;
        background: rgba(117, 170, 219, 0.15);
        border-radius: 999px; overflow: hidden;
        position: relative;
      }
      .pase-loader-bar-fill {
        position: absolute; top: 0; left: -40%;
        width: 40%; height: 100%;
        background: var(--pase-celeste, #75AADB);
        border-radius: 999px;
        animation: pase-loader-slide 1.2s ease-in-out infinite;
      }
      @keyframes pase-loader-slide {
        0% { left: -40%; }
        100% { left: 100%; }
      }
    `}</style>
  </div>
);
// Loader inline para cambio de ruta — sidebar ya está montada, solo
// se carga el área principal. Usa el mismo brand pero más compacto.
const PageLoader = () => (
  <div style={{
    padding: "60px 24px", display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center", gap: 6,
  }}>
    <div style={{
      fontSize: 24, fontWeight: 500,
      color: "var(--pase-text)", letterSpacing: "-0.035em", lineHeight: 1,
    }}>pase<span style={{color:"var(--pase-gold)"}}>.</span></div>
    <div style={{
      width: 120, height: 2, background: "rgba(117, 170, 219, 0.15)",
      borderRadius: 999, overflow: "hidden", position: "relative", marginTop: 8,
    }}>
      <div style={{
        position: "absolute", top: 0, left: "-40%", width: "40%", height: "100%",
        background: "var(--pase-celeste)", borderRadius: 999,
        animation: "pase-loader-slide 1.2s ease-in-out infinite",
      }}/>
    </div>
  </div>
);

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
    // Optimización egress 2026-05-17: proyectar solo lo que se renderiza.
    // Locales puede tener columnas pesadas (slug marketplace, fotos, JSON
    // de horarios). El sidebar y picker solo necesitan id+nombre+tenant_id.
    const { data } = await db.from("locales").select("id, nombre, tenant_id, provincia, localidad").order("id");
    const nuevos = data || [];
    setLocales(nuevos);
    // Decisión Lucas 2026-05-17: ya no existe modo "Todas las sucursales".
    // El sidebar siempre tiene UNA activa. Si localActivo es null acá, lo
    // default-eamos al primer local visible para el user. Sin esto algunas
    // pantallas se renderizarían en modo consolidado que ya no es válido.
    if (localActivo == null && nuevos.length > 0 && user) {
      const visibles = (user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin")
        ? nuevos
        : nuevos.filter(l => (user._locales || user.locales || []).includes(l.id));
      if (visibles.length > 0) {
        // Intentar restaurar el último seleccionado en sessionStorage.
        const stored = sessionStorage.getItem("pase_local_activo");
        const storedId = stored ? parseInt(stored) : NaN;
        const pre = !isNaN(storedId) && visibles.some(l => l.id === storedId) ? storedId : visibles[0]!.id;
        setLocalActivo(pre);
      }
    }
  };

  useEffect(()=>{
    if (!user) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refetchLocales();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetchLocales se redefine cada render pero solo queremos correr al cambiar user.
  },[user]);

  // Restaurar sesión al cargar.
  useEffect(()=>{
    const restore = async () => {
      try {
        const { data: { session } } = await db.auth.getSession();
        if (session?.user) {
          const { data: perfil } = await db.from("usuarios").select("id, auth_id, email, nombre, rol, activo, password_temporal, locales, cuentas_visibles, cuentas_operables, tenant_id").eq("auth_id", session.user.id).single();
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
          db.from("usuarios").select("id, auth_id, email, nombre, rol, activo, password_temporal, locales, cuentas_visibles, cuentas_operables, tenant_id").eq("auth_id", session.user.id).single().then(({ data: perfil }) => {
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
          .select("id, auth_id, email, nombre, rol, activo, password_temporal, locales, cuentas_visibles, cuentas_operables, tenant_id")
          .eq("auth_id", session.user.id).single();
        if (perfil) {
          setUser(curr => curr ? { ...curr, ...perfil } as Usuario : curr);
        }
        return;
      }
    });
    return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscription se setup UNA vez al mount. refetchLocales se usa dentro pero no debe re-correr el effect (sino se cancela y re-crea la sub en cada render).
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

  if (authLoading) return <><style>{css}</style><FullPageLoader/></>;

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
                        // Bug fix 24-may: el widget SaldoCajaWidget necesita
                        // cuentas_visibles del user para no mostrar Caja
                        // Efectivo a encargados. Antes solo se pasaba en
                        // /caja, no en /inicio → leak en dashboard.
                        cuentas_visibles: user.cuentas_visibles ?? null,
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
                  // tienePermiso(user, "ajustes_dashboards") = solo dueño/admin/
                  // superadmin (ver auth.ts). Sin este gate, un encargado que
                  // entre por URL directa veía la UI y los saves fallaban
                  // silencioso por RLS (policy permite solo dueño/admin).
                  user?.tenant_id && tienePermiso(user, "ajustes_dashboards")
                    ? <SettingsDashboards tenantId={user.tenant_id} />
                    : <Navigate to="/inicio" replace />
                }
              />
              <Route
                path="/ajustes/notificaciones"
                element={
                  user
                    ? <ConfiguracionNotificaciones user={user} />
                    : <Navigate to="/" replace />
                }
              />
              <Route
                path="/ajustes/codigos-manager"
                element={
                  // Solo dueño/admin/superadmin: la RPC obtener_codigo_totp_actual
                  // valida el rol en pgsql. El gate del frontend evita que un
                  // encargado entre por URL y vea la UI rota.
                  user && (user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin")
                    ? <CodigosManager user={user} />
                    : <Navigate to="/inicio" replace />
                }
              />
              <Route
                path="/usuarios-comanda"
                element={
                  // Sprint COMANDA Autónomo Fase 2 (24-may): pantalla para
                  // gestionar usuarios POS desde PASE. Solo dueño/admin.
                  user && (user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin")
                    ? <UsuariosComanda user={user} locales={locales} />
                    : <Navigate to="/inicio" replace />
                }
              />
              <Route
                path="/herramientas/importar"
                element={
                  user && tienePermiso(user, "importar") ? <Importar {...props}/> : <Navigate to="/inicio" replace />
                }
              />
              <Route
                path="/herramientas/lector-mp"
                element={
                  user && tienePermiso(user, "lector_mp") ? <LectorExtractoMP {...props}/> : <Navigate to="/inicio" replace />
                }
              />
              {/* /reservas OCULTADO 2026-05-18 (Lucas: "no sirve de nada y
                  en todo caso vive en COMANDA"). Redirige a /inicio para
                  bookmarks viejos. La pagina Reservas.tsx y la tabla `reservas`
                  en DB se mantienen — si se decide reintroducir o migrar a
                  COMANDA, descomentar la ruta original. */}
              <Route path="/reservas" element={<Navigate to="/inicio" replace />} />

              {/* Operación */}
              <Route path="/caja/*" element={<Caja {...props}/>} />
              <Route path="/compras/*" element={<Compras {...props}/>} />
              <Route path="/ventas" element={<Ventas {...props}/>} />

              {/* Dirección */}
              <Route path="/negocio" element={<Negocio user={user || undefined} locales={locales} localActivo={localActivo}/>} />
              <Route path="/finanzas" element={<Finanzas user={user || undefined} locales={locales} localActivo={localActivo}/>} />
              <Route path="/rentabilidad" element={
                user ? <Rentabilidad user={user} locales={locales} localActivo={localActivo}/> : <Navigate to="/" replace/>
              } />
              <Route path="/objetivos" element={
                user?.tenant_id ? <Objetivos locales={locales} tenantId={user.tenant_id} localActivo={localActivo}/> : <Navigate to="/" replace/>
              } />
              <Route path="/reportes" element={<EERR {...props}/>} />

              {/* Herramientas */}
              <Route path="/equipo" element={<RRHHPage {...props}/>} />
              <Route path="/mensajeria" element={
                user ? <MensajeriaIG user={user} /> : <Navigate to="/" replace/>
              } />
              <Route path="/herramientas/contador-iva" element={<Contador {...props}/>} />
              <Route path="/herramientas/blindaje" element={<Blindaje {...props}/>} />
              <Route path="/herramientas/conciliacion-bancaria" element={<ConciliacionBancaria />} />
              <Route path="/herramientas" element={
                user && tienePermiso(user, "herramientas_hub")
                  ? <HerramientasHub user={user} locales={locales} localActivo={localActivo}/>
                  : <Navigate to="/inicio" replace />
              } />

              {/* Sistema */}
              <Route path="/ajustes" element={<Ajustes user={user || undefined}/>} />

              {/* Accesibles internamente (no en sidebar top-level) */}
              <Route path="/gastos" element={<Gastos {...props}/>} />
              <Route path="/usuarios" element={
                tienePermiso(user, "usuarios") ? <Usuarios {...props}/> : <Navigate to="/inicio" replace />
              } />
              {/* RBAC: pantalla de roles y permisos. Solo dueño/admin/superadmin. */}
              <Route path="/usuarios/roles" element={
                tienePermiso(user, "usuarios") ? <RolesPermisos user={user!}/> : <Navigate to="/inicio" replace />
              } />
              <Route path="/maxirest" element={
                // Maxirest: import diario de cierre POS. Cualquiera con permiso
                // "ventas" puede usarlo (es la pantalla equivalente a cargar venta).
                tienePermiso(user, "ventas") ? <ImportarMaxirest {...props}/> : <Navigate to="/inicio" replace />
              } />
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
        {/* Widget de soporte flotante — visible siempre que haya user logueado.
            Llama a /api/claude con task=soporte-chat y persiste tickets en
            tickets_soporte para que Lucas los atienda desde Admin Console. */}
        <SoporteWidget user={user} />
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
