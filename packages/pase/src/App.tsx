import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { db } from "./lib/supabase";
import { getPermisos, tienePermiso, AuthProvider, necesitaElegirLocal } from "./lib/auth";
import type { Usuario, UsuarioRow, Local, Tenant } from "./types";
import { Sidebar, css } from "./components/Layout";
import Login from "./pages/Login";

// F5 (plan sunny-creek): code-splitting por página. Login queda eager porque
// es entry point para users sin sesión (no querés latencia extra ahí). El
// resto se lazy-loadea — el switch de renderSection() solo monta una página
// a la vez, así que el costo se distribuye sobre las navegaciones que el
// usuario realmente hace. Los dos early-returns (ForcePasswordChange,
// SeleccionarLocalModal) son flujos raros (primer login con password temp,
// encargado con >1 local) — lazy ahí libera ~5-10kB que casi nadie carga.
// Cashflow y Cierre quedan fuera del lazy: sus cases del switch redirigen
// a Dashboard/EERR respectivamente (oculos del sidebar 2026-05-08).
const ForcePasswordChange = lazy(() => import("./pages/ForcePasswordChange"));
const SeleccionarLocalModal = lazy(() => import("./components/SeleccionarLocalModal"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Ventas = lazy(() => import("./pages/Ventas"));
const Compras = lazy(() => import("./pages/Compras"));
const Caja = lazy(() => import("./pages/Caja"));
const EERR = lazy(() => import("./pages/EERR"));
const Contador = lazy(() => import("./pages/Contador"));
const ImportarMaxirest = lazy(() => import("./pages/ImportarMaxirest"));
const Gastos = lazy(() => import("./pages/Gastos"));
const Proveedores = lazy(() => import("./pages/Proveedores"));
const Usuarios = lazy(() => import("./pages/Usuarios"));
const LectorFacturasIA = lazy(() => import("./pages/LectorFacturasIA"));
const ConciliacionMP = lazy(() => import("./pages/ConciliacionMP"));
const Blindaje = lazy(() => import("./pages/Blindaje"));
const RRHHPage = lazy(() => import("./pages/RRHH"));
const Configuracion = lazy(() => import("./pages/Configuracion"));
const Tenants = lazy(() => import("./pages/Tenants"));

// Loader full-page (mismo look-and-feel que authLoading) para los
// early-returns lazy.
const FullPageLoader = () => (
  <div className="login-wrap">
    <div className="login-bg"/>
    <div className="login-card" style={{textAlign:"center",padding:40}}>Cargando...</div>
  </div>
);
// Loader inline para el switch de renderSection() — la sidebar ya está
// montada, solo cargamos la página en el área principal.
const PageLoader = () => <div className="loading">Cargando...</div>;

const TENANT_OVERRIDE_KEY = "pase_tenant_override";

export default function App() {
  const [user, setUser] = useState<Usuario | null>(null);
  const [section, setSection] = useState("dashboard");
  const [locales, setLocales] = useState<Local[]>([]);
  const [localActivo, setLocalActivo] = useState<number | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  // Multi-tenant (TASK 0.15): tenant del usuario logueado.
  // Para superadmin, queda null por default; con tenant_override se setea.
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [tenantOverride, setTenantOverride] = useState<string | null>(null);
  // Bug #27: bloquea navegación mientras encargado con >1 local no elige uno.
  const [showLocalModal, setShowLocalModal] = useState(false);

  // Persistir localActivo en sessionStorage para que al refrescar la página
  // el encargado no tenga que re-elegir el local mientras siga siendo válido.
  // necesitaElegirLocal() verifica que el stored siga estando en sus locales.
  useEffect(() => {
    if (localActivo != null) {
      sessionStorage.setItem("pase_local_activo", String(localActivo));
    } else {
      sessionStorage.removeItem("pase_local_activo");
    }
  }, [localActivo]);

  // Helper para (re)cargar locales del usuario actual. Extraído para
  // poder llamarlo desde varios sitios: useEffect inicial, y handlers
  // de TOKEN_REFRESHED / USER_UPDATED en onAuthStateChange.
  const refetchLocales = async () => {
    const { data } = await db.from("locales").select("*").order("id");
    setLocales(data || []);
  };

  // Refetch cuando user cambia (post-login, post-logout). Si no hay user,
  // skip — la query iría como rol anon y RLS la bloquea, dejando locales=[]
  // permanentemente para el resto de la sesión (race condition con
  // sesiones fresh tipo incógnito).
  useEffect(()=>{
    if (!user) return;
    // refetchLocales internamente llama setLocales después del fetch async,
    // pero el rule lo flaggea porque la setState está dentro del scope del
    // effect. Es el patrón de fetch-on-dep-change estándar — agregar
    // refetchLocales a deps generaría re-fetch infinito (la fn se recrea
    // cada render).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refetchLocales();
  },[user]);

  // Restaurar sesión al cargar — única fuente de verdad: Supabase Auth
  useEffect(()=>{
    const restore = async () => {
      try {
        const { data: { session } } = await db.auth.getSession();
        if (session?.user) {
          const { data: perfil } = await db.from("usuarios").select("*").eq("auth_id", session.user.id).single();
          if (perfil && perfil.activo !== false) {
            // TODO(lint-cleanup): applyLogin se declara abajo (l.157). El
            // closure se crea en render pero se invoca POST render (effect),
            // así que en runtime applyLogin ya existe. La regla immutability
            // pide reordenar la declaración — refactor estructural en flow
            // crítico de auth, mejor revisarlo en PR dedicado.
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

    // TASK 0.16: manejar todos los eventos de Supabase Auth para que la
    // sesión se mantenga en sync sin necesidad de hard refresh manual.
    // Evento → comportamiento:
    //   SIGNED_OUT       → limpiar todo el state.
    //   SIGNED_IN        → aplicar login (skip si ya hay user).
    //   INITIAL_SESSION  → el client hidrató una sesión persistida; idem
    //                      SIGNED_IN si trae user. Cubre el caso de
    //                      reabrir pestaña con sesión válida.
    //   TOKEN_REFRESHED  → JWT renovado. ANTES era no-op, lo cual causaba
    //                      el bug de "0 locales tras 1h": las queries
    //                      subsecuentes podían fallar si el listener no
    //                      reaccionaba. Ahora re-fetcheamos locales para
    //                      forzar uso del nuevo JWT y resetear cualquier
    //                      state desincronizado.
    //   USER_UPDATED     → el perfil cambió (ej: cambio de password,
    //                      cambio de email). Re-leer la fila enriched.
    const { data: { subscription } } = db.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_OUT") {
        setUser(null);
        setSection("dashboard");
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
        // Skip si ya hay user (login manual o restore() ya ejecutó applyLogin)
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
        // JWT renovado: re-fetch locales para usar el nuevo token y
        // recuperar de cualquier query stale que haya quedado vacía.
        // No re-aplicamos login (sería caro y user/perms no cambiaron).
        refetchLocales();
        return;
      }
      if (event === "USER_UPDATED" && session?.user) {
        // El perfil cambió (ej: ForcePasswordChange completó).
        // Re-fetcheamos la fila para que el state refleje password_temporal=false.
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
    // Load DB-driven permisos and locales
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
    const perms = getPermisos(enriched);
    if(!perms.includes("dashboard") && perms.length && perms[0]) setSection(perms[0]);

    // Multi-tenant (TASK 0.15): cargar tenant del usuario.
    // - superadmin → tenant_id NULL en su fila. Si hay sessionStorage
    //   tenant_override, lo usamos. Si no, queda en null y la pantalla
    //   "Tenants" lo deja elegir.
    // - resto → cargar el tenant directo de su tenant_id.
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

    // Decisión de localActivo: ver necesitaElegirLocal() en auth.ts.
    // Bug #27: encargado con >1 local NUNCA puede quedar con localActivo=null
    // porque le expone data cruzada de todos sus locales.
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

  // Refetch de usuario_permisos y usuario_locales del usuario activo sin
  // cerrar sesión. El dueño cambia permisos → el afectado hace click en
  // "Actualizar permisos" en el sidebar y ve el cambio al instante.
  const refreshPermisos = async () => {
    if (!user) return;
    const [{ data: permsData }, { data: locsData }] = await Promise.all([
      db.from("usuario_permisos").select("modulo_slug").eq("usuario_id", user.id),
      db.from("usuario_locales").select("local_id").eq("usuario_id", user.id),
    ]);
    const enriched: Usuario = {
      ...user,
      _permisos: (permsData || []).map((p: { modulo_slug: string }) => p.modulo_slug),
      _locales: (locsData || []).length ? (locsData || []).map((l: { local_id: number }) => l.local_id) : (user.locales || []),
    };
    // Re-evaluar localActivo: si el dueño le agregó/quitó locales al usuario,
    // puede que el localActivo actual ya no esté en sus _locales → modal.
    const decision = necesitaElegirLocal(enriched, localActivo);
    if (decision.action === "showModal") {
      setLocalActivo(null);
      setShowLocalModal(true);
    } else if (decision.action === "setActivo") {
      setLocalActivo(decision.localId!);
      setShowLocalModal(false);
    }
    setUser(enriched);
    sessionStorage.setItem("pase_user", JSON.stringify(enriched));
    showToast("Permisos actualizados");
  };

  const logout = async () => {
    await db.auth.signOut();
    // SIGNED_OUT en onAuthStateChange limpia el resto del state
  };

  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3000);
  };

  const props: { user: Usuario; locales: Local[]; localActivo: number | null } = { user: user!, locales, localActivo };

  const guardedNav = (slug: string) => {
    if (!tienePermiso(user, slug)) {
      setSection("dashboard");
      showToast("Sin acceso");
      return true;
    }
    return false;
  };

  const renderSection = () => {
    if (section !== "dashboard" && guardedNav(section)) return <Dashboard {...props}/>;
    switch(section) {
      case "dashboard": return <Dashboard {...props}/>;
      case "ventas":    return <Ventas {...props}/>;
      case "compras":   return <Compras {...props}/>;
      // Defensive: si algún user tiene section="remitos" persistido en
      // sessionStorage (de antes de la unificación 2026-05-07), redirigir
      // a Compras donde ahora viven los remitos.
      case "remitos":   return <Compras {...props}/>;
      case "caja":      return <Caja {...props}/>;
      case "eerr":      return <EERR {...props}/>;
      case "gastos":    return <Gastos {...props}/>;
      case "contador":  return <Contador {...props}/>;
      case "maxirest":  return <ImportarMaxirest {...props}/>;
      case "lector_ia": return <LectorFacturasIA {...props}/>;
      case "mp":        return <ConciliacionMP {...props}/>;
      // Cashflow oculto temporalmente (Lucas, 2026-05-08): si una sesión vieja
      // tiene "cashflow" en localStorage, fallback a Dashboard. Componente y
      // case se mantienen comentados para reactivar fácil cuando se resuelva
      // el flujo de ingresos no-MP.
      case "cashflow": return <Dashboard {...props}/>;
      // Cierre Comparativo fusionado en EERR (Lucas, 2026-05-08). Sesiones
      // viejas con localStorage "cierre" caen a EERR (que ahora soporta
      // comparativa de meses). El componente Cierre.tsx queda como código
      // muerto disponible para reactivar.
      case "cierre": return <EERR {...props}/>;
      case "blindaje": return <Blindaje {...props}/>;
      case "proveedores": return <Proveedores {...props}/>;
      case "usuarios":  return <Usuarios {...props}/>;
      case "rrhh":      return <RRHHPage {...props}/>;
      case "configuracion": return <Configuracion user={user} locales={locales}/>;
      case "tenants":   return user?.rol === "superadmin" ? <Tenants user={user as Usuario} /> : <Dashboard {...props}/>;
      default: return null;
    }
  };

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
    <AuthProvider value={{ user, refreshPermisos }}>
      <style>{css}</style>
      <div className="app">
        {/* Fondo decorativo para glassmorphism */}
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
          <div style={{
            position: "absolute", top: "40%", right: "20%",
            width: 400, height: 400, borderRadius: "50%",
            background: "radial-gradient(circle, rgba(196,97,74,0.07) 0%, transparent 70%)",
            filter: "blur(40px)"
          }}/>
        </div>
        <div style={{position:"relative",zIndex:1}}>
          <Sidebar user={user} section={section} onNav={setSection}
            onLogout={logout} onRefreshPerms={refreshPermisos}
            locales={locales} localActivo={localActivo} setLocalActivo={setLocalActivo}
            tenant={tenant} tenantOverride={tenantOverride} onClearOverride={clearTenantOverride}/>
        </div>
        <main className="main" style={{position:"relative",zIndex:1}}>
          {toast && <div style={{position:"fixed",top:16,right:16,zIndex:200,padding:"10px 20px",background:"var(--danger)",color:"#fff",borderRadius:"var(--r)",fontSize:12,fontFamily:"'DM Mono',monospace",fontWeight:600,boxShadow:"0 4px 12px rgba(0,0,0,.5)"}}>{toast}</div>}
          {/* TODO(lint-cleanup): renderSection() llama guardedNav() → showToast()
              que escribe toastTimer.current durante render. La regla refs pide
              mover la guard navigation a useEffect que reaccione a cambios de
              `section`. Refactor arquitectural — PR dedicado. */}
          {/* eslint-disable-next-line react-hooks/refs */}
          <Suspense fallback={<PageLoader/>}>{renderSection()}</Suspense>
        </main>
      </div>
    </AuthProvider>
  );
}
