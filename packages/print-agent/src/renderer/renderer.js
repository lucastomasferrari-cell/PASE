// renderer.js — UI lógica del status panel.
// Toca window.agentAPI (puente seguro vía preload.js).

const elIndicator = document.getElementById('status-indicator');
const elPort = document.getElementById('port');
const elVersion = document.getElementById('version');
const elErrorRow = document.getElementById('error-row');
const elErrorText = document.getElementById('error-text');
const elLoginCheckbox = document.getElementById('login-startup');

function setStatus(state) {
  // state: 'starting' | 'online' | 'error'
  const dot = elIndicator.querySelector('.dot');
  const label = elIndicator.querySelector('.label');
  dot.className = 'dot ' + (state === 'online' ? 'dot-green' : state === 'error' ? 'dot-red' : 'dot-yellow');
  label.textContent = state === 'online'
    ? 'Imprimiendo OK'
    : state === 'error'
    ? 'Error — ver detalle abajo'
    : 'Iniciando…';
}

async function refresh() {
  try {
    const s = await window.agentAPI.getStatus();
    elPort.textContent = String(s.port);
    elVersion.textContent = `v${s.version}`;
    if (s.printServerError) {
      setStatus('error');
      elErrorRow.hidden = false;
      elErrorText.textContent = s.printServerError;
    } else if (s.printServerStarted) {
      setStatus('online');
      elErrorRow.hidden = true;
    } else {
      setStatus('starting');
    }
    elLoginCheckbox.checked = s.loginAtStartup;
  } catch (err) {
    console.error('refresh error:', err);
  }
}

// Eventos UI
document.getElementById('open-comanda').addEventListener('click', (e) => {
  e.preventDefault();
  window.agentAPI.openComanda();
});

document.getElementById('open-comanda-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.agentAPI.openComanda();
});

// ─── Vinculación: el renderer habla directo al server local (127.0.0.1)
//     porque está corriendo en este mismo proceso. CSP de Electron lo
//     permite.

const elTokenInput = document.getElementById('token-input');
const elLinkBtn = document.getElementById('link-btn');
const elUnlinkBtn = document.getElementById('unlink-btn');
const elLinkError = document.getElementById('link-error');
const elLinkUnlinked = document.getElementById('link-unlinked');
const elLinkLinked = document.getElementById('link-linked');
const elTokenPreview = document.getElementById('token-preview');

async function refreshLinkStatus() {
  try {
    const resp = await fetch('http://127.0.0.1:9100/config');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.has_token) {
      elLinkUnlinked.hidden = true;
      elLinkLinked.hidden = false;
      elTokenPreview.textContent = data.token_preview || '—';
    } else {
      elLinkUnlinked.hidden = false;
      elLinkLinked.hidden = true;
    }
  } catch (err) {
    // Server todavía no arrancó — re-intentamos en próximo refresh tick.
    console.debug('config not available yet:', err.message);
  }
}

elTokenInput.addEventListener('input', () => {
  elLinkBtn.disabled = elTokenInput.value.trim().length < 16;
  elLinkError.hidden = true;
});

elLinkBtn.addEventListener('click', async () => {
  const token = elTokenInput.value.trim();
  if (token.length < 16) return;
  elLinkBtn.disabled = true;
  elLinkBtn.textContent = 'Vinculando…';
  try {
    const resp = await fetch('http://127.0.0.1:9100/config/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_token: token }),
    });
    if (!resp.ok) {
      const detail = await resp.json().catch(() => ({}));
      throw new Error(detail.error || `HTTP ${resp.status}`);
    }
    elTokenInput.value = '';
    await refreshLinkStatus();
  } catch (err) {
    elLinkError.textContent = `Error: ${err.message}`;
    elLinkError.hidden = false;
  } finally {
    elLinkBtn.disabled = false;
    elLinkBtn.textContent = 'Vincular esta PC';
  }
});

elUnlinkBtn.addEventListener('click', async () => {
  if (!confirm('¿Desvincular este agent de COMANDA?\n\nVa a dejar de reportar status al panel admin, pero la impresión local sigue funcionando.')) {
    return;
  }
  try {
    await fetch('http://127.0.0.1:9100/config/token', { method: 'DELETE' });
    await refreshLinkStatus();
  } catch (err) {
    elLinkError.textContent = `Error: ${err.message}`;
    elLinkError.hidden = false;
  }
});

document.getElementById('open-logs-btn').addEventListener('click', () => {
  window.agentAPI.openLogs();
});

elLoginCheckbox.addEventListener('change', async (e) => {
  await window.agentAPI.setLoginStartup(e.target.checked);
});

// Push del main → renderer
window.agentAPI.onPrintServerStatus((payload) => {
  if (payload.ok) {
    setStatus('online');
    elErrorRow.hidden = true;
  } else {
    setStatus('error');
    elErrorRow.hidden = false;
    elErrorText.textContent = payload.error || 'Error desconocido';
  }
});

// Refresh inicial y cada 5s
refresh();
refreshLinkStatus();
setInterval(() => { refresh(); refreshLinkStatus(); }, 5000);
