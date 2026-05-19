# COMANDA Print Server

Servidor local de impresión para COMANDA. Corre en la misma PC donde está conectada la impresora térmica (o donde se accede a impresoras de red). El POS web le habla por HTTP localhost.

## Por qué existe

El browser solo puede hablar con impresoras via WebUSB (Chrome/Edge únicamente, USB únicamente). Este servidor amplía las opciones a:

- **USB** — cualquier térmica ESC/POS, Epson/Star/Bixolon/Xprinter/etc.
- **Network/IP** — térmicas con interface Ethernet (puerto 9100 RAW estándar).
- **Serial / COM** — térmicas viejas seriales + cualquier térmica Bluetooth después de pairear (Windows crea un puerto COM virtual).
- **Tablets Android** — donde WebUSB no existe; corre el servidor en otra PC en red.

## Instalación

**Para usuarios finales (comerciantes):** descargar el instalador del `@pase/print-agent` (Electron) — no toques este paquete directo. El agent ya empaqueta este server adentro.

**Para desarrollo / debug:**

Requiere Node.js 22.x (la misma versión que ships con Electron 33). Si tenés Node 24+, el módulo nativo `better-sqlite3` va a fallar con `NODE_MODULE_VERSION mismatch`.

```bash
cd packages/print-server
npm install
npm start
```

Si tenés `NODE_MODULE_VERSION X` error: corré `pnpm --filter @pase/print-server rebuild-native` y volvé a probar.

El servidor escucha en `http://127.0.0.1:9100` por default. Se puede cambiar con env var `PRINT_SERVER_PORT`.

Para que arranque automáticamente al prender la PC:

**Windows**: agregar acceso directo a `npm start` en la carpeta Inicio (Win+R → `shell:startup`).

**macOS**: crear archivo `~/Library/LaunchAgents/com.comanda.printserver.plist` con configuración del demonio.

**Linux**: crear servicio systemd `/etc/systemd/system/comanda-print.service`.

(Más adelante vamos a empaquetar como ejecutable autocontenido con Electron o pkg para que no haya que instalar Node.)

## Configuración

Las impresoras se configuran desde la pantalla `/hardware/impresoras` en COMANDA — el browser le manda al servidor las creds vía HTTP. La config queda persistida en `~/.comanda-print-server.json`.

Estructura:

```json
{
  "printers": [
    {
      "id": "printer_1",
      "nombre": "Cocina caliente",
      "estacion": "cocina_caliente",
      "transporte": "usb",
      "config": { "vendor_id": "0x04b8", "product_id": "0x0202", "tipo": "epson", "width": 32 }
    },
    {
      "id": "printer_2",
      "nombre": "Barra",
      "estacion": "barra",
      "transporte": "network",
      "config": { "host": "192.168.1.50", "port": 9100, "width": 48 }
    },
    {
      "id": "printer_3",
      "nombre": "Cliente caja",
      "estacion": null,
      "transporte": "serial",
      "config": { "path": "COM3", "tipo": "star" }
    }
  ]
}
```

## Endpoints HTTP

| Método | URL | Descripción |
|---|---|---|
| GET | `/ping` | Health check |
| GET | `/printers` | Lista impresoras + estado de cada una |
| POST | `/printers` | Agregar/actualizar (body: `{ nombre, estacion, transporte, config }`) |
| DELETE | `/printers/:id` | Eliminar impresora |
| POST | `/print` | Imprimir ticket (`{ printer_id, ticket }`) |
| POST | `/print-by-estacion` | Ruteo: `{ estacion, ticket }` busca impresora con esa estación |
| POST | `/test/:id` | Página de prueba |
| GET | `/discover/usb` | Auto-detect impresoras USB conectadas |

## Estación es opcional

Una impresora puede tener `estacion: null` (típicamente la del cliente, en caja). Las que SÍ tienen estación (`"cocina_caliente"`, `"barra"`, etc) se usan para routing automático al mandar curso desde el POS.

## Failover

Si el servidor está caído, COMANDA cae back a WebUSB en el browser. Si las dos cosas fallan, el ticket queda igual en el KDS digital — la cocina ve los pedidos en pantalla sin depender del papel.

## CORS

El server permite todas las orígenes (HTTP local, no expuesto a internet). Si querés restringirlo, editá `cors({ origin: ... })` en `src/server.js`.
