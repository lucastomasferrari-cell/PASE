import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

// Página de bienvenida — selector Admin/POS. Estética terminal/CLI (paleta
// oscura, monospace, badges técnicos, ámbar como acento). Reemplaza el
// redirect directo a /login para que el usuario elija a qué mundo entra.
//
// Rutas:
//  - POS  → /login?next=/pos            (email/password del local + PinGate)
//  - Admin → /login?next=/reportes/dashboard (email/password del dueño/admin)
//
// La LoginPage ya sabe leer ?next= y volver a esa ruta después de auth (ver
// LoginPage.tsx línea ~59).

export function WelcomePage() {
  const navigate = useNavigate();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  function goPos() {
    navigate('/login?next=/pos');
  }
  function goAdmin() {
    navigate('/login?next=/reportes/dashboard');
  }

  const t = now.toTimeString().slice(0, 8);

  return (
    <div className="wel-root">
      <style>{styles}</style>

      {/* Status bar */}
      <div className="wel-status">
        <div className="wel-status-left">
          <span><span className="wel-dot" />SYSTEM LIVE</span>
          <span>SYNC: <b>OK</b></span>
          <span>REGION: <b>AR-BA</b></span>
        </div>
        <div className="wel-status-right">
          <span>SESSION: <b>--</b></span>
          <span className="wel-clock">{t}</span>
        </div>
      </div>

      {/* Body */}
      <div className="wel-body">
        <div className="wel-heading">
          <div className="wel-heading-left">
            <h1 className="wel-brand">comanda<span className="wel-dot-yellow">.</span></h1>
            <p className="wel-tagline">SELECCIONÁ EL MÓDULO AL QUE QUERÉS ACCEDER</p>
          </div>
          <div className="wel-heading-right">
            <span>BUILD: <b>5.0.4</b></span>
            <span>HOST: <b>pase-comanda.vercel.app</b></span>
          </div>
        </div>

        <div className="wel-grid">
          {/* POS card */}
          <button className="wel-mod" onClick={goPos} type="button" aria-label="Entrar al POS">
            <div className="wel-mod-head">
              <div className="wel-mod-label">01 // POS.SYS · FRONTLINE</div>
              <div className="wel-mod-badge wel-badge-live">
                <span className="wel-dot" />&nbsp;LIVE
              </div>
            </div>
            <div className="wel-mod-main">
              <div className="wel-mod-icon">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square">
                  <path d="M4 6l4 4-4 4" />
                  <path d="M12 14h8" />
                </svg>
              </div>
              <div>
                <div className="wel-mod-name">POS</div>
                <p className="wel-mod-sub">Salón · Mostrador · Pedidos · Caja</p>
              </div>
            </div>
            <div className="wel-mod-meta">
              <div><small>ACCESO</small><b>EMAIL + PIN</b></div>
              <div><small>OPTIMIZADO</small><b>Tablet · Táctil</b></div>
              <div><small>ROLES</small><b>Cajero · Mozo · Manager</b></div>
              <div><small>USO</small><b>Frontline</b></div>
            </div>
            <div className="wel-mod-cta">
              <span className="wel-cta-cmd">./run pos.sys</span>
              <span className="wel-cta-go">EJECUTAR →</span>
            </div>
          </button>

          {/* ADMIN card */}
          <button className="wel-mod" onClick={goAdmin} type="button" aria-label="Entrar al Admin">
            <div className="wel-mod-head">
              <div className="wel-mod-label">02 // ADMIN.SYS · BACKOFFICE</div>
              <div className="wel-mod-badge wel-badge-ready">
                <span className="wel-dot wel-dot-amber" />&nbsp;READY
              </div>
            </div>
            <div className="wel-mod-main">
              <div className="wel-mod-icon">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square">
                  <rect x="3" y="3" width="7" height="7" />
                  <rect x="14" y="3" width="7" height="7" />
                  <rect x="3" y="14" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" />
                </svg>
              </div>
              <div>
                <div className="wel-mod-name">Admin</div>
                <p className="wel-mod-sub">Catálogo · Precios · Empleados · Reportes</p>
              </div>
            </div>
            <div className="wel-mod-meta">
              <div><small>ACCESO</small><b>EMAIL + PWD</b></div>
              <div><small>OPTIMIZADO</small><b>Desktop</b></div>
              <div><small>ROLES</small><b>Dueño · Admin · Encargado</b></div>
              <div><small>USO</small><b>Backoffice</b></div>
            </div>
            <div className="wel-mod-cta">
              <span className="wel-cta-cmd">./run admin.sys</span>
              <span className="wel-cta-go">EJECUTAR →</span>
            </div>
          </button>
        </div>

        <div className="wel-footer">
          <span>ECOSISTEMA COCINA · PASE · COMANDA · MESA</span>
          <span>© {new Date().getFullYear()} · v5.0.4</span>
        </div>
      </div>
    </div>
  );
}

