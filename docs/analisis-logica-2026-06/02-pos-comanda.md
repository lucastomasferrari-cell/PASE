# Análisis de lógica — POS COMANDA (2026-06-11)

**Qué es esto:** auditoría de ARQUITECTURA DE PRODUCTO del POS. No es una lista de bugs ni de funciones — es una evaluación de las decisiones de diseño: ¿la lógica aguanta el crecimiento? ¿un empleado nuevo la entiende el día 1? ¿sirve para cualquier gastronómico o solo para uno tipo?

**Fuentes:** código real de `packages/comanda/src` (pantallas POS, services, cola offline), migraciones SQL de `packages/pase/supabase/migrations`, `DEUDA_TECNICA.md`, y el spec de rediseño del 28-may.

---

## 1. Cómo funciona hoy (el flujo real)

### El día de un cajero/mozo

1. **Login + PIN**: el empleado entra con su perfil POS (`comanda_usuarios`, separado de los usuarios de PASE) y un PIN de 4 dígitos. Auto-lock configurable.
2. **Abrir caja**: un turno por local. Declara monto inicial de efectivo. **Sin turno abierto NO se puede cobrar nada** (la RPC corta con `NO_HAY_TURNO_ABIERTO`) — decisión correcta: la plata nunca queda flotando sin arqueo.
3. **Salón**: plano de mesas con posiciones libres (o grid automático), colores por tiempo de ocupación (verde <20min → rojo pulsante >60min, calcado de Toast), resumen arriba (ocupadas, cubiertos, tiempo promedio, % ocupación). Tap en mesa libre → dialog de cantidad de personas → abre la venta.
4. **Comandar**: pantalla de venta con catálogo a la izquierda (grupos, favoritos por empleado, búsqueda con Enter = agregar el primero) y el ticket a la derecha agrupado por **cursos** (entrada/principal/postre). Cada ítem puede tener modificadores (dialog automático si el ítem los tiene), notas, "stay" (retener aunque se mande el curso), o mandarse individual. "Mandar curso" → los ítems pasan a la cocina.
5. **Cocina (KDS)**: pantalla por estación (caliente/fría/barra/postres) con token por QR (sin login), timer con semáforo de urgencia, "Listo" por ítem o "Todo" por venta, "Deshacer" con ventana de 60 segundos. Polling de 30s + Realtime. En paralelo, impresión térmica por estación (ESC/POS) con idempotencia para no duplicar tickets.
6. **Cobrar**: dialog multi-pago — métodos configurables por local, monto autocompletado con lo que falta, atajos de billetes AR ($1000/$2000/$5000/...) con vuelto calculado, cuotas para crédito, split de pagos. Cuando la suma cubre el total, la venta se marca cobrada y la mesa se libera sola. Después del cobro se ofrece emitir factura AFIP (si el tenant tiene credenciales).
7. **Dividir cuenta**: dos mecanismos distintos y bien separados conceptualmente:
   - **Partir cuenta** (`SplitCheckDialog`): mueve ítems a una venta hermana nueva. Requiere autorización de manager. Solo en 2 (no en 3+).
   - **Dividir por comensal** (`ComensalSplitDialog`): order-by-seat — asigna ítems a personas y cobra a cada una con pagos parciales sobre la MISMA venta. Sin manager.
8. **Acciones sensibles** (anular venta/ítem, cortesía, cambiar precio, transferir mesa, unir mesas, reabrir): siempre con **Manager Override** — PIN de un manager + motivo de mínimo 10 caracteres + IP, todo queda en historial auditable visible desde la venta.
9. **Cerrar caja**: arqueo con dos modos (monto rápido o por denominaciones de billetes), semáforo de diferencia, notas. Soporta venta anulada y retiros/depósitos/ajustes con umbral de override ($5.000 hardcodeado).

### Los otros modos de venta

- **Mostrador**: órdenes rápidas sin mesa + "Abrir tab" con nombre (modo barra: el cliente consume y paga al final). Filtros y orden cuando hay >3 órdenes.
- **Pedidos** (`PedidosHub`): feed estilo Toast con 5 tabs (por aprobar / programados / en cocina / listos / completados) para tienda online, menú QR, Rappi, PedidosYa. Notifica al partner externo en cada cambio de estado (aceptar/despachar/cancelar).
- **Handheld** (modo mozo): vista mobile-first de 2 pantallas (elegir mesa → cargar y mandar). A propósito NO cobra — el cobro se hace en el POS principal. Bloqueada en pantallas grandes.

### Offline-first (la parte invisible)

