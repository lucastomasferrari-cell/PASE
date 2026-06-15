# Estrategia de impresión térmica para COMANDA — investigación + recomendación

**Fecha:** 2026-06-14
**Qué es:** síntesis de una investigación de mercado (cómo lo resuelven los líderes) + el abanico técnico real + la recomendación de arquitectura aterrizada al código actual de COMANDA.
**Pregunta:** cómo imprimir tickets térmicos (comanda de cocina + ticket de venta, ESC/POS) desde un POS **web** (React en Chrome, Windows primario en Argentina), soportando **cualquier impresora del mercado** con la **instalación más simple** posible.

> ⚠️ Nota de método: la investigación fan-out trajo 66 afirmaciones de 14 fuentes (la mayoría **primarias**: docs oficiales de Fudo, Dutchie, QZ Tray, PrintNode, Star, Toast, Electron). La verificación adversarial automática **no llegó a correr** (se cortó por límite de sesión), así que las afirmaciones de abajo están cruzadas a mano contra conocimiento de ingeniería + el código real, no por el voto automático. Todas son consistentes y de fuentes creíbles.

---

## 1. Veredicto en una frase

**El camino profesional para un POS web NO es WebUSB — es un AGENTE LOCAL que imprime por el sistema operativo (spooler) y por red (puerto 9100). Es exactamente lo que ya tenés empezado (el `print-server` en Node) y lo que hace Fudo. Hay que TERMINARLO y pulir el onboarding, no reinventarlo.**

---

## 2. Cómo lo hacen los líderes (con fuentes)

| Producto | Cómo imprime | Hardware | Setup que ve el comerciante |
|---|---|---|---|
| **Fudo** (líder LatAm) | **USB**: instala la impresora en **Windows con driver "Genérico / Solo texto"** (brand-agnostic, anda con cualquier china) — **sin agente propio, sin Zadig**. **Red**: IP manual + **puerto 9100**, sin auto-descubrimiento (el comerciante hace un autotest, lee la IP, la tipea). | Cualquier térmica ESC/POS | Instalar driver en Windows (USB) o tipear IP (red). Plug-and-play moderado. |
| **Square** | App nativa + hardware certificado; USB/LAN/Bluetooth según modelo. | Lista de impresoras compatibles (no "cualquiera") | "Una caja, enchufar" pero sobre **su** hardware. |
| **Toast** | Impresoras **propias M30**, solo en red administrada por Toast (DHCP). | **Propietario, vendor-locked** | NO plug-and-play: reset de fábrica + SimpleAP + cambio temporal de WiFi → 3-5 min guiados. |
| **Dutchie POS** (web) | **WebUSB** con **driver Zadig por impresora** en Windows; recomienda **PrintNode** (agente cloud) como alternativa sin driver. | Genéricas | Instalar Zadig por cada impresora, o instalar PrintNode. |
| **QZ Tray** (solución genérica usada por muchos POS web) | **Agente local instalado**; el navegador le habla y él manda **RAW ESC/POS** a la impresora. Anda en todos los browsers de escritorio. | Cualquiera | Instalar el agente una vez. |
| **PrintNode** (servicio comercial) | **Agente local + cloud**: sockets event-driven entregan el job al cliente instalado; imprime **RAW** (bypassa el driver). | Cualquiera | Instalar el cliente; soporta hasta Raspberry Pi/Chromebook. |

**Conclusión del benchmark:** los que soportan "cualquier impresora" (Fudo, Dutchie, QZ Tray, PrintNode) lo hacen **por el spooler del SO y/o por red 9100, a través de un agente o del driver de Windows** — NO por WebUSB como camino principal. Toast/Square logran "plug-and-play" a costa de **vender su propio hardware** (no es nuestro caso). Nadie tiene auto-descubrimiento mágico universal: Fudo te hace tipear la IP.

---

## 3. El abanico técnico y por qué WebUSB NO es el camino feliz

