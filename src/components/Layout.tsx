import { ROLES, getPermisos } from "../lib/auth";

export function Sidebar({ user, section, onNav, onLogout, locales, localActivo, setLocalActivo }) {
  const perms = getPermisos(user);
  const localesDisp = (user.rol==="dueno" || user.rol==="admin") ? locales : locales.filter(l=>(user._locales||user.locales||[]).includes(l.id));
  const nav = [
    {id:"dashboard",label:"Dashboard",sec:"Principal",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="1" width="5" height="5" rx="1"/><rect x="8" y="1" width="5" height="5" rx="1"/><rect x="1" y="8" width="5" height="5" rx="1"/><rect x="8" y="8" width="5" height="5" rx="1"/></svg>`},
    {id:"ventas",label:"Ventas",sec:"Operaciones",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="1,11 4,6 7,8 10,4 13,6"/></svg>`},
    {id:"compras",label:"Facturas",sec:"Operaciones",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="1" width="10" height="12" rx="1"/><line x1="5" y1="5" x2="9" y2="5"/><line x1="5" y1="8" x2="7" y2="8"/></svg>`},
    {id:"remitos",label:"Remitos",sec:"Operaciones",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="3" width="12" height="9" rx="1"/><polyline points="1,6 7,9 13,6"/></svg>`},
    {id:"gastos",label:"Gastos",sec:"Operaciones",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="5"/><line x1="7" y1="4" x2="7" y2="7"/><line x1="7" y1="7" x2="9" y2="9"/></svg>`},
    {id:"proveedores",label:"Proveedores",sec:"Operaciones",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="5" r="2.5"/><path d="M2 13c0-3 2-4.5 5-4.5s5 1.5 5 4.5"/></svg>`},
    {id:"costos",label:"Costos",sec:"Operaciones",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="5"/><line x1="5" y1="7" x2="9" y2="7"/><line x1="7" y1="5" x2="7" y2="9"/></svg>`},
    {id:"mp",label:"Conciliación MP",sec:"Finanzas",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="3" width="12" height="8" rx="1"/><line x1="1" y1="7" x2="13" y2="7"/></svg>`},
    {id:"caja",label:"Caja & Bancos",sec:"Finanzas",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="5" width="12" height="8" rx="1"/><path d="M4 5V4a3 3 0 0 1 6 0v1"/></svg>`},
    {id:"caja_efectivo",label:"Caja Efectivo",sec:"Finanzas",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="3" width="12" height="8" rx="1"/><circle cx="7" cy="7" r="2"/></svg>`},
    {id:"eerr",label:"Estado de Result.",sec:"Finanzas",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="2" y1="11" x2="2" y2="5"/><line x1="6" y1="11" x2="6" y2="3"/><line x1="10" y1="11" x2="10" y2="7"/></svg>`},
    {id:"contador",label:"Contador / IVA",sec:"Finanzas",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="1" width="10" height="12" rx="1"/><line x1="5" y1="5" x2="9" y2="5"/><line x1="5" y1="8" x2="9" y2="8"/></svg>`},
    {id:"rrhh",label:"RRHH",sec:"RRHH",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5" cy="5" r="2.5"/><path d="M1 13c0-2.5 2-4 4-4s4 1.5 4 4"/><circle cx="10" cy="5" r="2"/><path d="M13 13c0-2 -1-3.5-3-3.5"/></svg>`},
    {id:"usuarios",label:"Usuarios",sec:"Config",icon:`<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="5" r="2.5"/><path d="M2 13c0-3 2-4.5 5-4.5s5 1.5 5 4.5"/></svg>`},
  ];
  const secs = [...new Set(nav.map(n=>n.sec))];
  return (
    <div className="sb">
      <div className="sb-logo">
        <div style={{fontFamily:"'Inter',sans-serif",fontWeight:500,fontSize:14,color:"#fff",letterSpacing:.2}}>PASE</div>
        <div style={{fontSize:9,color:"#444",letterSpacing:"1.2px",textTransform:"uppercase",marginTop:3}}>aliado gastronómico</div>
      </div>
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
              <span style={{width:14,height:14,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}} dangerouslySetInnerHTML={{__html: n.icon}}/>
              {n.label}
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
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#1c1c1c;--s1:#161616;--s2:#212121;--s3:#2a2a2a;--bd:#252525;--bd2:#303030;--acc:#cc785c;--txt:#e0e0e0;--muted:#666;--muted2:#888;--danger:#888;--success:#888;--warn:#888;--info:#888;--r:8px}
body{background:var(--bg);color:var(--txt);font-family:'Inter',sans-serif;font-size:13.5px;line-height:1.5}
.app{display:flex;min-height:100vh}
.sb{width:210px;background:var(--s1);border-right:1px solid var(--bd);display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:20}
.sb-logo{padding:14px 18px 16px;border-bottom:1px solid var(--bd)}
.sb-logo-name{font-size:15px;font-weight:500;color:#fff}
.sb-local{padding:8px 10px;border-bottom:1px solid var(--bd)}
.sb-local select{width:100%;background:var(--s2);border:1px solid var(--bd2);color:var(--txt);padding:5px 8px;font-size:12px;font-family:'Inter',sans-serif;border-radius:6px;outline:none}
.sb-nav{flex:1;padding:4px 0;overflow-y:auto}
.sb-section{padding:10px 18px 3px;font-size:9px;letter-spacing:.8px;text-transform:uppercase;color:#444}
.nav-item{display:flex;align-items:center;gap:9px;padding:6px 12px;cursor:pointer;font-size:13px;color:#777;border-radius:6px;margin:1px 6px;transition:all 0.1s}
.nav-item:hover{background:#1e1e1e;color:#bbb}
.nav-item.active{background:#252525;color:#f0f0f0}
.sb-user{padding:12px 18px;border-top:1px solid var(--bd)}
.sb-uname{font-size:12px;font-weight:500;margin-bottom:1px;color:var(--txt)}
.sb-logout{display:block;width:100%;margin-top:6px;padding:5px;background:transparent;border:1px solid var(--bd);color:var(--muted);cursor:pointer;font-size:10px;font-family:'Inter',sans-serif;border-radius:6px}
.sb-logout:hover{border-color:var(--acc);color:var(--acc)}
.main{margin-left:210px;flex:1;padding:20px 20px;min-height:100vh}
.ph-row{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px;gap:12px;flex-wrap:wrap}
.ph-title{font-family:'Inter',sans-serif;font-size:17px;font-weight:500;line-height:1;color:#fff}
.ph-sub{font-size:11px;color:var(--muted);margin-top:3px;font-weight:400}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px}
.kpi{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:12px 14px}
.kpi-label{font-size:9px;letter-spacing:.8px;text-transform:uppercase;color:var(--muted);margin-bottom:8px;line-height:1.3}
.kpi-value{font-size:18px;font-weight:500;line-height:1;color:var(--txt)}
.kpi-sub{font-size:10px;color:#444;margin-top:5px}
.kpi-acc{color:var(--acc)}
.kpi-danger{color:var(--danger)}
.kpi-warn{color:var(--warn)}
.kpi-success{color:var(--success)}
.panel{background:var(--s2);border:1px solid var(--bd);border-radius:10px;margin-bottom:10px}
.panel-hd{padding:10px 14px;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.panel-title{font-size:9px;letter-spacing:.8px;text-transform:uppercase;font-weight:500;color:var(--muted)}
table{width:100%;border-collapse:collapse}
thead th{padding:7px 12px;text-align:left;font-size:9px;letter-spacing:.8px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--bd);background:var(--s1)}
tbody tr{border-bottom:1px solid var(--bd);transition:background 0.1s}
tbody tr:last-child{border-bottom:none}
tbody tr:hover{background:#1e1e1e}
td{padding:9px 12px;font-size:12.5px}
.badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:9px;letter-spacing:.5px;text-transform:uppercase;font-weight:500}
.b-danger{background:var(--s3);color:var(--muted2)}
.b-success{background:var(--s3);color:var(--muted2)}
.b-warn{background:var(--s3);color:var(--muted2)}
.b-info{background:var(--s3);color:var(--muted2)}
.b-muted{background:var(--s3);color:var(--muted2)}
.b-anulada{background:rgba(100,100,100,.1);color:var(--muted);text-decoration:line-through}
.btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:none;cursor:pointer;font-family:'Inter',sans-serif;font-size:11px;font-weight:500;border-radius:var(--r);transition:all 0.15s;white-space:nowrap}
.btn-acc{background:var(--acc);color:#fff;border:none}
.btn-acc:hover{opacity:.85}
.btn-sec{background:var(--s3);color:var(--txt);border:1px solid var(--bd)}
.btn-sec:hover{border-color:var(--bd2)}
.btn-ghost{background:transparent;color:var(--muted2);border:1px solid var(--bd)}
.btn-ghost:hover{color:var(--txt);border-color:var(--bd2)}
.btn-sm{padding:3px 9px;font-size:10px}
.btn-success{background:transparent;color:var(--success);border:1px solid rgba(90,158,122,.4)}
.btn-success:hover{background:rgba(90,158,122,.1)}
.btn-danger{background:transparent;color:var(--danger);border:1px solid rgba(224,96,96,.4)}
.btn-danger:hover{background:rgba(224,96,96,.1)}
.field{margin-bottom:12px}
.field label{display:block;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:5px}
.field input,.field select,.field textarea{width:100%;background:var(--bg);border:1px solid var(--bd);color:var(--txt);padding:8px 10px;font-family:'Inter',sans-serif;font-size:12px;border-radius:var(--r);outline:none;transition:border-color 0.15s}
.field input:focus,.field select:focus,.field textarea:focus{border-color:var(--acc)}
.field select option{background:var(--s2)}
.form2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.form4{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px;align-items:end}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;z-index:100}
.modal{background:var(--s1);border:1px solid var(--bd2);border-radius:var(--r);width:640px;max-width:96vw;max-height:92vh;overflow-y:auto}
.modal-hd{padding:16px 20px;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:var(--s1);z-index:1}
.modal-title{font-family:'Inter',sans-serif;font-size:18px;font-weight:500}
.modal-body{padding:20px}
.modal-ft{padding:12px 20px;border-top:1px solid var(--bd);display:flex;gap:8px;justify-content:flex-end;position:sticky;bottom:0;background:var(--s1)}
.close-btn{background:none;border:none;color:var(--muted2);cursor:pointer;font-size:18px;line-height:1}
.close-btn:hover{color:var(--txt)}
.tabs{display:flex;border-bottom:1px solid var(--bd);margin-bottom:16px;flex-wrap:wrap}
.tab{padding:7px 14px;font-size:10px;letter-spacing:.8px;text-transform:uppercase;cursor:pointer;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px;transition:all 0.1s}
.tab.active{color:var(--acc);border-bottom-color:var(--acc)}
.tab:hover:not(.active){color:var(--txt)}
.alert{padding:10px 14px;border-radius:var(--r);font-size:11px;margin-bottom:12px;border-left:3px solid;line-height:1.5}
.alert-danger{background:rgba(255,255,255,.04);border-color:var(--bd2);color:var(--muted2)}
.alert-warn{background:rgba(255,255,255,.04);border-color:var(--bd2);color:var(--muted2)}
.alert-success{background:rgba(255,255,255,.04);border-color:var(--bd2);color:var(--muted2)}
.alert-info{background:rgba(255,255,255,.04);border-color:var(--bd2);color:var(--muted2)}
.caja-card{background:var(--s2);border:1px solid var(--bd);border-radius:var(--r);padding:16px;position:relative;overflow:hidden}
.caja-name{font-size:9px;letter-spacing:.8px;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
.caja-saldo{font-family:'Inter',sans-serif;font-size:20px;font-weight:500}
.anulada-row{opacity:0.5}
.search{background:var(--bg);border:1px solid var(--bd);color:var(--txt);padding:6px 12px;font-family:'Inter',sans-serif;font-size:12px;border-radius:var(--r);outline:none}
.search:focus{border-color:var(--acc)}
.empty{padding:40px;text-align:center;color:var(--muted);font-size:12px}
.loading{padding:40px;text-align:center;color:var(--muted2);font-size:11px;letter-spacing:2px;text-transform:uppercase}
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);position:relative}
.login-bg{position:absolute;inset:0}
.login-card{position:relative;width:400px;background:var(--s1);border:1px solid var(--bd);border-radius:var(--r);padding:40px}
.login-brand{font-family:'Inter',sans-serif;font-size:28px;font-weight:500;color:#fff;line-height:1;letter-spacing:.5px}
.login-sub{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:32px;margin-top:4px}
.num{font-family:'Inter',sans-serif;font-size:14px;font-weight:500}
.mono{font-family:'Inter',sans-serif;font-size:11px}
.eerr-row{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;border-bottom:1px solid var(--bd)}
.eerr-row:last-child{border-bottom:none}
.items-table{width:100%;border-collapse:collapse;margin-top:8px}
.items-table th{font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);padding:4px 6px;text-align:left;border-bottom:1px solid var(--bd)}
.items-table td{padding:4px 6px;font-size:11px}
.items-table tr:hover{background:var(--s2)}
.saldo-edit{display:flex;gap:8px;align-items:center}
.saldo-edit input{width:160px}
.section{margin-bottom:12px}
.section-hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px}
.section-title{font-size:9px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted2);font-weight:500}
.section-total{font-size:11px;color:var(--muted2)}
.pills{display:flex;gap:5px;margin-bottom:14px;flex-wrap:wrap}
.pill{padding:4px 11px;border-radius:20px;font-size:11px;cursor:pointer;color:var(--muted2);border:1px solid var(--bd);background:var(--s2);transition:all .1s}
.pill:hover{color:var(--txt)}
.pill.active{background:var(--s3);color:var(--txt);border-color:var(--bd2)}
`;
