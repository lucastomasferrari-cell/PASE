import { useState, useEffect } from "react";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://pduxydviqiaxfqnshhdc.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBkdXh5ZHZpcWlheGZxbnNoaGRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDExNDAsImV4cCI6MjA5MTMxNzE0MH0.oh0ObrthoSjmHeAEC3_kfvDnZeOY22ShGAsxv6_2o08";
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

const CATEGORIAS_COMPRA = ["PESCADERIA","CARNICERIA","VERDULERIA","BEBIDAS","VINOS","ALMACEN","PACKAGING","PAPELERIA","BARRIO CHINO","PRODUCTOS ORIENTALES","SUPERMERCADO","HIELO","LIMPIEZA","CONTADOR","PUBLICIDAD","EXPENSAS","PROPINAS","SUSHIMAN PM","EQUIPAMIENTO","SUELDOS","OTROS"];
const MEDIOS_COBRO = ["EFECTIVO SALON","TARJETA CREDITO","TARJETA DEBITO","QR","LINK","RAPPI ONLINE","PEYA ONLINE","PEYA EFECTIVO","MP DELIVERY","BIGBOX","FANBAG","EVENTO","TRANSFERENCIA","Point MP","Point Nave","NAVE","MASDELIVERY ONLINE","EFECTIVO DELIVERY"];
const CUENTAS = ["Caja Chica","Caja Mayor","MercadoPago","Banco"];
const UNIDADES = ["kg","g","litro","ml","unidad","caja","bolsa","docena"];
const GASTOS_FIJOS = ["ALQUILER","EDESUR","METROGAS","AYSA","INTERNET","MAXIREST","WOKI","SEGURO","FUMIGACION","ABL","EXPENSAS","AQA","CONTADOR","OTROS FIJOS"];
const GASTOS_VARIABLES = ["COMPRAS MERCADO LIBRE","ENVIOS","LIBRERIA","BAZAR","FARMACIA","MANTENIMIENTO","EQUIPAMIENTO","DEVOLUCIONES CLIENTES","PERSONAL","AJUSTE","GASTOS VARIOS"];
const GASTOS_PUBLICIDAD = ["PIMENTON","COMMUNITY MANAGER","PRENSA Y PAUTA FB","FOTOGRAFIA Y ACCIONES","RAPPI CUOTA ADS","OTRAS PUBLICIDAD"];
const COMISIONES_CATS = ["MERCADOPAGO","RAPPI","PEDIDOS YA","MASDELIVERY","BANCARIAS NAVE","COMPENSACIONES","OTRAS COMISIONES"];

const ROLES = {
  dueno:   { label:"Dueño",    color:"#E8C547", permisos:["dashboard","ventas","compras","remitos","gastos","caja","eerr","contador","proveedores","empleados","config","maxirest"] },
  admin:   { label:"Admin",    color:"#3B82F6", permisos:["dashboard","ventas","compras","remitos","gastos","caja","proveedores","empleados"] },
  compras: { label:"Compras",  color:"#8B5CF6", permisos:["compras","remitos","proveedores"] },
  cajero:  { label:"Cajero",   color:"#10B981", permisos:["caja","dashboard"] },
};

const toISO = d => d.toISOString().split("T")[0];
const today = new Date();
const fmt_d = d => d ? new Date(d+"T12:00:00").toLocaleDateString("es-AR") : "—";
const fmt_$ = n => new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS",maximumFractionDigits:0}).format(n||0);
const genId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;

