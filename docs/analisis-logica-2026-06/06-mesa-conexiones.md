# Análisis de lógica — MESA + conexión entre los 3 sistemas (2026-06-11)

**Qué es esto:** auditoría de ARQUITECTURA DE PRODUCTO. No es una lista de bugs — es una evaluación de las decisiones de diseño: ¿la forma en que PASE, COMANDA y MESA se conectan tiene topes futuros? ¿la lógica de reservas diseñada es correcta y vendible?

**Fuentes:** spec `docs/superpowers/specs/2026-06-08-mesa-reservas-design.md` + spec módulo #4 (09-jun), migraciones reales (`202605172100`/`202605203600` reservas, `202606100400` módulo #1, `202606100600` eventos/giftcards, `202606100700` perfil público, `202605051800` mesas), `reservasService.ts`, `SalonView.tsx`, `ReservasAdmin.tsx`, `CONTEXTO.md`, `DEUDA_TECNICA.md`.

---

## 1. Cómo funciona / se diseñó hoy

### La conexión entre los 3 productos

Los 3 productos son **3 frontends separados sobre UNA sola base de datos Postgres (Supabase)**:

- **Deploys independientes**: PASE, COMANDA y (futuro) MESA son apps Vercel separadas. Un deploy roto de COMANDA no tira PASE abajo.
- **Datos compartidos**: misma DB, mismas tablas, aislamiento por `tenant_id` + RLS. El catálogo vive en PASE y COMANDA lo lee directo (con Realtime para refrescar). MESA leería las mesas y tickets de COMANDA directo, sin "integración".
- **Lógica compartida**: casi toda mutación pasa por RPCs Postgres atómicas que viven en la DB — o sea, **el "backend" es uno solo para los 3 productos**.
- **Identidad compartida**: mismo Supabase Auth; COMANDA tiene sus usuarios (`comanda_usuarios`) pero el login es el mismo sistema. Hay una tabla `clientes` unificada por tenant (clave lógica: teléfono).

### El estado real de MESA (más avanzado que el spec)

El spec dice "7 módulos, módulo #1 primero". En el código ya hay MÁS que eso:

| Pieza | Estado real |
|---|---|
| Tabla `reservas` v2 (202605203600) | ✅ en prod — `fecha_hora`, `personas`, estados, `mesa_id`, `cliente_id`, idempotency |
| Módulo #1 (máquina de estados + agenda + alta manual) | ✅ implementado (202606100400 + `ReservasAdmin.tsx` + mutante) |
| Reserva pública + check de disponibilidad v1 | ✅ (`fn_crear_reserva_publica`, `fn_check_disponibilidad_reserva`) |
| Módulo #4 backend (eventos con prepago MP + giftcards) | ✅ (202606100600) |
| Perfil público del local + "¿hay mesa ahora?" v1 | ✅ (202606100700) |
| Recordatorio de reservas (cron push 1h antes) | ✅ (202606021500) |
| Floor plan + motor de disponibilidad EN VIVO (módulo #2) | ❌ no existe — la feature estrella todavía es diseño |
| Waitlist, CRM 360°, notificaciones al cliente, analytics | ❌ no existen |

### Cómo calcula disponibilidad HOY (v1)

`fn_check_disponibilidad_reserva` suma las **personas** de reservas pendientes+confirmadas en una ventana de ± duración (config del local, default 90 min) y compara contra `reservas_capacidad_max` (un número fijo configurado, default 50). **No mira mesas, no mira tickets de COMANDA.** Es un cupo global de cubiertos por franja — el modelo de un Google Form con validación, no el de OpenTable.

### La máquina de estados implementada (módulo #1)

```
pendiente  → confirmada | cumplida (walk-in) | cancelada
confirmada → cumplida | no_show | cancelada
cumplida / no_show / cancelada → TERMINALES
```

"Sentar" = pasar a `cumplida` (con mesa opcional). Importante: **`cumplida` es terminal y ocurre al sentar al cliente** — la reserva "termina" justo cuando el cliente empieza a ocupar la mesa.

---

## 2. Veredicto por pregunta

### 2.1 ✅ Una sola DB multi-tenant para los 3 productos — es el diferencial correcto, con 2 cuidados

**Veredicto: ✅ la decisión es correcta y es exactamente lo que hacen los ganadores.**

- **Toast** es UNA plataforma: POS + reservas (Toast Tables) + back-office sobre un solo modelo de datos. Es su pitch principal contra OpenTable.
- **Square** son apps sobre una plataforma común con UN directorio de clientes compartido (Square Customer Directory) — exactamente el patrón de tu tabla `clientes`.
- **SevenRooms/OpenTable** gastan fortunas en integraciones POS porque NO son dueños del POS. Tu spec lo identifica bien: el foso de MESA es no necesitar esa integración.

Separar MESA en su propia DB con APIs entre sistemas sería **peor**: matarías el diferencial (datos en vivo), sumarías latencia, duplicarías clientes/mesas/locales, y a tu escala (decenas-cientos de tenants chicos) un Postgres aguanta sobrado. El tope de escala real de un Postgres multi-tenant bien indexado está MUY lejos de un negocio de POS gastronómico argentino (miles de tenants). Cuando llegue, las palancas estándar existen (read replicas, particionado por tenant) sin cambiar la arquitectura.

**Los 2 cuidados reales (ya demostrados en tu propia historia):**

1. **El blast radius no es el deploy, es la DB.** Los deploys ya están separados (bien). Pero una migración SQL mala de un producto rompe a los otros — ya pasó: los triggers de history sin DEFINER (sprint COMANDA) rompieron el editor de plano de mesas; los wrappers `_offline` rotos vivieron 26 días en prod. Con MESA serán 3 productos escribiendo migraciones sobre la misma DB **sin staging y con push directo a main**. El riesgo no es la arquitectura — es el proceso. La suite e2e-full + el patrón BEGIN→test→COMMIT mitigan, pero a medida que se sume el tercer producto conviene tratar "migración que toca tablas de otro producto" como operación con confirmación explícita.
2. **La superficie `anon` crece con cada módulo público de MESA** (reserva pública, eventos, giftcards, perfil). Ya aprendiste la regla (`REVOKE ... FROM PUBLIC, anon` siempre, 11-jun). MESA va a ser EL producto con más RPCs anónimas del ecosistema — esa disciplina + rate limiting/anti-spam antes de publicitar la página pública es condición de salida.

### 2.2 ⚠️ La fórmula de disponibilidad en vivo es conceptualmente correcta, pero le faltan piezas que la rompen

La fórmula del spec (capacidad − tickets abiertos − reservas próximas) es la idea correcta y es real que nadie más la puede hacer nativa. **Pero tal como está el modelo hoy, estos edge cases la rompen:**

| Edge case | Qué pasa hoy | Gravedad |
|---|---|---|
| **Ticket abierto olvidado** | Mesa queda `ocupada` para siempre → el motor diría "lleno" estando vacío. Ya pasó en prod: un POS colgado 9 días. Una mesa zombie y el widget público miente toda la noche. | 🔴 |
| **Reserva sentada "desaparece"** | Al sentar, la reserva pasa a `cumplida` (terminal) y deja de contar en el cálculo. Si el ticket de COMANDA no se abrió todavía (el mozo tarda 10 min en cargar), esos cubiertos **no figuran en ningún lado** → sobreventa. | 🔴 |
| **Walk-in sin ticket** | El host sienta gente y el pedido se carga después → mismo agujero: ocupación invisible durante minutos. | 🟠 |
| **Mesas unidas** | `fn_unir_mesas_comanda` libera la mesa origen → el motor la ve "libre" aunque físicamente está pegada a otra ocupada. | 🟠 |
| **Turnos largos** | No hay duración por reserva (la tabla v2 la perdió; usa la duración global del local). Una mesa de 8 que se queda 3 horas rompe el cálculo de "se libera a las 23:00". | 🟠 |
| **No-show que nunca se marca** | No hay auto-liberación: una reserva confirmada de las 21:00 que no vino sigue bloqueando cupo hasta que un humano la marque. Sin cron de auto-no-show, la capacidad se "pierde" silenciosamente. | 🟠 |
| **Mezcla de unidades** | La fórmula del spec mezcla MESAS (tickets abiertos) con CUBIERTOS (reservas). Hay que elegir una unidad (cubiertos, con mapeo mesa→capacidad) o el resultado no cierra. | 🟠 |
| **Tickets sin mesa** | Mostrador/delivery/retiro tienen ticket abierto pero no ocupan salón — el motor debe filtrarlos por `modo='salon'` (el dato existe, solo hay que usarlo). | 🟡 |

**Veredicto: ⚠️ la lógica diseñada es la correcta como visión, pero el motor en vivo NO se puede construir encima del modelo de estados actual sin los cambios de la sección 3.** El v1 por cupo de cubiertos que ya está en prod es un puente razonable y honesto mientras tanto.

### 2.3 ⚠️ El modelo de mesa de COMANDA sirve como base FÍSICA, pero reservas necesita su propia capa de INVENTARIO

`mesas` (numero, zona, capacidad, posición, forma, estado libre/ocupada/hold/inactiva) es un buen plano físico del salón. Lo que es: **el estado operativo del POS en este instante**. Lo que NO es: un calendario de disponibilidad.

Cómo lo modelan los referentes:

- **OpenTable/SevenRooms** separan tres conceptos: (a) la mesa física, (b) los **shifts** (turnos de servicio: almuerzo/cena, con horarios por día), y (c) el **inventario reservable**: slots de 15 min con **pacing** (máximo de cubiertos nuevos por slot, para no reventar la cocina), duración estimada **por tamaño de grupo** (2 personas = 90 min, 6 personas = 150 min), y **combinaciones de mesas** como unidades reservables (mesa 4 + mesa 5 = "combo 8 personas").
- **Toast Tables** hace lo mismo apoyado en el plano del POS — que es exactamente tu posición de ventaja.

Hoy tenés: `reservas_horarios` JSONB (franjas por día — un proto-shift, bien) y un cupo global. **No tenés**: pacing, duración por tamaño de grupo, combos, ni matcheo grupo→mesa. Además `mesas.capacidad` es **nullable** — el día que el motor quiera derivar capacidad real del salón, no puede.

**Veredicto: ⚠️ no hay que tirar nada — `mesas` queda como la verdad física y el estado del POS. Pero el módulo #2 debe crear su propia capa (turnos de servicio + slots/pacing + combos) que REFERENCIA a `mesas`, no sobrecargar `mesas.estado` con semántica de reservas.** Meter "reservada" como estado de mesa sería el error clásico: mezclaría el ciclo de vida operativo del POS con el calendario.

Dato operativo ya visible: `SalonView.tsx` (el plano que usa el host/mozo) **no sabe que existen reservas** — nada le avisa al mozo que la mesa 7 que está por abrir como walk-in tiene reserva en 20 minutos. Ese es el primer punto de contacto real entre los dos mundos y hoy no existe.

### 2.4 ⚠️ La identidad del cliente: el modelo unificado EXISTE, pero las reservas no lo usan — y el CRM 360° depende de eso

Lo bueno: hay UNA tabla `clientes` por tenant (teléfono como clave lógica), con FK desde `ventas_pos.cliente_id`. Es el patrón Square Customer Directory — la decisión estructural correcta ya está tomada.

Lo que está cortado hoy (verificado en código):

1. **`reservas.cliente_id` existe pero NUNCA se llena.** `fn_crear_reserva_publica` hace el upsert del cliente… y descarta el ID sin guardarlo en la reserva. `fn_crear_reserva` (alta manual del staff, módulo #1) ni siquiera intenta el upsert — guarda nombre/teléfono como texto suelto.
2. **No existe el vínculo reserva → venta.** Cuando el host sienta la reserva (con mesa), nada conecta la reserva con el ticket que se abre en esa mesa. Sin ese join, "qué consumió el que reservó" solo se puede reconstruir con heurísticas frágiles (misma mesa + ventana horaria).
3. **Las métricas del CRM (`total_gastado`, `total_pedidos`, `ultimo_pedido_at`) son columnas que dice "las llena un job futuro"** — el job no existe.
4. **El teléfono no se normaliza** (con/sin +54, con/sin 9, espacios) → el mismo cliente se va a duplicar entre la tienda, la reserva y el mozo que lo carga a mano.

**Veredicto sobre el pitch del CRM 360°: ⚠️ es alcanzable y el diferencial es real, pero NO se llena solo "porque comparten DB".** Se llena si y solo si existen los dos eslabones: reserva→cliente y reserva→venta. Además, una verdad incómoda que conviene asumir en el diseño: en servicio de mesa, la mayoría de las ventas de COMANDA no van a tener teléfono del cliente — **la reserva es justamente EL momento donde conseguís la identidad**. Por eso el eslabón reserva→venta no es un detalle: es el corazón del módulo #5.

### 2.5 ✅/⚠️ Flujos de datos existentes: catálogo→POS limpio; ventas→back-office es el agujero

- **Catálogo (PASE → COMANDA): ✅ limpio.** Una sola fuente (directiva ya fijada: todo el catálogo en PASE, COMANDA consume), lectura directa + Realtime para refrescar + cache offline. ¿Falta versionado de catálogo/eventos? Para el tamaño actual, no — el patrón "recargar al cambiar" es suficiente y el precio queda capturado en la línea de venta al vender. Un event-log de catálogo sería sobre-ingeniería hoy.
- **Ventas (COMANDA → PASE): ⚠️ NO conectado.** Verificado: el frontend de PASE no lee `ventas_pos` en ningún lado; el EERR sigue alimentándose de totales diarios cargados a mano / Maxirest. Es deuda conocida ("Pendientes integración COMANDA-PASE") pero con MESA pasa a ser deuda de PITCH: el discurso de venta es "reserva + comanda + contabilidad son una sola cosa" y hoy el tercer eslabón está abierto. Para MESA en sí no bloquea (el CRM lee `ventas_pos` directo, no `ventas`), pero conviene cerrarlo antes de salir a vender la historia completa.
- **Patrón que sí falta a futuro (no urgente): eventos de dominio para reservas.** El módulo #6 (notificaciones WhatsApp/SMS) va a necesitar reaccionar a "reserva confirmada/cancelada/recordatorio". Hoy cada RPC hace UPDATE y listo. Un log append-only de eventos de reserva (tabla simple, no Kafka) hace que notificaciones, métricas de no-show y auditoría salgan gratis. Barato si nace con el módulo #2, molesto de retro-instalar.

---

## 3. Decisiones a cambiar AHORA (antes del módulo #2) — porque después son caras

Ordenadas por costo-de-cambiarlo-después:

1. **🔴 Agregar el estado `sentada` (ocupando) y separar el fin real (`finalizada`).** Hoy `cumplida` es terminal al sentar → el motor en vivo no puede saber quién está ocupando ni cuándo se liberó. Cambiar la máquina de estados después implica migrar datos, UI, tests y la página pública. Es LA decisión estructural del producto: sin "ocupando hasta X", no hay disponibilidad en vivo. (Alternativa mínima si no se quiere tocar la máquina: vincular reserva→venta y derivar la ocupación del ticket — pero el hueco "sentado sin ticket" queda.)
2. **🔴 Vincular reserva ↔ venta del POS** (columna `venta_id` en `reservas`, se llena al sentar). Es el eslabón que alimenta el CRM 360° (módulo #5) Y el motor en vivo (módulo #2). Hacerlo hoy = una columna + 3 líneas en la RPC de sentar. Hacerlo en 6 meses = backfill por heurísticas sobre miles de reservas.
3. **🔴 Llenar `reservas.cliente_id` SIEMPRE** (público Y manual) + FK real + normalización de teléfono a un formato canónico. Cada mes que pasa sin esto son reservas huérfanas que el CRM nunca va a poder unir.
4. **🟠 `mesas.capacidad` NOT NULL** (backfill con default razonable). El motor de disponibilidad y el matcheo grupo→mesa la necesitan; es un ALTER trivial hoy.
5. **🟠 Cron de auto-no-show / auto-liberación** (reserva confirmada + X min de gracia sin sentar → liberar cupo, marcar para revisión). Sin esto, la página pública va a decir "no hay lugar" con el salón medio vacío — el peor bug posible para un producto cuya feature estrella es decir la verdad en vivo.
6. **🟠 Recuperar la duración por reserva** (columna `duracion_min`, default por tamaño de grupo desde config). La tabla v1 la tenía, la v2 la perdió. Estándar OpenTable: 2p=90min, 5-6p=120min+. Sin esto, el cálculo de "cuándo se libera" es mentira para grupos grandes.
7. **🟠 Decidir la unidad del motor: CUBIERTOS** (no mesas), con mesas→cubiertos vía capacidad. Fijarlo en el spec del módulo #2 antes de escribir una línea.
8. **🟡 Diseñar la capa de inventario como tablas propias** (turnos de servicio formales en vez del JSONB, slots con pacing, combos de mesas) referenciando a `mesas` — y explícitamente NO agregar estados de reserva a `mesas.estado`.
9. **🟡 Mostrar reservas próximas en `SalonView`** (badge "reservada 21:30" en la mesa). Es la integración POS↔reservas más barata y la que el staff ve todos los días; además obliga a resolver el modelo de datos correcto temprano.
10. **🟡 Anti-spam/rate-limit en las RPCs `anon` de MESA** antes de publicitar la página pública (el spec ya lo lista — que no se caiga del módulo #4 v2).

**Qué NO cambiar:** la DB compartida, las RPCs como backend único, RLS dual, los deploys separados, el catálogo single-source. Eso está bien diseñado y es el estándar de las suites integradas.

---

## 4. Comparación con el estándar

| Dimensión | OpenTable / SevenRooms | Toast (Tables) | MESA hoy |
|---|---|---|---|
| Arquitectura | Reservas separadas del POS, integraciones pagas | **Una plataforma, un modelo de datos** | ✅ Una plataforma (igual que Toast) |
| Inventario reservable | Shifts + slots 15min + pacing + combos + duración por grupo | Similar, apoyado en el plano del POS | ⚠️ Cupo global de cubiertos por franja (v1 honesto, sin slots/pacing/combos) |
| Estados de reserva | booked → confirmed → seated → **finished** (+ no-show/cancel), auto-release | Similar | ⚠️ 5 estados, pero "sentada" y "terminó" colapsados en `cumplida` |
| Disponibilidad en vivo | NO la tienen real (inventario estático + sync POS parcial) | Parcial | 🔮 El diferencial diseñado es real — nadie lo tiene nativo. Falta construirlo sobre un modelo de estados corregido |
| CRM / perfil del comensal | SevenRooms: el mejor, pero a base de integraciones caras | Bueno (datos propios del POS) | ⚠️ Tabla `clientes` unificada (bien, patrón Square) pero reservas y ventas todavía no la alimentan |
| No-show | Auto-release + depósitos/tarjeta en garantía | Similar | ⚠️ Manual; el prepago de eventos (módulo #4) ya ataca el caso de mayor riesgo — bien |
| Comisión por cubierto | OpenTable sí (el dolor del mercado) | No | ✅ No — ventaja comercial correcta |

**Síntesis:** la arquitectura de conexión está en el lado correcto de la historia (lado Toast/Square, no lado OpenTable). El diferencial de MESA es real y defendible. Lo que falta no es replantear nada grande: son 4-5 decisiones de modelo de datos (estados con semántica de ocupación, reserva→venta, reserva→cliente, capacidad/duración) que cuestan días hoy y meses después. El módulo #2 NO debería arrancar hasta fijar los puntos 1-3 y 7 de la sección 3 en su spec.
