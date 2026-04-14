import { useState, useEffect, useRef } from "react";
import { db } from "./lib/supabase";
import { getPermisos, tienePermiso, AuthProvider } from "./lib/auth";
import { Sidebar, css } from "./components/Layout";
import Login from "./pages/Login";
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
import Empleados from "./pages/Empleados";
import Usuarios from "./pages/Usuarios";
import Insumos from "./pages/Insumos";
import LectorFacturasIA from "./pages/LectorFacturasIA";
import Recetas from "./pages/Recetas";
import ConciliacionMP from "./pages/ConciliacionMP";
import CajaEfectivo from "./pages/CajaEfectivo";
import RRHHPage from "./pages/RRHH";

export default function App() {
  const [user, setUser] = useState(null);
  const [section, setSection] = useState("dashboard");
  const [locales, setLocales] = useState([]);
  const [localActivo, setLocalActivo] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(()=>{
    db.from("locales").select("*").order("id").then(({data})=>setLocales(data||[]));
  },[]);

  // Restaurar sesión al cargar
  useEffect(()=>{
    const restore = async () => {
      const { data: { session } } = await db.auth.getSession();
      if (session?.user) {
        const { data: perfil } = await db
          .from("usuarios")
          .select("*")
          .eq("auth_id", session.user.id)
          .single();
        if (perfil) {
          applyLogin(perfil);
        }
      }
      setAuthLoading(false);
    };
    restore();

    // Escuchar cambios de sesión (refresh token, etc)
    const { data: { subscription } } = db.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_OUT") {
        setUser(null);
        setSection("dashboard");
        setLocalActivo(null);
      }
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
    const perms = getPermisos(enriched);
    if(!perms.includes("dashboard") && perms.length) setSection(perms[0]);
    if(enriched.rol!=="dueno" && enriched._locales?.length===1) setLocalActivo(enriched._locales[0]);
  };

  const login = (u) => {
    applyLogin(u);
  };

  const logout = async () => {
    await db.auth.signOut();
    setUser(null);
    setSection("dashboard");
    setLocalActivo(null);
    try { localStorage.removeItem("gastro_user"); } catch {}
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
      case "proveedores": return <Proveedores {...props}/>;
      case "empleados": return <Empleados {...props}/>;
      case "usuarios":  return <Usuarios {...props}/>;
      case "rrhh":      return <RRHHPage {...props}/>;
      default: return null;
    }
  };

  if (authLoading) return <><style>{css}</style><div className="login-wrap"><div className="login-bg"/><div className="login-card" style={{textAlign:"center",padding:40}}>Cargando...</div></div></>;

  if(!user) return <><style>{css}</style><Login onLogin={login}/></>;

  return (
    <AuthProvider value={user}>
      <style>{css}</style>
      <div className="app">
        <Sidebar user={user} section={section} onNav={setSection}
          onLogout={logout}
          locales={locales} localActivo={localActivo} setLocalActivo={setLocalActivo}/>
        <main className="main">
          {toast && <div style={{position:"fixed",top:16,right:16,zIndex:200,padding:"10px 20px",background:"var(--danger)",color:"#fff",borderRadius:"var(--r)",fontSize:12,fontFamily:"'DM Mono',monospace",fontWeight:600,boxShadow:"0 4px 12px rgba(0,0,0,.5)"}}>{toast}</div>}
          {renderSection()}
        </main>
      </div>
    </AuthProvider>
  );
}
