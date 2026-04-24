import { useState, useEffect, useRef } from "react";
import { db } from "./lib/supabase";
import { getPermisos, tienePermiso, AuthProvider, necesitaElegirLocal } from "./lib/auth";
import { Sidebar, css } from "./components/Layout";
import Login from "./pages/Login";
import ForcePasswordChange from "./pages/ForcePasswordChange";
import SeleccionarLocalModal from "./components/SeleccionarLocalModal";
import Dashboard from "./pages/Dashboard";
import Ventas from "./pages/Ventas";
import Compras from "./pages/Compras";
import Remitos from "./pages/Remitos";
import Caja from "./pages/Caja";
import EERR from "./pages/EERR";
import Contador from "./pages/Contador";
import ImportarMaxirest from "./pages/ImportarMaxirest";
import Gastos from "./pages/Gastos";
import Proveedores from "./pages/Proveedores";
import Usuarios from "./pages/Usuarios";
import Insumos from "./pages/Insumos";
import LectorFacturasIA from "./pages/LectorFacturasIA";
import Recetas from "./pages/Recetas";
import ConciliacionMP from "./pages/ConciliacionMP";
import CajaEfectivo from "./pages/CajaEfectivo";
import Cashflow from "./pages/Cashflow";
import Cierre from "./pages/Cierre";
import Blindaje from "./pages/Blindaje";
import RRHHPage from "./pages/RRHH";
import Costos from "./pages/Costos";
import Configuracion from "./pages/Configuracion";

export default function App() {
  const [user, setUser] = useState(null);
  const [section, setSection] = useState("dashboard");
  const [locales, setLocales] = useState([]);
  const [localActivo, setLocalActivo] = useState<number | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
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

  useEffect(()=>{
    db.from("locales").select("*").order("id").then(({data})=>setLocales(data||[]));
  },[]);

  // Restaurar sesión al cargar — única fuente de verdad: Supabase Auth
  useEffect(()=>{
    const restore = async () => {
      try {
        const { data: { session } } = await db.auth.getSession();
        if (session?.user) {
          const { data: perfil } = await db.from("usuarios").select("*").eq("auth_id", session.user.id).single();
          if (perfil && perfil.activo !== false) {
            await applyLogin(perfil);
          } else {
            await db.auth.signOut();
          }
        }
      } catch {}
      setAuthLoading(false);
    };
    restore();

    const { data: { subscription } } = db.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_OUT") {
        setUser(null);
        setSection("dashboard");
        setLocalActivo(null);
        setShowLocalModal(false);
        sessionStorage.removeItem("pase_user");
        sessionStorage.removeItem("pase_local_activo");
        localStorage.removeItem("pase_uid");
        return;
      }
      if (event === "SIGNED_IN" && session?.user) {
        // Skip si ya hay user (login manual ya ejecutó applyLogin) — evita doble fetch
        setUser(curr => {
          if (curr) return curr;
          db.from("usuarios").select("*").eq("auth_id", session.user.id).single().then(({ data: perfil }) => {
            if (perfil && perfil.activo !== false) applyLogin(perfil);
          });
          return curr;
        });
      }
      // TOKEN_REFRESHED: no-op; la sesión se mantiene, no hace falta re-fetch
    });
    return () => subscription.unsubscribe();
  },[]);

  const applyLogin = async (u) => {
    // Load DB-driven permisos and locales
    const [{ data: permsData }, { data: locsData }] = await Promise.all([
      db.from("usuario_permisos").select("modulo_slug").eq("usuario_id", u.id),
      db.from("usuario_locales").select("local_id").eq("usuario_id", u.id),
    ]);
    const enriched = {
      ...u,
      _permisos: (permsData || []).map(p => p.modulo_slug),
      _locales: (locsData || []).length ? (locsData || []).map(l => l.local_id) : (u.locales || []),
    };
    setUser(enriched);
    sessionStorage.setItem("pase_user", JSON.stringify(enriched));
    const perms = getPermisos(enriched);
    if(!perms.includes("dashboard") && perms.length) setSection(perms[0]);

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

  const login = (u) => {
    applyLogin(u);
  };

  // Refetch de usuario_permisos y usuario_locales del usuario activo sin
  // cerrar sesión. El dueño cambia permisos → el afectado hace click en
  // "Actualizar permisos" en el sidebar y ve el cambio al instante.
  const refreshPermisos = async () => {
    if (!user?.id) return;
    const [{ data: permsData }, { data: locsData }] = await Promise.all([
      db.from("usuario_permisos").select("modulo_slug").eq("usuario_id", user.id),
      db.from("usuario_locales").select("local_id").eq("usuario_id", user.id),
    ]);
    const enriched = {
      ...user,
      _permisos: (permsData || []).map(p => p.modulo_slug),
      _locales: (locsData || []).length ? (locsData || []).map(l => l.local_id) : (user.locales || []),
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
  const toastTimer = useRef<any>(null);
  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3000);
  };

  const props = { user, locales, localActivo };

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
      case "remitos":   return <Remitos {...props}/>;
      case "caja":      return <Caja {...props}/>;
      case "eerr":      return <EERR {...props}/>;
      case "gastos":    return <Gastos {...props}/>;
      case "contador":  return <Contador {...props}/>;
      case "maxirest":  return <ImportarMaxirest {...props}/>;
      case "insumos":   return <Insumos {...props}/>;
      case "lector_ia": return <LectorFacturasIA {...props}/>;
      case "recetas":   return <Recetas {...props}/>;
      case "mp":        return <ConciliacionMP {...props}/>;
      case "caja_efectivo": return <CajaEfectivo {...props}/>;
      case "cashflow": return <Cashflow {...props}/>;
      case "cierre": return <Cierre {...props}/>;
      case "blindaje": return <Blindaje {...props}/>;
      case "proveedores": return <Proveedores {...props}/>;
      case "usuarios":  return <Usuarios {...props}/>;
      case "rrhh":      return <RRHHPage {...props}/>;
      case "costos":    return <Costos {...props}/>;
      case "insumos":   return <Costos {...props}/>;
      case "recetas":   return <Costos {...props}/>;
      case "configuracion": return <Configuracion user={user}/>;
      default: return null;
    }
  };

  if (authLoading) return <><style>{css}</style><div className="login-wrap"><div className="login-bg"/><div className="login-card" style={{textAlign:"center",padding:40}}>Cargando...</div></div></>;

  if(!user) return <><style>{css}</style><Login onLogin={login}/></>;

  if (user.password_temporal) return <><style>{css}</style><ForcePasswordChange user={user} onDone={() => {
    const updated = { ...user, password_temporal: false };
    setUser(updated);
    sessionStorage.setItem("pase_user", JSON.stringify(updated));
  }}/></>;

  if (showLocalModal) return <><style>{css}</style><SeleccionarLocalModal user={user} locales={locales} onConfirm={(id) => {
    setLocalActivo(id);
    setShowLocalModal(false);
  }}/></>;

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
            locales={locales} localActivo={localActivo} setLocalActivo={setLocalActivo}/>
        </div>
        <main className="main" style={{position:"relative",zIndex:1}}>
          {toast && <div style={{position:"fixed",top:16,right:16,zIndex:200,padding:"10px 20px",background:"var(--danger)",color:"#fff",borderRadius:"var(--r)",fontSize:12,fontFamily:"'DM Mono',monospace",fontWeight:600,boxShadow:"0 4px 12px rgba(0,0,0,.5)"}}>{toast}</div>}
          {renderSection()}
        </main>
      </div>
    </AuthProvider>
  );
}
