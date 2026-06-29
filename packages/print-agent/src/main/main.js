// main.js — proceso principal del Electron app.
//
// Responsabilidades:
//   1. Arrancar el print-server local (Node) como child process embebido
//      (no spawn separado — usamos `fork`/`require` directo para que viva
//      en el mismo proceso Electron). Esto evita problemas de
//      empaquetado de binarios Node aparte.
//   2. Mostrar tray icon con menú (status verde/rojo, abrir ventana,
//      vincular agent, salir).
//   3. Ventana de status renderer con log de actividad.
//   4. Auto-start al login del usuario (setLoginItemSettings).
//   5. Auto-update vía electron-updater (en producción).
//   6. Mantener el agent corriendo aunque cierres la ventana — sigue en
//      el tray. Solo sale con "Salir" explícito.

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const log = require('electron-log');
const { autoUpdater } = require('electron-updater');

// ─── Configuración log ──────────────────────────────────────────────────
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
log.info('═══ COMANDA Print Agent starting ═══');
log.info('app version:', app.getVersion());
log.info('user data:', app.getPath('userData'));

const isDev = process.argv.includes('--dev') || !app.isPackaged;
const PRINT_SERVER_PORT = 9100;

let tray = null;
let mainWindow = null;
let printServerStarted = false;
let printServerError = null;

// ─── Single instance lock ──────────────────────────────────────────────
// Si abren el .exe 2 veces, la segunda instancia avisa a la primera y se
// cierra. Evita que arranquen 2 print-servers compitiendo por el puerto.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log.warn('Ya hay una instancia corriendo — saliendo');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ─── Start del print-server embebido ──────────────────────────────────
//
// En dev: require absoluto al packages/print-server.
// En prod (packaged): los recursos van a process.resourcesPath/print-server.
async function startPrintServer() {
  try {
    const serverPath = isDev
      ? path.resolve(__dirname, '../../../print-server/src/server.js')
      : path.join(process.resourcesPath, 'print-server', 'src', 'server.js');

    log.info('[print-server] path:', serverPath);
    log.info('[print-server] exists:', fs.existsSync(serverPath));

    // Forzar el puerto via env var (por si alguien lo cambia)
    process.env.PRINT_SERVER_PORT = String(PRINT_SERVER_PORT);
    // Le avisamos al server que está embebido — no debe instalar SIGINT
    // handlers que llamen process.exit (mataría Electron).
    process.env.PRINT_SERVER_EMBEDDED = '1';

    // Importar dinámicamente. server.js es ESM (type: module) — usamos
    // dynamic import desde CommonJS.
    const url = new URL(`file:///${serverPath.replaceAll('\\', '/')}`);
    await import(url.href);
    printServerStarted = true;
    log.info('[print-server] arrancado en puerto', PRINT_SERVER_PORT);
    if (mainWindow) mainWindow.webContents.send('print-server-status', { ok: true });
    updateTrayMenu();
  } catch (err) {
    printServerError = err.message;
    log.error('[print-server] FAILED:', err);
    if (mainWindow) mainWindow.webContents.send('print-server-status', { ok: false, error: err.message });
    updateTrayMenu();
  }
}

// ─── Tray ──────────────────────────────────────────────────────────────
function buildTrayIcon(state) {
  // En dev usamos un PNG simple. En prod hay íconos por OS en assets/.
  const iconName = state === 'online'
    ? 'tray-online.png'
    : state === 'error'
    ? 'tray-error.png'
    : 'tray-idle.png';
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', iconName),
    path.join(process.resourcesPath, 'assets', iconName),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return nativeImage.createFromPath(p);
  }
  // Fallback: ícono 1x1 transparente para no crashear
  return nativeImage.createEmpty();
}

