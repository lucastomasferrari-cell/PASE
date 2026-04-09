import { useState, useEffect } from 'react';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://pduxydviqiaxfqnshhdc.supabase.co';
const SUPABASE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBkdXh5ZHZpcWlheGZxbnNoaGRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDExNDAsImV4cCI6MjA5MTMxNzE0MH0.oh0ObrthoSjmHeAEC3_kfvDnZeOY22ShGAsxv6_2o08';
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

const CATEGORIAS_COMPRA = [
  'PESCADERIA',
  'CARNICERIA',
  'VERDULERIA',
  'BEBIDAS',
  'VINOS',
  'ALMACEN',
  'PACKAGING',
  'PAPELERIA',
  'BARRIO CHINO',
  'PRODUCTOS ORIENTALES',
  'SUPERMERCADO',
  'HIELO',
  'LIMPIEZA',
  'CONTADOR',
  'PUBLICIDAD',
  'EXPENSAS',
  'PROPINAS',
  'SUSHIMAN PM',
  'EQUIPAMIENTO',
  'OTROS',
];
const MEDIOS_COBRO = [
  'EFECTIVO SALON',
  'TARJETA CREDITO',
  'TARJETA DEBITO',
  'QR',
  'LINK',
  'RAPPI ONLINE',
  'PEYA ONLINE',
  'PEYA EFECTIVO',
  'MP DELIVERY',
  'BIGBOX',
  'FANBAG',
  'EVENTO',
  'TRANSFERENCIA',
  'Point MP',
  'Point Nave',
  'NAVE',
];
const CUENTAS = ['Caja Chica', 'Caja Mayor', 'MercadoPago', 'Banco'];
const ROLES = {
  dueno: {
    label: 'Dueño',
    color: '#E8C547',
    permisos: [
      'dashboard',
      'ventas',
      'compras',
      'remitos',
      'caja',
      'eerr',
      'proveedores',
      'config',
    ],
  },
  admin: {
    label: 'Admin',
    color: '#3B82F6',
    permisos: [
      'dashboard',
      'ventas',
      'compras',
      'remitos',
      'caja',
      'proveedores',
    ],
  },
  compras: {
    label: 'Compras',
    color: '#8B5CF6',
    permisos: ['compras', 'remitos', 'proveedores'],
  },
  cajero: {
    label: 'Cajero',
    color: '#10B981',
    permisos: ['caja', 'dashboard'],
  },
};