Cada operación crítica escribe **primero en IndexedDB local** y encola una operación pendiente. Un motor de sync (`syncEngine`) empuja la cola al servidor: FIFO estricto, dependencias padre-hijo (no se puede agregar un ítem antes de que exista la venta), backoff exponencial, reintentos con tope, detección de errores permanentes, reconciliación de IDs temporales negativos → IDs reales del server, y limpieza de operaciones zombies al arrancar. En el server, cada RPC crítica tiene un "wrapper" `_offline` que resuelve la venta por UUID de idempotencia cuando todavía no tiene ID real.

---

## 2. Veredicto por área

### ✅ Flujo de venta core (abrir → comandar → cocina → cobrar)

Es el área más fuerte del producto. El conteo de taps está al nivel de un POS comercial (ver sección 3), los defaults son inteligentes (monto autocompletado, "Exacto" preseleccionado, primer método de cobro default, covers = capacidad de la mesa), y los detalles de velocidad existen (favoritos por empleado, búsqueda + Enter, repetir ítem, atajos de billete). Un cajero nuevo entiende la pantalla de venta el día 1: catálogo a la izquierda, ticket a la derecha, dos botones grandes (Mandar / Cobrar). El coursing con hold/stay/mandar-individual es más fino que lo que ofrece Square.

### ✅ Modelo de venta multi-modo (NO es mesa-céntrico)

`ventas_pos` tiene `modo` ('salon' | 'mostrador' | 'delivery' | 'retiro'), `origen`, `tipo_entrega`, `canal_id`, `programada_para`, datos de cliente y tab con nombre. La mesa es **opcional** — el modelo nació genérico, no es un POS de mesas con parches. Esto cubre bien los 5 arquetipos: café de barrio (mostrador + tabs), parrilla (salón + cursos), fast food (mostrador), dark kitchen (PedidosHub + partners), fine dining (cursos + stay + coursing). Es una decisión estructural correcta que va a pagar dividendos.

### ⚠️ Coursing para fine dining — a medias

Los cursos existen en el ticket y el mozo controla cuándo manda cada uno (manual). Pero **el "coursing automático" no está cerrado**: el flag `coursing_auto` existe en la venta, y el KDS NO retiene el curso 2 hasta que el curso 1 esté listo — todo lo que se manda aparece ya en cocina. El spec del 28-may define el comportamiento correcto (`fn_kds_avanzar_curso`: curso N+1 invisible hasta que curso N esté todo bumpeado) pero está diferido. Para un fine dining real, hoy el mozo tiene que acordarse de mandar los cursos a mano en el momento justo — funciona, pero es el humano haciendo el trabajo del sistema.

### ⚠️ Turnos de caja: lógica sólida con tres grietas conocidas

**Lo bueno:** el invariante central está bien elegido — *ninguna plata se mueve sin turno abierto*. Si la venta no tiene turno asignado, el cobro la asigna al turno abierto actual; si no hay, aborta. Ventas que cruzan turnos quedan bien: el movimiento de caja cae en el turno donde efectivamente se cobró (que es lo que el arqueo necesita). Idempotencia en abrir/cerrar/movimientos.

**Las grietas:**
1. **Anulación post-cierre no compensa caja.** Si se anula una venta cobrada cuando el turno ya cerró, el trigger de reverso emite un aviso interno y NO genera el movimiento compensatorio → la plata queda "fantasma" hasta ajuste manual. Está documentado como deuda desde Sprint 8 (solución propuesta: tabla `reversos_pendientes` que se procesa al abrir el próximo turno) y confirmado como bug real en el ensayo general del 09-jun. **Es la grieta de plata más importante del POS hoy.**
2. **Un solo turno por local.** El modelo asume una caja física. Dos cajas en paralelo (mostrador + barra, o un local grande) no se pueden modelar — y todos los reportes/arqueos históricos van a quedar atados a este supuesto. Documentado como deuda desde Sprint 4.
3. **El cierre no es "ciego".** `CajaCerrar` muestra el "esperado en efectivo" ANTES de que el cajero cuente, y peor: **autocompleta el campo declarado con el monto calculado**. El cajero puede confirmar sin contar y la diferencia da siempre $0. El estándar (Toast, Square, cualquier POS serio) es blind close: contás primero, el sistema te muestra la diferencia después. Tal como está, el arqueo pierde su función anti-fraude y anti-error.

### 🔴 Offline-first: el motor es bueno, la arquitectura de los wrappers es frágil