function updateTrayMenu() {
  if (!tray) return;
  const status = printServerStarted ? 'online' : printServerError ? 'error' : 'starting';
  tray.setImage(buildTrayIcon(status));
  tray.setToolTip(
    status === 'online'
      ? `COMANDA Print Agent — corriendo en :${PRINT_SERVER_PORT}`
      : status === 'error'
      ? `COMANDA Print Agent — ERROR: ${printServerError}`
      : 'COMANDA Print Agent — iniciando…'
  );

  const menu = Menu.buildFromTemplate([
    {
      label: status === 'online'
        ? '🟢 En línea (puerto 9100)'
        : status === 'error'
        ? `🔴 ERROR — ${printServerError ?? ''}`.slice(0, 60)
        : '🟡 Iniciando…',
      enabled: false,
    },
    { type: 'separator' },
    { label: 'Abrir panel de status', click: () => showMainWindow() },
    { label: 'Abrir COMANDA en el navegador', click: () => shell.openExternal('https://pase-yndx.vercel.app') },
    { label: 'Ver logs', click: () => shell.openPath(log.transports.file.getFile().path) },
    { type: 'separator' },
    {
      label: 'Arrancar con Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({
          openAtLogin: menuItem.checked,
          openAsHidden: true, // que no aparezca ventana al booteo, solo tray
        });
        log.info('login item settings:', menuItem.checked);
      },
    },
    { type: 'separator' },
    { label: 'Salir', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ─── Ventana principal (status + config) ──────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#fafafa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Al cerrar la ventana, NO salir — minimizar a tray.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

function showMainWindow() {
  if (!mainWindow) createMainWindow();
  mainWindow.show();
  mainWindow.focus();
}

// ─── IPC: el renderer pregunta cosas al main ──────────────────────────
ipcMain.handle('get-status', () => ({
  printServerStarted,
  printServerError,
  port: PRINT_SERVER_PORT,
  version: app.getVersion(),
  loginAtStartup: app.getLoginItemSettings().openAtLogin,
}));

ipcMain.handle('open-comanda', () => shell.openExternal('https://pase-yndx.vercel.app'));
ipcMain.handle('open-logs', () => shell.openPath(log.transports.file.getFile().path));
ipcMain.handle('set-login-startup', (_evt, enable) => {
  app.setLoginItemSettings({ openAtLogin: !!enable, openAsHidden: true });
  return app.getLoginItemSettings().openAtLogin;
});

// Instala el driver "Generic / Text Only" + crea impresora Windows en USB001.
// Requiere admin; se ejecuta elevado via Start-Process -Verb RunAs.
ipcMain.handle('install-usb-driver', () => {
  const { execFile } = require('node:child_process');
  const script = [
    'Add-PrinterDriver -Name "Generic / Text Only" -ErrorAction SilentlyContinue;',
    '$port = (Get-PrinterPort | Where-Object { $_.Name -match "^USB" } | Select-Object -First 1).Name;',
    'if ($port) {',
    '  if (!(Get-Printer -Name "Impresora Comanda" -ErrorAction SilentlyContinue)) {',
    '    Add-Printer -Name "Impresora Comanda" -DriverName "Generic / Text Only" -PortName $port',
    '  }',
    '  "OK"',
    '} else {',
    '  throw "No se encontro puerto USB de impresora. Conecta la impresora y volvé a intentar."',
    '}',
  ].join(' ');

  return new Promise((resolve) => {
    // Elevar con Start-Process -Verb RunAs para que tenga permisos de admin
    const elevatedCmd = `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile -Command "${script.replace(/"/g, '\\"')}"'`;
    execFile('powershell.exe', ['-NoProfile', '-Command', elevatedCmd], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        log.error('[install-usb-driver] error:', err.message, stderr);
        resolve({ ok: false, error: stderr || err.message });
      } else {
        log.info('[install-usb-driver] ok');
        resolve({ ok: true });
      }
    });
  });
});

// ─── Auto-update ──────────────────────────────────────────────────────
if (!isDev) {
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Check inicial al arrancar + cada hora
  setTimeout(() => autoUpdater.checkForUpdatesAndNotify().catch((e) => log.warn('update check:', e.message)), 30_000);
  setInterval(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 60 * 60 * 1000);
}

// ─── Lifecycle ────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Por default activamos auto-start (el comerciante quiere que SIEMPRE
  // arranque). Si no le gusta, lo deshabilita desde el tray.
  if (!isDev && !app.getLoginItemSettings().openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
    log.info('auto-start habilitado por default');
  }

  tray = new Tray(buildTrayIcon('starting'));
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
  updateTrayMenu();
  createMainWindow();

  // Si NO viene con flag --hidden y NO está marcado openAsHidden (primera
  // vez), mostramos la ventana para que el usuario vea que arrancó.
  if (!process.argv.includes('--hidden')) showMainWindow();

  // Arrancar el print-server detrás de todo
  void startPrintServer();
});

app.on('window-all-closed', (e) => {
  // En Mac, no salir cuando se cierran ventanas
  e.preventDefault();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  log.info('═══ Salida grácil ═══');
});