const css = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Mono:wght@400&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0A0A0A;--s1:#111;--s2:#1A1A1A;--s3:#242424;--bd:#2A2A2A;--bd2:#333;--acc:#E8C547;--acc2:#FF6B35;--acc3:#3ECFCF;--txt:#F0EDE8;--muted:#666;--muted2:#888;--danger:#EF4444;--success:#22C55E;--warn:#F59E0B;--info:#3B82F6;--r:3px}
body{background:var(--bg);color:var(--txt);font-family:'DM Mono',monospace;font-size:13px;line-height:1.5}
.app{display:flex;min-height:100vh}
.sb{width:210px;background:var(--s1);border-right:1px solid var(--bd);display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:20}
.sb-logo{padding:20px 16px;border-bottom:1px solid var(--bd)}
.sb-name{font-family:'Syne',sans-serif;font-size:22px;font-weight:800;color:var(--acc);letter-spacing:1px;line-height:1}
.sb-tag{font-size:9px;color:var(--muted);letter-spacing:3px;text-transform:uppercase;margin-top:2px}
.sb-local{padding:10px 16px;border-bottom:1px solid var(--bd)}
.sb-local select{width:100%;background:var(--s3);border:1px solid var(--bd2);color:var(--txt);padding:6px 8px;font-size:11px;font-family:'DM Mono',monospace;border-radius:var(--r);outline:none}
.sb-nav{flex:1;padding:8px 0;overflow-y:auto}
.sb-section{padding:8px 12px 2px;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--muted)}
.nav-item{display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;font-size:11px;color:var(--muted2);transition:all 0.1s;border-left:2px solid transparent;margin:1px 0}
.nav-item:hover{background:var(--s2);color:var(--txt)}
.nav-item.active{background:rgba(232,197,71,0.08);color:var(--acc);border-left-color:var(--acc)}
.sb-user{padding:12px 16px;border-top:1px solid var(--bd)}
.sb-uname{font-size:11px;font-weight:600;margin-bottom:1px}
.sb-logout{display:block;width:100%;margin-top:8px;padding:5px;background:var(--s3);border:1px solid var(--bd);color:var(--muted2);cursor:pointer;font-size:10px;font-family:'DM Mono',monospace;border-radius:var(--r)}
.sb-logout:hover{border-color:var(--acc);color:var(--acc)}
.main{margin-left:210px;flex:1;padding:24px;min-height:100vh}
.ph-row{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px;gap:12px;flex-wrap:wrap}
.ph-title{font-family:'Syne',sans-serif;font-size:28px;font-weight:800;line-height:1}
.ph-sub{font-size:11px;color:var(--muted2);margin-top:4px}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px}
.kpi{background:var(--s1);border:1px solid var(--bd);border-radius:var(--r);padding:16px}
.kpi-label{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
.kpi-value{font-family:'Syne',sans-serif;font-size:26px;font-weight:700;line-height:1}
.kpi-sub{font-size:10px;color:var(--muted2);margin-top:4px}
.kpi-acc{color:var(--acc)}.kpi-danger{color:var(--danger)}.kpi-warn{color:var(--warn)}.kpi-success{color:var(--success)}
.panel{background:var(--s1);border:1px solid var(--bd);border-radius:var(--r);margin-bottom:16px}
.panel-hd{padding:12px 16px;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.panel-title{font-size:10px;letter-spacing:2px;text-transform:uppercase;font-weight:600;color:var(--muted2)}
table{width:100%;border-collapse:collapse}
thead th{padding:8px 12px;text-align:left;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--bd);background:var(--s2)}
tbody tr{border-bottom:1px solid var(--bd);transition:background 0.1s}
tbody tr:last-child{border-bottom:none}
tbody tr:hover{background:var(--s2)}
td{padding:10px 12px;font-size:12px}
.badge{display:inline-block;padding:2px 7px;border-radius:2px;font-size:9px;letter-spacing:1px;text-transform:uppercase;font-weight:600}
.b-danger{background:rgba(239,68,68,.12);color:var(--danger)}.b-success{background:rgba(34,197,94,.12);color:var(--success)}.b-warn{background:rgba(245,158,11,.12);color:var(--warn)}.b-info{background:rgba(59,130,246,.12);color:var(--info)}.b-muted{background:var(--s3);color:var(--muted2)}.b-anulada{background:rgba(100,100,100,.12);color:var(--muted);text-decoration:line-through}
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border:none;cursor:pointer;font-family:'DM Mono',monospace;font-size:11px;font-weight:600;border-radius:var(--r);transition:all 0.15s;white-space:nowrap}
.btn-acc{background:var(--acc);color:#000}.btn-acc:hover{background:#f0d060}
.btn-sec{background:var(--s3);color:var(--txt);border:1px solid var(--bd)}.btn-sec:hover{border-color:var(--acc);color:var(--acc)}
.btn-ghost{background:transparent;color:var(--muted2);border:1px solid var(--bd)}.btn-ghost:hover{border-color:var(--acc2);color:var(--acc2)}
.btn-sm{padding:4px 10px;font-size:10px}
.btn-success{background:transparent;color:var(--success);border:1px solid var(--success)}.btn-success:hover{background:var(--success);color:#000}
.btn-danger{background:transparent;color:var(--danger);border:1px solid var(--danger)}.btn-danger:hover{background:var(--danger);color:#fff}
.field{margin-bottom:12px}
.field label{display:block;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:5px}
.field input,.field select,.field textarea{width:100%;background:var(--bg);border:1px solid var(--bd);color:var(--txt);padding:8px 10px;font-family:'DM Mono',monospace;font-size:12px;border-radius:var(--r);outline:none;transition:border-color 0.15s}
.field input:focus,.field select:focus,.field textarea:focus{border-color:var(--acc)}
.field select option{background:var(--s2)}
.form2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.form4{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px;align-items:end}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:100;backdrop-filter:blur(4px)}
.modal{background:var(--s1);border:1px solid var(--bd2);border-radius:var(--r);width:640px;max-width:96vw;max-height:92vh;overflow-y:auto}
.modal-hd{padding:16px 20px;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:var(--s1);z-index:1}
.modal-title{font-family:'Syne',sans-serif;font-size:18px;font-weight:700}
.modal-body{padding:20px}.modal-ft{padding:12px 20px;border-top:1px solid var(--bd);display:flex;gap:8px;justify-content:flex-end;position:sticky;bottom:0;background:var(--s1)}
.close-btn{background:none;border:none;color:var(--muted2);cursor:pointer;font-size:18px;line-height:1}.close-btn:hover{color:var(--txt)}
.tabs{display:flex;border-bottom:1px solid var(--bd);margin-bottom:16px;flex-wrap:wrap}
.tab{padding:8px 16px;font-size:10px;letter-spacing:1px;text-transform:uppercase;cursor:pointer;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px;transition:all 0.15s}
.tab.active{color:var(--acc);border-bottom-color:var(--acc)}.tab:hover:not(.active){color:var(--txt)}
.alert{padding:10px 14px;border-radius:var(--r);font-size:11px;margin-bottom:12px;border-left:3px solid;line-height:1.5}
.alert-danger{background:rgba(239,68,68,.08);border-color:var(--danger);color:#fca5a5}.alert-warn{background:rgba(245,158,11,.08);border-color:var(--warn);color:#fcd34d}.alert-success{background:rgba(34,197,94,.08);border-color:var(--success);color:#86efac}.alert-info{background:rgba(59,130,246,.08);border-color:var(--info);color:#93c5fd}
.caja-card{background:var(--s2);border:1px solid var(--bd);border-radius:var(--r);padding:16px;position:relative;overflow:hidden}
.caja-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.caja-chica::before{background:var(--acc)}.caja-mayor::before{background:var(--acc2)}.caja-mp::before{background:var(--acc3)}.caja-banco::before{background:var(--info)}
.caja-name{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
.caja-saldo{font-family:'Syne',sans-serif;font-size:20px;font-weight:700}
.prov-row td:first-child{border-left:2px solid rgba(62,207,207,.4)}
.remito-row td:first-child{border-left:2px solid rgba(245,158,11,.4)}
.anulada-row{opacity:0.5}
.search{background:var(--bg);border:1px solid var(--bd);color:var(--txt);padding:6px 12px;font-family:'DM Mono',monospace;font-size:12px;border-radius:var(--r);outline:none}
.search:focus{border-color:var(--acc)}
.empty{padding:40px;text-align:center;color:var(--muted);font-size:12px}
.loading{padding:40px;text-align:center;color:var(--muted2);font-size:11px;letter-spacing:2px;text-transform:uppercase}
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);position:relative}
.login-bg{position:absolute;inset:0;background:radial-gradient(ellipse at 30% 40%,rgba(232,197,71,.06) 0%,transparent 60%)}
.login-card{position:relative;width:400px;background:var(--s1);border:1px solid var(--bd);border-radius:var(--r);padding:40px}
.login-brand{font-family:'Syne',sans-serif;font-size:36px;font-weight:800;color:var(--acc);line-height:1;letter-spacing:1px}
.login-sub{font-size:9px;letter-spacing:3px;text-transform:uppercase;color:var(--muted);margin-bottom:32px;margin-top:2px}
.num{font-family:'Syne',sans-serif;font-size:15px;font-weight:700}
.mono{font-family:'DM Mono',monospace;font-size:11px}
.eerr-row{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;border-bottom:1px solid var(--bd)}
.eerr-row:last-child{border-bottom:none}
.items-table{width:100%;border-collapse:collapse;margin-top:8px}
.items-table th{font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);padding:4px 6px;text-align:left;border-bottom:1px solid var(--bd)}
.items-table td{padding:4px 6px;font-size:11px}
.items-table tr:hover{background:var(--s2)}
.saldo-edit{display:flex;gap:8px;align-items:center}
.saldo-edit input{width:160px}
`;

// ─── LOGIN ────────────────────────────────────────────────────────────────────
function Login({ onLogin }) {
  const [usuario, setUsuario] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const go = async () => {
    if (!usuario || !password) return;
    setLoading(true); setErr("");
    const { data } = await db.from("usuarios").select("*").eq("email", usuario).eq("password", password).single();
    setLoading(false);
    if (data) onLogin(data); else setErr("Usuario o contraseña incorrectos");
  };
  return (
    <div className="login-wrap">
      <div className="login-bg" />
      <div className="login-card">
        <div className="login-brand">GASTRO</div>
        <div className="login-sub">Sistema de Gestión</div>
        {err && <div className="alert alert-danger">{err}</div>}
        <div className="field"><label>Usuario</label><input value={usuario} onChange={e=>setUsuario(e.target.value)} placeholder="dueno / admin / compras / cajero" onKeyDown={e=>e.key==="Enter"&&go()} /></div>
        <div className="field"><label>Contraseña</label><input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••" onKeyDown={e=>e.key==="Enter"&&go()} /></div>
        <button className="btn btn-acc" style={{width:"100%",justifyContent:"center"}} onClick={go} disabled={loading}>{loading?"Verificando...":"Ingresar"}</button>
        <div style={{marginTop:16,padding:10,background:"var(--bg)",borderRadius:"var(--r)",fontSize:10,color:"var(--muted)",lineHeight:1.8}}>
          dueno123 · admin123 · compras123 · cajero123
        </div>
      </div>
    </div>
  );
}

// ─── SIDEBAR ──────────────────────────────────────────────────────────────────
function Sidebar({ user, section, onNav, onLogout, locales, localActivo, setLocalActivo }) {
  const perms = ROLES[user.rol]?.permisos || [];
  const localesDisp = user.rol==="dueno" ? locales : locales.filter(l=>(user.locales||[]).includes(l.id));
  const nav = [
    {id:"dashboard",label:"Dashboard",icon:"▦",sec:"Principal"},
    {id:"ventas",label:"Ventas",icon:"↑",sec:"Operaciones"},
    {id:"compras",label:"Facturas",icon:"📄",sec:"Operaciones"},
    {id:"remitos",label:"Remitos",icon:"🚚",sec:"Operaciones"},
    {id:"gastos",label:"Gastos",icon:"💸",sec:"Operaciones"},
    {id:"proveedores",label:"Proveedores",icon:"🏭",sec:"Operaciones"},
    {id:"maxirest",label:"Import Maxirest",icon:"📥",sec:"Operaciones"},
    {id:"caja",label:"Caja & Bancos",icon:"💰",sec:"Finanzas"},
    {id:"eerr",label:"Estado de Result.",icon:"📊",sec:"Finanzas"},
    {id:"contador",label:"Contador / IVA",icon:"🧾",sec:"Finanzas"},
    {id:"empleados",label:"Empleados",icon:"👷",sec:"RRHH"},
    {id:"config",label:"Usuarios",icon:"👥",sec:"Config"},
  ];
  const secs = [...new Set(nav.map(n=>n.sec))];
  return (
    <div className="sb">
      <div className="sb-logo"><div className="sb-name">GASTRO</div><div className="sb-tag">Sistema de Gestión</div></div>
      {localesDisp.length > 1 && (
        <div className="sb-local">
          <select value={localActivo||""} onChange={e=>setLocalActivo(e.target.value?parseInt(e.target.value):null)}>
            {user.rol==="dueno" && <option value="">Todos los locales</option>}
            {localesDisp.map(l=><option key={l.id} value={l.id}>{l.nombre}</option>)}
          </select>
        </div>
      )}
      <nav className="sb-nav">
        {secs.map(s=>{
          const items = nav.filter(n=>n.sec===s&&perms.includes(n.id));
          if(!items.length) return null;
          return (<div key={s}><div className="sb-section">{s}</div>{items.map(n=>(
            <div key={n.id} className={`nav-item ${section===n.id?"active":""}`} onClick={()=>onNav(n.id)}>
              <span style={{width:14,textAlign:"center"}}>{n.icon}</span>{n.label}
            </div>
          ))}</div>);
        })}
      </nav>
      <div className="sb-user">
        <div className="sb-uname">{user.nombre}</div>
        <div style={{fontSize:10,color:ROLES[user.rol]?.color}}>{ROLES[user.rol]?.label}</div>
        <button className="sb-logout" onClick={onLogout}>Cerrar sesión →</button>
      </div>
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({ locales, localActivo }) {
  const [stats, setStats] = useState({saldos:{},deuda:0,vencidas:0,ventasHoy:0,remPend:0});
  const [provDeuda, setProvDeuda] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(()=>{
    const load = async () => {
      const hoy = toISO(today);
      const [{data:saldos},{data:facturas},{data:remitos},{data:ventas},{data:provs}] = await Promise.all([
        db.from("saldos_caja").select("*"),
        db.from("facturas").select("*").neq("estado","anulada"),
        db.from("remitos").select("*"),
        db.from("ventas").select("*").eq("fecha",hoy),
        db.from("proveedores").select("*").gt("saldo",0).eq("estado","Activo"),
      ]);
      const saldosObj = {};
      (saldos||[]).forEach(s=>saldosObj[s.cuenta]=s.saldo);
      const fAct = (facturas||[]).filter(f=>f.estado!=="pagada"&&(!localActivo||f.local_id===localActivo));
      setStats({
        saldos:saldosObj,
        deuda:fAct.reduce((s,f)=>s+(f.total||0),0),
        vencidas:fAct.filter(f=>f.estado==="vencida").length,
        ventasHoy:(ventas||[]).filter(v=>!localActivo||v.local_id===localActivo).reduce((s,v)=>s+(v.monto||0),0),
        remPend:(remitos||[]).filter(r=>r.estado==="sin_factura"&&(!localActivo||r.local_id===localActivo)).length,
      });
      setProvDeuda((provs||[]).sort((a,b)=>b.saldo-a.saldo).slice(0,8));
      setLoading(false);
    };
    load();
  },[localActivo]);
  if(loading) return <div className="loading">Cargando...</div>;
  const totalLiquidez = Object.values(stats.saldos).reduce((a,b)=>a+b,0);
  return (
    <div>
      <div style={{marginBottom:20}}>
        <div className="ph-title">Dashboard</div>
        <div className="ph-sub">{today.toLocaleDateString("es-AR",{weekday:"long",year:"numeric",month:"long",day:"numeric"})}</div>
      </div>
      <div className="grid4">
        <div className="kpi"><div className="kpi-label">Liquidez Total</div><div className="kpi-value kpi-acc">{fmt_$(totalLiquidez)}</div><div className="kpi-sub">Todas las cuentas</div></div>
        <div className="kpi"><div className="kpi-label">Ventas Hoy</div><div className="kpi-value kpi-success">{fmt_$(stats.ventasHoy)}</div></div>
        <div className="kpi"><div className="kpi-label">Deuda Proveedores</div><div className="kpi-value kpi-warn">{fmt_$(stats.deuda)}</div></div>
        <div className="kpi"><div className="kpi-label">Facturas Vencidas</div><div className="kpi-value kpi-danger">{stats.vencidas}</div></div>
      </div>
      <div className="grid2">
        <div className="panel">
          <div className="panel-hd"><span className="panel-title">Saldos en Tiempo Real</span></div>
          <div style={{padding:"12px 16px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            {CUENTAS.map(k=>(
              <div key={k} className={`caja-card caja-${k==="Caja Chica"?"chica":k==="Caja Mayor"?"mayor":k==="MercadoPago"?"mp":"banco"}`}>
                <div className="caja-name">{k}</div>
                <div className="caja-saldo" style={{color:(stats.saldos[k]||0)<0?"var(--danger)":"var(--txt)"}}>{fmt_$(stats.saldos[k]||0)}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-hd"><span className="panel-title" style={{color:"var(--warn)"}}>⚡ Alertas</span></div>
          <div style={{padding:"8px 16px"}}>
            {stats.vencidas>0 && <div className="alert alert-danger">⚠ {stats.vencidas} factura(s) vencida(s)</div>}
            {stats.remPend>0 && <div className="alert alert-warn">🚚 {stats.remPend} remito(s) sin factura</div>}
            {stats.vencidas===0&&stats.remPend===0 && <div className="alert alert-success">✓ Todo al día</div>}
          </div>
        </div>
      </div>
      {provDeuda.length>0 && (
        <div className="panel">
          <div className="panel-hd"><span className="panel-title">Deuda por Proveedor</span></div>
          <table><thead><tr><th>Proveedor</th><th>Categoría</th><th>Saldo</th></tr></thead>
          <tbody>{provDeuda.map(p=>(
            <tr key={p.id} className="prov-row">
              <td style={{fontWeight:500}}>{p.nombre}</td>
              <td><span className="badge b-muted">{p.cat}</span></td>
              <td><span className="num kpi-warn">{fmt_$(p.saldo)}</span></td>
            </tr>
          ))}</tbody></table>
        </div>
      )}
    </div>
  );
}

// ─── VENTAS ───────────────────────────────────────────────────────────────────
function Ventas({ user, locales, localActivo }) {
  const [ventas,setVentas]=useState([]);
  const [loading,setLoading]=useState(true);
  const [modalNuevo,setModalNuevo]=useState(false);
  const [detalleModal,setDetalleModal]=useState(null);
  const [editModal,setEditModal]=useState(null);
  const [filtFecha,setFiltFecha]=useState("");
  const [filtMes,setFiltMes]=useState(toISO(today).slice(0,7));
  // filtMes is always active unless filtFecha is set
  const [form,setForm]=useState({local_id:"",fecha:toISO(today),turno:"Noche",medio:"EFECTIVO SALON",monto:"",cant:""});
  const localesDisp=user.rol==="dueno"?locales:locales.filter(l=>(user.locales||[]).includes(l.id));

  const load=async()=>{
    setLoading(true);
    let q=db.from("ventas").select("*").order("fecha",{ascending:false});
    if(filtFecha){
      q=q.eq("fecha",filtFecha);
    } else {
      const desde=filtMes+"-01";
      const hasta=filtMes+"-31";
      q=q.gte("fecha",desde).lte("fecha",hasta);
    }
    if(localActivo) q=q.eq("local_id",localActivo);
    const {data}=await q.limit(500);
    setVentas(data||[]);setLoading(false);
  };
  useEffect(()=>{load();},[filtFecha,filtMes,localActivo]);
  useEffect(()=>{if(localesDisp.length>0&&!form.local_id)setForm(f=>({...f,local_id:localActivo||localesDisp[0]?.id||""}));},[locales,localActivo]);

  // Group ventas by fecha + turno + local
  const grupos=[];
  const seen={};
  for(const v of ventas){
    const key=`${v.fecha}||${v.turno}||${v.local_id}`;
    if(!seen[key]){seen[key]={key,fecha:v.fecha,turno:v.turno,local_id:v.local_id,items:[],total:0};grupos.push(seen[key]);}
    seen[key].items.push(v);
    seen[key].total+=(v.monto||0);
  }
  grupos.sort((a,b)=>a.fecha<b.fecha?1:a.fecha>b.fecha?-1:0);

  const totalPeriodo=ventas.reduce((s,v)=>s+(v.monto||0),0);

  const guardar=async()=>{
    if(!form.monto||!form.local_id)return;
    await db.from("ventas").insert([{...form,id:genId("V"),local_id:parseInt(form.local_id),monto:parseFloat(form.monto),cant:parseInt(form.cant)||1}]);
    setModalNuevo(false);load();
  };

  const guardarEdit=async()=>{
    if(!editModal)return;
    await db.from("ventas").update({fecha:editModal.fecha,turno:editModal.turno,medio:editModal.medio,monto:parseFloat(editModal.monto),cant:parseInt(editModal.cant)||1,local_id:parseInt(editModal.local_id)}).eq("id",editModal.id);
    setEditModal(null);
    if(detalleModal){
      // refresh detalle
      const updated=detalleModal.items.map(i=>i.id===editModal.id?{...i,...editModal,monto:parseFloat(editModal.monto)}:i);
      setDetalleModal({...detalleModal,items:updated,total:updated.reduce((s,i)=>s+(i.monto||0),0)});
    }
    load();
  };

  const eliminarLinea=async(id)=>{
    if(!confirm("¿Eliminar este registro?"))return;
    await db.from("ventas").delete().eq("id",id);
    if(detalleModal){
      const updated=detalleModal.items.filter(i=>i.id!==id);
      if(updated.length===0){setDetalleModal(null);}
      else{setDetalleModal({...detalleModal,items:updated,total:updated.reduce((s,i)=>s+(i.monto||0),0)});}
    }
    load();
  };

  const eliminarBloque=async(grupo)=>{
    if(!confirm(`¿Eliminar el cierre completo del ${fmt_d(grupo.fecha)} ${grupo.turno}?`))return;
    await Promise.all(grupo.items.map(v=>db.from("ventas").delete().eq("id",v.id)));
    setDetalleModal(null);load();
  };

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Ventas</div><div className="ph-sub">Total período: {fmt_$(totalPeriodo)}</div></div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
          <input type="date" className="search" style={{width:155}} value={filtFecha} 
            onChange={e=>{setFiltFecha(e.target.value);}} 
            placeholder="Día específico"/>
          <input type="month" className="search" style={{width:140}} value={filtMes} 
            onChange={e=>{setFiltMes(e.target.value);setFiltFecha("");}}/>
          <button className="btn btn-acc" onClick={()=>setModalNuevo(true)}>+ Cargar</button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-hd"><span className="panel-title">Cierres de turno — {grupos.length} bloques</span></div>
        {loading?<div className="loading">Cargando...</div>:grupos.length===0?<div className="empty">No hay ventas en este período</div>:(
          <table>
            <thead><tr><th>Fecha</th><th>Turno</th><th>Local</th><th>Registros</th><th>Total</th><th></th></tr></thead>
            <tbody>{grupos.map(g=>(
              <tr key={g.key}>
                <td className="mono">{fmt_d(g.fecha)}</td>
                <td><span className={`badge ${g.turno==="Noche"?"b-info":"b-warn"}`}>{g.turno}</span></td>
                <td style={{fontSize:11,color:"var(--muted2)"}}>{locales.find(l=>l.id===g.local_id)?.nombre||"—"}</td>
                <td style={{fontSize:11,color:"var(--muted2)"}}>{g.items.length} formas de cobro</td>
                <td><span className="num kpi-success">{fmt_$(g.total)}</span></td>
                <td><button className="btn btn-ghost btn-sm" onClick={()=>setDetalleModal(g)}>Ver detalle →</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>

      {/* DETALLE MODAL */}
      {detalleModal&&(
        <div className="overlay" onClick={()=>setDetalleModal(null)}>
          <div className="modal" style={{width:640}} onClick={e=>e.stopPropagation()}>
            <div className="modal-hd">
              <div>
                <div className="modal-title">{fmt_d(detalleModal.fecha)} · {detalleModal.turno}</div>
                <div style={{fontSize:11,color:"var(--muted2)",marginTop:2}}>{locales.find(l=>l.id===detalleModal.local_id)?.nombre} · Total: <span style={{color:"var(--success)",fontFamily:"'Syne',sans-serif",fontWeight:700}}>{fmt_$(detalleModal.total)}</span></div>
              </div>
              <div style={{display:"flex",gap:6}}>
                <button className="btn btn-danger btn-sm" onClick={()=>eliminarBloque(detalleModal)}>Eliminar cierre</button>
                <button className="close-btn" onClick={()=>setDetalleModal(null)}>✕</button>
              </div>
            </div>
            <div className="modal-body" style={{padding:0}}>
              <table>
                <thead><tr><th>Forma de Cobro</th><th>Cubiertos</th><th>Monto</th><th>% del total</th><th></th></tr></thead>
                <tbody>{detalleModal.items.sort((a,b)=>b.monto-a.monto).map(v=>(
                  <tr key={v.id}>
                    <td style={{fontWeight:500}}>{v.medio}</td>
                    <td style={{color:"var(--muted2)"}}>{v.cant||"—"}</td>
                    <td><span className="num kpi-success">{fmt_$(v.monto)}</span></td>
                    <td style={{fontSize:11,color:"var(--muted2)"}}>{detalleModal.total>0?((v.monto/detalleModal.total)*100).toFixed(1):0}%</td>
                    <td><div style={{display:"flex",gap:4}}>
                      <button className="btn btn-ghost btn-sm" onClick={()=>setEditModal({...v})}>Editar</button>
                      <button className="btn btn-danger btn-sm" onClick={()=>eliminarLinea(v.id)}>✕</button>
                    </div></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* EDIT MODAL */}
      {editModal&&(
        <div className="overlay" onClick={()=>setEditModal(null)}>
          <div className="modal" style={{width:440}} onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Editar Venta</div><button className="close-btn" onClick={()=>setEditModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="form2">
                <div className="field"><label>Fecha</label><input type="date" value={editModal.fecha} onChange={e=>setEditModal({...editModal,fecha:e.target.value})}/></div>
                <div className="field"><label>Turno</label><select value={editModal.turno} onChange={e=>setEditModal({...editModal,turno:e.target.value})}><option>Mediodía</option><option>Noche</option></select></div>
              </div>
              <div className="field"><label>Forma de Cobro</label><select value={editModal.medio} onChange={e=>setEditModal({...editModal,medio:e.target.value})}>{MEDIOS_COBRO.map(m=><option key={m}>{m}</option>)}</select></div>
              <div className="form2">
                <div className="field"><label>Monto $</label><input type="number" value={editModal.monto} onChange={e=>setEditModal({...editModal,monto:e.target.value})}/></div>
                <div className="field"><label>Cubiertos</label><input type="number" value={editModal.cant||""} onChange={e=>setEditModal({...editModal,cant:e.target.value})}/></div>
              </div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setEditModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={guardarEdit}>Guardar</button></div>
          </div>
        </div>
      )}

      {/* NUEVO MODAL */}
      {modalNuevo&&(
        <div className="overlay" onClick={()=>setModalNuevo(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Nueva Venta</div><button className="close-btn" onClick={()=>setModalNuevo(false)}>✕</button></div>
            <div className="modal-body">
              <div className="form2">
                <div className="field"><label>Local</label><select value={form.local_id} onChange={e=>setForm({...form,local_id:e.target.value})}><option value="">Seleccioná...</option>{localesDisp.map(l=><option key={l.id} value={l.id}>{l.nombre}</option>)}</select></div>
                <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e=>setForm({...form,fecha:e.target.value})}/></div>
              </div>
              <div className="form2">
                <div className="field"><label>Turno</label><select value={form.turno} onChange={e=>setForm({...form,turno:e.target.value})}><option>Mediodía</option><option>Noche</option></select></div>
                <div className="field"><label>Medio de Cobro</label><select value={form.medio} onChange={e=>setForm({...form,medio:e.target.value})}>{MEDIOS_COBRO.map(m=><option key={m}>{m}</option>)}</select></div>
              </div>
              <div className="form2">
                <div className="field"><label>Monto $</label><input type="number" value={form.monto} onChange={e=>setForm({...form,monto:e.target.value})} placeholder="0"/></div>
                <div className="field"><label>Cubiertos</label><input type="number" value={form.cant} onChange={e=>setForm({...form,cant:e.target.value})} placeholder="0"/></div>
              </div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModalNuevo(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Guardar</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function Compras({ user, locales, localActivo }) {
  const [facturas, setFacturas] = useState([]);
  const [proveedores, setProveedores] = useState([]);
  const [tab, setTab] = useState("todas");
  const [modal, setModal] = useState(false);
  const [pagarModal, setPagarModal] = useState(null);
  const [editModal, setEditModal] = useState(null);
  const [verModal, setVerModal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const emptyForm = {prov_id:"",local_id:localActivo||"",nro:"",fecha:toISO(today),venc:"",neto:"",iva21:"",iva105:"",iibb:"",cat:"",detalle:""};
  const [form, setForm] = useState(emptyForm);
  const [items, setItems] = useState([]);
  const [pagoForm, setPagoForm] = useState({cuenta:"MercadoPago",monto:"",fecha:toISO(today)});
  const localesDisp = user.rol==="dueno"?locales:locales.filter(l=>(user.locales||[]).includes(l.id));
  const calcTotal = () => (parseFloat(form.neto)||0)+(parseFloat(form.iva21)||0)+(parseFloat(form.iva105)||0)+(parseFloat(form.iibb)||0);

  const load = async () => {
    setLoading(true);
    const [{data:f},{data:p}] = await Promise.all([
      db.from("facturas").select("*").order("fecha",{ascending:false}),
      db.from("proveedores").select("*").eq("estado","Activo").order("nombre"),
    ]);
    setFacturas(f||[]); setProveedores(p||[]); setLoading(false);
  };
  useEffect(()=>{load();},[]);

  const fFilt = facturas.filter(f=>{
    if(localActivo&&f.local_id!==localActivo) return false;
    if(tab==="pendientes") return f.estado==="pendiente";
    if(tab==="vencidas") return f.estado==="vencida";
    if(tab==="pagadas") return f.estado==="pagada";
    if(tab==="anuladas") return f.estado==="anulada";
    return f.estado!=="anulada";
  }).filter(f=>!search||proveedores.find(p=>p.id===f.prov_id)?.nombre.toLowerCase().includes(search.toLowerCase())||(f.nro||"").includes(search));

  const fActivas = facturas.filter(f=>f.estado!=="pagada"&&f.estado!=="anulada"&&(!localActivo||f.local_id===localActivo));

  const onProvChange = (prov_id) => {
    const prov = proveedores.find(p=>p.id===parseInt(prov_id));
    setForm(f=>({...f,prov_id,cat:prov?.cat||f.cat}));
  };

  const addItem = () => setItems([...items,{producto:"",cantidad:"",unidad:"kg",precio_unitario:"",subtotal:0}]);
  const updateItem = (i,field,val) => {
    const newItems = [...items];
    newItems[i] = {...newItems[i],[field]:val};
    if(field==="cantidad"||field==="precio_unitario") {
      const q = parseFloat(field==="cantidad"?val:newItems[i].cantidad)||0;
      const p = parseFloat(field==="precio_unitario"?val:newItems[i].precio_unitario)||0;
      newItems[i].subtotal = q*p;
    }
    setItems(newItems);
  };
  const removeItem = (i) => setItems(items.filter((_,idx)=>idx!==i));

  const guardar = async () => {
    if(!form.prov_id||!form.nro||!form.neto||!form.local_id) return;
    const total = calcTotal();
    const id = genId("FACT");
    const nueva = {...form,id,prov_id:parseInt(form.prov_id),local_id:parseInt(form.local_id),neto:parseFloat(form.neto),iva21:parseFloat(form.iva21)||0,iva105:parseFloat(form.iva105)||0,iibb:parseFloat(form.iibb)||0,total,estado:"pendiente",pagos:[]};
    await db.from("facturas").insert([nueva]);
    if(items.length>0) {
      const itemsToInsert = items.filter(it=>it.producto).map(it=>({...it,factura_id:id,cantidad:parseFloat(it.cantidad)||0,precio_unitario:parseFloat(it.precio_unitario)||0,subtotal:it.subtotal}));
      if(itemsToInsert.length>0) await db.from("factura_items").insert(itemsToInsert);
    }
    const prov = proveedores.find(p=>p.id===nueva.prov_id);
    if(prov) await db.from("proveedores").update({saldo:(prov.saldo||0)+total}).eq("id",prov.id);
    setModal(false); setForm(emptyForm); setItems([]); load();
  };

  const [pagando,setPagando]=useState(false);
  const pagar = async () => {
    if(pagando) return; setPagando(true);
    const f = pagarModal;
    const monto = parseFloat(pagoForm.monto)||f.total;
    const nuevosPagos = [...(f.pagos||[]),{cuenta:pagoForm.cuenta,monto,fecha:pagoForm.fecha}];
    const totalPagado = nuevosPagos.reduce((s,p)=>s+p.monto,0);
    const nuevoEstado = totalPagado>=f.total?"pagada":"pendiente";
    await db.from("facturas").update({estado:nuevoEstado,pagos:nuevosPagos}).eq("id",f.id);
    const prov = proveedores.find(p=>p.id===f.prov_id);
    if(prov) await db.from("proveedores").update({saldo:Math.max(0,(prov.saldo||0)-monto)}).eq("id",f.prov_id);
    // Registrar movimiento en caja
    const {data:caja} = await db.from("saldos_caja").select("saldo").eq("cuenta",pagoForm.cuenta).single();
    if(caja) await db.from("saldos_caja").update({saldo:(caja.saldo||0)-monto}).eq("cuenta",pagoForm.cuenta);
    await db.from("movimientos").insert([{id:genId("MOV"),fecha:pagoForm.fecha,cuenta:pagoForm.cuenta,tipo:"Pago Proveedor",cat:f.cat,importe:-monto,detalle:`Pago ${prov?.nombre||""} - Fact ${f.nro}`,fact_id:f.id}]);
    setPagarModal(null); load();
  };

  const anular = async (f) => {
    if(!confirm(`¿Anular factura ${f.nro}? Esta acción queda registrada.`)) return;
    await db.from("facturas").update({estado:"anulada"}).eq("id",f.id);
    const prov = proveedores.find(p=>p.id===f.prov_id);
    if(prov&&f.estado!=="pagada") await db.from("proveedores").update({saldo:Math.max(0,(prov.saldo||0)-f.total)}).eq("id",f.prov_id);
    load();
  };

  const eb = e => {
    if(e==="vencida") return <span className="badge b-danger">Vencida</span>;
    if(e==="pagada") return <span className="badge b-success">Pagada</span>;
    if(e==="anulada") return <span className="badge b-anulada">Anulada</span>;
    return <span className="badge b-warn">Pendiente</span>;
  };

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Facturas</div><div className="ph-sub">{fActivas.length} activas · {fmt_$(fActivas.reduce((s,f)=>s+(f.total||0),0))} por pagar</div></div>
        <button className="btn btn-acc" onClick={()=>{setForm(emptyForm);setItems([]);setModal(true)}}>+ Cargar Factura</button>
      </div>
      <div className="tabs">
        {[["todas","Todas"],["pendientes","Pendientes"],["vencidas","Vencidas"],["pagadas","Pagadas"],["anuladas","Anuladas"]].map(([id,l])=>(
          <div key={id} className={`tab ${tab===id?"active":""}`} onClick={()=>setTab(id)}>{l}</div>
        ))}
        <div style={{flex:1}}/>
        <input className="search" placeholder="Buscar..." value={search} onChange={e=>setSearch(e.target.value)} style={{margin:"0 0 -1px",width:180}}/>
      </div>
      <div className="panel">
        {loading?<div className="loading">Cargando...</div>:fFilt.length===0?<div className="empty">No hay facturas</div>:(
          <table><thead><tr><th>Proveedor</th><th>Nº Factura</th><th>Fecha</th><th>Vencimiento</th><th>Categoría</th><th>Total</th><th>Estado</th><th></th></tr></thead>
          <tbody>{fFilt.map(f=>{
            const prov=proveedores.find(p=>p.id===f.prov_id);
            return (
              <tr key={f.id} className={f.estado==="anulada"?"anulada-row":""}>
                <td style={{fontWeight:500,maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{prov?.nombre}</td>
                <td className="mono">{f.nro}</td>
                <td className="mono" style={{fontSize:11}}>{fmt_d(f.fecha)}</td>
                <td className="mono" style={{fontSize:11,color:f.estado==="vencida"?"var(--danger)":"var(--muted2)"}}>{fmt_d(f.venc)}</td>
                <td><span className="badge b-muted">{f.cat}</span></td>
                <td><span className="num kpi-warn">{fmt_$(f.total)}</span></td>
                <td>{eb(f.estado)}</td>
                <td>
                  <div style={{display:"flex",gap:4}}>
                    <button className="btn btn-ghost btn-sm" onClick={()=>setVerModal(f)}>Ver</button>
                    {f.estado!=="pagada"&&f.estado!=="anulada"&&<button className="btn btn-success btn-sm" onClick={()=>{setPagarModal(f);setPagoForm({cuenta:"MercadoPago",monto:f.total,fecha:toISO(today)})}}>Pagar</button>}
                    {f.estado!=="anulada"&&<button className="btn btn-danger btn-sm" onClick={()=>anular(f)}>Anular</button>}
                  </div>
                </td>
              </tr>
            );
          })}</tbody></table>
        )}
      </div>

      {/* MODAL CARGAR FACTURA */}
      {modal && (
        <div className="overlay" onClick={()=>setModal(false)}>
          <div className="modal" style={{width:680}} onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Cargar Factura</div><button className="close-btn" onClick={()=>setModal(false)}>✕</button></div>
            <div className="modal-body">
              <div className="form2">
                <div className="field"><label>Proveedor *</label><select value={form.prov_id} onChange={e=>onProvChange(e.target.value)}><option value="">Seleccioná...</option>{proveedores.map(p=><option key={p.id} value={p.id}>{p.nombre}</option>)}</select></div>
                <div className="field"><label>Local *</label><select value={form.local_id} onChange={e=>setForm({...form,local_id:e.target.value})}><option value="">Seleccioná...</option>{localesDisp.map(l=><option key={l.id} value={l.id}>{l.nombre}</option>)}</select></div>
              </div>
              <div className="form2">
                <div className="field"><label>Nº Factura *</label><input value={form.nro} onChange={e=>setForm({...form,nro:e.target.value})} placeholder="A-0001-00001234"/></div>
                <div className="field"><label>Categoría EERR</label><select value={form.cat} onChange={e=>setForm({...form,cat:e.target.value})}><option value="">Seleccioná...</option>{CATEGORIAS_COMPRA.map(c=><option key={c}>{c}</option>)}</select></div>
              </div>
              <div className="form2">
                <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e=>setForm({...form,fecha:e.target.value})}/></div>
                <div className="field"><label>Vencimiento</label><input type="date" value={form.venc} onChange={e=>setForm({...form,venc:e.target.value})}/></div>
              </div>
              <div className="form3">
                <div className="field"><label>Neto Gravado *</label><input type="number" value={form.neto} onChange={e=>setForm({...form,neto:e.target.value})} placeholder="0"/></div>
                <div className="field"><label>IVA 21%</label><input type="number" value={form.iva21} onChange={e=>setForm({...form,iva21:e.target.value})} placeholder="0"/></div>
                <div className="field"><label>IVA 10.5%</label><input type="number" value={form.iva105} onChange={e=>setForm({...form,iva105:e.target.value})} placeholder="0"/></div>
              </div>
              <div className="form2">
                <div className="field"><label>Perc. IIBB</label><input type="number" value={form.iibb} onChange={e=>setForm({...form,iibb:e.target.value})} placeholder="0"/></div>
                <div className="field"><label>Total calculado</label><input readOnly value={fmt_$(calcTotal())} style={{color:"var(--acc)",fontFamily:"'Syne',sans-serif",fontWeight:700}}/></div>
              </div>
              <div className="field"><label>Descripción</label><input value={form.detalle} onChange={e=>setForm({...form,detalle:e.target.value})} placeholder="Detalle general..."/></div>

              {/* DETALLE DE INSUMOS */}
              <div style={{marginTop:16,borderTop:"1px solid var(--bd)",paddingTop:16}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <span style={{fontSize:10,letterSpacing:2,textTransform:"uppercase",color:"var(--muted2)"}}>Detalle de Insumos (opcional)</span>
                  <button className="btn btn-ghost btn-sm" onClick={addItem}>+ Agregar ítem</button>
                </div>
                {items.length>0 && (
                  <table className="items-table">
                    <thead><tr><th>Producto</th><th>Cantidad</th><th>Unidad</th><th>Precio unit.</th><th>Subtotal</th><th></th></tr></thead>
                    <tbody>{items.map((it,i)=>(
                      <tr key={i}>
                        <td><input style={{width:"100%",background:"var(--bg)",border:"1px solid var(--bd)",color:"var(--txt)",padding:"4px 6px",fontFamily:"'DM Mono',monospace",fontSize:11,borderRadius:"var(--r)"}} value={it.producto} onChange={e=>updateItem(i,"producto",e.target.value)} placeholder="Ej: Salmón"/></td>
                        <td><input type="number" style={{width:70,background:"var(--bg)",border:"1px solid var(--bd)",color:"var(--txt)",padding:"4px 6px",fontFamily:"'DM Mono',monospace",fontSize:11,borderRadius:"var(--r)"}} value={it.cantidad} onChange={e=>updateItem(i,"cantidad",e.target.value)}/></td>
                        <td><select style={{background:"var(--bg)",border:"1px solid var(--bd)",color:"var(--txt)",padding:"4px 6px",fontFamily:"'DM Mono',monospace",fontSize:11,borderRadius:"var(--r)"}} value={it.unidad} onChange={e=>updateItem(i,"unidad",e.target.value)}>{UNIDADES.map(u=><option key={u}>{u}</option>)}</select></td>
                        <td><input type="number" style={{width:90,background:"var(--bg)",border:"1px solid var(--bd)",color:"var(--txt)",padding:"4px 6px",fontFamily:"'DM Mono',monospace",fontSize:11,borderRadius:"var(--r)"}} value={it.precio_unitario} onChange={e=>updateItem(i,"precio_unitario",e.target.value)}/></td>
                        <td style={{color:"var(--acc)",fontFamily:"'Syne',sans-serif",fontSize:13,fontWeight:700}}>{fmt_$(it.subtotal)}</td>
                        <td><button className="btn btn-danger btn-sm" onClick={()=>removeItem(i)}>✕</button></td>
                      </tr>
                    ))}</tbody>
                  </table>
                )}
              </div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Guardar</button></div>
          </div>
        </div>
      )}

      {/* MODAL VER FACTURA */}
      {verModal && (
        <div className="overlay" onClick={()=>setVerModal(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Factura {verModal.nro}</div><button className="close-btn" onClick={()=>setVerModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="form2">
                <div><span style={{fontSize:9,color:"var(--muted)",letterSpacing:2,textTransform:"uppercase"}}>Proveedor</span><div style={{marginTop:4}}>{proveedores.find(p=>p.id===verModal.prov_id)?.nombre}</div></div>
                <div><span style={{fontSize:9,color:"var(--muted)",letterSpacing:2,textTransform:"uppercase"}}>Local</span><div style={{marginTop:4}}>{locales.find(l=>l.id===verModal.local_id)?.nombre}</div></div>
              </div>
              <div className="form3" style={{marginTop:12}}>
                <div><span style={{fontSize:9,color:"var(--muted)",letterSpacing:2,textTransform:"uppercase"}}>Fecha</span><div style={{marginTop:4}}>{fmt_d(verModal.fecha)}</div></div>
                <div><span style={{fontSize:9,color:"var(--muted)",letterSpacing:2,textTransform:"uppercase"}}>Vencimiento</span><div style={{marginTop:4}}>{fmt_d(verModal.venc)}</div></div>
                <div><span style={{fontSize:9,color:"var(--muted)",letterSpacing:2,textTransform:"uppercase"}}>Categoría</span><div style={{marginTop:4}}>{verModal.cat}</div></div>
              </div>
              <div style={{marginTop:16,background:"var(--s2)",padding:12,borderRadius:"var(--r)"}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,fontSize:12}}><span>Neto Gravado</span><span>{fmt_$(verModal.neto)}</span></div>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,fontSize:12}}><span>IVA 21%</span><span>{fmt_$(verModal.iva21)}</span></div>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,fontSize:12}}><span>IVA 10.5%</span><span>{fmt_$(verModal.iva105)}</span></div>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,fontSize:12}}><span>Perc. IIBB</span><span>{fmt_$(verModal.iibb)}</span></div>
                <div style={{display:"flex",justifyContent:"space-between",borderTop:"1px solid var(--bd)",paddingTop:8,fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:700}}><span>TOTAL</span><span style={{color:"var(--acc)"}}>{fmt_$(verModal.total)}</span></div>
              </div>
              {(verModal.pagos||[]).length>0 && (
                <div style={{marginTop:12}}>
                  <div style={{fontSize:9,color:"var(--muted)",letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>Pagos registrados</div>
                  {verModal.pagos.map((p,i)=>(
                    <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid var(--bd)",fontSize:12}}>
                      <span>{fmt_d(p.fecha)} · {p.cuenta}</span><span style={{color:"var(--success)"}}>{fmt_$(p.monto)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODAL PAGAR */}
      {pagarModal && (
        <div className="overlay" onClick={()=>setPagarModal(null)}>
          <div className="modal" style={{width:420}} onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Registrar Pago</div><button className="close-btn" onClick={()=>setPagarModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="alert alert-info">{pagarModal.nro} · Total: {fmt_$(pagarModal.total)}</div>
              <div className="field"><label>Cuenta de egreso</label><select value={pagoForm.cuenta} onChange={e=>setPagoForm({...pagoForm,cuenta:e.target.value})}>{CUENTAS.map(c=><option key={c}>{c}</option>)}</select></div>
              <div className="field"><label>Monto</label><input type="number" value={pagoForm.monto} onChange={e=>setPagoForm({...pagoForm,monto:e.target.value})}/></div>
              <div className="field"><label>Fecha</label><input type="date" value={pagoForm.fecha} onChange={e=>setPagoForm({...pagoForm,fecha:e.target.value})}/></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setPagarModal(null)}>Cancelar</button><button className="btn btn-success" onClick={pagar}>Confirmar Pago</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── REMITOS ──────────────────────────────────────────────────────────────────
function Remitos({ user, locales, localActivo }) {
  const [remitos, setRemitos] = useState([]);
  const [facturas, setFacturas] = useState([]);
  const [proveedores, setProveedores] = useState([]);
  const [modal, setModal] = useState(false);
  const [vincModal, setVincModal] = useState(null);
  const [pagarModal, setPagarModal] = useState(null);
  const [loading, setLoading] = useState(true);
  const emptyForm = {prov_id:"",local_id:localActivo||"",nro:"",fecha:toISO(today),monto:"",cat:"",detalle:""};
  const [form, setForm] = useState(emptyForm);
  const [pagoForm, setPagoForm] = useState({cuenta:"MercadoPago",monto:"",fecha:toISO(today)});
  const localesDisp = user.rol==="dueno"?locales:locales.filter(l=>(user.locales||[]).includes(l.id));

  const load = async () => {
    setLoading(true);
    const [{data:r},{data:f},{data:p}] = await Promise.all([
      db.from("remitos").select("*").order("fecha",{ascending:false}),
      db.from("facturas").select("*").neq("estado","pagada").neq("estado","anulada"),
      db.from("proveedores").select("*").eq("estado","Activo").order("nombre"),
    ]);
    setRemitos(r||[]); setFacturas(f||[]); setProveedores(p||[]); setLoading(false);
  };
  useEffect(()=>{load();},[]);

  const rFilt = remitos.filter(r=>!localActivo||r.local_id===localActivo);
  const sinFact = rFilt.filter(r=>r.estado==="sin_factura");

  const onProvChange = (prov_id) => {
    const prov = proveedores.find(p=>p.id===parseInt(prov_id));
    setForm(f=>({...f,prov_id,cat:prov?.cat||f.cat}));
  };

  const guardar = async () => {
    if(!form.prov_id||!form.monto||!form.local_id) return;
    const nro = form.nro||`REM-${Date.now().toString().slice(-6)}`;
    const nuevo = {...form,id:genId("REM"),prov_id:parseInt(form.prov_id),local_id:parseInt(form.local_id),nro,monto:parseFloat(form.monto),estado:"sin_factura",fact_id:null};
    await db.from("remitos").insert([nuevo]);
    const prov = proveedores.find(p=>p.id===nuevo.prov_id);
    if(prov) await db.from("proveedores").update({saldo:(prov.saldo||0)+nuevo.monto}).eq("id",prov.id);
    setModal(false); setForm(emptyForm); load();
  };

  const vincFact = async (fid) => {
    const r = vincModal;
    const f = facturas.find(f=>f.id===fid);
    // Cancelar deuda del remito y reemplazar por la de la factura (diferencia)
    const prov = proveedores.find(p=>p.id===r.prov_id);
    if(prov) {
      const diff = (f?.total||0) - r.monto; // diferencia puede ser positiva o negativa
      // El saldo ya tiene la deuda del remito, solo ajustamos la diferencia
      await db.from("proveedores").update({saldo:Math.max(0,(prov.saldo||0)+diff)}).eq("id",prov.id);
    }
    await db.from("remitos").update({estado:"facturado",fact_id:fid}).eq("id",r.id);
    setVincModal(null); load();
  };

  const [pagandoRem,setPagandoRem]=useState(false);
  const pagarRemito = async () => {
    if(pagandoRem) return; setPagandoRem(true);
    const r = pagarModal;
    const monto = parseFloat(pagoForm.monto)||r.monto;
    await db.from("remitos").update({estado:"pagado"}).eq("id",r.id);
    const prov = proveedores.find(p=>p.id===r.prov_id);
    if(prov) await db.from("proveedores").update({saldo:Math.max(0,(prov.saldo||0)-monto)}).eq("id",r.prov_id);
    const {data:caja} = await db.from("saldos_caja").select("saldo").eq("cuenta",pagoForm.cuenta).single();
    if(caja) await db.from("saldos_caja").update({saldo:(caja.saldo||0)-monto}).eq("cuenta",pagoForm.cuenta);
    await db.from("movimientos").insert([{id:genId("MOV"),fecha:pagoForm.fecha,cuenta:pagoForm.cuenta,tipo:"Pago Proveedor",cat:r.cat,importe:-monto,detalle:`Pago remito ${r.nro} - ${prov?.nombre||""}`,fact_id:null}]);
    setPagandoRem(false); setPagarModal(null); load();
  };

  const anular = async (r) => {
    if(!confirm(`¿Anular remito ${r.nro}?`)) return;
    await db.from("remitos").update({estado:"anulado"}).eq("id",r.id);
    if(r.estado==="sin_factura") {
      const prov = proveedores.find(p=>p.id===r.prov_id);
      if(prov) await db.from("proveedores").update({saldo:Math.max(0,(prov.saldo||0)-r.monto)}).eq("id",r.prov_id);
    }
    load();
  };

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Remitos</div><div className="ph-sub">{sinFact.length} sin factura · {fmt_$(sinFact.reduce((s,r)=>s+(r.monto||0),0))} deuda provisoria</div></div>
        <button className="btn btn-acc" onClick={()=>{setForm(emptyForm);setModal(true)}}>+ Remito Valorado</button>
      </div>
      <div className="alert alert-warn">Los remitos generan <strong>deuda provisoria</strong>. Vinculalos a la factura cuando llegue, o registrá el pago directo si no viene factura.</div>
      <div className="panel">
        {loading?<div className="loading">Cargando...</div>:rFilt.length===0?<div className="empty">No hay remitos</div>:(
          <table><thead><tr><th>Proveedor</th><th>Nº Remito</th><th>Fecha</th><th>Categoría</th><th>Monto</th><th>Estado</th><th></th></tr></thead>
          <tbody>{rFilt.map(r=>{
            const prov=proveedores.find(p=>p.id===r.prov_id);
            const isAnulado = r.estado==="anulado";
            return (
              <tr key={r.id} className={r.estado==="sin_factura"?"remito-row":isAnulado?"anulada-row":""}>
                <td style={{fontWeight:500}}>{prov?.nombre}</td>
                <td className="mono">{r.nro}</td>
                <td className="mono">{fmt_d(r.fecha)}</td>
                <td><span className="badge b-muted">{r.cat}</span></td>
                <td><span className="num kpi-warn">{fmt_$(r.monto)}</span></td>
                <td>
                  {r.estado==="sin_factura"&&<span className="badge b-warn">Sin Factura</span>}
                  {r.estado==="facturado"&&<span className="badge b-success">Facturado</span>}
                  {r.estado==="pagado"&&<span className="badge b-info">Pagado</span>}
                  {r.estado==="anulado"&&<span className="badge b-anulada">Anulado</span>}
                </td>
                <td>
                  {!isAnulado && (
                    <div style={{display:"flex",gap:4}}>
                      {r.estado==="sin_factura"&&<button className="btn btn-ghost btn-sm" onClick={()=>setVincModal(r)}>Vincular FC</button>}
                      {r.estado==="sin_factura"&&<button className="btn btn-success btn-sm" onClick={()=>{setPagarModal(r);setPagoForm({cuenta:"MercadoPago",monto:r.monto,fecha:toISO(today)})}}>Pagar</button>}
                      <button className="btn btn-danger btn-sm" onClick={()=>anular(r)}>Anular</button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}</tbody></table>
        )}
      </div>

      {modal && (
        <div className="overlay" onClick={()=>setModal(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Nuevo Remito Valorado</div><button className="close-btn" onClick={()=>setModal(false)}>✕</button></div>
            <div className="modal-body">
              <div className="alert alert-info">Para compras informales. Si llega factura, la vinculás. Si no llega, pagás directo.</div>
              <div className="form2">
                <div className="field"><label>Proveedor *</label><select value={form.prov_id} onChange={e=>onProvChange(e.target.value)}><option value="">Seleccioná...</option>{proveedores.map(p=><option key={p.id} value={p.id}>{p.nombre}</option>)}</select></div>
                <div className="field"><label>Local *</label><select value={form.local_id} onChange={e=>setForm({...form,local_id:e.target.value})}><option value="">Seleccioná...</option>{localesDisp.map(l=><option key={l.id} value={l.id}>{l.nombre}</option>)}</select></div>
              </div>
              <div className="form2">
                <div className="field"><label>Nº Remito (opcional)</label><input value={form.nro} onChange={e=>setForm({...form,nro:e.target.value})} placeholder="Se genera automático"/></div>
                <div className="field"><label>Categoría EERR</label><select value={form.cat} onChange={e=>setForm({...form,cat:e.target.value})}><option value="">Seleccioná...</option>{CATEGORIAS_COMPRA.map(c=><option key={c}>{c}</option>)}</select></div>
              </div>
              <div className="form2">
                <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e=>setForm({...form,fecha:e.target.value})}/></div>
                <div className="field"><label>Monto *</label><input type="number" value={form.monto} onChange={e=>setForm({...form,monto:e.target.value})} placeholder="0"/></div>
              </div>
              <div className="field"><label>Descripción / Folio</label><input value={form.detalle} onChange={e=>setForm({...form,detalle:e.target.value})} placeholder="Folio 1234 - Detalle..."/></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Confirmar</button></div>
          </div>
        </div>
      )}

      {vincModal && (
        <div className="overlay" onClick={()=>setVincModal(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Vincular a Factura</div><button className="close-btn" onClick={()=>setVincModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="alert alert-warn">Remito {vincModal.nro} · {fmt_$(vincModal.monto)}</div>
              <p style={{fontSize:11,color:"var(--muted2)",marginBottom:12}}>Al vincular, la deuda provisoria del remito se ajusta con la deuda fiscal de la factura.</p>
              <table><thead><tr><th>Factura</th><th>Fecha</th><th>Total</th><th>Diferencia</th><th></th></tr></thead>
              <tbody>{facturas.filter(f=>f.prov_id===vincModal.prov_id).map(f=>{
                const diff = (f.total||0)-(vincModal.monto||0);
                return (<tr key={f.id}>
                  <td className="mono">{f.nro}</td><td>{fmt_d(f.fecha)}</td>
                  <td className="num">{fmt_$(f.total)}</td>
                  <td style={{color:diff>0?"var(--danger)":diff<0?"var(--success)":"var(--muted2)"}}>{diff>0?"+":""}{fmt_$(diff)}</td>
                  <td><button className="btn btn-acc btn-sm" onClick={()=>vincFact(f.id)}>Vincular</button></td>
                </tr>);
              })}</tbody></table>
              {facturas.filter(f=>f.prov_id===vincModal.prov_id).length===0&&<div className="empty">No hay facturas pendientes de este proveedor</div>}
            </div>
          </div>
        </div>
      )}

      {pagarModal && (
        <div className="overlay" onClick={()=>setPagarModal(null)}>
          <div className="modal" style={{width:420}} onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Pagar Remito Directo</div><button className="close-btn" onClick={()=>setPagarModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="alert alert-info">Remito {pagarModal.nro} · {fmt_$(pagarModal.monto)}</div>
              <div className="alert alert-warn">Esto registra el pago sin factura. El gasto impacta en caja y en el EERR.</div>
              <div className="field"><label>Cuenta de egreso</label><select value={pagoForm.cuenta} onChange={e=>setPagoForm({...pagoForm,cuenta:e.target.value})}>{CUENTAS.map(c=><option key={c}>{c}</option>)}</select></div>
              <div className="field"><label>Monto</label><input type="number" value={pagoForm.monto} onChange={e=>setPagoForm({...pagoForm,monto:e.target.value})}/></div>
              <div className="field"><label>Fecha</label><input type="date" value={pagoForm.fecha} onChange={e=>setPagoForm({...pagoForm,fecha:e.target.value})}/></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setPagarModal(null)}>Cancelar</button><button className="btn btn-success" onClick={pagarRemito} disabled={pagandoRem}>{pagandoRem?"Procesando...":"Confirmar Pago"}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CAJA ─────────────────────────────────────────────────────────────────────
function Caja() {
  const [movimientos, setMovimientos] = useState([]);
  const [saldos, setSaldos] = useState({});
  const [modal, setModal] = useState(false);
  const [editSaldoModal, setEditSaldoModal] = useState(null);
  const [filtCuenta, setFiltCuenta] = useState("Todas");
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({fecha:toISO(today),cuenta:"Caja Chica",tipo:"Pago Gasto",cat:"",importe:"",detalle:"",esEgreso:true});

  const load = async () => {
    setLoading(true);
    const [{data:m},{data:s}] = await Promise.all([
      db.from("movimientos").select("*").order("fecha",{ascending:false}).limit(80),
      db.from("saldos_caja").select("*"),
    ]);
    setMovimientos(m||[]);
    const obj={}; (s||[]).forEach(x=>obj[x.cuenta]=x.saldo); setSaldos(obj);
    setLoading(false);
  };
  useEffect(()=>{load();},[]);

  const mFilt = movimientos.filter(m=>filtCuenta==="Todas"||m.cuenta===filtCuenta);
  const totalLiquidez = Object.values(saldos).reduce((a,b)=>a+b,0);

  const guardar = async () => {
    if(!form.importe) return;
    const importe = parseFloat(form.importe)*(form.esEgreso?-1:1);
    const {esEgreso,...rest} = form;
    await db.from("movimientos").insert([{...rest,id:genId("MOV"),importe,fact_id:null}]);
    const actual = saldos[form.cuenta]||0;
    await db.from("saldos_caja").update({saldo:actual+importe}).eq("cuenta",form.cuenta);
    setModal(false); load();
  };

  const guardarSaldo = async (cuenta, nuevoSaldo) => {
    await db.from("saldos_caja").update({saldo:parseFloat(nuevoSaldo)||0}).eq("cuenta",cuenta);
    setEditSaldoModal(null); load();
  };

  const cc = c => c==="Caja Chica"?"var(--acc)":c==="Caja Mayor"?"var(--acc2)":c==="MercadoPago"?"var(--acc3)":"var(--info)";

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Caja & Bancos</div><div className="ph-sub">Total disponible: {fmt_$(totalLiquidez)}</div></div>
        <button className="btn btn-acc" onClick={()=>setModal(true)}>+ Movimiento</button>
      </div>
      <div className="grid4">
        {CUENTAS.map(k=>(
          <div key={k} className={`caja-card caja-${k==="Caja Chica"?"chica":k==="Caja Mayor"?"mayor":k==="MercadoPago"?"mp":"banco"}`}>
            <div className="caja-name">{k}</div>
            <div className="caja-saldo" style={{color:(saldos[k]||0)<0?"var(--danger)":"var(--txt)"}}>{fmt_$(saldos[k]||0)}</div>
            <button className="btn btn-ghost btn-sm" style={{marginTop:8,fontSize:9}} onClick={()=>setEditSaldoModal({cuenta:k,saldo:saldos[k]||0})}>Editar saldo</button>
          </div>
        ))}
      </div>
      <div className="panel">
        <div className="panel-hd">
          <span className="panel-title">Movimientos</span>
          <select className="search" style={{width:160}} value={filtCuenta} onChange={e=>setFiltCuenta(e.target.value)}>
            <option>Todas</option>{CUENTAS.map(c=><option key={c}>{c}</option>)}
          </select>
        </div>
        {loading?<div className="loading">Cargando...</div>:mFilt.length===0?<div className="empty">Sin movimientos</div>:(
          <table><thead><tr><th>Fecha</th><th>Cuenta</th><th>Tipo</th><th>Categoría</th><th>Detalle</th><th>Importe</th></tr></thead>
          <tbody>{mFilt.map(m=>(
            <tr key={m.id}>
              <td className="mono">{fmt_d(m.fecha)}</td>
              <td><span className="badge" style={{background:"transparent",color:cc(m.cuenta),border:`1px solid ${cc(m.cuenta)}44`}}>{m.cuenta}</span></td>
              <td style={{fontSize:11,color:"var(--muted2)"}}>{m.tipo}</td>
              <td>{m.cat?<span className="badge b-muted">{m.cat}</span>:"—"}</td>
              <td style={{fontSize:11,maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.detalle}</td>
              <td><span className="num" style={{color:m.importe<0?"var(--danger)":"var(--success)"}}>{fmt_$(m.importe)}</span></td>
            </tr>
          ))}</tbody></table>
        )}
      </div>

      {editSaldoModal && (
        <div className="overlay" onClick={()=>setEditSaldoModal(null)}>
          <div className="modal" style={{width:380}} onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Editar Saldo — {editSaldoModal.cuenta}</div><button className="close-btn" onClick={()=>setEditSaldoModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="alert alert-warn">Este ajuste modifica el saldo directamente. Usalo para sincronizar con el saldo real actual.</div>
              <div className="field"><label>Saldo actual real $</label><input type="number" value={editSaldoModal.saldo} onChange={e=>setEditSaldoModal({...editSaldoModal,saldo:e.target.value})} placeholder="0"/></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setEditSaldoModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={()=>guardarSaldo(editSaldoModal.cuenta,editSaldoModal.saldo)}>Guardar</button></div>
          </div>
        </div>
      )}

      {modal && (
        <div className="overlay" onClick={()=>setModal(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Nuevo Movimiento</div><button className="close-btn" onClick={()=>setModal(false)}>✕</button></div>
            <div className="modal-body">
              <div className="form2">
                <div className="field"><label>Cuenta</label><select value={form.cuenta} onChange={e=>setForm({...form,cuenta:e.target.value})}>{CUENTAS.map(c=><option key={c}>{c}</option>)}</select></div>
                <div className="field"><label>Dirección</label><select value={form.esEgreso?"egreso":"ingreso"} onChange={e=>setForm({...form,esEgreso:e.target.value==="egreso"})}><option value="egreso">Egreso (sale plata)</option><option value="ingreso">Ingreso (entra plata)</option></select></div>
              </div>
              <div className="form2">
                <div className="field"><label>Categoría EERR</label><select value={form.cat} onChange={e=>setForm({...form,cat:e.target.value})}><option value="">Sin categoría</option>{CATEGORIAS_COMPRA.map(c=><option key={c}>{c}</option>)}</select></div>
                <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e=>setForm({...form,fecha:e.target.value})}/></div>
              </div>
              <div className="field"><label>Importe $</label><input type="number" value={form.importe} onChange={e=>setForm({...form,importe:e.target.value})} placeholder="0"/></div>
              <div className="field"><label>Detalle</label><input value={form.detalle} onChange={e=>setForm({...form,detalle:e.target.value})} placeholder="Descripción..."/></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Guardar</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── EERR ─────────────────────────────────────────────────────────────────────
function EERR({ locales, localActivo }) {
  const [ventas, setVentas] = useState([]);
  const [facturas, setFacturas] = useState([]);
  const [sueldos, setSueldos] = useState(0);
  const [mes, setMes] = useState(toISO(today).slice(0,7));
  const [loading, setLoading] = useState(true);
  useEffect(()=>{
    const load = async () => {
      setLoading(true);
      const desde=mes+"-01", hasta=mes+"-31";
      const [{data:v},{data:f},{data:m}] = await Promise.all([
        db.from("ventas").select("*").gte("fecha",desde).lte("fecha",hasta),
        db.from("facturas").select("*").gte("fecha",desde).lte("fecha",hasta).eq("estado","pagada"),
        db.from("movimientos").select("*").gte("fecha",desde).lte("fecha",hasta).eq("cat","SUELDOS"),
      ]);
      setVentas((v||[]).filter(x=>!localActivo||x.local_id===localActivo));
      setFacturas((f||[]).filter(x=>!localActivo||x.local_id===localActivo));
      setSueldos((m||[]).filter(x=>!localActivo||true).reduce((s,x)=>s+Math.abs(x.importe||0),0));
      setLoading(false);
    };
    load();
  },[mes,localActivo]);

  const totalVentas=ventas.reduce((s,v)=>s+(v.monto||0),0);
  const totalCompras=facturas.reduce((s,f)=>s+(f.total||0),0);
  const utilidadBruta=totalVentas-totalCompras;
  const utilidadNeta=utilidadBruta-sueldos;
  const pctBruto=totalVentas>0?((utilidadBruta/totalVentas)*100).toFixed(1):0;
  const porMedio=MEDIOS_COBRO.map(m=>({m,t:ventas.filter(v=>v.medio===m).reduce((s,v)=>s+v.monto,0)})).filter(x=>x.t>0).sort((a,b)=>b.t-a.t);
  const porCat=CATEGORIAS_COMPRA.map(c=>({c,t:facturas.filter(f=>f.cat===c).reduce((s,f)=>s+f.total,0)})).filter(x=>x.t>0).sort((a,b)=>b.t-a.t);

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Estado de Resultados</div><div className="ph-sub">P&L automático · {mes}</div></div>
        <input type="month" className="search" style={{width:160}} value={mes} onChange={e=>setMes(e.target.value)}/>
      </div>
      {loading?<div className="loading">Cargando...</div>:(
        <>
          <div className="grid4">
            <div className="kpi"><div className="kpi-label">Ingresos</div><div className="kpi-value kpi-success">{fmt_$(totalVentas)}</div></div>
            <div className="kpi"><div className="kpi-label">CMV</div><div className="kpi-value kpi-warn">{fmt_$(totalCompras)}</div></div>
            <div className="kpi"><div className="kpi-label">Sueldos</div><div className="kpi-value kpi-warn">{fmt_$(sueldos)}</div></div>
            <div className="kpi"><div className="kpi-label">Utilidad Neta</div><div className={`kpi-value ${utilidadNeta>=0?"kpi-success":"kpi-danger"}`}>{fmt_$(utilidadNeta)}</div><div className="kpi-sub">Margen bruto: {pctBruto}%</div></div>
          </div>
          <div className="grid2">
            <div className="panel">
              <div className="panel-hd"><span className="panel-title">Ventas por Forma de Cobro</span></div>
              {porMedio.length===0?<div className="empty">Sin ventas</div>:(
                <div>
                  {porMedio.map(x=>(<div key={x.m} className="eerr-row"><span style={{fontSize:12}}>{x.m}</span><div><span className="num kpi-success">{fmt_$(x.t)}</span><span style={{fontSize:10,color:"var(--muted2)",marginLeft:6}}>{totalVentas>0?((x.t/totalVentas)*100).toFixed(1):0}%</span></div></div>))}
                  <div className="eerr-row" style={{background:"var(--s2)"}}><span style={{fontWeight:600}}>TOTAL VENTAS</span><span style={{fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:700,color:"var(--success)"}}>{fmt_$(totalVentas)}</span></div>
                </div>
              )}
            </div>
            <div className="panel">
              <div className="panel-hd"><span className="panel-title">Compras por Categoría</span></div>
              {porCat.length===0?<div className="empty">Sin compras</div>:(
                <div>
                  {porCat.map(x=>(<div key={x.c} className="eerr-row"><span style={{fontSize:12}}>{x.c}</span><div><span className="num kpi-warn">{fmt_$(x.t)}</span><span style={{fontSize:10,color:"var(--muted2)",marginLeft:6}}>{totalVentas>0?((x.t/totalVentas)*100).toFixed(1):0}%</span></div></div>))}
                  <div className="eerr-row" style={{background:"var(--s2)"}}><span style={{fontWeight:600}}>TOTAL CMV</span><span style={{fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:700,color:"var(--warn)"}}>{fmt_$(totalCompras)}</span></div>
                </div>
              )}
            </div>
          </div>
          <div className="panel">
            <div className="panel-hd"><span className="panel-title">Resumen P&L</span></div>
            <div style={{padding:"8px 0 12px"}}>
              {[
                ["Ventas brutas",totalVentas,"var(--success)"],
                ["(-) CMV",-totalCompras,"var(--danger)"],
                ["(=) Utilidad Bruta",utilidadBruta,utilidadBruta>=0?"var(--success)":"var(--danger)"],
                ["(-) Sueldos",-sueldos,"var(--danger)"],
                ["(=) Utilidad Neta",utilidadNeta,utilidadNeta>=0?"var(--success)":"var(--danger)"],
              ].map(([l,v,c],i)=>(
                <div key={i} className="eerr-row" style={(i===2||i===4)?{background:"var(--s2)",padding:"12px 16px"}:{}}>
                  <span style={{fontSize:(i===2||i===4)?13:12,fontWeight:(i===2||i===4)?600:400}}>{l}</span>
                  <span style={{fontFamily:"'Syne',sans-serif",fontSize:(i===2||i===4)?22:16,fontWeight:700,color:c}}>{fmt_$(v)}</span>
                </div>
              ))}
              <div style={{margin:"12px 16px 0",padding:"10px 12px",background:"rgba(232,197,71,.06)",border:"1px solid rgba(232,197,71,.2)",borderRadius:"var(--r)",fontSize:11,color:"var(--muted2)"}}>
                ⚡ OPEX, amortizaciones e impuestos — próxima fase.
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── PROVEEDORES ──────────────────────────────────────────────────────────────
function Proveedores() {
  const [proveedores, setProveedores] = useState([]);
  const [modal, setModal] = useState(false);
  const [editModal, setEditModal] = useState(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const emptyForm = {nombre:"",cuit:"",cat:"PESCADERIA",estado:"Activo"};
  const [form, setForm] = useState(emptyForm);

  const load = async () => {
    setLoading(true);
    const {data} = await db.from("proveedores").select("*").order("nombre");
    setProveedores(data||[]); setLoading(false);
  };
  useEffect(()=>{load();},[]);

  const pFilt = proveedores.filter(p=>!search||p.nombre.toLowerCase().includes(search.toLowerCase())||(p.cuit||"").includes(search));

  const guardar = async () => {
    if(!form.nombre) return;
    await db.from("proveedores").insert([{...form,saldo:0}]);
    setModal(false); setForm(emptyForm); load();
  };

  const guardarEdit = async () => {
    await db.from("proveedores").update({nombre:editModal.nombre,cuit:editModal.cuit,cat:editModal.cat,estado:editModal.estado}).eq("id",editModal.id);
    setEditModal(null); load();
  };

  const toggleEstado = async (p) => {
    const nuevoEstado = p.estado==="Activo"?"Inactivo":"Activo";
    await db.from("proveedores").update({estado:nuevoEstado}).eq("id",p.id);
    load();
  };

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Proveedores</div><div className="ph-sub">{proveedores.filter(p=>p.estado==="Activo").length} activos · Deuda {fmt_$(proveedores.reduce((s,p)=>s+(p.saldo||0),0))}</div></div>
        <div style={{display:"flex",gap:8}}><input className="search" placeholder="Buscar..." value={search} onChange={e=>setSearch(e.target.value)}/><button className="btn btn-acc" onClick={()=>setModal(true)}>+ Nuevo</button></div>
      </div>
      <div className="panel">
        {loading?<div className="loading">Cargando...</div>:(
          <table><thead><tr><th>Proveedor</th><th>CUIT</th><th>Categoría EERR</th><th>Saldo</th><th>Estado</th><th></th></tr></thead>
          <tbody>{pFilt.map(p=>(
            <tr key={p.id} className={p.saldo>0?"prov-row":""} style={{opacity:p.estado==="Inactivo"?0.5:1}}>
              <td style={{fontWeight:500}}>{p.nombre}</td>
              <td className="mono" style={{color:"var(--muted2)"}}>{p.cuit||"—"}</td>
              <td><span className="badge b-muted">{p.cat}</span></td>
              <td><span className="num" style={{color:p.saldo>0?"var(--warn)":"var(--muted2)"}}>{fmt_$(p.saldo||0)}</span></td>
              <td><span className={`badge ${p.estado==="Activo"?"b-success":"b-muted"}`}>{p.estado}</span></td>
              <td>
                <div style={{display:"flex",gap:4}}>
                  <button className="btn btn-ghost btn-sm" onClick={()=>setEditModal({...p})}>Editar</button>
                  <button className="btn btn-ghost btn-sm" onClick={()=>toggleEstado(p)}>{p.estado==="Activo"?"Desactivar":"Activar"}</button>
                </div>
              </td>
            </tr>
          ))}</tbody></table>
        )}
      </div>

      {modal && (
        <div className="overlay" onClick={()=>setModal(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Nuevo Proveedor</div><button className="close-btn" onClick={()=>setModal(false)}>✕</button></div>
            <div className="modal-body">
              <div className="field"><label>Razón Social *</label><input value={form.nombre} onChange={e=>setForm({...form,nombre:e.target.value})} placeholder="Empresa S.A."/></div>
              <div className="form2">
                <div className="field"><label>CUIT</label><input value={form.cuit} onChange={e=>setForm({...form,cuit:e.target.value})} placeholder="30-12345678-0"/></div>
                <div className="field"><label>Categoría EERR</label><select value={form.cat} onChange={e=>setForm({...form,cat:e.target.value})}>{CATEGORIAS_COMPRA.map(c=><option key={c}>{c}</option>)}</select></div>
              </div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Guardar</button></div>
          </div>
        </div>
      )}

      {editModal && (
        <div className="overlay" onClick={()=>setEditModal(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Editar Proveedor</div><button className="close-btn" onClick={()=>setEditModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="field"><label>Razón Social</label><input value={editModal.nombre} onChange={e=>setEditModal({...editModal,nombre:e.target.value})}/></div>
              <div className="form2">
                <div className="field"><label>CUIT</label><input value={editModal.cuit||""} onChange={e=>setEditModal({...editModal,cuit:e.target.value})}/></div>
                <div className="field"><label>Categoría EERR</label><select value={editModal.cat} onChange={e=>setEditModal({...editModal,cat:e.target.value})}>{CATEGORIAS_COMPRA.map(c=><option key={c}>{c}</option>)}</select></div>
              </div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setEditModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={guardarEdit}>Guardar</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── EMPLEADOS ────────────────────────────────────────────────────────────────
function Empleados({ locales }) {
  const [empleados,setEmpleados]=useState([]);
  const [modal,setModal]=useState(false);
  const [editModal,setEditModal]=useState(null);
  const [pagarModal,setPagarModal]=useState(null);
  const [aumentoModal,setAumentoModal]=useState(false);
  const [archivosModal,setArchivosModal]=useState(null);
  const [archivos,setArchivos]=useState([]);
  const [uploading,setUploading]=useState(false);
  const [loading,setLoading]=useState(true);
  const [search,setSearch]=useState("");
  const [pct,setPct]=useState("");
  const [pagoForm,setPagoForm]=useState({cuenta:"Banco",fecha:toISO(today),monto:""});
  const emptyForm={nombre:"",legajo:"",local_id:"",puesto:"",sueldo:"",fecha_ingreso:toISO(today),fecha_alta_afip:"",estado:"Activo"};
  const [form,setForm]=useState(emptyForm);

  const load=async()=>{setLoading(true);const {data}=await db.from("empleados").select("*").order("nombre");setEmpleados(data||[]);setLoading(false);};
  useEffect(()=>{load();},[]);

  const loadArchivos=async(empId)=>{const {data}=await db.from("empleado_archivos").select("*").eq("empleado_id",empId).order("fecha",{ascending:false});setArchivos(data||[]);};
  const abrirArchivos=async(e)=>{setArchivosModal(e);await loadArchivos(e.id);};

  const subirArchivo=async(file,empId)=>{
    if(!file)return;
    setUploading(true);
    const ext=file.name.split(".").pop();
    const path=`${empId}/${Date.now()}.${ext}`;
    const {error}=await db.storage.from("empleados").upload(path,file);
    if(!error){
      const {data:urlData}=db.storage.from("empleados").getPublicUrl(path);
      await db.from("empleado_archivos").insert([{id:genId("ARG"),empleado_id:empId,nombre:file.name,url:urlData.publicUrl,tipo:ext,fecha:toISO(today),detalle:""}]);
      await loadArchivos(empId);
    }
    setUploading(false);
  };

  const eFilt=empleados.filter(e=>!search||e.nombre.toLowerCase().includes(search.toLowerCase()));
  const totalSueldos=empleados.filter(e=>e.estado==="Activo").reduce((s,e)=>s+(e.sueldo||0),0);

  const guardar=async()=>{if(!form.nombre)return;await db.from("empleados").insert([{...form,local_id:form.local_id?parseInt(form.local_id):null,sueldo:parseFloat(form.sueldo)||0}]);setModal(false);setForm(emptyForm);load();};
  const guardarEdit=async()=>{await db.from("empleados").update({nombre:editModal.nombre,legajo:editModal.legajo,puesto:editModal.puesto,sueldo:parseFloat(editModal.sueldo)||0,local_id:editModal.local_id?parseInt(editModal.local_id):null,estado:editModal.estado,fecha_ingreso:editModal.fecha_ingreso,fecha_alta_afip:editModal.fecha_alta_afip,fecha_baja:editModal.fecha_baja,fecha_baja_afip:editModal.fecha_baja_afip}).eq("id",editModal.id);setEditModal(null);load();};

  const [pagandoSue,setPagandoSue]=useState(false);
  const pagar=async()=>{
    if(pagandoSue)return; setPagandoSue(true);
    const e=pagarModal;const monto=parseFloat(pagoForm.monto)||e.sueldo;
    const {data:caja}=await db.from("saldos_caja").select("saldo").eq("cuenta",pagoForm.cuenta).single();
    if(caja)await db.from("saldos_caja").update({saldo:(caja.saldo||0)-monto}).eq("cuenta",pagoForm.cuenta);
    await db.from("movimientos").insert([{id:genId("MOV"),fecha:pagoForm.fecha,cuenta:pagoForm.cuenta,tipo:"Pago Sueldo",cat:"SUELDOS",importe:-monto,detalle:`Sueldo ${e.nombre}`,fact_id:null}]);
    setPagandoSue(false); setPagarModal(null);
  };

  const aumentoMasivo=async()=>{
    const p=parseFloat(pct);if(!p||p<=0)return;
    const activos=empleados.filter(e=>e.estado==="Activo");
    await Promise.all(activos.map(e=>db.from("empleados").update({sueldo:Math.round(e.sueldo*(1+p/100))}).eq("id",e.id)));
    setAumentoModal(false);setPct("");load();
  };

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Empleados</div><div className="ph-sub">{empleados.filter(e=>e.estado==="Activo").length} activos · Masa salarial {fmt_$(totalSueldos)}/mes</div></div>
        <div style={{display:"flex",gap:8}}>
          <input className="search" placeholder="Buscar..." value={search} onChange={e=>setSearch(e.target.value)}/>
          <button className="btn btn-ghost" onClick={()=>setAumentoModal(true)}>Aumento %</button>
          <button className="btn btn-acc" onClick={()=>{setForm(emptyForm);setModal(true)}}>+ Nuevo</button>
        </div>
      </div>
      <div className="panel">
        {loading?<div className="loading">Cargando...</div>:eFilt.length===0?<div className="empty">No hay empleados</div>:(
          <table><thead><tr><th>Nombre</th><th>Legajo</th><th>Puesto</th><th>Local</th><th>Ingreso</th><th>Alta AFIP</th><th>Sueldo</th><th>Estado</th><th></th></tr></thead>
          <tbody>{eFilt.map(e=>(
            <tr key={e.id} style={{opacity:e.estado==="Inactivo"?0.5:1}}>
              <td style={{fontWeight:500}}>{e.nombre}</td>
              <td className="mono" style={{color:"var(--muted2)"}}>{e.legajo||"—"}</td>
              <td style={{fontSize:11,color:"var(--muted2)"}}>{e.puesto||"—"}</td>
              <td style={{fontSize:11,color:"var(--muted2)"}}>{locales.find(l=>l.id===e.local_id)?.nombre||"—"}</td>
              <td className="mono" style={{fontSize:11}}>{fmt_d(e.fecha_ingreso)}</td>
              <td className="mono" style={{fontSize:11,color:e.fecha_alta_afip?"var(--success)":"var(--warn)"}}>{e.fecha_alta_afip?fmt_d(e.fecha_alta_afip):"Pendiente"}</td>
              <td><span className="num kpi-acc">{fmt_$(e.sueldo)}</span></td>
              <td><span className={`badge ${e.estado==="Activo"?"b-success":"b-muted"}`}>{e.estado}</span></td>
              <td><div style={{display:"flex",gap:4}}>
                <button className="btn btn-ghost btn-sm" onClick={()=>setEditModal({...e})}>Editar</button>
                <button className="btn btn-ghost btn-sm" onClick={()=>abrirArchivos(e)}>📎</button>
                {e.estado==="Activo"&&<button className="btn btn-success btn-sm" onClick={()=>{setPagarModal(e);setPagoForm({cuenta:"Banco",fecha:toISO(today),monto:e.sueldo})}}>Pagar</button>}
              </div></td>
            </tr>
          ))}</tbody></table>
        )}
      </div>

      {modal&&(<div className="overlay" onClick={()=>setModal(false)}><div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Nuevo Empleado</div><button className="close-btn" onClick={()=>setModal(false)}>✕</button></div>
        <div className="modal-body">
          <div className="form2">
            <div className="field"><label>Nombre *</label><input value={form.nombre} onChange={e=>setForm({...form,nombre:e.target.value})} placeholder="Nombre completo"/></div>
            <div className="field"><label>Legajo</label><input value={form.legajo} onChange={e=>setForm({...form,legajo:e.target.value})} placeholder="001"/></div>
          </div>
          <div className="form2">
            <div className="field"><label>Puesto</label><input value={form.puesto} onChange={e=>setForm({...form,puesto:e.target.value})} placeholder="Mozo, Sushiman..."/></div>
            <div className="field"><label>Local</label><select value={form.local_id} onChange={e=>setForm({...form,local_id:e.target.value})}><option value="">Sin asignar</option>{locales.map(l=><option key={l.id} value={l.id}>{l.nombre}</option>)}</select></div>
          </div>
          <div className="form2">
            <div className="field"><label>Fecha de Ingreso</label><input type="date" value={form.fecha_ingreso} onChange={e=>setForm({...form,fecha_ingreso:e.target.value})}/></div>
            <div className="field"><label>Fecha Alta AFIP</label><input type="date" value={form.fecha_alta_afip} onChange={e=>setForm({...form,fecha_alta_afip:e.target.value})}/></div>
          </div>
          <div className="field"><label>Sueldo mensual $</label><input type="number" value={form.sueldo} onChange={e=>setForm({...form,sueldo:e.target.value})} placeholder="0"/></div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Guardar</button></div>
      </div></div>)}

      {editModal&&(<div className="overlay" onClick={()=>setEditModal(null)}><div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Editar Empleado</div><button className="close-btn" onClick={()=>setEditModal(null)}>✕</button></div>
        <div className="modal-body">
          <div className="form2">
            <div className="field"><label>Nombre</label><input value={editModal.nombre} onChange={e=>setEditModal({...editModal,nombre:e.target.value})}/></div>
            <div className="field"><label>Legajo</label><input value={editModal.legajo||""} onChange={e=>setEditModal({...editModal,legajo:e.target.value})}/></div>
          </div>
          <div className="form2">
            <div className="field"><label>Puesto</label><input value={editModal.puesto||""} onChange={e=>setEditModal({...editModal,puesto:e.target.value})}/></div>
            <div className="field"><label>Local</label><select value={editModal.local_id||""} onChange={e=>setEditModal({...editModal,local_id:e.target.value})}><option value="">Sin asignar</option>{locales.map(l=><option key={l.id} value={l.id}>{l.nombre}</option>)}</select></div>
          </div>
          <div className="form2">
            <div className="field"><label>Fecha de Ingreso</label><input type="date" value={editModal.fecha_ingreso||""} onChange={e=>setEditModal({...editModal,fecha_ingreso:e.target.value})}/></div>
            <div className="field"><label>Fecha Alta AFIP</label><input type="date" value={editModal.fecha_alta_afip||""} onChange={e=>setEditModal({...editModal,fecha_alta_afip:e.target.value})}/></div>
          </div>
          <div className="form2">
            <div className="field"><label>Fecha de Baja</label><input type="date" value={editModal.fecha_baja||""} onChange={e=>setEditModal({...editModal,fecha_baja:e.target.value})}/></div>
            <div className="field"><label>Fecha Baja AFIP</label><input type="date" value={editModal.fecha_baja_afip||""} onChange={e=>setEditModal({...editModal,fecha_baja_afip:e.target.value})}/></div>
          </div>
          <div className="form2">
            <div className="field"><label>Sueldo $</label><input type="number" value={editModal.sueldo} onChange={e=>setEditModal({...editModal,sueldo:e.target.value})}/></div>
            <div className="field"><label>Estado</label><select value={editModal.estado} onChange={e=>setEditModal({...editModal,estado:e.target.value})}><option>Activo</option><option>Inactivo</option></select></div>
          </div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setEditModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={guardarEdit}>Guardar</button></div>
      </div></div>)}

      {pagarModal&&(<div className="overlay" onClick={()=>setPagarModal(null)}><div className="modal" style={{width:420}} onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Pagar Sueldo</div><button className="close-btn" onClick={()=>setPagarModal(null)}>✕</button></div>
        <div className="modal-body">
          <div className="alert alert-info">{pagarModal.nombre} · Sueldo: {fmt_$(pagarModal.sueldo)}</div>
          <div className="field"><label>Cuenta</label><select value={pagoForm.cuenta} onChange={e=>setPagoForm({...pagoForm,cuenta:e.target.value})}>{CUENTAS.map(c=><option key={c}>{c}</option>)}</select></div>
          <div className="field"><label>Monto</label><input type="number" value={pagoForm.monto} onChange={e=>setPagoForm({...pagoForm,monto:e.target.value})}/></div>
          <div className="field"><label>Fecha</label><input type="date" value={pagoForm.fecha} onChange={e=>setPagoForm({...pagoForm,fecha:e.target.value})}/></div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setPagarModal(null)}>Cancelar</button><button className="btn btn-success" onClick={pagar}>Confirmar Pago</button></div>
      </div></div>)}

      {aumentoModal&&(<div className="overlay" onClick={()=>setAumentoModal(false)}><div className="modal" style={{width:380}} onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Aumento Masivo</div><button className="close-btn" onClick={()=>setAumentoModal(false)}>✕</button></div>
        <div className="modal-body">
          <div className="alert alert-warn">Se aplica a todos los activos. Masa actual: {fmt_$(totalSueldos)}</div>
          <div className="field"><label>Porcentaje %</label><input type="number" value={pct} onChange={e=>setPct(e.target.value)} placeholder="Ej: 15"/></div>
          {pct&&<div style={{padding:10,background:"var(--s2)",borderRadius:"var(--r)",fontSize:12}}>Nueva masa: <strong style={{color:"var(--acc)"}}>{fmt_$(totalSueldos*(1+parseFloat(pct)/100))}</strong></div>}
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setAumentoModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={aumentoMasivo}>Aplicar</button></div>
      </div></div>)}

      {archivosModal&&(<div className="overlay" onClick={()=>setArchivosModal(null)}><div className="modal" style={{width:580}} onClick={e=>e.stopPropagation()}>
        <div className="modal-hd">
          <div><div className="modal-title">📎 Legajo — {archivosModal.nombre}</div><div style={{fontSize:11,color:"var(--muted2)",marginTop:2}}>{archivosModal.puesto} · {locales.find(l=>l.id===archivosModal.local_id)?.nombre}</div></div>
          <button className="close-btn" onClick={()=>setArchivosModal(null)}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{marginBottom:16,padding:12,background:"var(--s2)",borderRadius:"var(--r)",border:"2px dashed var(--bd2)"}}>
            <div style={{fontSize:10,letterSpacing:2,textTransform:"uppercase",color:"var(--muted)",marginBottom:8}}>Subir documento</div>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" style={{display:"none"}} id="file-upload"
              onChange={e=>subirArchivo(e.target.files[0],archivosModal.id)}/>
            <label htmlFor="file-upload" className="btn btn-acc" style={{cursor:"pointer",display:"inline-flex"}}>
              {uploading?"Subiendo...":"+ Seleccionar archivo"}
            </label>
            <span style={{fontSize:10,color:"var(--muted)",marginLeft:10}}>PDF, JPG, PNG — Altas, bajas, recibos firmados...</span>
          </div>
          {archivos.length===0?<div className="empty">No hay archivos cargados</div>:(
            <table><thead><tr><th>Nombre</th><th>Tipo</th><th>Fecha</th><th></th></tr></thead>
            <tbody>{archivos.map(a=>(
              <tr key={a.id}>
                <td><a href={a.url} target="_blank" rel="noreferrer" style={{color:"var(--acc)",textDecoration:"none"}}>{a.nombre}</a></td>
                <td><span className="badge b-muted">{a.tipo?.toUpperCase()}</span></td>
                <td className="mono" style={{fontSize:11}}>{fmt_d(a.fecha)}</td>
                <td><a href={a.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">⬇ Ver</a></td>
              </tr>
            ))}</tbody></table>
          )}
        </div>
      </div></div>)}
    </div>
  );
}


function Config({ locales }) {
  const [usuarios, setUsuarios] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [editModal, setEditModal] = useState(null);
  const [form, setForm] = useState({nombre:"",email:"",password:"",rol:"cajero",locales:[]});

  const load = async () => {
    setLoading(true);
    const {data} = await db.from("usuarios").select("*").order("rol");
    setUsuarios(data||[]); setLoading(false);
  };
  useEffect(()=>{load();},[]);

  const guardar = async () => {
    if(!form.nombre||!form.email||!form.password) return;
    await db.from("usuarios").insert([form]);
    setModal(false); setForm({nombre:"",email:"",password:"",rol:"cajero",locales:[]}); load();
  };

  const guardarEdit = async () => {
    await db.from("usuarios").update({password:editModal.password}).eq("id",editModal.id);
    setEditModal(null); load();
  };

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Usuarios</div><div className="ph-sub">Accesos y permisos</div></div>
        <button className="btn btn-acc" onClick={()=>setModal(true)}>+ Nuevo Usuario</button>
      </div>
      <div className="panel">
        {loading?<div className="loading">Cargando...</div>:(
          <table><thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Locales</th><th></th></tr></thead>
          <tbody>{usuarios.map(u=>{
            const locs=u.rol==="dueno"?"Todos":(u.locales||[]).map(id=>locales.find(l=>l.id===id)?.nombre).filter(Boolean).join(", ")||"Sin asignar";
            return (<tr key={u.id}>
              <td style={{fontWeight:500}}>{u.nombre}</td>
              <td className="mono" style={{color:"var(--muted2)"}}>{u.email}</td>
              <td><span className="badge" style={{background:ROLES[u.rol]?.color+"22",color:ROLES[u.rol]?.color}}>{ROLES[u.rol]?.label}</span></td>
              <td style={{fontSize:11,color:"var(--muted2)"}}>{locs}</td>
              <td><button className="btn btn-ghost btn-sm" onClick={()=>setEditModal({...u})}>Cambiar clave</button></td>
            </tr>);
          })}</tbody></table>
        )}
      </div>
      {modal && (
        <div className="overlay" onClick={()=>setModal(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Nuevo Usuario</div><button className="close-btn" onClick={()=>setModal(false)}>✕</button></div>
            <div className="modal-body">
              <div className="field"><label>Nombre</label><input value={form.nombre} onChange={e=>setForm({...form,nombre:e.target.value})} placeholder="Nombre completo"/></div>
              <div className="form2">
                <div className="field"><label>Usuario</label><input value={form.email} onChange={e=>setForm({...form,email:e.target.value})} placeholder="usuario"/></div>
                <div className="field"><label>Contraseña</label><input value={form.password} onChange={e=>setForm({...form,password:e.target.value})} placeholder="••••••••"/></div>
              </div>
              <div className="field"><label>Rol</label><select value={form.rol} onChange={e=>setForm({...form,rol:e.target.value})}>{Object.entries(ROLES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}</select></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Crear</button></div>
          </div>
        </div>
      )}
      {editModal && (
        <div className="overlay" onClick={()=>setEditModal(null)}>
          <div className="modal" style={{width:380}} onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Cambiar Contraseña</div><button className="close-btn" onClick={()=>setEditModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="alert alert-info">Usuario: {editModal.nombre}</div>
              <div className="field"><label>Nueva contraseña</label><input value={editModal.password} onChange={e=>setEditModal({...editModal,password:e.target.value})} placeholder="Nueva contraseña"/></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setEditModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={guardarEdit}>Guardar</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── APP ──────────────────────────────────────────────────────────────────────

// ─── GASTOS ───────────────────────────────────────────────────────────────────
function Gastos({ user, locales, localActivo }) {
  const [gastos,setGastos]=useState([]);
  const [loading,setLoading]=useState(true);
  const [tab,setTab]=useState("fijos");
  const [modal,setModal]=useState(false);
  const [mes,setMes]=useState(toISO(today).slice(0,7));
  const emptyForm={fecha:toISO(today),local_id:"",categoria:"",monto:"",detalle:"",cuenta:"MercadoPago"};
  const [form,setForm]=useState(emptyForm);
  const load=async()=>{
    setLoading(true);
    let q=db.from("gastos").select("*").gte("fecha",mes+"-01").lte("fecha",mes+"-31").order("fecha",{ascending:false});
    if(localActivo)q=q.eq("local_id",localActivo);
    const {data}=await q;setGastos(data||[]);setLoading(false);
  };
  useEffect(()=>{load();},[mes,localActivo]);
  const getCats=()=>tab==="fijos"?GASTOS_FIJOS:tab==="variables"?GASTOS_VARIABLES:tab==="publicidad"?GASTOS_PUBLICIDAD:COMISIONES_CATS;
  const getTipo=()=>tab==="fijos"?"fijo":tab==="variables"?"variable":tab==="publicidad"?"publicidad":"comision";
  const gFilt=gastos.filter(g=>g.tipo===getTipo());
  const totalMes=gastos.reduce((s,g)=>s+(g.monto||0),0);
  const totalTab=gFilt.reduce((s,g)=>s+(g.monto||0),0);
  const guardar=async()=>{
    if(!form.monto||!form.categoria)return;
    const nuevo={...form,id:genId("GASTO"),tipo:getTipo(),local_id:form.local_id?parseInt(form.local_id):null,monto:parseFloat(form.monto)};
    await db.from("gastos").insert([nuevo]);
    const {data:caja}=await db.from("saldos_caja").select("saldo").eq("cuenta",form.cuenta).single();
    if(caja)await db.from("saldos_caja").update({saldo:(caja.saldo||0)-parseFloat(form.monto)}).eq("cuenta",form.cuenta);
    await db.from("movimientos").insert([{id:genId("MOV"),fecha:form.fecha,cuenta:form.cuenta,tipo:"Gasto "+getTipo(),cat:form.categoria,importe:-parseFloat(form.monto),detalle:form.detalle||form.categoria,fact_id:null}]);
    setModal(false);setForm(emptyForm);load();
  };
  const tabLabels=[["fijos","Gastos Fijos"],["variables","Gastos Variables"],["publicidad","Publicidad y MKT"],["comisiones","Comisiones"]];
  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Gastos</div><div className="ph-sub">Total mes: {fmt_$(totalMes)}</div></div>
        <div style={{display:"flex",gap:8}}>
          <input type="month" className="search" style={{width:160}} value={mes} onChange={e=>setMes(e.target.value)}/>
          <button className="btn btn-acc" onClick={()=>{setForm(emptyForm);setModal(true)}}>+ Cargar Gasto</button>
        </div>
      </div>
      <div className="tabs">{tabLabels.map(([id,l])=><div key={id} className={`tab ${tab===id?"active":""}`} onClick={()=>setTab(id)}>{l}</div>)}</div>
      <div className="panel">
        <div className="panel-hd"><span className="panel-title">{tabLabels.find(t=>t[0]===tab)?.[1]}</span><span className="num kpi-warn">{fmt_$(totalTab)}</span></div>
        {loading?<div className="loading">Cargando...</div>:gFilt.length===0?<div className="empty">No hay gastos este mes</div>:(
          <table><thead><tr><th>Fecha</th><th>Categoría</th><th>Detalle</th><th>Local</th><th>Cuenta</th><th>Monto</th></tr></thead>
          <tbody>{gFilt.map(g=>(
            <tr key={g.id}>
              <td className="mono">{fmt_d(g.fecha)}</td>
              <td><span className="badge b-muted">{g.categoria}</span></td>
              <td style={{fontSize:11,color:"var(--muted2)"}}>{g.detalle||"—"}</td>
              <td style={{fontSize:11,color:"var(--muted2)"}}>{locales.find(l=>l.id===g.local_id)?.nombre||"Todos"}</td>
              <td style={{fontSize:11,color:"var(--muted2)"}}>{g.cuenta||"—"}</td>
              <td><span className="num kpi-danger">{fmt_$(g.monto)}</span></td>
            </tr>
          ))}</tbody></table>
        )}
      </div>
      {modal&&(<div className="overlay" onClick={()=>setModal(false)}><div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Cargar — {tabLabels.find(t=>t[0]===tab)?.[1]}</div><button className="close-btn" onClick={()=>setModal(false)}>✕</button></div>
        <div className="modal-body">
          <div className="form2">
            <div className="field"><label>Categoría *</label><select value={form.categoria} onChange={e=>setForm({...form,categoria:e.target.value})}><option value="">Seleccioná...</option>{getCats().map(c=><option key={c}>{c}</option>)}</select></div>
            <div className="field"><label>Local</label><select value={form.local_id} onChange={e=>setForm({...form,local_id:e.target.value})}><option value="">Todos</option>{locales.map(l=><option key={l.id} value={l.id}>{l.nombre}</option>)}</select></div>
          </div>
          <div className="form2">
            <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e=>setForm({...form,fecha:e.target.value})}/></div>
            <div className="field"><label>Cuenta de egreso</label><select value={form.cuenta} onChange={e=>setForm({...form,cuenta:e.target.value})}>{CUENTAS.map(c=><option key={c}>{c}</option>)}</select></div>
          </div>
          <div className="field"><label>Monto $</label><input type="number" value={form.monto} onChange={e=>setForm({...form,monto:e.target.value})} placeholder="0"/></div>
          <div className="field"><label>Detalle</label><input value={form.detalle} onChange={e=>setForm({...form,detalle:e.target.value})} placeholder="Descripción..."/></div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Guardar</button></div>
      </div></div>)}
    </div>
  );
}

// ─── CONTADOR ─────────────────────────────────────────────────────────────────
function Contador({ locales, localActivo }) {
  const [facturas,setFacturas]=useState([]);
  const [ventas,setVentas]=useState([]);
  const [loading,setLoading]=useState(true);
  const [tab,setTab]=useState("iva");
  const [mes,setMes]=useState(toISO(today).slice(0,7));
  useEffect(()=>{
    const load=async()=>{
      setLoading(true);
      const desde=mes+"-01",hasta=mes+"-31";
      const [{data:f},{data:v}]=await Promise.all([
        db.from("facturas").select("*").gte("fecha",desde).lte("fecha",hasta).neq("estado","anulada"),
        db.from("ventas").select("*").gte("fecha",desde).lte("fecha",hasta),
      ]);
      const lid=localActivo?parseInt(localActivo):null;
      setFacturas((f||[]).filter(x=>!lid||parseInt(x.local_id)===lid));
      setVentas((v||[]).filter(x=>!lid||parseInt(x.local_id)===lid));
      setLoading(false);
    };
    load();
  },[mes,localActivo]);
  const ivaC21=facturas.reduce((s,f)=>s+(f.iva21||0),0);
  const ivaC105=facturas.reduce((s,f)=>s+(f.iva105||0),0);
  const totalIvaC=ivaC21+ivaC105;
  const totalV=ventas.reduce((s,v)=>s+(v.monto||0),0);
  const ivaV=totalV/1.21*0.21;
  const pos=ivaV-totalIvaC;
  const exportCSV=(rows,fn)=>{const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([rows.map(r=>r.join(",")).join("\n")],{type:"text/csv"}));a.download=fn;a.click();};
  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Contador / IVA</div><div className="ph-sub">Libros y posición fiscal</div></div>
        <input type="month" className="search" style={{width:160}} value={mes} onChange={e=>setMes(e.target.value)}/>
      </div>
      <div className="tabs">
        {[["iva","Monitor IVA"],["compras","Libro IVA Compras"],["ventas_l","Libro IVA Ventas"]].map(([id,l])=>(
          <div key={id} className={`tab ${tab===id?"active":""}`} onClick={()=>setTab(id)}>{l}</div>
        ))}
      </div>
      {loading?<div className="loading">Cargando...</div>:tab==="iva"?(
        <>
          <div className="grid3">
            <div className="kpi"><div className="kpi-label">IVA Ventas (Débito)</div><div className="kpi-value kpi-danger">{fmt_$(ivaV)}</div><div className="kpi-sub">Estimado s/ {fmt_$(totalV)}</div></div>
            <div className="kpi"><div className="kpi-label">IVA Compras (Crédito)</div><div className="kpi-value kpi-success">{fmt_$(totalIvaC)}</div><div className="kpi-sub">21%: {fmt_$(ivaC21)} · 10.5%: {fmt_$(ivaC105)}</div></div>
            <div className="kpi"><div className="kpi-label">Posición Neta</div><div className={`kpi-value ${pos>0?"kpi-danger":"kpi-success"}`}>{fmt_$(pos)}</div><div className="kpi-sub">{pos>0?"⚠ A pagar a AFIP":"✓ Saldo a favor"}</div></div>
          </div>
          <div className="panel">
            <div className="panel-hd"><span className="panel-title">Resumen Fiscal — {mes}</span></div>
            <div style={{padding:"8px 0 12px"}}>
              {[["Débito Fiscal (IVA ventas)",ivaV,"var(--danger)"],["(-) Crédito Fiscal",-totalIvaC,"var(--success)"],["(=) Posición Neta",pos,pos>0?"var(--danger)":"var(--success)"]].map(([l,v,c],i)=>(
                <div key={i} className="eerr-row" style={i===2?{background:"var(--s2)",padding:"12px 16px"}:{}}>
                  <span style={{fontSize:i===2?13:12,fontWeight:i===2?600:400}}>{l}</span>
                  <span style={{fontFamily:"'Syne',sans-serif",fontSize:i===2?22:16,fontWeight:700,color:c}}>{fmt_$(v)}</span>
                </div>
              ))}
              <div style={{margin:"12px 16px 0",padding:"10px 12px",background:pos>50000?"rgba(239,68,68,.08)":"rgba(34,197,94,.08)",border:`1px solid ${pos>50000?"rgba(239,68,68,.3)":"rgba(34,197,94,.3)"}`,borderRadius:"var(--r)",fontSize:11}}>
                {pos>50000?"⚠ Posición IVA elevada. Considerá hacer más compras con factura.":"✓ Posición IVA bajo control."}
              </div>
            </div>
          </div>
        </>
      ):tab==="compras"?(
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-title">Libro IVA Compras — {mes} ({facturas.length} comp.)</span>
            <button className="btn btn-acc btn-sm" onClick={()=>exportCSV([["Fecha","Nro Factura","Neto","IVA 21","IVA 10.5","IIBB","Total"],...facturas.map(f=>[f.fecha,f.nro,f.neto,f.iva21,f.iva105,f.iibb,f.total])],`libro_compras_${mes}.csv`)}>⬇ Exportar CSV</button>
          </div>
          {facturas.length===0?<div className="empty">Sin facturas</div>:(
            <table><thead><tr><th>Fecha</th><th>Nº Factura</th><th>Neto</th><th>IVA 21%</th><th>IVA 10.5%</th><th>IIBB</th><th>Total</th></tr></thead>
            <tbody>{facturas.map(f=><tr key={f.id}><td className="mono">{fmt_d(f.fecha)}</td><td className="mono">{f.nro}</td><td>{fmt_$(f.neto)}</td><td style={{color:"var(--warn)"}}>{fmt_$(f.iva21)}</td><td style={{color:"var(--warn)"}}>{fmt_$(f.iva105)}</td><td style={{color:"var(--muted2)"}}>{fmt_$(f.iibb)}</td><td><span className="num kpi-acc">{fmt_$(f.total)}</span></td></tr>)}</tbody>
          </table>)}
        </div>
      ):(
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-title">Libro IVA Ventas — {mes} ({ventas.length} reg.)</span>
            <button className="btn btn-acc btn-sm" onClick={()=>exportCSV([["Fecha","Local","Forma Cobro","Total","Neto Est","IVA 21 Est"],...ventas.map(v=>[v.fecha,locales.find(l=>l.id===v.local_id)?.nombre,v.medio,v.monto,(v.monto/1.21).toFixed(2),(v.monto/1.21*0.21).toFixed(2)])],`libro_ventas_${mes}.csv`)}>⬇ Exportar CSV</button>
          </div>
          {ventas.length===0?<div className="empty">Sin ventas</div>:(
            <table><thead><tr><th>Fecha</th><th>Local</th><th>Forma de Cobro</th><th>Total</th><th>Neto Est.</th><th>IVA Est.</th></tr></thead>
            <tbody>{ventas.map(v=><tr key={v.id}><td className="mono">{fmt_d(v.fecha)}</td><td style={{fontSize:11,color:"var(--muted2)"}}>{locales.find(l=>l.id===v.local_id)?.nombre}</td><td>{v.medio}</td><td><span className="num kpi-success">{fmt_$(v.monto)}</span></td><td style={{color:"var(--muted2)"}}>{fmt_$(v.monto/1.21)}</td><td style={{color:"var(--warn)"}}>{fmt_$(v.monto/1.21*0.21)}</td></tr>)}</tbody>
          </table>)}
        </div>
      )}
    </div>
  );
}

// ─── IMPORTAR MAXIREST ────────────────────────────────────────────────────────
function ImportarMaxirest({ locales }) {
  const [texto,setTexto]=useState("");
  const [preview,setPreview]=useState(null);
  const [loading,setLoading]=useState(false);
  const MMAP={"EFECTIVO SALON":"EFECTIVO SALON","EFECTIVO DELIVERY":"EFECTIVO DELIVERY","TARJETA DEBITO":"TARJETA DEBITO","TARJETA CREDITO":"TARJETA CREDITO","RAPPI ONLINE":"RAPPI ONLINE","PEYA ONLINE":"PEYA ONLINE","MP DELIVERY":"MP DELIVERY","MASDELIVERY ONLINE":"MASDELIVERY ONLINE","BIGBOX":"BIGBOX","FANBAG":"FANBAG","TRANSFERENCIA":"TRANSFERENCIA","QR":"QR","LINK":"LINK","POINT NAVE":"Point Nave"};
  const parsear=()=>{
    if(!texto.trim())return;
    let fecha=toISO(today);
    const fm=texto.match(/(\w+)\s+(\d+)\s+de\s+(\w+)\s+de\s+(\d{4})/i);
    if(fm){const ms={enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12};const m=ms[fm[3].toLowerCase()];if(m)fecha=`${fm[4]}-${String(m).padStart(2,"0")}-${String(fm[2]).padStart(2,"0")}`;}
    const tm=texto.match(/Turno\s+\d+\s+\((\w+)/i);
    const turno=tm?.[1]==="Noche"?"Noche":"Mediodía";
    let local_id=locales[0]?.id;
    if(texto.includes("Villa Crespo")||texto.includes("Juan Ramirez"))local_id=locales.find(l=>l.nombre.includes("Villa Crespo"))?.id||local_id;
    else if(texto.includes("Belgrano"))local_id=locales.find(l=>l.nombre.includes("Belgrano"))?.id||local_id;
    else if(texto.includes("Devoto"))local_id=locales.find(l=>l.nombre.includes("Devoto"))?.id||local_id;
    else if(texto.includes("Palermo"))local_id=locales.find(l=>l.nombre.includes("Palermo"))?.id||local_id;
    else if(texto.includes("Rene")||texto.includes("Cantina"))local_id=locales.find(l=>l.nombre.includes("Rene"))?.id||local_id;
    const ventas=[];
    const idx=texto.indexOf("VENTAS POR FORMA DE COBRO");
    if(idx>-1){
      texto.slice(idx).split("\n").forEach(line=>{
        const m=line.match(/^(.+?)\s+([\d.]+)\s+(\d+)\s*$/);
        if(m){const mr=m[1].trim().toUpperCase();const monto=parseFloat(m[2]);const cant=parseInt(m[3]);if(monto>0&&!mr.includes("TOTAL")){ventas.push({medio:MMAP[mr]||mr,monto,cant,fecha,turno,local_id});}}
      });
    }
    setPreview({fecha,turno,local_id,ventas});
  };
  const confirmar=async()=>{
    if(!preview||preview.ventas.length===0)return;
    setLoading(true);
    // Check for duplicate: same fecha + turno + local
    const {data:exist}=await db.from("ventas").select("id").eq("fecha",preview.fecha).eq("turno",preview.turno).eq("local_id",parseInt(preview.local_id)).limit(1);
    if(exist&&exist.length>0){
      setLoading(false);
      if(!confirm(`⚠ Ya existe un cierre del ${fmt_d(preview.fecha)} turno ${preview.turno} para este local. ¿Importar igual?`))return;
      setLoading(true);
    }
    await db.from("ventas").insert(preview.ventas.map(v=>({...v,id:genId("V"),local_id:parseInt(v.local_id)})));
    setLoading(false);setTexto("");setPreview(null);
    alert("✓ Importado: "+preview.ventas.length+" registros · Total: "+fmt_$(preview.ventas.reduce((s,v)=>s+v.monto,0)));
  };
  return (
    <div>
      <div className="ph-row"><div><div className="ph-title">Importar Maxirest</div><div className="ph-sub">Pegá el texto del mail de cierre de turno</div></div></div>
      <div className="panel">
        <div className="panel-hd"><span className="panel-title">Texto del mail de cierre</span></div>
        <div style={{padding:16}}>
          <textarea style={{width:"100%",height:280,background:"var(--bg)",border:"1px solid var(--bd)",color:"var(--txt)",padding:"10px 12px",fontFamily:"'DM Mono',monospace",fontSize:11,borderRadius:"var(--r)",outline:"none",resize:"vertical"}} placeholder="Pegá acá el texto completo del mail de cierre de Maxirest..." value={texto} onChange={e=>setTexto(e.target.value)}/>
          <button className="btn btn-acc" style={{marginTop:8}} onClick={parsear}>Analizar texto</button>
        </div>
      </div>
      {preview&&(
        <div className="panel">
          <div className="panel-hd"><span className="panel-title">Preview — {fmt_d(preview.fecha)} · {preview.turno} · {locales.find(l=>l.id===preview.local_id)?.nombre}</span></div>
          <div style={{padding:16}}>
            {preview.ventas.length>0?(
              <>
                <table style={{marginBottom:12}}><thead><tr><th>Forma de Cobro</th><th>Monto</th><th>Cant.</th></tr></thead>
                <tbody>{preview.ventas.map((v,i)=><tr key={i}><td>{v.medio}</td><td><span className="num kpi-success">{fmt_$(v.monto)}</span></td><td style={{color:"var(--muted2)"}}>{v.cant}</td></tr>)}</tbody></table>
                <div style={{fontFamily:"'Syne',sans-serif",fontSize:20,fontWeight:700,color:"var(--success)",marginBottom:16}}>Total: {fmt_$(preview.ventas.reduce((s,v)=>s+v.monto,0))}</div>
              </>
            ):<div className="alert alert-warn">No se detectaron ventas. Verificá el formato.</div>}
            <div style={{display:"flex",gap:8}}>
              <button className="btn btn-sec" onClick={()=>setPreview(null)}>Cancelar</button>
              <button className="btn btn-acc" onClick={confirmar} disabled={loading||preview.ventas.length===0}>{loading?"Importando...":"✓ Confirmar e Importar"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

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
          onLogout={()=>{setUser(null);setSection("dashboard");setLocalActivo(null);}}
          locales={locales} localActivo={localActivo} setLocalActivo={setLocalActivo}/>
        <main className="main">{renderSection()}</main>
      </div>
    </>
  );
}
