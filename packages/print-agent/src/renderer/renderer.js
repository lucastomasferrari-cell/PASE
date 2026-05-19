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
setInterval(refresh, 5000);
