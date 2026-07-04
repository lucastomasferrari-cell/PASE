import { useState, useEffect, lazy, Suspense } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { db } from "./lib/supabase";
import { initConsoleCapture } from "./lib/consoleCapture";
import { useVersionPolling, checkVersionNow } from "./lib/versionCheck";
import { skipAutoSignOut } from "./lib/rememberMe";
// Capturar errores de consola desde el boot, ANTES de cualquier otro código.
// Los errores capturados se incluyen en tickets de soporte para que el agent
// auto-fix tenga contexto del browser cuando diagnostica.
initConsoleCapture();
import { AuthProvider, necesitaElegirLocal, getPermisos, tienePermiso, mergeLocales, debeReintentarLocales, unirPermisos } from "./lib/auth";
import { getDefaultRoute, LEGACY_REDIRECTS } from "./lib/sidebar-nav";
import type { Usuario, UsuarioRow, Local, Tenant } from "./types";
import { Sidebar, TopBar, css } from "./components/Layout";
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
// Mockup interactivo del rediseño RRHH (Lucas 30-may): /sueldos-preview
// Read-only de la DB real (Maneki), interacciones cliente-only. NO afecta
// datos. Sirve para validar UX antes de portar a /equipo real.
const SueldosPreview = lazy(() => import("./pages/SueldosPreview"));
const Tenants = lazy(() => import("./pages/Tenants"));
const DesignSystem = lazy(() => import("./pages/DesignSystem"));
const ConciliacionExtracto = lazy(() => import("./pages/ConciliacionExtracto"));
const Rentabilidad = lazy(() => import("./pages/Rentabilidad"));
// Insumos + Recetas (sprint 28-may noche): gestión de catálogo de materia
// prima y vinculación con platos (CMV teórico, margen, alertas). Las acciones
// operativas (conteo, mermas, transferencias) viven en COMANDA.
// 28-may noche: agrupadas en /recetario (hub estilo Compras con sub-nav
// lateral). Las rutas /insumos y /recetas standalone redireccionan al hub.
// Los componentes Insumos/Recetas se importan dentro del hub (lazy interno),
// no acá — por eso solo Recetario tiene su lazy en App.
const Recetario = lazy(() => import("./pages/Recetario"));
const MensajeriaIG = lazy(() => import("./pages/MensajeriaIG"));
const Negocio = lazy(() => import("./pages/Negocio"));
const Cashflow = lazy(() => import("./pages/Cashflow"));
const Utilidades = lazy(() => import("./pages/Utilidades"));
const Objetivos = lazy(() => import("./pages/Objetivos"));
const Ayuda = lazy(() => import("./pages/Ayuda"));
const Ajustes = lazy(() => import("./pages/Ajustes"));
const Importar = lazy(() => import("./pages/Importar"));
const LectorExtractoMP = lazy(() => import("./pages/LectorExtractoMP"));
// Reservas import sacado 2026-05-18 — la ruta /reservas redirige a /inicio
// (ver más abajo). El archivo Reservas.tsx queda en el código por si se
// reintroduce o se migra a COMANDA.
// const Reservas = lazy(() => import("./pages/Reservas"));
const CodigosManager = lazy(() => import("./pages/CodigosManager"));
const ConfiguracionNotificaciones = lazy(() => import("./pages/ConfiguracionNotificaciones"));
// UsuariosComanda eliminado 24-may noche: la gestión vive ahora EN COMANDA
// (Sprint COMANDA Autónomo Fase 2.b). Ir a pase-comanda.vercel.app →
// Empleados → Usuarios POS.
const HerramientasHub = lazy(() => import("./pages/HerramientasHub"));
const Onboarding = lazy(() => import("./pages/Onboarding"));
const AprobarSolicitud = lazy(() => import("./pages/AprobarSolicitud"));
const Solicitudes = lazy(() => import("./pages/Solicitudes"));
// Gestión de feature flags por tenant migrada al admin-console (24-may).
// Acá solo se LEEN las features para filtrar el sidebar (ver Layout.tsx).
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
// Pantalla "Reconectando…" — se muestra en lugar del dashboard cuando el user
// está logueado pero `locales` quedó vacío (carrera de sesión / post-deploy).
// Evita que se renderice la "pantalla fantasma" (sidebar sin locales). Mientras
// se ve esto, App chequea si fue un deploy (→ logout a login) y reintenta los
// fetches; si nada recupera, el watchdog recarga. El botón deja salir ya.
const ReconectandoScreen = ({ onLogout }: { onLogout: () => void }) => {
  // Los primeros 1.5s se ve IGUAL que el loader normal (brand + barra) para que
  // una recarga rápida sea seamless (no flashea "reconectando"). Si sigue
  // trabada, revela el mensaje + botón de escape.
  const [mostrarMensaje, setMostrarMensaje] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMostrarMensaje(true), 1500);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="pase-loader-fullpage">
      <div className="pase-loader-brand">pase<span style={{color:"var(--pase-gold)"}}>.</span></div>
      <div className="pase-loader-sub">{mostrarMensaje ? "reconectando…" : "aliado gastronómico"}</div>
      <div className="pase-loader-bar"><div className="pase-loader-bar-fill"/></div>
      {mostrarMensaje && (
        <>
          <div style={{
            fontSize: 12, color: "var(--pase-text-muted, #93A8C2)", maxWidth: 320,
            textAlign: "center", marginTop: 14, marginBottom: 16, lineHeight: 1.5,
          }}>
            Estamos restableciendo tu sesión. Si acaba de salir una actualización,
            en unos segundos te llevamos al login.
          </div>
          <button
            onClick={onLogout}
            style={{
              fontSize: 12, padding: "7px 16px", borderRadius: 8, cursor: "pointer",
              color: "var(--pase-text, #F0F4F8)", background: "transparent",
              border: "0.5px solid rgba(117,170,219,0.4)", fontFamily: "inherit",
            }}
          >Ir al login ahora</button>
        </>
      )}
      <style>{`
        .pase-loader-fullpage {
          position: fixed; inset: 0;
          background: var(--pase-bg, #0E1726);
          display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 8px;
          z-index: 9999; font-family: "Inter", system-ui, sans-serif;
        }
        .pase-loader-brand {
          font-size: 38px; font-weight: 500;
          color: var(--pase-text, #F0F4F8); letter-spacing: -0.035em; line-height: 1;
        }
        .pase-loader-sub {
          font-size: 11px; color: var(--pase-text-muted, #93A8C2); letter-spacing: 0.04em;
          margin-bottom: 16px;
        }
        .pase-loader-bar {
          width: 180px; height: 2px; background: rgba(117, 170, 219, 0.15);
          border-radius: 999px; overflow: hidden; position: relative;
        }
        .pase-loader-bar-fill {
          position: absolute; top: 0; left: -40%; width: 40%; height: 100%;
          background: var(--pase-celeste, #75AADB); border-radius: 999px;
          animation: pase-loader-slide 1.2s ease-in-out infinite;
        }
        @keyframes pase-loader-slide { 0% { left: -40%; } 100% { left: 100%; } }
      `}</style>
    </div>
  );
};
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
  // Detección post-deploy: cada 5min + on focus fetchea /version.json y
  // compara con la versión embebida en el bundle. Si difieren → signOut
  // + reload (fuerza JWT/bundle frescos para todos los users después de
  // cada deploy). Pedido Lucas 31-may.
  useVersionPolling();
  const [user, setUser] = useState<Usuario | null>(null);

  // Realtime: subscribe a la fila del user logueado para invalidar el
  // cache de perfil apenas un admin cambie sus permisos/cuentas.
  //
  // Bug fix 2026-06-04 (Sabrina): hasta hoy, si un admin cambiaba
  // `cuentas_operables` desde /usuarios, el user logueado seguía con el
  // perfil viejo en sessionStorage hasta que cerrara/abriera sesión.
  // Caso real: a Sabrina le agregaron MercadoPago y Banco a
  // `cuentas_operables` pero seguía sin verlos en el dropdown de pago.
  //
  // Fix: subscribe a `usuarios` filtrado por auth_id del logueado.
  // Cuando dispara UPDATE → re-fetch perfil completo + actualizar
  // sessionStorage cache + setUser (que dispara re-render). Sabrina ve
  // los cambios al instante, sin tener que hacer nada.
  useEffect(() => {
    if (!user?.auth_id) return;
    const authId = user.auth_id;
    const channel = db.channel(`user-profile-${authId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "usuarios", filter: `auth_id=eq.${authId}` },
        async () => {
          // Re-fetch perfil completo de DB (no usar `payload.new` porque
          // las RLS pueden filtrar columnas y `payload.new` no incluye
          // _permisos ni _locales — los necesitamos enriquecidos).
          const { data: perfil } = await db.from("usuarios")
            .select("id, auth_id, email, nombre, rol, rol_id, activo, password_temporal, locales, cuentas_visibles, cuentas_operables, tenant_id")
            .eq("auth_id", authId).single();
          if (!perfil) return;
          // Si el admin desactivó al user mientras estaba operando, signOut.
          if (perfil.activo === false) {
            // eslint-disable-next-line no-console
            console.warn("[realtime] tu cuenta fue desactivada por un admin, cerrando sesión");
            await db.auth.signOut();
            return;
          }
          // eslint-disable-next-line no-console
          console.log("[realtime] perfil actualizado desde DB — re-hidratando permisos/cuentas");
          // Re-enriquecer permisos + locales con applyLogin (idem que login fresh).
          // applyLogin se define más abajo (const, línea ~538); este callback
          // async corre mucho después del mount, así que en runtime ya está
          // definido. La regla del React Compiler lo marca igual (TDZ estático).
          // eslint-disable-next-line react-hooks/immutability -- async closure: applyLogin ya está definido cuando esto corre
          await applyLogin(perfil);
        },
      )
      .subscribe();
    return () => { void db.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applyLogin se redefine cada render pero solo queremos re-subscribir si cambia el user logueado.
  }, [user?.auth_id]);
  const [locales, setLocales] = useState<Local[]>([]);
  const [localActivo, setLocalActivo] = useState<number | null>(null);
  // Capturado en el PRIMER render (antes de que el effect de persistencia borre
  // pase_local_activo al montar): ¿el user ya tenía un local elegido antes del
  // reload? Lo usan el gate y el watchdog anti-fantasma para no afectar a
  // tenants nuevos. useState con init lazy → render-safe (a diferencia de un ref
  // leído en render) y el valor se congela en el primer render.
  const [teniaLocalAlMontar] = useState<boolean>(
    () => typeof window !== "undefined" && !!sessionStorage.getItem("pase_local_activo"),
  );
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

  // ─── WATCHDOG ANTI "PANTALLA FANTASMA" ──────────────────────────────────────
  // Causa raíz (análisis 08-jun): la RLS resuelve el tenant desde la tabla
  // `usuarios` por auth.uid(), NO desde el JWT. Entonces `locales` queda vacío
  // SOLO cuando la query salió ANÓNIMA (sin token adjunto) — típico tras el
  // reload que dispara useVersionPolling post-deploy, cuando el cliente Supabase
  // arranca un instante sin sesión, o cuando un SIGNED_OUT transitorio dejó la
  // sesión zombie. Reintentar la query no recupera un cliente zombie; recargar
  // la página SÍ (re-lee la sesión de localStorage en frío) — es lo que Lucas
  // hace a mano y siempre funciona.
  //
  // Watchdog: si estás logueado pero `locales` sigue vacío tras 7s (y ya habías
  // elegido un local antes = señal de que SÍ tenés locales), forzamos UNA
  // recarga controlada. Tope anti-loop: máx 2 recargas en 30s; si tras eso
  // sigue vacío, no recarga más (evita loop infinito en un tenant real sin
  // locales o un caso irrecuperable).
  useEffect(() => {
    if (authLoading || !user || locales.length > 0) return;
    // ¿Hay evidencia de que este user SÍ debería ver locales? Solo si ya había
    // un local elegido ANTES del reload. Se captura en el primer render
    // (teniaLocalAlMontarRef) porque el effect de persistencia de localActivo
    // borra `pase_local_activo` al montar (localActivo arranca null). Un tenant
    // nuevo en onboarding (0 locales legítimo) nunca lo tuvo → NO recargamos.
    if (!teniaLocalAlMontar) return;
    let cancel = false;
    // (1) CHEQUEO INMEDIATO DE DEPLOY: si el bundle quedó viejo (post-deploy),
    // checkVersionNow hace logout a login al instante. Mientras tanto el render
    // muestra "Reconectando…" (gate más abajo), nunca el dashboard fantasma.
    // Es lo que pidió Lucas: tras un deploy, logout directo, sin ghost.
    void checkVersionNow().catch(() => { /* sin red / dev → ignorar */ });
    // (2) BACKSTOP para la carrera transitoria (NO deploy): si la query de
    // locales salió anónima por timing y sigue vacía a los 6s, recargar una vez
    // (recupera la sesión válida; si el token está muerto, restore() cae a
    // login). Tope anti-loop: máx 2 recargas en 30s.
    const timer = setTimeout(async () => {
      if (cancel || locales.length > 0) return;
      const { data: { session } } = await db.auth.getSession();
      if (!session) return; // sin sesión = logout real, no es ghost
      const KEY = "pase_ghost_reloads";
      let stamps: number[] = [];
      try { stamps = JSON.parse(sessionStorage.getItem(KEY) || "[]") as number[]; } catch { stamps = []; }
      const ahora = Date.now();
      stamps = stamps.filter(ts => ahora - ts < 30_000);
      if (stamps.length >= 2) {
        // eslint-disable-next-line no-console
        console.error("[ghost-watchdog] locales vacío tras 2 recargas en 30s — no recargo más (evito loop)");
        return;
      }
      stamps.push(ahora);
      sessionStorage.setItem(KEY, JSON.stringify(stamps));
      // eslint-disable-next-line no-console
      console.warn("[ghost-watchdog] logueado pero sin locales (carrera de sesión) — recargando para recuperar");
      window.location.reload();
    }, 6000);
    return () => { cancel = true; clearTimeout(timer); };
  }, [authLoading, user, locales.length]);

  const refetchLocales = async (retryDepth = 0) => {
    // Optimización egress 2026-05-17: proyectar solo lo que se renderiza.
    // Locales puede tener columnas pesadas (slug marketplace, fotos, JSON
    // de horarios). El sidebar y picker solo necesitan id+nombre+tenant_id.
    //
    // Fix 2026-05-30 v2 (queja Lucas recurrente: "queda sin sidebar al costado
    // y tengo que refrescar nuevamente"). CAUSA RAÍZ confirmada contra prod DB:
    // race condition. Al recargar, este fetch puede correr ANTES de que el
    // cliente de Supabase termine de hidratar la sesión desde localStorage.
    // Sin sesión, auth.uid() es NULL → la RLS de `locales` (tenant scope)
    // devuelve 0 filas SIN ERROR. El retry-por-error NO ayudaba porque 0 filas
    // no es error. Resultado: locales=[] → localesDisp.length=0 → Layout oculta
    // el selector. Por eso "refresco de nuevo y aparece".
    //
    // Fix: 1) await getSession() (resuelve recién con la sesión hidratada),
    // 2) reintentar si devuelve 0 filas en los primeros intentos (la sesión
    // todavía no propagó a PostgREST); aceptar 0 recién en el último intento
    // (tenant legítimamente sin locales). 3) Nunca pisar el state con vacío.
    await db.auth.getSession();
    let data: Array<{ id: number; nombre: string; tenant_id: string; provincia: string | null; localidad: string | null; }> | null = null;
    let lastError: unknown = null;
    for (let intento = 0; intento < 4; intento++) {
      const resp = await db.from("locales").select("id, nombre, tenant_id, provincia, localidad").order("id");
      if (!resp.error && resp.data && resp.data.length > 0) { data = resp.data; lastError = null; break; }
      // 0 filas sin error en intentos tempranos = sesión no propagada → reintentar.
      // En el último intento aceptamos el resultado vacío (tenant sin locales real).
      if (!resp.error && resp.data && intento === 3) { data = resp.data; lastError = null; break; }
      lastError = resp.error;
      // Backoff exponencial: 200ms, 400ms, 800ms, 1600ms.
      await new Promise(r => setTimeout(r, 200 * Math.pow(2, intento)));
    }
    // SELF-HEAL del bug "pantalla fantasma" (queja Lucas recurrente, sobre
    // todo POST-DEPLOY): el primer fetch de locales suele venir VACÍO (0 filas)
    // o con ERROR 401 porque el JWT todavía no propagó a PostgREST / quedó
    // viejo tras el deploy. Antes el path de ERROR daba `return` sin reintentar
    // → el sidebar quedaba sin selector de locales hasta recargar a mano (el
    // retry-por-vacío solo cubría 0-filas-sin-error, NO el 401).
    //
    // Ahora ambos casos (vacío Y error) reintentan; y en el reintento forzamos
    // un refreshSession() que re-emite el JWT con app_metadata.tenant_id
    // fresco — eso ataca la raíz del caso post-deploy. Bounded por
    // debeReintentarLocales (tope 6) para no loopear en un tenant real sin locales.
    const fetchVacioOError = !data || data.length === 0;
    if (fetchVacioOError) {
      const { data: { session } } = await db.auth.getSession();
      if (session && debeReintentarLocales(0, true, retryDepth)) {
        // OJO: NO llamar refreshSession() acá. En un cliente recién recargado
        // puede disparar un SIGNED_OUT que —con "Mantener sesión" ON— App se
        // traga y deja la sesión ZOMBIE (UI logueada, cliente sin token) →
        // ghost permanente. Acá solo reintentamos la query: el header de auth
        // suele adjuntarse en ms. Si tras los reintentos sigue vacío, el
        // watchdog anti-fantasma (más abajo) recarga la página para recuperar.
        // eslint-disable-next-line no-console
        console.warn(`[refetchLocales] ${data ? "0 filas" : "error"} con sesión — reintento ${retryDepth + 1} en 1s`, lastError);
        setTimeout(() => { void refetchLocales(retryDepth + 1); }, 1000);
        return;
      }
    }
    if (!data) {
      // Agotados los reintentos y sin data (solo errores). Conservar lo previo
      // para no romper el sidebar; loggear para diagnóstico.
      // eslint-disable-next-line no-console
      console.warn("[refetchLocales] sin data tras reintentos, conservando locales previos", lastError);
      return;
    }
    const nuevos = data;
    // Nunca pisar una lista NO vacía con vacío (functional update para leer el
    // state actual aunque el closure sea viejo, ej. la auth-subscription).
    setLocales(prev => mergeLocales(prev, nuevos));
    // Decisión Lucas 2026-05-17: ya no existe modo "Todas las sucursales".
    // El sidebar siempre tiene UNA activa. Si localActivo es null acá, lo
    // default-eamos al primer local visible para el user. Sin esto algunas
    // pantallas se renderizarían en modo consolidado que ya no es válido.
    //
    // BUG FIX 2026-06-03 (Agos): cuando el JWT se refresca (~1h) el
    // handler de TOKEN_REFRESHED en onAuthStateChange llamaba
    // refetchLocales() con el closure del primer render — `localActivo`
    // era `null` ahí. La condición `localActivo == null` evaluaba TRUE
    // aunque el state actual tuviera un local elegido → pisaba con el
    // default (Villa Crespo). Agos cambiaba a Rene Cantina, pasaba 1h,
    // y volvía solo al primero.
    // Fix: usar functional update — `setLocalActivo(curr => ...)` lee
    // el valor actual del state, no del closure. Si ya hay uno, se respeta.
    if (nuevos.length > 0 && user) {
      const visibles = (user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin")
        ? nuevos
        : nuevos.filter(l => (user._locales || user.locales || []).includes(l.id));
      if (visibles.length > 0) {
        setLocalActivo(curr => {
          // Si ya hay uno elegido Y sigue siendo visible para este user, NO pisar.
          if (curr != null && visibles.some(l => l.id === curr)) return curr;
          // Sino, default: último de sessionStorage si está disponible, o primero visible.
          const stored = sessionStorage.getItem("pase_local_activo");
          const storedId = stored ? parseInt(stored) : NaN;
          return !isNaN(storedId) && visibles.some(l => l.id === storedId)
            ? storedId
            : visibles[0]!.id;
        });
      }
    }
  };

  useEffect(()=>{
    if (!user) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refetchLocales();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetchLocales se redefine cada render pero solo queremos correr al cambiar user.
  },[user]);

  // Handler "Ver como tenant" desde admin-console (26-jun-2026).
  // Admin-console abre PASE con `?override_tenant=<uuid>` después de validar
  // que el caller es superadmin. Acá leemos el param, lo guardamos en
  // sessionStorage (que applyLogin lee si rol===superadmin) y limpiamos
  // la URL. Si el user logueado NO es superadmin, applyLogin lo borra solo.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const overrideTenant = params.get('override_tenant');
      if (overrideTenant && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(overrideTenant)) {
        sessionStorage.setItem(TENANT_OVERRIDE_KEY, overrideTenant);
        params.delete('override_tenant');
        const newUrl = window.location.pathname + (params.toString() ? '?' + params : '') + window.location.hash;
        window.history.replaceState({}, '', newUrl);
      }
    } catch { /* fail silently */ }
  }, []);

  // Restaurar sesión al cargar.
  useEffect(()=>{
    const restore = async () => {
      try {
        const { data: { session } } = await db.auth.getSession();
        if (session?.user) {
          // CRÍTICO (fix bug 27-may): getSession() solo lee localStorage,
          // NO valida con el server. Si los tokens fueron revocados
          // (típico: admin reset de password via Admin API), getSession()
          // sigue devolviendo "ok" con tokens stale → user queda atrapado
          // en ForcePasswordChange aunque cierre y refresque la pestaña.
          // getUser() SÍ hace HTTP al server y rechaza tokens inválidos.
          //
          // Fix 2026-05-30 (queja Lucas recurrente: "recargo y se desloguea
          // sola en el 2do reload"): antes ANY error de getUser() →
          // signOut(). Eso deslogeaba ante errores transitorios (red flaky
          // post-deploy, timeout, 5xx). Ahora solo deslogeamos si el server
          // explícitamente rechaza el token (401/403 con código auth claro).
          // Errores de red / 5xx → conservar sesión y dejar que las queries
          // siguientes reintenten. Si el token está realmente invalido, las
          // queries Supabase tirarán 401 y el handler de signOut se
          // disparará por otro lado.
          const { data: serverUser, error: getUserErr } = await db.auth.getUser();
          const errAny = getUserErr as { status?: number; code?: string; name?: string; message?: string } | null;
          const isHardAuthFail =
            errAny?.status === 401 ||
            errAny?.status === 403 ||
            errAny?.code === 'PGRST301' || // JWT expired
            (typeof errAny?.message === 'string' && /jwt|token|invalid|revoked|expired|unauthor/i.test(errAny.message));
          if (isHardAuthFail || (getUserErr === null && !serverUser?.user)) {
            // Token confirmadamente inválido. Si el user pidió "Mantener
            // sesión abierta", intentamos sobrevivir: refresh session +
            // restaurar perfil desde el cache local. Si todo eso falla,
            // SÍ desloguea — no hay alternativa razonable.
            // (Fix Lucas 02-jun noche: F5 lo expulsaba aunque tildara el
            // checkbox — éste era uno de los 3 paths que ignoraban el flag.)
            if (skipAutoSignOut(`getUser() hard fail: ${errAny?.message ?? 'rechazo'}`)) {
              // Intentar recuperar la sesión con el refresh token y VERIFICAR
              // que realmente funcionó.
              //
              // BUG RAÍZ (análisis 08-jun, consola de Lucas: 403 en
              // auth/v1/user + 406 en usuarios/tenants + 401 en RPCs): antes
              // refrescábamos a ciegas (`try { refreshSession() } catch {}`) y
              // restaurábamos el perfil DESDE EL CACHE aunque el refresh hubiera
              // fallado → quedaba una sesión ZOMBIE: UI logueada pero token
              // muerto, TODAS las queries 403/406/401, sidebar sin locales, 0
              // datos, y NO se recuperaba ni recargando (el reload caía en el
              // mismo token muerto). Esto es lo que Lucas veía como "pantalla
              // fantasma" persistente.
              //
              // Fix: refrescar, chequear el resultado, y SOLO si la sesión
              // quedó viva re-fetchear el perfil FRESCO (con el token bueno) y
              // applyLogin. Si el refresh no recupera (refresh token muerto),
              // NO mostramos el cache zombie: caemos al signOut limpio para que
              // el user re-loguee y obtenga tokens frescos (es la única forma
              // de poder operar — sin token válido no hay nada que hacer).
              try {
                const { data: refData, error: refErr } = await db.auth.refreshSession();
                if (!refErr && refData?.session?.user) {
                  const { data: perfilFresh } = await db.from("usuarios")
                    .select("id, auth_id, email, nombre, rol, rol_id, activo, password_temporal, locales, cuentas_visibles, cuentas_operables, tenant_id")
                    .eq("auth_id", refData.session.user.id).single();
                  if (perfilFresh && perfilFresh.activo !== false) {
                    // eslint-disable-next-line react-hooks/immutability
                    await applyLogin(perfilFresh);
                    setAuthLoading(false);
                    return;
                  }
                }
              } catch { /* refresh falló — caemos al signOut limpio */ }
            }
            // eslint-disable-next-line no-console
            console.warn("[App] getUser() rechazó tokens (hard fail), signOut:", errAny?.message);
            await db.auth.signOut().catch(() => { /* idem */ });
            try { sessionStorage.removeItem("pase_user"); } catch { /* idem */ }
            setAuthLoading(false);
            return;
          }
          if (getUserErr) {
            // Error transitorio (red, 5xx). NO deslogeamos — conservamos la
            // sesión local. Las queries siguientes van a reintentar y si el
            // token está realmente inválido, fallarán con 401 explícito.
            // eslint-disable-next-line no-console
            console.warn("[App] getUser() error transitorio, conservando sesión:", errAny?.message);
          }
          const { data: perfil } = await db.from("usuarios").select("id, auth_id, email, nombre, rol, rol_id, activo, password_temporal, locales, cuentas_visibles, cuentas_operables, tenant_id").eq("auth_id", session.user.id).single();

          // CRÍTICO (fix 2026-05-30 — "veo Conecta tu Instagram con todo
          // conectado" + "sidebar sin selector de local"): si el JWT en
          // localStorage es VIEJO y no tiene app_metadata.tenant_id, las
          // RLS policies devuelven 0 rows en TODAS las queries con tenant
          // scope (locales, ig_config, etc.). Las queries no fallan — dan
          // 0 rows silenciosamente. El user ve "todo vacío". Si refresca
          // 2 veces, Supabase auto-refresca el JWT y vuelve a andar.
          //
          // Fix: si el perfil tiene tenant_id pero el JWT no, forzar
          // refreshSession() para que el server re-emita el JWT con el
          // app_metadata actualizado (commit 68310df setea app_metadata
          // al crear/reusar users, pero users viejos tenían JWT sin eso).
          const jwtTenantId = (session.user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
          if (perfil?.tenant_id && !jwtTenantId) {
            // eslint-disable-next-line no-console
            console.warn("[App] JWT sin app_metadata.tenant_id pero perfil tiene tenant_id, forzando refresh");
            const refreshResp = await db.auth.refreshSession();
            const newJwtTenantId = (refreshResp.data.session?.user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
            if (!newJwtTenantId) {
              // Refresh no fue suficiente — significa que el server-side
              // tampoco tiene app_metadata.tenant_id para este user. Hay
              // que fixearlo en DB. Mientras tanto, signOut para que el
              // próximo login fresco lo regenere (Supabase re-emite el
              // JWT con metadata fresca al loguear).
              //
              // EXCEPT: si el user pidió "Mantener sesión abierta", NO
              // desloguear automático. Hacemos applyLogin con el perfil
              // que ya leímos — las queries con tenant scope van a
              // devolver 0 filas pero el user permanece logueado y puede
              // operar partes que no requieren tenant. Fix Lucas 02-jun.
              if (skipAutoSignOut('refreshSession sin tenant_id en JWT')) {
                if (perfil && perfil.activo !== false) {
                  await applyLogin(perfil);
                }
                setAuthLoading(false);
                return;
              }
              // eslint-disable-next-line no-console
              console.error("[App] Tras refresh sigue sin tenant_id en JWT. Forzando signOut para login fresco.");
              await db.auth.signOut().catch(() => { /* idem */ });
              try { sessionStorage.removeItem("pase_user"); } catch { /* idem */ }
              setAuthLoading(false);
              return;
            }
          }

          if (perfil && perfil.activo !== false) {
            // eslint-disable-next-line react-hooks/immutability
            await applyLogin(perfil);
          } else if (!perfil) {
            // Query del perfil falló (network/RLS transitorio). Si el user
            // pidió "Mantener sesión", intentamos restaurar del cache antes
            // de desloguear. Fix Lucas 03-jun: este path no se gateaba y
            // expulsaba a users con remember_me en errores transitorios.
            if (skipAutoSignOut("perfil query devolvió null (network/RLS?)")) {
              try {
                const cached = sessionStorage.getItem("pase_user");
                if (cached) {
                  const perfilCache = JSON.parse(cached) as Usuario;
                  if (perfilCache?.id && perfilCache?.activo !== false) {
                    setUser(perfilCache);
                    setAuthLoading(false);
                    return;
                  }
                }
              } catch { /* idem */ }
            }
            await db.auth.signOut();
          } else {
            // perfil.activo === false: admin desactivó al user. Acá SÍ
            // desloguea aunque tenga remember_me — es decisión del admin.
            await db.auth.signOut();
          }
        }
      } catch { /* auth restore puede fallar (sin sesión / network) — no crítico */ }
      setAuthLoading(false);
    };
    restore();

    const { data: { subscription } } = db.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_OUT") {
        // Fix Lucas 03-jun: este evento se dispara también cuando Supabase
        // Auth refresca el token y el server lo rechaza (refresh_token
        // expired, network blip post-visibility-change, etc.) — NO solo en
        // logout manual. Eso borraba `pase_local_activo` y al volver
        // caía al default (Villa Crespo). Si el user pidió "Mantener
        // sesión", preservamos el state local y dejamos que las queries
        // fallen visibles (en vez de expulsarlo silenciosamente).
        if (skipAutoSignOut("evento SIGNED_OUT (Auth server)")) {
          // NO limpiamos user/locales/sessionStorage. El user ve la
          // pantalla intacta. Si necesita operar, las queries van a
          // fallar con 401 y verá el error en consola. Puede re-loguear
          // manual desde el botón "Cerrar sesión" del sidebar.
          return;
        }
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
          db.from("usuarios").select("id, auth_id, email, nombre, rol, rol_id, activo, password_temporal, locales, cuentas_visibles, cuentas_operables, tenant_id").eq("auth_id", session.user.id).single().then(({ data: perfil }) => {
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
          .select("id, auth_id, email, nombre, rol, rol_id, activo, password_temporal, locales, cuentas_visibles, cuentas_operables, tenant_id")
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
    // RBAC fix 11-jun: además de los permisos sueltos (usuario_permisos),
    // traer los del rol asignado (rol_permisos via rol_id). Sin esto, un
    // usuario creado solo con rol (ej. Socio) veía el sidebar vacío — el
    // backend lo dejaba pasar (auth_tiene_permiso) pero la UI no se enteraba.
    const [{ data: permsData }, { data: locsData }, { data: rolPermsData }] = await Promise.all([
      db.from("usuario_permisos").select("modulo_slug").eq("usuario_id", u.id),
      db.from("usuario_locales").select("local_id").eq("usuario_id", u.id),
      u.rol_id
        ? db.from("rol_permisos").select("modulo_slug").eq("rol_id", u.rol_id)
        : Promise.resolve({ data: [] as Array<{ modulo_slug: string }> }),
    ]);
    const enriched: Usuario = {
      ...u,
      _permisos: unirPermisos(
        (rolPermsData || []).map((p: { modulo_slug: string }) => p.modulo_slug),
        (permsData || []).map((p: { modulo_slug: string }) => p.modulo_slug),
      ),
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
    try { await db.auth.signOut(); } catch { /* token ya inválido — limpiamos igual */ }
    try { sessionStorage.removeItem("pase_user"); } catch { /* idem */ }
    setUser(null);
    setAuthLoading(false);
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

  // GATE anti "pantalla fantasma": si está logueado pero `locales` quedó vacío
  // (y ya tenía un local antes → debería tenerlos), NO renderizamos el dashboard
  // sin sidebar. Mostramos "Reconectando…" mientras el watchdog chequea deploy
  // (→ logout a login) y reintenta los fetches. Un tenant nuevo (0 locales real)
  // no entra acá porque teniaLocalAlMontarRef es false.
  if (locales.length === 0 && teniaLocalAlMontar) {
    return <><style>{css}</style><ReconectandoScreen onLogout={() => { void db.auth.signOut().finally(() => window.location.reload()); }} /></>;
  }

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
        <TopBar user={user} onLogout={logout} />
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
              {/* Ruta /usuarios-comanda eliminada 24-may noche: la gestión
                  de usuarios POS vive ahora EN COMANDA (Sprint COMANDA
                  Autónomo Fase 2.b). Si alguien entra por la URL vieja,
                  lo mandamos a /inicio. */}
              <Route
                path="/usuarios-comanda"
                element={<Navigate to="/inicio" replace />}
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

              {/* Wizard de onboarding — guía paso a paso para tenant nuevo.
                  Tenants existentes ya tienen todo completado por backfill en
                  migration 202605270100. Accesible siempre vía link directo. */}
              <Route
                path="/onboarding"
                element={user ? <Onboarding user={user} /> : <Navigate to="/" replace />}
              />
              {/* Pantalla mobile-first: el dueño aprueba/rechaza solicitudes
                  de autorización de sus encargados desde el celu (deeplink
                  desde push notification). Solo dueño/admin pueden ver. */}
              <Route
                path="/aprobar-solicitud/:id"
                element={user ? <AprobarSolicitud user={user} /> : <Navigate to="/" replace />}
              />
              <Route
                path="/solicitudes"
                element={user ? <Solicitudes user={user} /> : <Navigate to="/" replace />}
              />

              {/* Operación */}
              <Route path="/caja/*" element={<Caja {...props}/>} />
              <Route path="/compras/*" element={<Compras {...props}/>} />
              <Route path="/ventas" element={<Ventas {...props}/>} />

              {/* Dirección */}
              <Route path="/negocio" element={<Negocio user={user || undefined} locales={locales} localActivo={localActivo}/>} />
              {/* Finanzas fusionada en Negocio (rediseño 11-jun). Redirect
                  para bookmarks y deep-links viejos. */}
              <Route path="/finanzas" element={<Navigate to="/negocio" replace />} />
              <Route path="/conciliacion-extracto" element={
                user && tienePermiso(user, "conciliacion") ? <ConciliacionExtracto key={localActivo ?? "sin-local"} user={user} locales={locales} localActivo={localActivo}/> : <Navigate to="/inicio" replace/>
              } />
              <Route path="/rentabilidad" element={
                user ? <Rentabilidad user={user} locales={locales} localActivo={localActivo}/> : <Navigate to="/" replace/>
              } />
              {/* Hub Recetario: agrupa Insumos + Recetas con sub-nav lateral
                  (estilo Compras). Las rutas /insumos y /recetas standalone
                  redirigen al hub con la sub-sección preseleccionada para que
                  bookmarks viejos no se rompan. */}
              <Route path="/recetario" element={
                user && tienePermiso(user, "rentabilidad") ? <Recetario user={user} locales={locales} localActivo={localActivo}/> : <Navigate to="/inicio" replace/>
              } />
              <Route path="/insumos" element={<Navigate to="/recetario?sec=insumos" replace />} />
              <Route path="/materias-primas" element={<Navigate to="/recetario?sec=materias-primas" replace />} />
              <Route path="/recetas" element={<Navigate to="/recetario?sec=recetas" replace />} />
              <Route path="/objetivos" element={
                user?.tenant_id ? <Objetivos locales={locales} tenantId={user.tenant_id} localActivo={localActivo}/> : <Navigate to="/" replace/>
              } />
              <Route path="/reportes" element={<EERR {...props}/>} />
              <Route path="/cashflow" element={<Cashflow {...props}/>} />
              <Route path="/utilidades" element={<Utilidades {...props}/>} />
              <Route path="/ayuda" element={<Ayuda/>} />

              {/* Herramientas */}
              <Route path="/equipo" element={<RRHHPage {...props}/>} />
              <Route path="/sueldos-preview" element={<SueldosPreview />} />
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
