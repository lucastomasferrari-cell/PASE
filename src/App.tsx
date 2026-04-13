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

  useEffect(()=>{
    db.from("locales").select("*").order("id").then(({data})=>setLocales(data||[]));
  },[]);

  const login = u => {
    setUser(u);
    const perms = ROLES[u.rol]?.permisos||[];
    if(!perms.includes("dashboard")) setSection(perms[0]);
    if(u.rol!=="dueno"&&(u.locales||[]).length===1) setLocalActivo(u.locales[0]);
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

  if(!user) return <><style>{css}</style><Login onLogin={login}/></>;

  return (
    <>
      <style>{css}</style>
      <div className="app">
        <Sidebar user={user} section={section} onNav={setSection}
          onLogout={()=>{setUser(null);setSection("dashboard");setLocalActivo(null);try{localStorage.removeItem("gastro_user");}catch{}}}
          locales={locales} localActivo={localActivo} setLocalActivo={setLocalActivo}/>
        <main className="main">{renderSection()}</main>
      </div>
    </>
  );
}