const toISO = (d) => d.toISOString().split('T')[0];
const today = new Date();
const fmt_d = (d) => new Date(d + 'T12:00:00').toLocaleDateString('es-AR');
const fmt_$ = (n) =>
  new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  }).format(n || 0);

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
.ph-row{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px}
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
.b-danger{background:rgba(239,68,68,.12);color:var(--danger)}.b-success{background:rgba(34,197,94,.12);color:var(--success)}.b-warn{background:rgba(245,158,11,.12);color:var(--warn)}.b-info{background:rgba(59,130,246,.12);color:var(--info)}.b-muted{background:var(--s3);color:var(--muted2)}
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border:none;cursor:pointer;font-family:'DM Mono',monospace;font-size:11px;font-weight:600;border-radius:var(--r);transition:all 0.15s;white-space:nowrap}
.btn-acc{background:var(--acc);color:#000}.btn-acc:hover{background:#f0d060}
.btn-sec{background:var(--s3);color:var(--txt);border:1px solid var(--bd)}.btn-sec:hover{border-color:var(--acc);color:var(--acc)}
.btn-ghost{background:transparent;color:var(--muted2);border:1px solid var(--bd)}.btn-ghost:hover{border-color:var(--acc2);color:var(--acc2)}
.btn-sm{padding:4px 10px;font-size:10px}
.btn-success{background:transparent;color:var(--success);border:1px solid var(--success)}.btn-success:hover{background:var(--success);color:#000}
.field{margin-bottom:12px}
.field label{display:block;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:5px}
.field input,.field select{width:100%;background:var(--bg);border:1px solid var(--bd);color:var(--txt);padding:8px 10px;font-family:'DM Mono',monospace;font-size:12px;border-radius:var(--r);outline:none;transition:border-color 0.15s}
.field input:focus,.field select:focus{border-color:var(--acc)}
.field select option{background:var(--s2)}
.form2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:100;backdrop-filter:blur(4px)}
.modal{background:var(--s1);border:1px solid var(--bd2);border-radius:var(--r);width:560px;max-width:96vw;max-height:90vh;overflow-y:auto}
.modal-hd{padding:16px 20px;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between}
.modal-title{font-family:'Syne',sans-serif;font-size:18px;font-weight:700}
.modal-body{padding:20px}.modal-ft{padding:12px 20px;border-top:1px solid var(--bd);display:flex;gap:8px;justify-content:flex-end}
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
.search{background:var(--bg);border:1px solid var(--bd);color:var(--txt);padding:6px 12px;font-family:'DM Mono',monospace;font-size:12px;border-radius:var(--r);outline:none}
.search:focus{border-color:var(--acc)}
.empty{padding:40px;text-align:center;color:var(--muted);font-size:12px}
.loading{padding:40px;text-align:center;color:var(--muted2);font-size:11px;letter-spacing:2px;text-transform:uppercase}
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg)}
.login-bg{position:absolute;inset:0;background:radial-gradient(ellipse at 30% 40%,rgba(232,197,71,.06) 0%,transparent 60%)}
.login-card{position:relative;width:400px;background:var(--s1);border:1px solid var(--bd);border-radius:var(--r);padding:40px}
.login-brand{font-family:'Syne',sans-serif;font-size:36px;font-weight:800;color:var(--acc);line-height:1;letter-spacing:1px}
.login-sub{font-size:9px;letter-spacing:3px;text-transform:uppercase;color:var(--muted);margin-bottom:32px;margin-top:2px}
.num{font-family:'Syne',sans-serif;font-size:15px;font-weight:700}
.mono{font-family:'DM Mono',monospace;font-size:11px}
.eerr-row{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;border-bottom:1px solid var(--bd)}
.eerr-row:last-child{border-bottom:none}
`;

function Login({ onLogin }) {
  const [usuario, setUsuario] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const go = async () => {
    if (!usuario || !password) return;
    setLoading(true);
    setErr('');
    const { data } = await db
      .from('usuarios')
      .select('*')
      .eq('email', usuario)
      .eq('password', password)
      .single();
    setLoading(false);
    if (data) onLogin(data);
    else setErr('Usuario o contraseña incorrectos');
  };
  return (
    <div className="login-wrap" style={{ position: 'relative' }}>
      <div className="login-bg" />
      <div className="login-card">
        <div className="login-brand">GASTRO</div>
        <div className="login-sub">Sistema de Gestión</div>
        {err && <div className="alert alert-danger">{err}</div>}
        <div className="field">
          <label>Usuario</label>
          <input
            value={usuario}
            onChange={(e) => setUsuario(e.target.value)}
            placeholder="dueno / admin / compras / cajero"
            onKeyDown={(e) => e.key === 'Enter' && go()}
          />
        </div>
        <div className="field">
          <label>Contraseña</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            onKeyDown={(e) => e.key === 'Enter' && go()}
          />
        </div>
        <button
          className="btn btn-acc"
          style={{ width: '100%', justifyContent: 'center' }}
          onClick={go}
          disabled={loading}
        >
          {loading ? 'Verificando...' : 'Ingresar'}
        </button>
        <div
          style={{
            marginTop: 16,
            padding: 10,
            background: 'var(--bg)',
            borderRadius: 'var(--r)',
            fontSize: 10,
            color: 'var(--muted)',
            lineHeight: 1.8,
          }}
        >
          Contraseñas iniciales:
          <br />
          dueno → <b style={{ color: 'var(--muted2)' }}>dueno123</b> &nbsp;
          admin → <b style={{ color: 'var(--muted2)' }}>admin123</b>
          <br />
          compras → <b style={{ color: 'var(--muted2)' }}>compras123</b> &nbsp;
          cajero → <b style={{ color: 'var(--muted2)' }}>cajero123</b>
        </div>
      </div>
    </div>
  );
}

function Sidebar({
  user,
  section,
  onNav,
  onLogout,
  locales,
  localActivo,
  setLocalActivo,
}) {
  const perms = ROLES[user.rol]?.permisos || [];
  const localesDisp =
    user.rol === 'dueno'
      ? locales
      : locales.filter((l) => (user.locales || []).includes(l.id));
  const nav = [
    { id: 'dashboard', label: 'Dashboard', icon: '▦', sec: 'Principal' },
    { id: 'ventas', label: 'Ventas', icon: '↑', sec: 'Operaciones' },
    { id: 'compras', label: 'Facturas', icon: '📄', sec: 'Operaciones' },
    { id: 'remitos', label: 'Remitos', icon: '🚚', sec: 'Operaciones' },
    { id: 'proveedores', label: 'Proveedores', icon: '🏭', sec: 'Operaciones' },
    { id: 'caja', label: 'Caja & Bancos', icon: '💰', sec: 'Finanzas' },
    { id: 'eerr', label: 'Estado de Result.', icon: '📊', sec: 'Finanzas' },
    { id: 'config', label: 'Usuarios', icon: '👥', sec: 'Config' },
  ];
  const secs = [...new Set(nav.map((n) => n.sec))];
  return (
    <div className="sb">
      <div className="sb-logo">
        <div className="sb-name">GASTRO</div>
        <div className="sb-tag">Sistema de Gestión</div>
      </div>
      {localesDisp.length > 1 && (
        <div className="sb-local">
          <select
            value={localActivo || ''}
            onChange={(e) =>
              setLocalActivo(e.target.value ? parseInt(e.target.value) : null)
            }
          >
            {user.rol === 'dueno' && (
              <option value="">Todos los locales</option>
            )}
            {localesDisp.map((l) => (
              <option key={l.id} value={l.id}>
                {l.nombre}
              </option>
            ))}
          </select>
        </div>
      )}
      <nav className="sb-nav">
        {secs.map((s) => {
          const items = nav.filter((n) => n.sec === s && perms.includes(n.id));
          if (!items.length) return null;
          return (
            <div key={s}>
              <div className="sb-section">{s}</div>
              {items.map((n) => (
                <div
                  key={n.id}
                  className={`nav-item ${section === n.id ? 'active' : ''}`}
                  onClick={() => onNav(n.id)}
                >
                  <span style={{ width: 14, textAlign: 'center' }}>
                    {n.icon}
                  </span>
                  {n.label}
                </div>
              ))}
            </div>
          );
        })}
      </nav>
      <div className="sb-user">
        <div className="sb-uname">{user.nombre}</div>
        <div style={{ fontSize: 10, color: ROLES[user.rol]?.color }}>
          {ROLES[user.rol]?.label}
        </div>
        <button className="sb-logout" onClick={onLogout}>
          Cerrar sesión →
        </button>
      </div>
    </div>
  );
}

function Dashboard({ locales, localActivo }) {
  const [stats, setStats] = useState({
    saldos: {},
    deuda: 0,
    vencidas: 0,
    ventasHoy: 0,
    remPend: 0,
  });
  const [provDeuda, setProvDeuda] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const load = async () => {
      const hoy = toISO(today);
      const [
        { data: saldos },
        { data: facturas },
        { data: remitos },
        { data: ventas },
        { data: provs },
      ] = await Promise.all([
        db.from('saldos_caja').select('*'),
        db.from('facturas').select('*'),
        db.from('remitos').select('*'),
        db.from('ventas').select('*').eq('fecha', hoy),
        db.from('proveedores').select('*').gt('saldo', 0),
      ]);
      const saldosObj = {};
      (saldos || []).forEach((s) => (saldosObj[s.cuenta] = s.saldo));
      const fAct = (facturas || []).filter(
        (f) =>
          f.estado !== 'pagada' && (!localActivo || f.local_id === localActivo)
      );
      setStats({
        saldos: saldosObj,
        deuda: fAct.reduce((s, f) => s + (f.total || 0), 0),
        vencidas: fAct.filter((f) => f.estado === 'vencida').length,
        ventasHoy: (ventas || [])
          .filter((v) => !localActivo || v.local_id === localActivo)
          .reduce((s, v) => s + (v.monto || 0), 0),
        remPend: (remitos || []).filter(
          (r) =>
            r.estado === 'sin_factura' &&
            (!localActivo || r.local_id === localActivo)
        ).length,
      });
      setProvDeuda((provs || []).sort((a, b) => b.saldo - a.saldo).slice(0, 8));
      setLoading(false);
    };
    load();
  }, [localActivo]);
  if (loading) return <div className="loading">Cargando...</div>;
  const totalLiquidez = Object.values(stats.saldos).reduce((a, b) => a + b, 0);
  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <div className="ph-title">Dashboard</div>
        <div className="ph-sub">
          {today.toLocaleDateString('es-AR', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })}
        </div>
      </div>
      <div className="grid4">
        <div className="kpi">
          <div className="kpi-label">Liquidez Total</div>
          <div className="kpi-value kpi-acc">{fmt_$(totalLiquidez)}</div>
          <div className="kpi-sub">Todas las cuentas</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Ventas Hoy</div>
          <div className="kpi-value kpi-success">{fmt_$(stats.ventasHoy)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Deuda Proveedores</div>
          <div className="kpi-value kpi-warn">{fmt_$(stats.deuda)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Facturas Vencidas</div>
          <div className="kpi-value kpi-danger">{stats.vencidas}</div>
        </div>
      </div>
      <div className="grid2">
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-title">Saldos en Tiempo Real</span>
          </div>
          <div
            style={{
              padding: '12px 16px',
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 8,
            }}
          >
            {CUENTAS.map((k) => (
              <div
                key={k}
                className={`caja-card caja-${
                  k === 'Caja Chica'
                    ? 'chica'
                    : k === 'Caja Mayor'
                    ? 'mayor'
                    : k === 'MercadoPago'
                    ? 'mp'
                    : 'banco'
                }`}
              >
                <div className="caja-name">{k}</div>
                <div
                  className="caja-saldo"
                  style={{
                    color:
                      (stats.saldos[k] || 0) < 0
                        ? 'var(--danger)'
                        : 'var(--txt)',
                  }}
                >
                  {fmt_$(stats.saldos[k] || 0)}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-title" style={{ color: 'var(--warn)' }}>
              ⚡ Alertas
            </span>
          </div>
          <div style={{ padding: '8px 16px' }}>
            {stats.vencidas > 0 && (
              <div className="alert alert-danger">
                ⚠ {stats.vencidas} factura(s) vencida(s)
              </div>
            )}
            {stats.remPend > 0 && (
              <div className="alert alert-warn">
                🚚 {stats.remPend} remito(s) sin factura
              </div>
            )}
            {stats.vencidas === 0 && stats.remPend === 0 && (
              <div className="alert alert-success">✓ Todo al día</div>
            )}
          </div>
        </div>
      </div>
      {provDeuda.length > 0 && (
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-title">Deuda por Proveedor</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Proveedor</th>
                <th>Categoría</th>
                <th>Saldo</th>
              </tr>
            </thead>
            <tbody>
              {provDeuda.map((p) => (
                <tr key={p.id} className="prov-row">
                  <td style={{ fontWeight: 500 }}>{p.nombre}</td>
                  <td>
                    <span className="badge b-muted">{p.cat}</span>
                  </td>
                  <td>
                    <span className="num kpi-warn">{fmt_$(p.saldo)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Ventas({ user, locales, localActivo }) {
  const [ventas, setVentas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [filtFecha, setFiltFecha] = useState(toISO(today));
  const [form, setForm] = useState({
    local_id: '',
    fecha: toISO(today),
    turno: 'Noche',
    medio: 'EFECTIVO SALON',
    monto: '',
    cant: '',
  });
  const localesDisp =
    user.rol === 'dueno'
      ? locales
      : locales.filter((l) => (user.locales || []).includes(l.id));
  const load = async () => {
    setLoading(true);
    let q = db.from('ventas').select('*').order('fecha', { ascending: false });
    if (filtFecha) q = q.eq('fecha', filtFecha);
    if (localActivo) q = q.eq('local_id', localActivo);
    const { data } = await q.limit(100);
    setVentas(data || []);
    setLoading(false);
  };
  useEffect(() => {
    load();
  }, [filtFecha, localActivo]);
  useEffect(() => {
    if (localesDisp[0])
      setForm((f) => ({
        ...f,
        local_id: localActivo || localesDisp[0]?.id || '',
      }));
  }, [locales]);
  const total = ventas.reduce((s, v) => s + (v.monto || 0), 0);
  const porMedio = MEDIOS_COBRO.map((m) => ({
    m,
    t: ventas.filter((v) => v.medio === m).reduce((s, v) => s + v.monto, 0),
  }))
    .filter((x) => x.t > 0)
    .sort((a, b) => b.t - a.t);
  const guardar = async () => {
    if (!form.monto || !form.local_id) return;
    await db
      .from('ventas')
      .insert([
        {
          ...form,
          id: `V-${Date.now()}`,
          local_id: parseInt(form.local_id),
          monto: parseFloat(form.monto),
          cant: parseInt(form.cant) || 1,
        },
      ]);
    setModal(false);
    load();
  };
  return (
    <div>
      <div className="ph-row">
        <div>
          <div className="ph-title">Ventas</div>
          <div className="ph-sub">Total: {fmt_$(total)}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="date"
            className="search"
            style={{ width: 155 }}
            value={filtFecha}
            onChange={(e) => setFiltFecha(e.target.value)}
          />
          <button className="btn btn-acc" onClick={() => setModal(true)}>
            + Cargar
          </button>
        </div>
      </div>
      {porMedio.length > 0 && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-hd">
            <span className="panel-title">Por Forma de Cobro</span>
          </div>
          <div
            style={{
              padding: '12px 16px',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))',
              gap: 8,
            }}
          >
            {porMedio.map((x) => (
              <div
                key={x.m}
                style={{
                  background: 'var(--s2)',
                  padding: '10px 12px',
                  borderRadius: 'var(--r)',
                  borderLeft: '2px solid var(--acc)',
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    color: 'var(--muted)',
                    marginBottom: 4,
                  }}
                >
                  {x.m}
                </div>
                <div className="num">{fmt_$(x.t)}</div>
                <div style={{ fontSize: 10, color: 'var(--muted2)' }}>
                  {total > 0 ? ((x.t / total) * 100).toFixed(1) : 0}%
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="panel">
        {loading ? (
          <div className="loading">Cargando...</div>
        ) : ventas.length === 0 ? (
          <div className="empty">No hay ventas para esta fecha</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Local</th>
                <th>Turno</th>
                <th>Medio</th>
                <th>Cant.</th>
                <th>Monto</th>
              </tr>
            </thead>
            <tbody>
              {ventas.map((v) => (
                <tr key={v.id}>
                  <td style={{ fontSize: 11, color: 'var(--muted2)' }}>
                    {locales.find((l) => l.id === v.local_id)?.nombre}
                  </td>
                  <td>
                    <span className="badge b-muted">{v.turno}</span>
                  </td>
                  <td>{v.medio}</td>
                  <td style={{ color: 'var(--muted2)' }}>{v.cant}</td>
                  <td>
                    <span className="num kpi-success">{fmt_$(v.monto)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {modal && (
        <div className="overlay" onClick={() => setModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">Nueva Venta</div>
              <button className="close-btn" onClick={() => setModal(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="form2">
                <div className="field">
                  <label>Local</label>
                  <select
                    value={form.local_id}
                    onChange={(e) =>
                      setForm({ ...form, local_id: e.target.value })
                    }
                  >
                    <option value="">Seleccioná...</option>
                    {localesDisp.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.nombre}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Fecha</label>
                  <input
                    type="date"
                    value={form.fecha}
                    onChange={(e) =>
                      setForm({ ...form, fecha: e.target.value })
                    }
                  />
                </div>
              </div>
              <div className="form2">
                <div className="field">
                  <label>Turno</label>
                  <select
                    value={form.turno}
                    onChange={(e) =>
                      setForm({ ...form, turno: e.target.value })
                    }
                  >
                    <option>Mediodía</option>
                    <option>Noche</option>
                  </select>
                </div>
                <div className="field">
                  <label>Medio de Cobro</label>
                  <select
                    value={form.medio}
                    onChange={(e) =>
                      setForm({ ...form, medio: e.target.value })
                    }
                  >
                    {MEDIOS_COBRO.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form2">
                <div className="field">
                  <label>Monto $</label>
                  <input
                    type="number"
                    value={form.monto}
                    onChange={(e) =>
                      setForm({ ...form, monto: e.target.value })
                    }
                    placeholder="0"
                  />
                </div>
                <div className="field">
                  <label>Cubiertos</label>
                  <input
                    type="number"
                    value={form.cant}
                    onChange={(e) => setForm({ ...form, cant: e.target.value })}
                    placeholder="0"
                  />
                </div>
              </div>
            </div>
            <div className="modal-ft">
              <button className="btn btn-sec" onClick={() => setModal(false)}>
                Cancelar
              </button>
              <button className="btn btn-acc" onClick={guardar}>
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Compras({ user, locales, localActivo }) {
  const [facturas, setFacturas] = useState([]);
  const [proveedores, setProveedores] = useState([]);
  const [tab, setTab] = useState('todas');
  const [modal, setModal] = useState(false);
  const [pagarModal, setPagarModal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({
    prov_id: '',
    local_id: '',
    nro: '',
    fecha: toISO(today),
    venc: '',
    neto: '',
    iva21: '',
    iva105: '',
    iibb: '',
    cat: 'PESCADERIA',
    detalle: '',
  });
  const [pagoForm, setPagoForm] = useState({
    cuenta: 'MercadoPago',
    monto: '',
    fecha: toISO(today),
  });
  const localesDisp =
    user.rol === 'dueno'
      ? locales
      : locales.filter((l) => (user.locales || []).includes(l.id));
  const calcTotal = () =>
    (parseFloat(form.neto) || 0) +
    (parseFloat(form.iva21) || 0) +
    (parseFloat(form.iva105) || 0) +
    (parseFloat(form.iibb) || 0);
  const load = async () => {
    setLoading(true);
    const [{ data: f }, { data: p }] = await Promise.all([
      db.from('facturas').select('*').order('fecha', { ascending: false }),
      db.from('proveedores').select('*').order('nombre'),
    ]);
    setFacturas(f || []);
    setProveedores(p || []);
    setLoading(false);
  };
  useEffect(() => {
    load();
  }, []);
  const fFilt = facturas
    .filter((f) => {
      if (localActivo && f.local_id !== localActivo) return false;
      if (tab === 'pendientes') return f.estado === 'pendiente';
      if (tab === 'vencidas') return f.estado === 'vencida';
      if (tab === 'pagadas') return f.estado === 'pagada';
      return true;
    })
    .filter(
      (f) =>
        !search ||
        proveedores
          .find((p) => p.id === f.prov_id)
          ?.nombre.toLowerCase()
          .includes(search.toLowerCase()) ||
        (f.nro || '').includes(search)
    );
  const guardar = async () => {
    if (!form.prov_id || !form.nro || !form.neto || !form.local_id) return;
    const total = calcTotal();
    const nueva = {
      ...form,
      id: `FACT-${Date.now()}`,
      prov_id: parseInt(form.prov_id),
      local_id: parseInt(form.local_id),
      neto: parseFloat(form.neto),
      iva21: parseFloat(form.iva21) || 0,
      iva105: parseFloat(form.iva105) || 0,
      iibb: parseFloat(form.iibb) || 0,
      total,
      estado: 'pendiente',
      pagos: [],
    };
    await db.from('facturas').insert([nueva]);
    const prov = proveedores.find((p) => p.id === nueva.prov_id);
    if (prov)
      await db
        .from('proveedores')
        .update({ saldo: (prov.saldo || 0) + total })
        .eq('id', prov.id);
    setModal(false);
    load();
  };
  const pagar = async () => {
    const f = pagarModal;
    const monto = parseFloat(pagoForm.monto) || f.total;
    const nuevosPagos = [
      ...(f.pagos || []),
      { cuenta: pagoForm.cuenta, monto, fecha: pagoForm.fecha },
    ];
    const totalPagado = nuevosPagos.reduce((s, p) => s + p.monto, 0);
    await db
      .from('facturas')
      .update({
        estado: totalPagado >= f.total ? 'pagada' : 'pendiente',
        pagos: nuevosPagos,
      })
      .eq('id', f.id);
    const prov = proveedores.find((p) => p.id === f.prov_id);
    if (prov)
      await db
        .from('proveedores')
        .update({ saldo: Math.max(0, (prov.saldo || 0) - monto) })
        .eq('id', f.prov_id);
    const { data: caja } = await db
      .from('saldos_caja')
      .select('saldo')
      .eq('cuenta', pagoForm.cuenta)
      .single();
    if (caja)
      await db
        .from('saldos_caja')
        .update({ saldo: (caja.saldo || 0) - monto })
        .eq('cuenta', pagoForm.cuenta);
    setPagarModal(null);
    load();
  };
  const eb = (e) =>
    e === 'vencida' ? (
      <span className="badge b-danger">Vencida</span>
    ) : e === 'pagada' ? (
      <span className="badge b-success">Pagada</span>
    ) : (
      <span className="badge b-warn">Pendiente</span>
    );
  return (
    <div>
      <div className="ph-row">
        <div>
          <div className="ph-title">Facturas</div>
          <div className="ph-sub">
            {facturas.filter((f) => f.estado !== 'pagada').length} activas ·{' '}
            {fmt_$(
              facturas
                .filter((f) => f.estado !== 'pagada')
                .reduce((s, f) => s + (f.total || 0), 0)
            )}{' '}
            por pagar
          </div>
        </div>
        <button className="btn btn-acc" onClick={() => setModal(true)}>
          + Cargar Factura
        </button>
      </div>
      <div className="tabs">
        {[
          ['todas', 'Todas'],
          ['pendientes', 'Pendientes'],
          ['vencidas', 'Vencidas'],
          ['pagadas', 'Pagadas'],
        ].map(([id, l]) => (
          <div
            key={id}
            className={`tab ${tab === id ? 'active' : ''}`}
            onClick={() => setTab(id)}
          >
            {l}
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <input
          className="search"
          placeholder="Buscar..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ margin: '0 0 -1px', width: 180 }}
        />
      </div>
      <div className="panel">
        {loading ? (
          <div className="loading">Cargando...</div>
        ) : fFilt.length === 0 ? (
          <div className="empty">No hay facturas</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Proveedor</th>
                <th>Nº Factura</th>
                <th>Vencimiento</th>
                <th>Categoría</th>
                <th>Neto</th>
                <th>Total</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {fFilt.map((f) => {
                const prov = proveedores.find((p) => p.id === f.prov_id);
                return (
                  <tr key={f.id}>
                    <td
                      style={{
                        fontWeight: 500,
                        maxWidth: 160,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {prov?.nombre}
                    </td>
                    <td className="mono">{f.nro}</td>
                    <td
                      className="mono"
                      style={{
                        color:
                          f.estado === 'vencida'
                            ? 'var(--danger)'
                            : 'var(--muted2)',
                      }}
                    >
                      {f.venc ? fmt_d(f.venc) : '—'}
                    </td>
                    <td>
                      <span className="badge b-muted">{f.cat}</span>
                    </td>
                    <td className="num">{fmt_$(f.neto)}</td>
                    <td>
                      <span className="num kpi-warn">{fmt_$(f.total)}</span>
                    </td>
                    <td>{eb(f.estado)}</td>
                    <td>
                      {f.estado !== 'pagada' && (
                        <button
                          className="btn btn-success btn-sm"
                          onClick={() => {
                            setPagarModal(f);
                            setPagoForm({
                              cuenta: 'MercadoPago',
                              monto: f.total,
                              fecha: toISO(today),
                            });
                          }}
                        >
                          Pagar
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {modal && (
        <div className="overlay" onClick={() => setModal(false)}>
          <div
            className="modal"
            style={{ width: 620 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-hd">
              <div className="modal-title">Cargar Factura</div>
              <button className="close-btn" onClick={() => setModal(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="form2">
                <div className="field">
                  <label>Proveedor *</label>
                  <select
                    value={form.prov_id}
                    onChange={(e) =>
                      setForm({ ...form, prov_id: e.target.value })
                    }
                  >
                    <option value="">Seleccioná...</option>
                    {proveedores.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nombre}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Local *</label>
                  <select
                    value={form.local_id}
                    onChange={(e) =>
                      setForm({ ...form, local_id: e.target.value })
                    }
                  >
                    <option value="">Seleccioná...</option>
                    {localesDisp.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.nombre}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form2">
                <div className="field">
                  <label>Nº Factura *</label>
                  <input
                    value={form.nro}
                    onChange={(e) => setForm({ ...form, nro: e.target.value })}
                    placeholder="A-0001-00001234"
                  />
                </div>
                <div className="field">
                  <label>Categoría EERR</label>
                  <select
                    value={form.cat}
                    onChange={(e) => setForm({ ...form, cat: e.target.value })}
                  >
                    {CATEGORIAS_COMPRA.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form2">
                <div className="field">
                  <label>Fecha</label>
                  <input
                    type="date"
                    value={form.fecha}
                    onChange={(e) =>
                      setForm({ ...form, fecha: e.target.value })
                    }
                  />
                </div>
                <div className="field">
                  <label>Vencimiento</label>
                  <input
                    type="date"
                    value={form.venc}
                    onChange={(e) => setForm({ ...form, venc: e.target.value })}
                  />
                </div>
              </div>
              <div className="form3">
                <div className="field">
                  <label>Neto Gravado *</label>
                  <input
                    type="number"
                    value={form.neto}
                    onChange={(e) => setForm({ ...form, neto: e.target.value })}
                    placeholder="0"
                  />
                </div>
                <div className="field">
                  <label>IVA 21%</label>
                  <input
                    type="number"
                    value={form.iva21}
                    onChange={(e) =>
                      setForm({ ...form, iva21: e.target.value })
                    }
                    placeholder="0"
                  />
                </div>
                <div className="field">
                  <label>IVA 10.5%</label>
                  <input
                    type="number"
                    value={form.iva105}
                    onChange={(e) =>
                      setForm({ ...form, iva105: e.target.value })
                    }
                    placeholder="0"
                  />
                </div>
              </div>
              <div className="form2">
                <div className="field">
                  <label>Perc. IIBB</label>
                  <input
                    type="number"
                    value={form.iibb}
                    onChange={(e) => setForm({ ...form, iibb: e.target.value })}
                    placeholder="0"
                  />
                </div>
                <div className="field">
                  <label>Total calculado</label>
                  <input
                    readOnly
                    value={fmt_$(calcTotal())}
                    style={{
                      color: 'var(--acc)',
                      fontFamily: "'Syne',sans-serif",
                      fontWeight: 700,
                    }}
                  />
                </div>
              </div>
              <div className="field">
                <label>Descripción</label>
                <input
                  value={form.detalle}
                  onChange={(e) =>
                    setForm({ ...form, detalle: e.target.value })
                  }
                  placeholder="Detalle..."
                />
              </div>
            </div>
            <div className="modal-ft">
              <button className="btn btn-sec" onClick={() => setModal(false)}>
                Cancelar
              </button>
              <button className="btn btn-acc" onClick={guardar}>
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}
      {pagarModal && (
        <div className="overlay" onClick={() => setPagarModal(null)}>
          <div
            className="modal"
            style={{ width: 420 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-hd">
              <div className="modal-title">Registrar Pago</div>
              <button className="close-btn" onClick={() => setPagarModal(null)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="alert alert-info">
                {pagarModal.nro} · Total: {fmt_$(pagarModal.total)}
              </div>
              <div className="field">
                <label>Cuenta de egreso</label>
                <select
                  value={pagoForm.cuenta}
                  onChange={(e) =>
                    setPagoForm({ ...pagoForm, cuenta: e.target.value })
                  }
                >
                  {CUENTAS.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Monto</label>
                <input
                  type="number"
                  value={pagoForm.monto}
                  onChange={(e) =>
                    setPagoForm({ ...pagoForm, monto: e.target.value })
                  }
                />
              </div>
              <div className="field">
                <label>Fecha</label>
                <input
                  type="date"
                  value={pagoForm.fecha}
                  onChange={(e) =>
                    setPagoForm({ ...pagoForm, fecha: e.target.value })
                  }
                />
              </div>
            </div>
            <div className="modal-ft">
              <button
                className="btn btn-sec"
                onClick={() => setPagarModal(null)}
              >
                Cancelar
              </button>
              <button className="btn btn-success" onClick={pagar}>
                Confirmar Pago
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Remitos({ user, locales, localActivo }) {
  const [remitos, setRemitos] = useState([]);
  const [facturas, setFacturas] = useState([]);
  const [proveedores, setProveedores] = useState([]);
  const [modal, setModal] = useState(false);
  const [vincModal, setVincModal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    prov_id: '',
    local_id: '',
    nro: '',
    fecha: toISO(today),
    monto: '',
    cat: 'PESCADERIA',
    detalle: '',
  });
  const localesDisp =
    user.rol === 'dueno'
      ? locales
      : locales.filter((l) => (user.locales || []).includes(l.id));
  const load = async () => {
    setLoading(true);
    const [{ data: r }, { data: f }, { data: p }] = await Promise.all([
      db.from('remitos').select('*').order('fecha', { ascending: false }),
      db.from('facturas').select('*').neq('estado', 'pagada'),
      db.from('proveedores').select('*').order('nombre'),
    ]);
    setRemitos(r || []);
    setFacturas(f || []);
    setProveedores(p || []);
    setLoading(false);
  };
  useEffect(() => {
    load();
  }, []);
  const rFilt = remitos.filter(
    (r) => !localActivo || r.local_id === localActivo
  );
  const sinFact = rFilt.filter((r) => r.estado === 'sin_factura');
  const guardar = async () => {
    if (!form.prov_id || !form.monto || !form.local_id) return;
    const nro = form.nro || `REM-${Date.now().toString().slice(-6)}`;
    const nuevo = {
      ...form,
      id: `REM-${Date.now()}`,
      prov_id: parseInt(form.prov_id),
      local_id: parseInt(form.local_id),
      nro,
      monto: parseFloat(form.monto),
      estado: 'sin_factura',
      fact_id: null,
    };
    await db.from('remitos').insert([nuevo]);
    const prov = proveedores.find((p) => p.id === nuevo.prov_id);
    if (prov)
      await db
        .from('proveedores')
        .update({ saldo: (prov.saldo || 0) + nuevo.monto })
        .eq('id', prov.id);
    setModal(false);
    load();
  };
  const vincFact = async (fid) => {
    await db
      .from('remitos')
      .update({ estado: 'facturado', fact_id: fid })
      .eq('id', vincModal.id);
    setVincModal(null);
    load();
  };
  return (
    <div>
      <div className="ph-row">
        <div>
          <div className="ph-title">Remitos</div>
          <div className="ph-sub">
            {sinFact.length} sin factura ·{' '}
            {fmt_$(sinFact.reduce((s, r) => s + (r.monto || 0), 0))} deuda
            provisoria
          </div>
        </div>
        <button className="btn btn-acc" onClick={() => setModal(true)}>
          + Remito Valorado
        </button>
      </div>
      <div className="alert alert-warn">
        Los remitos generan <strong>deuda provisoria</strong>. Vinculalos a la
        factura cuando llegue.
      </div>
      <div className="panel">
        {loading ? (
          <div className="loading">Cargando...</div>
        ) : rFilt.length === 0 ? (
          <div className="empty">No hay remitos</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Proveedor</th>
                <th>Nº Remito</th>
                <th>Fecha</th>
                <th>Categoría</th>
                <th>Monto</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rFilt.map((r) => {
                const prov = proveedores.find((p) => p.id === r.prov_id);
                return (
                  <tr
                    key={r.id}
                    className={r.estado === 'sin_factura' ? 'remito-row' : ''}
                  >
                    <td style={{ fontWeight: 500 }}>{prov?.nombre}</td>
                    <td className="mono">{r.nro}</td>
                    <td className="mono">{fmt_d(r.fecha)}</td>
                    <td>
                      <span className="badge b-muted">{r.cat}</span>
                    </td>
                    <td>
                      <span className="num kpi-warn">{fmt_$(r.monto)}</span>
                    </td>
                    <td>
                      {r.estado === 'sin_factura' ? (
                        <span className="badge b-warn">Sin Factura</span>
                      ) : (
                        <span className="badge b-success">Facturado</span>
                      )}
                    </td>
                    <td>
                      {r.estado === 'sin_factura' && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setVincModal(r)}
                        >
                          Vincular
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {modal && (
        <div className="overlay" onClick={() => setModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">Nuevo Remito Valorado</div>
              <button className="close-btn" onClick={() => setModal(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="alert alert-info">
                Para compras informales. Si llega factura, la vinculás después.
              </div>
              <div className="form2">
                <div className="field">
                  <label>Proveedor *</label>
                  <select
                    value={form.prov_id}
                    onChange={(e) =>
                      setForm({ ...form, prov_id: e.target.value })
                    }
                  >
                    <option value="">Seleccioná...</option>
                    {proveedores.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nombre}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Local *</label>
                  <select
                    value={form.local_id}
                    onChange={(e) =>
                      setForm({ ...form, local_id: e.target.value })
                    }
                  >
                    <option value="">Seleccioná...</option>
                    {localesDisp.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.nombre}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form2">
                <div className="field">
                  <label>Nº Remito (opcional)</label>
                  <input
                    value={form.nro}
                    onChange={(e) => setForm({ ...form, nro: e.target.value })}
                    placeholder="Se genera automático"
                  />
                </div>
                <div className="field">
                  <label>Categoría</label>
                  <select
                    value={form.cat}
                    onChange={(e) => setForm({ ...form, cat: e.target.value })}
                  >
                    {CATEGORIAS_COMPRA.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form2">
                <div className="field">
                  <label>Fecha</label>
                  <input
                    type="date"
                    value={form.fecha}
                    onChange={(e) =>
                      setForm({ ...form, fecha: e.target.value })
                    }
                  />
                </div>
                <div className="field">
                  <label>Monto *</label>
                  <input
                    type="number"
                    value={form.monto}
                    onChange={(e) =>
                      setForm({ ...form, monto: e.target.value })
                    }
                    placeholder="0"
                  />
                </div>
              </div>
              <div className="field">
                <label>Descripción / Folio</label>
                <input
                  value={form.detalle}
                  onChange={(e) =>
                    setForm({ ...form, detalle: e.target.value })
                  }
                  placeholder="Folio 1234 - Detalle..."
                />
              </div>
            </div>
            <div className="modal-ft">
              <button className="btn btn-sec" onClick={() => setModal(false)}>
                Cancelar
              </button>
              <button className="btn btn-acc" onClick={guardar}>
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
      {vincModal && (
        <div className="overlay" onClick={() => setVincModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">Vincular a Factura</div>
              <button className="close-btn" onClick={() => setVincModal(null)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="alert alert-warn">
                Remito {vincModal.nro} · {fmt_$(vincModal.monto)}
              </div>
              <p
                style={{
                  fontSize: 11,
                  color: 'var(--muted2)',
                  marginBottom: 12,
                }}
              >
                Seleccioná la factura oficial de este proveedor.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Factura</th>
                    <th>Fecha</th>
                    <th>Total</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {facturas
                    .filter((f) => f.prov_id === vincModal.prov_id)
                    .map((f) => (
                      <tr key={f.id}>
                        <td className="mono">{f.nro}</td>
                        <td>{fmt_d(f.fecha)}</td>
                        <td className="num">{fmt_$(f.total)}</td>
                        <td>
                          <button
                            className="btn btn-acc btn-sm"
                            onClick={() => vincFact(f.id)}
                          >
                            Vincular
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {facturas.filter((f) => f.prov_id === vincModal.prov_id)
                .length === 0 && (
                <div className="empty">
                  No hay facturas pendientes de este proveedor
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Caja() {
  const [movimientos, setMovimientos] = useState([]);
  const [saldos, setSaldos] = useState({});
  const [modal, setModal] = useState(false);
  const [filtCuenta, setFiltCuenta] = useState('Todas');
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    fecha: toISO(today),
    cuenta: 'Caja Chica',
    tipo: 'Pago Gasto',
    cat: '',
    importe: '',
    detalle: '',
    esEgreso: true,
  });
  const load = async () => {
    setLoading(true);
    const [{ data: m }, { data: s }] = await Promise.all([
      db
        .from('movimientos')
        .select('*')
        .order('fecha', { ascending: false })
        .limit(60),
      db.from('saldos_caja').select('*'),
    ]);
    setMovimientos(m || []);
    const obj = {};
    (s || []).forEach((x) => (obj[x.cuenta] = x.saldo));
    setSaldos(obj);
    setLoading(false);
  };
  useEffect(() => {
    load();
  }, []);
  const mFilt = movimientos.filter(
    (m) => filtCuenta === 'Todas' || m.cuenta === filtCuenta
  );
  const totalLiquidez = Object.values(saldos).reduce((a, b) => a + b, 0);
  const guardar = async () => {
    if (!form.importe) return;
    const importe = parseFloat(form.importe) * (form.esEgreso ? -1 : 1);
    const { esEgreso, ...rest } = form;
    await db
      .from('movimientos')
      .insert([{ ...rest, id: `MOV-${Date.now()}`, importe, fact_id: null }]);
    const actual = saldos[form.cuenta] || 0;
    await db
      .from('saldos_caja')
      .update({ saldo: actual + importe })
      .eq('cuenta', form.cuenta);
    setModal(false);
    load();
  };
  const cc = (c) =>
    c === 'Caja Chica'
      ? 'var(--acc)'
      : c === 'Caja Mayor'
      ? 'var(--acc2)'
      : c === 'MercadoPago'
      ? 'var(--acc3)'
      : 'var(--info)';
  return (
    <div>
      <div className="ph-row">
        <div>
          <div className="ph-title">Caja & Bancos</div>
          <div className="ph-sub">Total disponible: {fmt_$(totalLiquidez)}</div>
        </div>
        <button className="btn btn-acc" onClick={() => setModal(true)}>
          + Movimiento
        </button>
      </div>
      <div className="grid4">
        {CUENTAS.map((k) => (
          <div
            key={k}
            className={`caja-card caja-${
              k === 'Caja Chica'
                ? 'chica'
                : k === 'Caja Mayor'
                ? 'mayor'
                : k === 'MercadoPago'
                ? 'mp'
                : 'banco'
            }`}
          >
            <div className="caja-name">{k}</div>
            <div
              className="caja-saldo"
              style={{
                color: (saldos[k] || 0) < 0 ? 'var(--danger)' : 'var(--txt)',
              }}
            >
              {fmt_$(saldos[k] || 0)}
            </div>
          </div>
        ))}
      </div>
      <div className="panel">
        <div className="panel-hd">
          <span className="panel-title">Movimientos</span>
          <select
            className="search"
            style={{ width: 160 }}
            value={filtCuenta}
            onChange={(e) => setFiltCuenta(e.target.value)}
          >
            <option>Todas</option>
            {CUENTAS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        {loading ? (
          <div className="loading">Cargando...</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Cuenta</th>
                <th>Tipo</th>
                <th>Categoría</th>
                <th>Detalle</th>
                <th>Importe</th>
              </tr>
            </thead>
            <tbody>
              {mFilt.map((m) => (
                <tr key={m.id}>
                  <td className="mono">{fmt_d(m.fecha)}</td>
                  <td>
                    <span
                      className="badge"
                      style={{
                        background: 'transparent',
                        color: cc(m.cuenta),
                        border: `1px solid ${cc(m.cuenta)}44`,
                      }}
                    >
                      {m.cuenta}
                    </span>
                  </td>
                  <td style={{ fontSize: 11, color: 'var(--muted2)' }}>
                    {m.tipo}
                  </td>
                  <td>
                    {m.cat ? (
                      <span className="badge b-muted">{m.cat}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td
                    style={{
                      fontSize: 11,
                      maxWidth: 200,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {m.detalle}
                  </td>
                  <td>
                    <span
                      className="num"
                      style={{
                        color:
                          m.importe < 0 ? 'var(--danger)' : 'var(--success)',
                      }}
                    >
                      {fmt_$(m.importe)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {modal && (
        <div className="overlay" onClick={() => setModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">Nuevo Movimiento</div>
              <button className="close-btn" onClick={() => setModal(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="form2">
                <div className="field">
                  <label>Cuenta</label>
                  <select
                    value={form.cuenta}
                    onChange={(e) =>
                      setForm({ ...form, cuenta: e.target.value })
                    }
                  >
                    {CUENTAS.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Dirección</label>
                  <select
                    value={form.esEgreso ? 'egreso' : 'ingreso'}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        esEgreso: e.target.value === 'egreso',
                      })
                    }
                  >
                    <option value="egreso">Egreso (sale plata)</option>
                    <option value="ingreso">Ingreso (entra plata)</option>
                  </select>
                </div>
              </div>
              <div className="form2">
                <div className="field">
                  <label>Categoría EERR</label>
                  <select
                    value={form.cat}
                    onChange={(e) => setForm({ ...form, cat: e.target.value })}
                  >
                    <option value="">Sin categoría</option>
                    {CATEGORIAS_COMPRA.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Fecha</label>
                  <input
                    type="date"
                    value={form.fecha}
                    onChange={(e) =>
                      setForm({ ...form, fecha: e.target.value })
                    }
                  />
                </div>
              </div>
              <div className="field">
                <label>Importe $</label>
                <input
                  type="number"
                  value={form.importe}
                  onChange={(e) =>
                    setForm({ ...form, importe: e.target.value })
                  }
                  placeholder="0"
                />
              </div>
              <div className="field">
                <label>Detalle</label>
                <input
                  value={form.detalle}
                  onChange={(e) =>
                    setForm({ ...form, detalle: e.target.value })
                  }
                  placeholder="Descripción..."
                />
              </div>
            </div>
            <div className="modal-ft">
              <button className="btn btn-sec" onClick={() => setModal(false)}>
                Cancelar
              </button>
              <button className="btn btn-acc" onClick={guardar}>
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EERR({ locales, localActivo }) {
  const [ventas, setVentas] = useState([]);
  const [facturas, setFacturas] = useState([]);
  const [mes, setMes] = useState(toISO(today).slice(0, 7));
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const desde = mes + '-01',
        hasta = mes + '-31';
      const [{ data: v }, { data: f }] = await Promise.all([
        db.from('ventas').select('*').gte('fecha', desde).lte('fecha', hasta),
        db
          .from('facturas')
          .select('*')
          .gte('fecha', desde)
          .lte('fecha', hasta)
          .eq('estado', 'pagada'),
      ]);
      setVentas(
        (v || []).filter((x) => !localActivo || x.local_id === localActivo)
      );
      setFacturas(
        (f || []).filter((x) => !localActivo || x.local_id === localActivo)
      );
      setLoading(false);
    };
    load();
  }, [mes, localActivo]);
  const totalVentas = ventas.reduce((s, v) => s + (v.monto || 0), 0);
  const totalCompras = facturas.reduce((s, f) => s + (f.total || 0), 0);
  const utilidad = totalVentas - totalCompras;
  const pct = totalVentas > 0 ? ((utilidad / totalVentas) * 100).toFixed(1) : 0;
  const porMedio = MEDIOS_COBRO.map((m) => ({
    m,
    t: ventas.filter((v) => v.medio === m).reduce((s, v) => s + v.monto, 0),
  }))
    .filter((x) => x.t > 0)
    .sort((a, b) => b.t - a.t);
  const porCat = CATEGORIAS_COMPRA.map((c) => ({
    c,
    t: facturas.filter((f) => f.cat === c).reduce((s, f) => s + f.total, 0),
  }))
    .filter((x) => x.t > 0)
    .sort((a, b) => b.t - a.t);
  return (
    <div>
      <div className="ph-row">
        <div>
          <div className="ph-title">Estado de Resultados</div>
          <div className="ph-sub">P&L automático · {mes}</div>
        </div>
        <input
          type="month"
          className="search"
          style={{ width: 160 }}
          value={mes}
          onChange={(e) => setMes(e.target.value)}
        />
      </div>
      {loading ? (
        <div className="loading">Cargando...</div>
      ) : (
        <>
          <div className="grid3">
            <div className="kpi">
              <div className="kpi-label">Ingresos</div>
              <div className="kpi-value kpi-success">{fmt_$(totalVentas)}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">CMV</div>
              <div className="kpi-value kpi-warn">{fmt_$(totalCompras)}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Utilidad Bruta</div>
              <div
                className={`kpi-value ${
                  utilidad >= 0 ? 'kpi-success' : 'kpi-danger'
                }`}
              >
                {fmt_$(utilidad)}
              </div>
              <div className="kpi-sub">Margen: {pct}%</div>
            </div>
          </div>
          <div className="grid2">
            <div className="panel">
              <div className="panel-hd">
                <span className="panel-title">Ventas por Forma de Cobro</span>
              </div>
              {porMedio.length === 0 ? (
                <div className="empty">Sin ventas en este período</div>
              ) : (
                <div>
                  {porMedio.map((x) => (
                    <div key={x.m} className="eerr-row">
                      <span style={{ fontSize: 12 }}>{x.m}</span>
                      <div>
                        <span className="num kpi-success">{fmt_$(x.t)}</span>
                        <span
                          style={{
                            fontSize: 10,
                            color: 'var(--muted2)',
                            marginLeft: 6,
                          }}
                        >
                          {totalVentas > 0
                            ? ((x.t / totalVentas) * 100).toFixed(1)
                            : 0}
                          %
                        </span>
                      </div>
                    </div>
                  ))}
                  <div className="eerr-row" style={{ background: 'var(--s2)' }}>
                    <span style={{ fontWeight: 600 }}>TOTAL VENTAS</span>
                    <span
                      style={{
                        fontFamily: "'Syne',sans-serif",
                        fontSize: 18,
                        fontWeight: 700,
                        color: 'var(--success)',
                      }}
                    >
                      {fmt_$(totalVentas)}
                    </span>
                  </div>
                </div>
              )}
            </div>
            <div className="panel">
              <div className="panel-hd">
                <span className="panel-title">Compras por Categoría</span>
              </div>
              {porCat.length === 0 ? (
                <div className="empty">Sin compras pagadas</div>
              ) : (
                <div>
                  {porCat.map((x) => (
                    <div key={x.c} className="eerr-row">
                      <span style={{ fontSize: 12 }}>{x.c}</span>
                      <div>
                        <span className="num kpi-warn">{fmt_$(x.t)}</span>
                        <span
                          style={{
                            fontSize: 10,
                            color: 'var(--muted2)',
                            marginLeft: 6,
                          }}
                        >
                          {totalVentas > 0
                            ? ((x.t / totalVentas) * 100).toFixed(1)
                            : 0}
                          %
                        </span>
                      </div>
                    </div>
                  ))}
                  <div className="eerr-row" style={{ background: 'var(--s2)' }}>
                    <span style={{ fontWeight: 600 }}>TOTAL CMV</span>
                    <span
                      style={{
                        fontFamily: "'Syne',sans-serif",
                        fontSize: 18,
                        fontWeight: 700,
                        color: 'var(--warn)',
                      }}
                    >
                      {fmt_$(totalCompras)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="panel">
            <div className="panel-hd">
              <span className="panel-title">Resumen P&L</span>
            </div>
            <div style={{ padding: '8px 0 12px' }}>
              {[
                [`Ventas brutas`, totalVentas, 'var(--success)'],
                [`(-) CMV`, -totalCompras, 'var(--danger)'],
                [
                  `(=) Utilidad Bruta`,
                  utilidad,
                  utilidad >= 0 ? 'var(--success)' : 'var(--danger)',
                ],
              ].map(([l, v, c], i) => (
                <div
                  key={i}
                  className="eerr-row"
                  style={
                    i === 2
                      ? { background: 'var(--s2)', padding: '12px 16px' }
                      : {}
                  }
                >
                  <span
                    style={{
                      fontSize: i === 2 ? 13 : 12,
                      fontWeight: i === 2 ? 600 : 400,
                    }}
                  >
                    {l}
                  </span>
                  <span
                    style={{
                      fontFamily: "'Syne',sans-serif",
                      fontSize: i === 2 ? 24 : 16,
                      fontWeight: 700,
                      color: c,
                    }}
                  >
                    {fmt_$(v)}
                  </span>
                </div>
              ))}
              <div
                style={{
                  margin: '12px 16px 0',
                  padding: '10px 12px',
                  background: 'rgba(232,197,71,.06)',
                  border: '1px solid rgba(232,197,71,.2)',
                  borderRadius: 'var(--r)',
                  fontSize: 11,
                  color: 'var(--muted2)',
                }}
              >
                ⚡ Labor Cost, OPEX y EBITDA — próxima fase.
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Proveedores() {
  const [proveedores, setProveedores] = useState([]);
  const [modal, setModal] = useState(false);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    nombre: '',
    cuit: '',
    cat: 'PESCADERIA',
    estado: 'Activo',
  });
  const load = async () => {
    setLoading(true);
    const { data } = await db.from('proveedores').select('*').order('nombre');
    setProveedores(data || []);
    setLoading(false);
  };
  useEffect(() => {
    load();
  }, []);
  const pFilt = proveedores.filter(
    (p) =>
      !search ||
      p.nombre.toLowerCase().includes(search.toLowerCase()) ||
      (p.cuit || '').includes(search)
  );
  const guardar = async () => {
    if (!form.nombre) return;
    await db.from('proveedores').insert([{ ...form, saldo: 0 }]);
    setModal(false);
    setForm({ nombre: '', cuit: '', cat: 'PESCADERIA', estado: 'Activo' });
    load();
  };
  return (
    <div>
      <div className="ph-row">
        <div>
          <div className="ph-title">Proveedores</div>
          <div className="ph-sub">
            {proveedores.length} registrados · Deuda total{' '}
            {fmt_$(proveedores.reduce((s, p) => s + (p.saldo || 0), 0))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="search"
            placeholder="Buscar..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn btn-acc" onClick={() => setModal(true)}>
            + Nuevo
          </button>
        </div>
      </div>
      <div className="panel">
        {loading ? (
          <div className="loading">Cargando...</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Proveedor</th>
                <th>CUIT</th>
                <th>Categoría</th>
                <th>Saldo Pendiente</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {pFilt.map((p) => (
                <tr key={p.id} className={p.saldo > 0 ? 'prov-row' : ''}>
                  <td style={{ fontWeight: 500 }}>{p.nombre}</td>
                  <td className="mono" style={{ color: 'var(--muted2)' }}>
                    {p.cuit || '—'}
                  </td>
                  <td>
                    <span className="badge b-muted">{p.cat}</span>
                  </td>
                  <td>
                    <span
                      className="num"
                      style={{
                        color: p.saldo > 0 ? 'var(--warn)' : 'var(--muted2)',
                      }}
                    >
                      {fmt_$(p.saldo || 0)}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        p.estado === 'Activo' ? 'b-success' : 'b-muted'
                      }`}
                    >
                      {p.estado}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {modal && (
        <div className="overlay" onClick={() => setModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">Nuevo Proveedor</div>
              <button className="close-btn" onClick={() => setModal(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>Razón Social *</label>
                <input
                  value={form.nombre}
                  onChange={(e) => setForm({ ...form, nombre: e.target.value })}
                  placeholder="Empresa S.A."
                />
              </div>
              <div className="form2">
                <div className="field">
                  <label>CUIT</label>
                  <input
                    value={form.cuit}
                    onChange={(e) => setForm({ ...form, cuit: e.target.value })}
                    placeholder="30-12345678-0"
                  />
                </div>
                <div className="field">
                  <label>Categoría EERR</label>
                  <select
                    value={form.cat}
                    onChange={(e) => setForm({ ...form, cat: e.target.value })}
                  >
                    {CATEGORIAS_COMPRA.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            <div className="modal-ft">
              <button className="btn btn-sec" onClick={() => setModal(false)}>
                Cancelar
              </button>
              <button className="btn btn-acc" onClick={guardar}>
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Config({ locales }) {
  const [usuarios, setUsuarios] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [editModal, setEditModal] = useState(null);
  const [form, setForm] = useState({
    nombre: '',
    email: '',
    password: '',
    rol: 'cajero',
    locales: [],
  });
  const load = async () => {
    setLoading(true);
    const { data } = await db.from('usuarios').select('*').order('rol');
    setUsuarios(data || []);
    setLoading(false);
  };
  useEffect(() => {
    load();
  }, []);
  const guardar = async () => {
    if (!form.nombre || !form.email || !form.password) return;
    await db.from('usuarios').insert([form]);
    setModal(false);
    setForm({
      nombre: '',
      email: '',
      password: '',
      rol: 'cajero',
      locales: [],
    });
    load();
  };
  const guardarEdit = async () => {
    await db
      .from('usuarios')
      .update({ password: editModal.password })
      .eq('id', editModal.id);
    setEditModal(null);
    load();
  };
  return (
    <div>
      <div className="ph-row">
        <div>
          <div className="ph-title">Usuarios</div>
          <div className="ph-sub">Accesos y permisos</div>
        </div>
        <button className="btn btn-acc" onClick={() => setModal(true)}>
          + Nuevo Usuario
        </button>
      </div>
      <div className="panel">
        {loading ? (
          <div className="loading">Cargando...</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Usuario</th>
                <th>Rol</th>
                <th>Locales</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {usuarios.map((u) => {
                const locs =
                  u.rol === 'dueno'
                    ? 'Todos'
                    : (u.locales || [])
                        .map((id) => locales.find((l) => l.id === id)?.nombre)
                        .filter(Boolean)
                        .join(', ') || 'Sin asignar';
                return (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 500 }}>{u.nombre}</td>
                    <td className="mono" style={{ color: 'var(--muted2)' }}>
                      {u.email}
                    </td>
                    <td>
                      <span
                        className="badge"
                        style={{
                          background: ROLES[u.rol]?.color + '22',
                          color: ROLES[u.rol]?.color,
                        }}
                      >
                        {ROLES[u.rol]?.label}
                      </span>
                    </td>
                    <td style={{ fontSize: 11, color: 'var(--muted2)' }}>
                      {locs}
                    </td>
                    <td>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setEditModal({ ...u })}
                      >
                        Cambiar clave
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {modal && (
        <div className="overlay" onClick={() => setModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">Nuevo Usuario</div>
              <button className="close-btn" onClick={() => setModal(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>Nombre</label>
                <input
                  value={form.nombre}
                  onChange={(e) => setForm({ ...form, nombre: e.target.value })}
                  placeholder="Nombre completo"
                />
              </div>
              <div className="form2">
                <div className="field">
                  <label>Usuario (email/login)</label>
                  <input
                    value={form.email}
                    onChange={(e) =>
                      setForm({ ...form, email: e.target.value })
                    }
                    placeholder="usuario@neko.com"
                  />
                </div>
                <div className="field">
                  <label>Contraseña inicial</label>
                  <input
                    value={form.password}
                    onChange={(e) =>
                      setForm({ ...form, password: e.target.value })
                    }
                    placeholder="••••••••"
                  />
                </div>
              </div>
              <div className="field">
                <label>Rol</label>
                <select
                  value={form.rol}
                  onChange={(e) => setForm({ ...form, rol: e.target.value })}
                >
                  {Object.entries(ROLES).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="modal-ft">
              <button className="btn btn-sec" onClick={() => setModal(false)}>
                Cancelar
              </button>
              <button className="btn btn-acc" onClick={guardar}>
                Crear
              </button>
            </div>
          </div>
        </div>
      )}
      {editModal && (
        <div className="overlay" onClick={() => setEditModal(null)}>
          <div
            className="modal"
            style={{ width: 380 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-hd">
              <div className="modal-title">Cambiar Contraseña</div>
              <button className="close-btn" onClick={() => setEditModal(null)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="alert alert-info">
                Usuario: {editModal.nombre}
              </div>
              <div className="field">
                <label>Nueva contraseña</label>
                <input
                  value={editModal.password}
                  onChange={(e) =>
                    setEditModal({ ...editModal, password: e.target.value })
                  }
                  placeholder="Nueva contraseña"
                />
              </div>
            </div>
            <div className="modal-ft">
              <button
                className="btn btn-sec"
                onClick={() => setEditModal(null)}
              >
                Cancelar
              </button>
              <button className="btn btn-acc" onClick={guardarEdit}>
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [section, setSection] = useState('dashboard');
  const [locales, setLocales] = useState([]);
  const [localActivo, setLocalActivo] = useState(null);

  useEffect(() => {
    db.from('locales')
      .select('*')
      .order('id')
      .then(({ data }) => setLocales(data || []));
  }, []);

  const login = (u) => {
    setUser(u);
    const perms = ROLES[u.rol]?.permisos || [];
    if (!perms.includes('dashboard')) setSection(perms[0]);
    if (u.rol !== 'dueno' && (u.locales || []).length === 1)
      setLocalActivo(u.locales[0]);
  };

  const props = { user, locales, localActivo };

  const renderSection = () => {
    switch (section) {
      case 'dashboard':
        return <Dashboard {...props} />;
      case 'ventas':
        return <Ventas {...props} />;
      case 'compras':
        return <Compras {...props} />;
      case 'remitos':
        return <Remitos {...props} />;
      case 'caja':
        return <Caja {...props} />;
      case 'eerr':
        return <EERR {...props} />;
      case 'proveedores':
        return <Proveedores {...props} />;
      case 'config':
        return <Config {...props} />;
      default:
        return null;
    }
  };

  if (!user)
    return (
      <>
        <style>{css}</style>
        <Login onLogin={login} />
      </>
    );

  return (
    <>
      <style>{css}</style>
      <div className="app">
        <Sidebar
          user={user}
          section={section}
          onNav={setSection}
          onLogout={() => {
            setUser(null);
            setSection('dashboard');
            setLocalActivo(null);
          }}
          locales={locales}
          localActivo={localActivo}
          setLocalActivo={setLocalActivo}
        />
        <main className="main">{renderSection()}</main>
      </div>
    </>
  );
}
