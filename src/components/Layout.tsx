import { ROLES } from "../lib/auth";

export function Sidebar({ user, section, onNav, onLogout, locales, localActivo, setLocalActivo }) {
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
    {id:"insumos",label:"Insumos",icon:"🥩",sec:"Stock"},
    {id:"lector_ia",label:"Lector Facturas IA",icon:"🤖",sec:"Stock"},
    {id:"recetas",label:"Recetas",icon:"📋",sec:"Stock"},
    {id:"mp",label:"Conciliación MP",icon:"💳",sec:"Finanzas"},
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

export const css = `
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
