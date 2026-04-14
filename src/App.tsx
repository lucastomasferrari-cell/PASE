import { useState, useEffect } from "react";
import { db } from "./lib/supabase";
import { ROLES } from "./lib/auth";
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
import Config from "./pages/Config";
import Insumos from "./pages/Insumos";
import LectorFacturasIA from "./pages/LectorFacturasIA";
import Recetas from "./pages/Recetas";
import ConciliacionMP from "./pages/ConciliacionMP";

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

  const applyLogin = (u) => {
    setUser(u);
    const perms = ROLES[u.rol]?.permisos||[];
    if(!perms.includes("dashboard")) setSection(perms[0]);
    if(u.rol!=="dueno"&&(u.locales||[]).length===1) setLocalActivo(u.locales[0]);
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

  const props = { user, locales, localActivo };

  const renderSection = () => {
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
      case "proveedores": return <Proveedores {...props}/>;
      case "empleados": return <Empleados {...props}/>;
      case "config":    return <Config {...props}/>;
      default: return null;
    }
  };

  if (authLoading) return <><style>{css}</style><div className="login-wrap"><div className="login-bg"/><div className="login-card" style={{textAlign:"center",padding:40}}>Cargando...</div></div></>;

  if(!user) return <><style>{css}</style><Login onLogin={login}/></>;

  return (
    <>
      <style>{css}</style>
      <div className="app">
        <Sidebar user={user} section={section} onNav={setSection}
          onLogout={logout}
          locales={locales} localActivo={localActivo} setLocalActivo={setLocalActivo}/>
        <main className="main">{renderSection()}</main>
      </div>
    </>
  );
}