**El motor cliente (cola en IndexedDB) está bien diseñado**: FIFO, depends_on, backoff, idempotencia por operación, reconciliación de IDs, higiene de zombies, errores permanentes que no queman reintentos. Eso es nivel profesional.

**El problema es estructural y está en el borde cliente↔servidor:**

1. **9 wrappers `_offline` duplicados a mano.** Cada RPC crítica tiene una copia con sufijo `_offline` que repite la firma + resuelve UUIDs. La historia lo condena: 7 de los 9 estuvieron **rotos en silencio desde el 16-may hasta el 11-jun** (~4 semanas) — llamaban funciones internas que no existían, uno pasaba los argumentos de unir mesas AL REVÉS (hubiera unido las mesas al revés), y todos eran ejecutables por `anon`. Nadie lo notó porque el camino online enmascaraba el roto: el wrapper solo se ejercita cuando una op pasa por la cola. **Dos contratos paralelos que solo se prueban en condiciones distintas = van a divergir de nuevo.**
2. **El ruteo es una heurística mágica.** `pushQueue` decide si llamar a la versión `_offline` mirando si el payload contiene alguna clave con el texto `idempotency_uuid`. Eso ya causó un bug (06-jun) y es el tipo de acoplamiento implícito que se rompe con cualquier refactor.
3. **Dual-path en cada service.** Cada función de `ventasService`/`pagosService` tiene un `if (featureFlags.offlineFirstVentas) { camino A } else { camino B }`. Son dos POS conviviendo: el flag se prendió y apagó 4 veces entre mayo y junio. Cada feature nueva tiene que implementarse dos veces o queda online-only en silencio.
4. **La cobertura offline es parcial y nadie lo sabe mirando la UI.** Concretamente:
   - El **cobro real del POS no es offline**: `PaymentDialog` y `ComensalSplitDialog` usan `agregarPago` → RPC online directa, sin rama offline. La función `cobrar()` offline-aware existe pero **ningún dialog la usa**. Si se corta internet en el momento de cobrar una mesa, falla.
   - `modificarItem`, `mandarItemIndividual`, `toggleStay`, `updateVentaMeta`, `reabrirVenta` → online-only.
   - Abrir una **tab con nombre** en modo offline pierde el nombre (la rama offline no transporta `clienteNombre` y el `updateVentaMeta` posterior es un UPDATE online sobre un ID negativo que no existe en el server).
   - El precio offline sale de `precio_madre` del cache — **ignora la lista de precios por canal**: una venta delivery cargada offline usaría precio de salón.