// Estilos inline — la página vive fuera del layout dark de la app (fondo
// oscuro puro, monospace, ámbar). Evita depender de tokens compartidos.
const styles = `
  .wel-root {
    --wel-bg: #0A0E17;
    --wel-bg-alt: #0F1520;
    --wel-line: #1D2A3A;
    --wel-line-2: #263447;
    --wel-line-3: #33445E;
    --wel-ink: #E8ECEF;
    --wel-ink-2: #94A3B8;
    --wel-ink-3: #64748B;
    --wel-ink-4: #3E4B60;
    --wel-amber: #F5B72E;
    --wel-green: #4ADE80;
    min-height: 100vh;
    background: var(--wel-bg);
    color: var(--wel-ink);
    font-family: "JetBrains Mono", "IBM Plex Mono", "Cascadia Code", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 13.5px;
    line-height: 1.55;
    display: flex;
    flex-direction: column;
    -webkit-font-smoothing: antialiased;
  }
  @keyframes wel-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }
  .wel-dot {
    width: 7px; height: 7px; border-radius: 50%;
    display: inline-block; margin-right: 6px;
    background: var(--wel-green);
    box-shadow: 0 0 8px color-mix(in srgb, var(--wel-green) 60%, transparent);
    animation: wel-pulse 2s ease-in-out infinite;
    vertical-align: middle;
  }
  .wel-dot-amber {
    background: var(--wel-amber);
    box-shadow: 0 0 8px color-mix(in srgb, var(--wel-amber) 60%, transparent);
  }
  .wel-dot-yellow { color: var(--wel-amber); }

  .wel-status {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 20px;
    background: var(--wel-bg);
    border-bottom: 1px solid var(--wel-line);
    font-size: 11px;
    letter-spacing: 0.06em;
    color: var(--wel-ink-3);
    flex-wrap: wrap;
    gap: 12px;
  }
  .wel-status-left, .wel-status-right {
    display: flex; gap: 20px; align-items: center; flex-wrap: wrap;
  }
  .wel-status b { color: var(--wel-ink); font-weight: 500; }
  .wel-status .wel-clock {
    color: var(--wel-amber);
    font-variant-numeric: tabular-nums;
  }

  .wel-body {
    max-width: 1240px;
    width: 100%;
    margin: 0 auto;
    padding: 40px 24px 32px;
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .wel-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 16px;
    margin-bottom: 28px;
    padding-bottom: 12px;
    border-bottom: 1px dashed var(--wel-line-2);
  }
  .wel-brand {
    font-family: "Inter", system-ui, sans-serif;
    font-size: 32px;
    font-weight: 700;
    letter-spacing: -0.03em;
    color: var(--wel-ink);
    margin: 0 0 6px;
    line-height: 1;
  }
  .wel-tagline {
    font-size: 12px;
    color: var(--wel-ink-3);
    letter-spacing: 0.06em;
    margin: 0;
  }
  .wel-heading-right {
    font-size: 11px;
    color: var(--wel-ink-3);
    letter-spacing: 0.08em;
    text-align: right;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .wel-heading-right b { color: var(--wel-ink); font-weight: 500; }

  .wel-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    flex: 1;
  }
  .wel-mod {
    all: unset;
    background: var(--wel-bg-alt);
    border: 1px solid var(--wel-line);
    border-radius: 5px;
    padding: 24px 24px 20px;
    cursor: pointer;
    transition: all 0.2s;
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow: hidden;
    color: var(--wel-ink);
    text-align: left;
  }
  .wel-mod::before {
    content: "";
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: var(--wel-amber);
    transform: scaleX(0);
    transform-origin: left;
    transition: transform 0.25s;
  }
  .wel-mod:hover {
    border-color: var(--wel-line-3);
    background: color-mix(in srgb, var(--wel-amber) 3%, var(--wel-bg-alt));
  }
  .wel-mod:hover::before { transform: scaleX(1); }
  .wel-mod:focus-visible {
    outline: 2px solid var(--wel-amber);
    outline-offset: 2px;
  }

  .wel-mod-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }
  .wel-mod-label {
    font-size: 11px;
    letter-spacing: 0.1em;
    color: var(--wel-ink-3);
  }
  .wel-mod-badge {
    padding: 3px 9px;
    border-radius: 3px;
    font-size: 10px;
    letter-spacing: 0.1em;
    border: 1px solid;
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
  }
  .wel-badge-live {
    color: var(--wel-green);
    border-color: color-mix(in srgb, var(--wel-green) 40%, transparent);
    background: color-mix(in srgb, var(--wel-green) 8%, transparent);
  }
  .wel-badge-ready {
    color: var(--wel-amber);
    border-color: color-mix(in srgb, var(--wel-amber) 40%, transparent);
    background: color-mix(in srgb, var(--wel-amber) 8%, transparent);
  }

  .wel-mod-main {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 12px 0;
  }
  .wel-mod-icon {
    width: 64px; height: 64px;
    border: 1px solid var(--wel-line-2);
    border-radius: 4px;
    display: flex; align-items: center; justify-content: center;
    color: var(--wel-amber);
    background: var(--wel-bg);
    flex-shrink: 0;
  }
  .wel-mod-name {
    font-family: "Inter", sans-serif;
    font-size: 34px;
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1;
    margin: 0 0 6px;
    color: var(--wel-ink);
  }
  .wel-mod-sub {
    color: var(--wel-ink-2);
    font-size: 12.5px;
    margin: 0;
    line-height: 1.5;
  }
  .wel-mod-meta {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px 24px;
    padding: 14px 0;
    border-top: 1px dashed var(--wel-line-2);
    font-size: 11px;
  }
  .wel-mod-meta div { display: flex; flex-direction: column; gap: 2px; }
  .wel-mod-meta small {
    color: var(--wel-ink-3);
    letter-spacing: 0.08em;
    font-size: 10px;
  }
  .wel-mod-meta b { color: var(--wel-ink); font-weight: 500; font-size: 12px; }

  .wel-mod-cta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 8px;
    border-top: 1px solid var(--wel-line);
    font-size: 12px;
    letter-spacing: 0.06em;
  }
  .wel-cta-cmd { color: var(--wel-ink-3); }
  .wel-cta-go {
    color: var(--wel-amber);
    font-weight: 500;
    letter-spacing: 0.1em;
  }
  .wel-mod:hover .wel-cta-go {
    letter-spacing: 0.14em;
  }

  .wel-footer {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid var(--wel-line);
    display: flex;
    justify-content: space-between;
    font-size: 10.5px;
    letter-spacing: 0.08em;
    color: var(--wel-ink-3);
    flex-wrap: wrap;
    gap: 8px;
  }

  @media (max-width: 900px) {
    .wel-grid { grid-template-columns: 1fr; }
    .wel-mod-main { gap: 14px; }
    .wel-mod-name { font-size: 28px; }
    .wel-heading { flex-direction: column; align-items: flex-start; }
    .wel-heading-right { text-align: left; }
    .wel-body { padding: 24px 16px; }
  }
`;