| Enfoque | ¿Anda con CUALQUIER impresora? | Windows | Tablet/iPad | Veredicto |
|---|---|---|---|---|
| **WebUSB** | No de fábrica | ❌ El driver de Windows "agarra" el dispositivo → hay que instalar **Zadig por impresora** (confirmado por Dutchie y CloudBridal). Solo Chrome/Edge. | Android Chrome sí; **iOS no** | **Fallback frágil**, no el camino principal |
| **Web Serial** | Parcial | El workaround (puerto COM virtual) es **inestable** (falla con Star) | iOS no | No confiable cross-marca |
| **Web Bluetooth** | Solo BT | Quisquilloso | iOS no (Safari) | Nicho |
| **Agente local → spooler del SO** | **✅ Sí** (cualquier impresora que Windows pueda instalar, con driver Genérico/Solo texto) | ✅ Sin Zadig | El agente corre en una PC; la tablet le pega por LAN (ver §6) | **GANADOR para USB** |
| **Red puerto 9100 (RAW ESC/POS)** | **✅ Sí** (cualquier térmica de red) | ✅ | ✅ (pero el browser no abre TCP solo → necesita el agente/un proceso en la LAN) | **GANADOR para multi-dispositivo** |
| **Cloud-print fabricante** (Star CloudPRNT, Epson ePOS) | ❌ Solo hardware de esa marca | — | ✅ | No universal (descartado para genéricas) |
| **Diálogo de impresión del navegador / PDF** | Funciona pero feo (corta mal, lento, pide confirmación, no abre cajón) | ✅ | ✅ | Último recurso, mala UX de POS |

**El "mínimo común denominador" que anda con TODAS las impresoras de un POS web es: un AGENTE LOCAL que sabe hablar (a) por el spooler del SO y (b) por red 9100.** El navegador solo, sin agente, **no puede** abrir USB crudo de forma confiable en Windows ni abrir un socket TCP a la impresora — siempre necesitás un proceso local que ponga los bytes en la impresora (esto es lo que son QZ Tray y PrintNode, y lo que es tu `print-server`).

---

## 4. Lo que YA tenés (y por qué es el camino correcto)

- `packages/print-server`: server Node (Express en `:9100`) que usa **`node-thermal-printer`** e imprime por **`printer:` (spooler del SO)** y **`tcp://` (red 9100)**. **Esto es arquitectónicamente lo mismo que hace QZ Tray / PrintNode / Fudo.** Es el camino correcto.
- `packages/print-agent`: wrapper **Electron** (tray + auto-start + auto-update) que empaqueta el print-server. **A medio terminar** (falta compilar/distribuir; bloqueado hoy por better-sqlite3 atado a Node 22 vs Node 24 de la PC).
- COMANDA `printerService.ts`: detecta `server` (agente) → si no, cae a `webusb` → si no, `none`. **Failover ya pensado.**
- WebUSB: lo dejé sin filtro de marcas (commit `f2fef50`), pero igual es el **fallback frágil**, no el principal.

**Brechas a cerrar** (no reinventar, terminar):
1. El agente no está compilado/instalable de forma simple (el blocker de Node 22).
2. La pantalla de Impresoras **solo muestra configurar/probar en modo `server`** — en WebUSB no hay UI (gap conocido).
3. El auto-detect USB del print-server usa `printer:auto`, que **no es un nombre real de impresora de Windows** → hay que apuntar al **nombre** que Windows le da (modelo Fudo: instalás la impresora en Windows, el agente la lista por nombre).
4. No hay auto-descubrimiento de impresoras de red (igual que Fudo: se tipea la IP — aceptable).

---

## 5. Recomendación de arquitectura (el plan ganador)

**Empujar el AGENTE como camino feliz, con DOS modos de conexión soportados, en este orden de prioridad para el contexto argentino (PC en el mostrador, impresora USB barata):**

### Camino feliz A — PC + impresora USB (el 80% de tus clientes)
1. El cliente instala la impresora en **Windows con el driver "Genérico / Solo texto"** (un solo paso, sirve para cualquier marca china — **el truco de Fudo, sin Zadig**).
2. Instala el **COMANDA Print Agent** (un click, arranca solo con Windows, vive en la bandeja).
3. En COMANDA → Impresoras: el agente aparece "conectado", la impresora se lista **por su nombre de Windows**, "Imprimir prueba". Listo.

### Camino feliz B — impresora de RED (multi-caja / a futuro tablets)
1. Impresora por Ethernet/WiFi, se lee su IP del autotest.
2. En COMANDA: agregar impresora → IP + puerto 9100. (El agente en cualquier PC de la LAN manda los bytes.)

### WebUSB = solo fallback declarado
Para el caso "no quiero instalar nada y tengo Chrome" — pero avisando que en Windows puede pedir Zadig. No es el camino que vendés.

### Por qué este orden
- USB-por-spooler **anda con cualquier impresora** sin Zadig (lo probado por Fudo).
- Red 9100 es el camino limpio para **tablets/multi-dispositivo** a futuro.
- El agente es **una sola pieza** que cubre los dos → mantenés un solo código de impresión.

---

## 6. Onboarding "a prueba de tontos" — el flujo objetivo

Patrón Shopify/Square (checklist, no wizard) + el truco brand-agnostic de Fudo:

1. **Detección automática**: al abrir Impresoras, si no hay agente → un solo botón grande **"Instalar impresión (1 click)"** que baja el agente firmado.
2. **El agente, al instalarse**, se auto-vincula al tenant (token embebido o pegar un código corto) y **auto-detecta impresoras** ya instaladas en Windows + escanea la LAN por puertos 9100 abiertos (best-effort).
3. **Auto-test**: el agente imprime un ticket de prueba apenas detecta una impresora, y COMANDA muestra "✅ Imprimiendo OK".
4. **Driver Genérico/Solo texto** documentado en 3 pasos con captura (para las USB que Windows no reconoce solo).
5. Para red: un campo IP + botón "Probar", nada más (como Fudo).

**Meta realista** (lo que promete Fudo, "90% operando en < 1 semana"): no es magia, es **(a) un instalador de un click + (b) el driver genérico documentado + (c) auto-test inmediato**. Eso es alcanzable.

---

## 7. Las dos espinas reales (honestas)

1. **Code signing (Windows SmartScreen).** Sin firmar, Windows muestra "protegió su PC" en el primer install. Desde jun-2023 Microsoft pide certificado **EV** (USD 200-400/año) para que NO moleste; los baratos (OV) ya no sirven. **Para el piloto**: documentar el "Más info → Ejecutar de todas formas" (1 vez). **Para escalar/vender**: comprar el cert EV. (Fuente: docs de Electron.)
2. **Tablets + web + impresora (a futuro).** Una tablet con la COMANDA en HTTPS **no puede** hablarle al agente por `http://IP-de-la-LAN` (el navegador bloquea "contenido mixto"; `localhost` está exento pero una IP de LAN no). Soluciones cuando llegue: agente con cert HTTPS local, o impresora de red + un proceso en la LAN, o app nativa para mozos. **No es para el piloto** — el piloto es PC en el mostrador (localhost, anda perfecto).

---

## 8. Plan priorizado

**Fase 1 — Desbloquear y terminar el agente (lo que destraba TODO):**
- Resolver el blocker better-sqlite3/Node 22 (correr el agente con Node 22, que el binario ya existe; o rebuild para Electron ABI).
- Compilar el instalador Windows (.exe) y distribuirlo (Supabase Storage, no Vercel) — o instalarlo local directo para el piloto.
- Arreglar el `printer:auto` → listar y elegir la impresora por **nombre de Windows**.

**Fase 2 — Onboarding:**
- Botón "Instalar impresión (1 click)" + auto-vinculación por token.
- Auto-detección de impresoras Windows + auto-test al conectar.
- Doc de 3 pasos del driver "Genérico / Solo texto".

**Fase 3 — Pulido / escala:**
- Auto-escaneo de la LAN para impresoras 9100 (best-effort).
- Certificado EV cuando haya volumen.
- (Futuro) camino de tablets.

**WebUSB**: queda como fallback, ya con el filtro arreglado. No invertir más ahí.

---

## 9. Fuentes (calidad)

- Fudo — instalación impresoras USB (primaria): driver Genérico/Solo texto, sin agente. `soporte.fu.do/es/instalación-de-impresoras-de-comandas-usb`
- Fudo — impresoras Ethernet (primaria): IP manual + 9100, sin auto-discovery. `soporte.fu.do/es/articles/11732086`
- Dutchie POS (primaria): WebUSB requiere Zadig por impresora en Windows; recomienda PrintNode. `support.dutchie.com/.../29384799104531`
- NielsLeenheer/WebUSBReceiptPrinter (primaria): en Windows el driver reclama el device y bloquea WebUSB; workaround WebSerial inestable. `github.com/NielsLeenheer/WebUSBReceiptPrinter`
- QZ Tray (primaria): agente local para RAW ESC/POS desde el browser. `qz.io/docs/what-is-raw-printing`
- PrintNode (primaria): agente local + cloud, RAW printing. `printnode.com/en/docs/introduction`
- Star CloudPRNT (primaria): solo hardware Star, polling HTTP. `starmicronics.com/cloudprnt-...`
- Toast M30 (primaria): hardware propietario, setup guiado 3-5 min. `support.toasttab.com/.../Setting-Up-Your-M30-Wireless-Printer`
- Electron code signing (primaria): EV cert requerido desde jun-2023. `electronjs.org/docs/latest/tutorial/code-signing`
- CloudBridal (secundaria), mike42.me (blog), testmuai/sabatino (blogs) — corroboran WebUSB/Zadig y "el browser no abre USB/TCP crudo".