**Forma estructuralmente mejor** (sin tirar lo construido): (a) matar los 9 wrappers haciendo que las RPCs canónicas acepten `p_idempotency_uuid` opcional — un solo contrato, el camino online y el offline ejercitan el MISMO código server; (b) eliminar el if/else por service: **todo pasa siempre por la cola** y cuando hay internet el push es inmediato (online = offline con latencia cero) — es lo que hacen Square y Toast; el flag deja de existir como bifurcación de lógica; (c) el test de contrato de wrappers (#43, ya creado el 11-jun) se vuelve innecesario porque no hay segundo contrato que verificar.

### ⚠️ Permisos y Manager Override: buen diseño, fricción puntual

El modelo de dos capas es correcto: `rol_pos` (mozo/cajero/manager/admin) con permisos en tabla `rol_pos_permisos` (DB, cacheada 1h) + Manager Override por PIN para acciones sensibles. El override es **presencial** (el manager camina hasta la terminal y pone su PIN) — eso es lo estándar y funciona. Fricciones reales:

- **Motivo obligatorio de 10 caracteres mínimo en TODO override**, incluso una cortesía de un café. En hora pico eso es teclear texto con guantes de parrilla. Toast pide motivo de un picker (lista de motivos comunes + "otro"); acá habría que tipear siempre. Es la fricción #1 del flujo de excepciones.
- **Partir cuenta requiere manager.** Dividir la cuenta en dos es una operación cotidiana e inocua (no destruye plata, la reacomoda) — exigir manager ahí es más estricto que el estándar y va a generar colas de "llamá al encargado". Dividir por comensal, que es funcionalmente parecido, NO lo requiere — la asimetría confunde.
- **Manager remoto no existe** (el spec lo diseña con push notification). Para un dueño multi-local que no está en el salón, hoy no hay forma de autorizar a distancia.
- El cache de permisos de 1h significa que sacarle un permiso a alguien tarda hasta 1h en reflejarse en la UI (RLS server-side lo corta antes, así que es cosmético, no seguridad).

### ⚠️ Catálogo PASE→COMANDA: acople razonable, con dos topes concretos

El acople es por **DB compartida** (mismo Postgres, mismas tablas `items`/`item_grupos`), no por API — eso es limpio y simple, y la directiva "todo el catálogo en PASE, COMANDA consume" es la correcta. Cache en 3 capas: sessionStorage 60s (navegación), IndexedDB (offline), Realtime para 86/agotado en el flujo de venta. Pero:

1. **`listItems` tiene `LIMIT 200` hardcodeado.** Una carta grande (parrilla con vinos, fine dining) supera 200 SKUs y los ítems 201+ **desaparecen del POS sin error**. Es un tope silencioso, de los peores.
2. **VentaScreen recarga el catálogo completo al entrar a CADA venta** (~150-250KB por mesa abierta). Con 60 mesas/día y 3-4 entradas por mesa son cientos de descargas del mismo catálogo. El patrón correcto (cache compartido en memoria/IndexedDB con invalidación por Realtime — exactamente lo que el spec 2.2 describe) está diseñado pero no implementado.
3. La consulta de "qué ítems tienen modificadores" es otra query por montaje de pantalla — mismo problema, mismo fix.

### ✅ KDS

Simple y correcto para el 90% de los casos: token por estación (la tablet de cocina no necesita login — buena decisión), timers con semáforo, "Todo listo", deshacer con ventana, auto-ocultar entregados, sonido opcional. Los pendientes (coursing automático, tokens sin rate-limit) ya están identificados. El polling de 30s como backup de Realtime es razonable.

---

## 3. Conteo de taps — las 5 operaciones más frecuentes

Conteo sobre el código real (taps de pantalla; tipeo cuenta aparte). "Ideal" = lo que logra Toast/Square en el mismo flujo.

| # | Operación | Taps hoy | Ideal | Dónde se pierde |
|---|---|---|---|---|
| 1 | **Abrir mesa + comandar 3 ítems + mandar** | 1 (mesa) + 0-2 (covers) + 1 (abrir) + 3 (ítems) + 1 (mandar) = **6-8** | 5-6 | El dialog de covers es obligatorio siempre. Toast lo hace opcional/configurable. Para café de barrio es un paso muerto en cada mesa. |
| 2 | **Agregar ítems a mesa abierta** | 1 (mesa) + N (ítems) + 1 (mandar) = **N+2** | N+2 | ✅ Sin desperdicio. El feedback visual de "agregado" y el repetir-ítem están bien. |
| 3 | **Cobro simple en efectivo exacto** | 1 (Cobrar) + 1 (Cobrar $X — monto y método ya autocompletados) + 1 (cerrar dialog factura) = **3** | 2 | El dialog AFIP post-cobro agrega 1 tap a CADA venta aunque el 95% no facture con CUIT. Con 200 ventas/día = 200 taps muertos. Debería ser opt-in ("Facturar" como botón secundario) o auto-skip si consumidor final. |
| 4 | **Cobro con tarjeta en cuotas** | 1 (Cobrar) + 1 (método) + 1 (cuotas) + 1 (confirmar) + 1 (cerrar factura) = **5** | 4 | Mismo tap muerto del dialog de factura. El resto está bien. |
| 5 | **Anular un ítem ya enviado** | 1 (menú del ítem) + 1 (anular) + tipear motivo ≥10 chars + 4 (PIN) + 1 (autorizar) = **7 taps + texto libre** | 7 taps + 1 tap de motivo | La fricción del PIN es intencional y correcta. El texto libre obligatorio NO: un picker de motivos comunes ("se cayó", "cliente cambió", "error de carga") + opción "otro" baja 10-15 segundos por anulación. |

**Bonus — KDS marcar venta lista:** 1 tap ("Todo"). ✅ Imbatible.

**Conclusión de taps:** el core está a nivel comercial. Los dos ahorros grandes y baratos son (a) hacer skippeable/configurable el dialog de covers, y (b) hacer opt-in el dialog de factura post-cobro. Los dos juntos ahorran ~1-3 taps por venta, que a escala de un servicio son minutos reales.

---

## 4. Decisiones a cambiar AHORA (después van a ser caras)

En orden de urgencia:

1. **Unificar el contrato offline/online en el server.** Eliminar los 9 wrappers `_offline` haciendo que las RPCs canónicas acepten `p_idempotency_uuid` opcional. Mientras existan dos contratos, van a volver a divergir — ya pasó 4 semanas sin que nadie lo note. Cada RPC nueva que se agregue al POS multiplica el problema. **Costo hoy: una migración + ajustar `pushQueue`. Costo en 6 meses: re-romper producción con clientes reales.**

2. **Un solo camino de escritura (matar el dual-path del feature flag).** Todo pasa por la cola siempre; online = flush inmediato. Esto además arregla de raíz el hueco más grave del momento: **el cobro (PaymentDialog) hoy es online-only** — el POS "offline-first" no puede cobrar sin internet, que es exactamente el momento donde offline importa.

3. **Modelar turno por caja (no por local) antes del piloto.** Es un cambio de una FK + UI hoy; cuando haya meses de arqueos históricos colgando de `turnos_caja` con el supuesto "1 por local", migrar va a ser cirugía. Cualquier local con barra + mostrador lo va a pedir en el primer mes.

4. **Cierre de caja ciego.** Sacar el "esperado" y el autocompletado del declarado de `CajaCerrar` (o al menos hacerlo configurable con default ciego). Es un cambio de UI de una tarde y es la diferencia entre un arqueo que detecta faltantes y uno decorativo. Hacerlo antes del piloto: cambiar el hábito de los cajeros después es mucho más difícil.

5. **Reversos pendientes para anulaciones post-cierre.** La tabla `reversos_pendientes` que el propio backlog propone. Es EL bug de plata conocido; con un solo local de prueba se maneja a mano, con clientes pagos no.

6. **Subir/eliminar el LIMIT 200 del catálogo** y mover el catálogo de VentaScreen a un cache compartido con invalidación Realtime (el diseño ya está escrito en el spec 2.2). Hacerlo antes de onboardear un cliente con carta grande — el síntoma ("me faltan platos en el POS") es desconcertante de diagnosticar.

7. **Precio por canal en el camino offline.** Hoy `agregarItemOffline` usa `precio_madre` siempre. Si el negocio usa lista de precios por canal (delivery más caro), cada venta offline cobra mal — y cobrar mal es el peor bug posible en un POS. Arreglarlo cuando hay poca data offline es trivial; después implica reconciliar ventas históricas mal cobradas.

8. *(Menor pero barato)* **Picker de motivos en Manager Override** y **sacar el manager de "partir cuenta"** (o hacerlo permiso configurable). Bajan la fricción operativa diaria sin tocar el modelo de auditoría.

---

## 5. Comparación con el estándar (Toast / Square)

| Área | COMANDA hoy | Toast / Square | Veredicto |
|---|---|---|---|
| Velocidad de cobro | 3-5 taps, defaults inteligentes, atajos de billete | 2-4 taps | ✅ A la par (sacando el dialog AFIP) |
| Plano de salón | Posiciones libres + colores por tiempo + resumen | Igual + reservas integradas | ✅ A la par (MESA va a cubrir reservas) |
| Coursing | Manual con hold/stay (más fino que Square) | Toast: coursing automático en KDS | ⚠️ Falta el auto (spec ya escrito) |
| Multi-canal (mostrador/delivery/partners) | Modelo nativo, hub de pedidos, notificación a partners | Igual | ✅ A la par |
| Turnos/arqueo | 1 turno por local, cierre NO ciego, anulación post-cierre sin reverso | Multi-drawer, blind close, ajustes automáticos | 🔴 Acá está el gap más grande |
| Offline | Cola local sólida, pero cobro online-only y doble contrato server | Square/Toast: TODO offline incluyendo cobro, un solo camino | 🔴 Gap estructural, arreglable |
| Manager override | PIN + motivo + auditoría completa con historial por venta | Igual + motivos en picker + aprobación remota | ✅ Modelo correcto, fricción de texto libre |
| Permisos | Roles POS + tabla de permisos en DB | Igual | ✅ |
| KDS | Token sin login, timers, bump, recall | Igual + coursing auto + tiempos meta por ítem | ⚠️ Cubre el 90% |
| Fiscal | AFIP integrado (CAE + QR) post-cobro | (N/A — ventaja local) | ✅ Diferencial AR, pero hacerlo opt-in por venta |

**Síntesis:** la lógica de VENTA de COMANDA ya juega en la liga de los POS comerciales y el modelo de datos es genérico de verdad (no mesa-céntrico). Los dos sistemas que están un escalón abajo del estándar son **la caja** (cierre no ciego, un turno por local, anulaciones post-cierre) y **el borde offline↔server** (doble contrato que ya falló en silencio una vez). Los dos son arreglables con semanas, no meses — pero solo si se hacen ANTES de acumular historia de datos y hábitos de usuarios.
