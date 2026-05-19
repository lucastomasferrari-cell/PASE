# COMANDA Print Agent

App de escritorio (Electron) que envuelve el `@pase/print-server` con UI tray + auto-start. Lo que instala el comerciante en la PC del local para que las comandas vayan a las impresoras térmicas sin tener que abrir terminal nunca.

## Stack

- **Electron 33** — wrapper de ventana + tray + lifecycle.
- **electron-builder** — empaqueta `.exe` (NSIS) Windows y `.dmg` macOS.
- **electron-updater** — auto-actualización vía URL pública.
- **electron-log** — log estructurado al filesystem del usuario (visible desde el menú "Ver logs").
- **`@pase/print-server`** (workspace) — el server Express + cola SQLite + heartbeat que vive en `packages/print-server`. El Electron lo importa al boot.

## Cómo corre

1. `pnpm --filter @pase/print-agent start` abre la app en modo dev.
2. Al boot, `main.js` hace `import()` dinámico del `print-server/src/server.js` que arranca Express en `127.0.0.1:9100`. **Misma process tree**, no spawn separado — más simple de empaquetar.
3. Tray icon aparece con menú: status, abrir COMANDA, ver logs, arranque automático, salir.
4. Ventana principal (`src/renderer/index.html`) muestra status grande + checkbox auto-start + pasos para vincular.
5. Al cerrar la X de la ventana, NO sale — minimiza al tray. Solo sale con menú → Salir.

## Build de producción

```bash
# Desde la raíz del monorepo
pnpm --filter @pase/print-agent install
pnpm --filter @pase/print-agent dist:win    # → dist/COMANDA Print Agent Setup X.X.X.exe
pnpm --filter @pase/print-agent dist:mac    # → dist/COMANDA Print Agent-X.X.X.dmg
```

El instalador empaqueta:
- Electron runtime (~80MB de Node + Chromium).
- `src/main` + `src/renderer` del agent.
- `packages/print-server/` completo como recurso extra (Express + node-thermal-printer + better-sqlite3).

**Importante**: `electron-builder install-app-deps` corre en postinstall para rebuildear los addons nativos (`better-sqlite3` tiene addon C++) contra la versión de Node embebida en Electron.

## Code signing

**Por ahora se distribuye SIN firma.** Windows SmartScreen va a mostrar "Windows protegió su PC" la primera vez — el usuario hace click en "Más información → Ejecutar de todas formas". macOS Gatekeeper también va a quejarse — botón derecho → Abrir.

Para producción seria comprar:
- **Windows**: certificado Code Signing EV (~$200/año). Salta el waiting period de SmartScreen.
- **macOS**: Apple Developer Program ($99/año) + notarización.

Configurar en `electron-builder` via env vars `CSC_LINK` + `CSC_KEY_PASSWORD` (Windows) y `APPLE_ID` + `APPLE_TEAM_ID` (Mac).

## Auto-update

Configurado pero requiere infraestructura:
1. Subir `latest.yml` + `.exe` a `https://pase-yndx.vercel.app/print-agent-releases/win/` después de cada build.
2. `autoUpdater.checkForUpdatesAndNotify()` corre cada hora — si hay versión nueva, descarga + instala silencioso al próximo reinicio.

Por ahora no hay endpoint público — postergado hasta tener 1er piloto pidiendo updates.

## Auto-start al login

`app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })` se llama por default al primer boot. El comerciante puede deshabilitarlo desde el tray.

- **Windows**: registra entry en `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
- **macOS**: agrega a Login Items vía AppleScript Bridge.
- **Linux**: no soportado por Electron — habría que escribir `.desktop` manualmente en `~/.config/autostart/`.

## Wire-up con COMANDA

Una vez instalado:
1. El comerciante abre COMANDA en el navegador.
2. Va a Hardware → Print Agents → "Vincular nueva PC" → genera un token.
3. **TODO Sprint 5**: pegar el token desde la UI del agent (hoy hay que llamar `POST 127.0.0.1:9100/config/token` a mano).
4. El agent empieza a mandar heartbeat cada 60s.
5. La pantalla "Hardware → Print Agents" muestra el agent como "En línea" en menos de 1 minuto.
6. Después: COMANDA → Hardware → Impresoras (la pantalla existente) sigue funcionando como antes — agrega impresoras al print-server local de esta PC.
