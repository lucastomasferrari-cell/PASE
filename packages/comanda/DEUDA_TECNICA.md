# Deuda técnica COMANDA

Última actualización: 2026-05-07 (final de Sprint 8 — service de motor).

Este documento lista lo que se decidió postergar, no lo que está roto.
Todo lo de acá funciona; simplemente queda margen para crecer.

## Sprint 8 — Service de motor

### Tarea 1 (anulación)

- **Cola de reversos pendientes**: cuando se anula una venta cobrada
  pero no hay turno abierto en el local, el trigger
  `fn_trg_revertir_movimientos_al_anular_venta` emite `RAISE NOTICE`
  y NO genera el reverso. El cuadre queda con dinero "fantasma" hasta
  que se ajusta a mano vía Auditoría. Solución futura: tabla
  `reversos_pendientes(venta_id, local_id, monto, estado)` que se
  procesa al abrir el siguiente turno.

### Tarea 3 (timezone)

- **Migrar call sites legacy de formatFechaAR/formatHoraAR a
  formatFecha/formatHora con useTimezone()**. Sprint 8 dejó las
  funciones nuevas pero NO migró los call sites (refactor mecánico
  amplio). `useTimezone` es el hook a usar.

- **Selector de timezone en SettingsLocal** cuando entre el primer
  cliente fuera de Argentina. Hoy `comanda_local_settings.timezone`
  acepta el cambio vía DB pero no hay UI.

- **Lista de zonas horarias en CHECK constraint** — extender cuando
  se onboardee un país nuevo no incluido (ver migration
  `202605101010_sprint8_timezone_configurable.sql`).

### Tarea 4 (tests)

- **Tests UI con `@testing-library/react`** — postergado, no crítico
  hoy. Cuando se quieran tests de componentes complejos (dialogs con
  flow multi-step, breadcrumb dinámico) hace falta esta dep.

- **Tests E2E con Playwright** — flow login → POS → cobrar → cerrar
  caja. No hay nada hoy.

- **Tests SQL reales (DB local + integration)** — los tests actuales
  mockean Supabase a nivel JS. NO testean: triggers (incluyendo el
  reverso de movimientos del sprint 8 y el saldo proveedor del sprint
  5), CHECK constraints, RLS policies, race conditions con
  `FOR UPDATE`.

- **Servicios sin tests pendientes**: `allChecksService`,
  `canalesService`, `combosService`, `configService`, `itemsService`,
  `kdsTokensService`, `localSettingsService`, `menuQrTokensService`,
  `modifiersService`, `recetasService`, `recetaPasosService`,
  `settingsLocalesService`, `tiendaService`.

### Tarea 5 (coverage)

- **Subir thresholds de coverage gradualmente**: hoy 25% (línea con
  realidad post-sprint 8). Roadmap:
  - Sprint 9: 35%.
  - Sprint 10: 45%.
  - Pre-launch SaaS: 60%.

- **`pnpm test --coverage` no funciona via turbo** (intercepta el
  flag). Hay que usar `node_modules/.bin/vitest run --coverage`.
  Documentado en TESTING.md. Si se quiere fix, configurar turbo para
  pasar args.

### General (mantener desde sprints previos)

- **Auditoría de seguridad externa (pentest)** antes del primer
  cliente pago.
- **Backups automáticos documentados + drill de restore** semestral.
- **Status page público y monitoring** (Uptime Kuma o similar).
- **Cliente Supabase sin generic Database** — regenerar tipos cuando
  el schema sea estable.

## Sprint Fix CurrencyInput

### Migrado en este sprint

**PASE — Compras.tsx (form factura manual)**:
- Neto Gravado, IVA 21%, IVA 10.5%, Perc. IIBB, Perc. IVA, Otros
  Cargos, Descuentos (7 inputs).
- Modal Registrar Pago (factura): Monto.
- Modal Nuevo Remito Valorado: Monto.
- Modal Pagar Remito Directo: Monto.

**COMANDA — vía wrapper MoneyInput** (delegado a CurrencyInput):
- MovimientoCajaDialog (monto retiro/depósito/ajuste).
- PaymentDialog (propina, montoNuevo, montoEntregado de cada pago).
- CajaAbrir (montoInicial), CajaCerrar (montoEfectivoDeclarado).
- SettingsLocal (costo_envio_default).
- ItemForm (precio), ModificadoresTab (nuevoPrecio).

### Pendiente de migrar (próximo sprint)

- **PASE — LectorFacturasIA**: campos editables del OCR (neto, IVA,
  total). Hoy son `<input type="number">`. El bug de coma podría
  reaparecer si el usuario edita los valores. Migrar similar a
  Compras.tsx. Los inputs están en líneas ~462 y ~468 del archivo.

- **PASE — Items detalle factura (Compras.tsx:662-664)**: cantidad
  + precio_unitario en celdas de tabla. Cantidad NO es plata
  (queda type=number). Precio_unitario sí es plata pero la celda
  es 70-90px de ancho — CurrencyInput puede verse apretado.
  Decisión pendiente: o se migra con `currencySymbol={null}` y
  className compacta, o se deja con type=number (los items son
  opcionales, no bloquean el flow del bug original).

### Notas arquitecturales

- **Componente CurrencyInput duplicado** entre PASE (sin tailwind,
  styles inline) y COMANDA (con shadcn + tailwind). Cuando se
  consolide `@pase/shared`, extraer a uno solo con styling más
  versátil.

- **MoneyInput es un wrapper deprecable**. Para nuevos componentes,
  usar `CurrencyInput` directo (más explícito: currencySymbol,
  allowNegative, maxIntegerDigits, ref forwarding).

- **Variantes futuras a considerar**:
  - `<PercentageInput />` para IVA, comisiones, descuentos %.
    NO migrar % a CurrencyInput — son lógicas distintas (0-100,
    no centavos).
  - `<CurrencyInput currency="USD" />` si en el futuro se aceptan
    dólares (formato US sería el default).

## Sprint 7 — Fixes seguridad/integridad financiera

### Bloqueadores diferidos (no urgentes hoy)

- **Eliminación del branch legacy storage facturas**: la policy
  `facturas_read_mt` permite paths sin UUID prefix si el caller es
  Neko. Antes de onboardear el segundo tenant productivo, ejecutar
  `packages/pase/scripts/backfill_storage_facturas_legacy.sql` y
  crear migration de cleanup que elimina el branch legacy. Anotado
  con `COMMENT ON POLICY` en migration 202605091230.

- **Rate limiting de tokens KDS y Menú QR**: necesario si se filtra
  un token o si aumenta el volumen. Implementación en aplicación o
  edge function de Supabase.

- **Tabla `rol_pos_permisos` formal**: hoy mapeo está hardcoded en
  `usePermiso.ts`. Cuando se cree UI de "asignar permisos a roles
  POS" en `/empleados/permisos`, mover a DB. JSDoc `@deprecated` ya
  agregado en `Usuario.permisos`.

- **`comanda_local_settings.umbral_override_retiro`**: sprint 7
  hardcodeó $5000 como `CONSTANT v_umbral_override` en
  `fn_movimiento_caja_comanda`. Mover a config por local cuando un
  cliente con tickets más altos lo necesite.

- **Lint rule custom `no-permisos-includes`**: prevenir regresiones
  del patrón legacy `user.permisos.includes(slug)`. Hoy 0 ocurrencias
  en components, pero falta lint que lo bloquee.

- **Tests SQL/integration con DB local**: verificar el comportamiento
  real de las RPCs del sprint 7 (RAISE EXCEPTION en
  `fn_recalc_total_venta` con descuento > subtotal, FOR UPDATE en
  `fn_agregar_pago_venta_comanda` bajo concurrencia, asserts IDOR).
  Hoy solo se mockea Supabase a nivel JS — tests reales requieren
  Supabase local + scripts seed.

### HIGH no atendidos en Sprint 7 (del informe auditoría)

- **Triggers de recalculo `movimientos_caja` cuando se anula venta**:
  cuando se anula una venta cobrada, no hay trigger que reverse los
  movimientos de caja asociados. El turno cierra con cuadre incorrecto.

- **`useLocalActivo` con potencial loop de re-render**: agent de
  auditoría lo flageo pero no se verificó en este sprint. Revisar en
  próximo.

### MEDIUM/LOW pendientes (no prioritarios)

- **Timezone hardcoded** `'America/Argentina/Buenos_Aires'` en
  `lib/format.ts` — extraer a config por tenant cuando aplique.
- **Tests para servicios sin coverage**: `mesasService`,
  `empleadosService`, `combosService`, `gruposService`,
  `metodosCobroService`.
- **Tests de casos negativos en `descuentosService`**.
- **Coverage configurado en `vitest.config.ts`** — agregar
  `coverage: { provider: 'v8' }` para reportes %.
- **Drawer mobile sin focus trap** (`AdminLayout.tsx`).
- **Inputs date sin labels** en `ReportesLayout.tsx`.
- **Migration histórica `20260414_rls_policies.sql`** mover a
  `_history/` para que futuras auditorías no la confundan con
  policies activas.
- **`getDescuentos()` stub deprecation**.

## Sprint 6 — Refactor admin a sidebar + stubs

### Sidebar admin

- **Keyboard navigation en el sidebar**: hoy navegación solo con
  mouse/touch. Falta soporte de Arrow keys / Enter / Esc para
  accesibilidad.

- **Buscador global del header**: input visual stub. Click en el campo
  dispara toast "Próximamente — vas a poder buscar items, mesas,
  empleados, ventas desde acá". Implementación real requiere
  índice cliente (Fuse.js) o RPC de búsqueda multi-tabla.

- **Notificaciones del header**: campana stub. Click → toast
  "Próximamente". Implementación requiere tabla de notificaciones
  + Realtime + suscripción por user.

- **Multi-tenant selector con search**: si en el futuro hay >5 tenants
  (caso superadmin), el selector actual de locales se vuelve incómodo.
  Falta selector con search.

- **Toast-style "publicar cambios" con banner amarillo**: futuro flow
  donde los cambios al menú son drafts hasta que el manager publica.
  Hoy todos los cambios son inmediatos.

- **Tabla rol_pos_permisos formal**: sigue como deuda — Sprint 6
  sumó más slugs al mapeo provisional en usePermiso (empleados,
  salon, pagos, online, hardware, marketing, clientes, integraciones,
  configuracion, suscripcion). Cuando se cree una pantalla de
  "asignar permisos a roles POS" en /empleados/permisos, mover el
  mapping a DB.

- **Permission matrix completo documentado**: hoy el mapeo está en
  código (usePermiso.ts). Falta documento que explique qué slug
  corresponde a qué rol y qué pantalla protege.

### Stubs implementados (~30) — implementación real pendiente

Cada uno tiene copy específico en `src/lib/stubsCopy.ts` con el
detalle de features esperadas. Los listo agrupados por categoría:

- **Reportes**: ventas, empleados (performance individual)
- **Menú**: combos, disponibilidad (86 items)
- **Salón**: servicios y turnos, reservas
- **Empleados**: horarios y turnos, performance
- **Pagos**: caja chica, histórico turnos, conciliación MP
  (link a PASE), settlements (link a PASE)
- **Online**: tienda online (config), tracking pedidos
- **Hardware**: impresoras, cajón de dinero, MP Point, tablets KDS
- **Marketing**: promociones, cupones, fidelidad, campañas
- **Clientes**: lista, historial, reseñas
- **Integraciones**: MP, Rappi, PedidosYa, WhatsApp, contabilidad,
  webhooks/API
- **Configuración**: branding, notificaciones, recibos, idioma, backup
- **Suscripción**: plan, facturación, métodos de pago, historial

## Sprint 5

### Tienda online — diferida a próxima iteración

- **Sistema de promociones / discounts**: la sección "Discounts" del
  rediseño Roc N Ramen requiere modelado de promos (porcentaje, 2x1,
  cupones). Hoy `tiendaService.getDescuentos()` es stub que devuelve
  []. Cuando se implemente, agregar tabla `promociones` (con start/end,
  tipo, porcentaje, items asociados) + RPC + UI en /catalogo.

- **Programar pedido para más tarde** (pickup/delivery time): el
  selector de hora del rediseño hoy solo muestra "ASAP". Para
  programar, generar slots de 15 min hasta cierre del local (mirar
  schedule del local en `comanda_local_settings`) + pasar
  `programada_para` a `fn_crear_pedido_publico_comanda`.

- **destacado_tienda en vista pública**: agregamos la columna
  `items.destacado_tienda` (migration sprint 5) para fallback de
  Popular cuando no hay ventas reales. Pero `v_catalogo_publico` NO
  expone el flag, así que el fallback no se materializa en el frontend
  todavía. Si hay 0 populares por ventas, la sección se oculta en vez
  de mostrar destacados manuales. Migration de la vista pendiente.

- **Estética V2 KDS, Menú QR, Reportes**: Sprint 5 solo cubrió la
  Tienda online. Las otras 3 superficies siguen con el look del
  Sprint 4. Misma filosofía Roc N Ramen, próximo sprint.

- **TiendaSeguimiento sin rediseño**: la pantalla pública para
  trackear pedido por teléfono (sin login) quedó con el estilo viejo.
  Refactor cosmético menor.

- **ModifiersDialogTienda**: el rediseño asumió que la mayoría de
  pedidos tienda no tienen modifiers (la vista `v_catalogo_publico`
  no expone modifier_groups). Cuando se sumen modifiers a la tienda
  online, hace falta una variante con estética V2 del ModifiersDialog
  POS (~250 líneas).

- **Buscador en sidebar de Tienda**: el input de search está y filtra
  por nombre + descripción client-side. Cuando el catálogo sea grande
  (200+ items), conviene mover a SQL con FTS / trigram.

- **IntersectionObserver fallback** para navegadores muy viejos: el
  rediseño de TiendaHome usa IntersectionObserver para resaltar la
  categoría visible al scrollear. Soportado en todos los modernos,
  pero IE11 no.

- **Open Graph + meta description**: hoy solo seteamos
  `document.title`. `react-helmet-async` no está instalado y no se
  agregó dep para evitar bundle bloat. Si se quiere preview rico al
  compartir el link, hay que agregarla.

- **Progress bar real durante upload de MP QR**: el SDK supabase-js
  no expone `onProgress` para storage uploads. Si se quiere progreso
  visible (más que un spinner), implementar con XHR raw + signed URL.

### Bugs cerrados (no son deuda)
Los 5 bugs del bloque A (NumericPad mouse, CambiarPinDialog error
handling, header back button, turno status sin F5, MenuQrView
useCallback) quedaron resueltos.

## Sprint 4 (Sesión B)

### Tienda online + KDS + Menú QR

- **Realtime Supabase** para tickets KDS, tracking de pedidos públicos
  y pedidos nuevos en `PedidosPlaceholder`. Hoy todos pollean
  (KDS 10s, tienda 15s, menú QR 15s, POS 30s). Implementación: canales
  por (local_id, estacion) o (local_id) + replicación habilitada.

- **Notificación "Llamar mozo"** desde menú QR: hoy es un toast
  cliente-side ("Pedile al mozo"). Falta crear tabla `mesa_pedidos_atencion`
  o emitir un broadcast que aparezca en POS como notificación push.

- **Notificación al POS de pedidos nuevos** desde tienda online y menú
  QR: hoy se descubren via polling de `PedidosPlaceholder`. Mismo
  patrón Realtime que arriba.

- **Print CSS optimizado para QR de mesa**: el botón "Imprimir" del
  dialog de Menú QR usa `window.print()` directamente. La página
  imprime con todo el chrome — falta `@media print` que oculte
  navbar/sidebar y fuerce un layout centrado del QR.

- **Polígonos de delivery / radios de zona**: hoy hay solo
  `costo_envio_default` fijo por local. Postergado.

- **Idempotency_key en `fn_crear_pedido_publico_comanda`**: la RPC
  Sprint 2 NO recibe idempotency. Si el cliente toca dos veces
  "Confirmar" muy rápido se generan duplicados. Mitigación actual:
  setEnviando(true) deshabilita el botón. Para fix definitivo,
  agregar `p_idempotency_key TEXT` a la RPC y hacer SELECT antes
  del INSERT.

- **Sonido KDS sin asset**: el beep se genera con Web Audio API
  inline. Funciona pero limitado al primer "user gesture". Si Lucas
  quiere un sonido más prolijo, agregar `public/sounds/ticket.mp3`
  y reproducirlo con `<audio>` o `new Audio()`.

- **Insights ML en reportes**: hoy heurística simple (valor crudo en
  cards). Falta comparación con período anterior con flecha y % de
  variación, y banners "Caída de volumen en X (-Y%)".

- **Charts library**: el gráfico de "Ventas por canal" es SVG/CSS
  plano (barras horizontales). Si se quiere histograma de hora del
  día, line charts, etc., conviene una librería liviana
  (recharts o chart.js).

- **Tests E2E Playwright** para flow tienda → POS → KDS y menú QR
  modos asistido/autónomo. Hoy solo unit tests.

- **Menú QR tracking de venta abierta** (MenuQrTracking del brief):
  postergado. La RPC `fn_menu_qr_get_local_comanda` ya existe pero
  no se construyó la pantalla con la lista de items + estado +
  total acumulado + "pedir cuenta".

- **Tienda online: variantes/tamaños** (S/M/L) por producto:
  postergado, requiere modelado nuevo de `item_variantes`.

- **Multi-foto producto** en tienda: hoy solo `foto_url` única.

- **Integración MP real** (Point + checkout): hoy QR estático
  embebido. Pago real fuera del sistema, sin notificación de pago
  recibido al pedido.

- **Integración impresora térmica** para tickets KDS: hoy todo digital.

## Sprint 4 (Sesión A)

### UX

- **Drag & drop** para reordenar items en `SettingsMetodosCobro` (orden
  con input numérico ahora) y para asignar items a cuentas en
  `SplitCheckDialog` (checkboxes ahora; soporte para 3+ cuentas también
  postergado — solo split en 2). Para cuando alguien la pida.

- **Plano de mesas con drag & drop** y posicionamiento por coordenadas
  (`pos_x`, `pos_y` ya están en el schema). Hoy es grid auto-fit.

- **Atajos teclado** ricos: `Ctrl+1/2/3` para cambiar curso en
  `VentaScreen`, `Ctrl+P` para cobrar, etc. Solo `/` está implementado
  (abre AllChecks). Postergado por compatibilidad mobile.

- **Sonner Toaster posición**: hoy `top-center`. Convención web normal
  es `top-right`. Si Lucas prefiere, cambio mínimo en `App.tsx`.

- **Skeleton loaders** creados pero adopción incremental: muchas
  pantallas siguen mostrando "Cargando…". Se reemplazan oportunamente
  cuando se tocan en próximos sprints.

### Realtime y notificaciones

- **Supabase Realtime** para detectar pedidos nuevos en
  `PedidosPlaceholder`. Hoy hace polling cada 30s. Realtime requiere
  setup de canales y configurar replicación; postergado para no
  bloquear la sesión.

- **Notificaciones WhatsApp / SMS** al cliente cuando su pedido cambia
  de estado. Sprint dedicado.

### Permisos y roles

- **Tabla `rol_pos_permisos` formal**: hoy `usePermiso` deriva permisos
  del `rol_pos` con un mapeo provisional en código (cajero=cobrar;
  encargado=+descuento; manager=+anular/config; dueno=*). Cuando se
  necesite asignación granular (ej. un cajero específico que pueda
  hacer descuentos), agregar la tabla.

- **Telemetría/Sentry**: el `ErrorBoundary` solo logea a `console`.
  Falta integración con un servicio de monitoreo (Sentry / PostHog).

### Catálogo

- **Combos UI completa**: el modelo (`item.es_combo`,
  `combo_componentes`) está. La UI para definir combos en Settings y
  usarlos en venta queda para sprint dedicado.

- **Asignación de modifier_groups a items en UI**: el form de items no
  permite asignar/desasignar `item_modifier_groups`. Solo via DB.
  ModifiersDialog ya consume las asignaciones existentes.

### Caja

- **Auto-cutoff de caja** por hora del día (cierre automático): la
  columna `comanda_local_settings.autolock_minutos` existe pero no hay
  job. Agregar como Edge Function o cron de Supabase.

- **Múltiples turnos abiertos en paralelo** (cocinero + barra): hoy
  un turno abierto por local. Si el negocio crece a múltiples cajas
  físicas, repensar el modelo.

### Sesión B (próximo sprint)

Los siguientes módulos se construyen en Sesión B:

- **KDS** (pantalla cocina con timer por item, ack de listo).
- **Tienda online pública** UI completa (carrito, checkout, MP QR).
- **Menú QR** cliente final escaneando.
- **Reportes operativos** (ventas por cajero, productos top, hora pico,
  promedio ticket, etc.).
- **Polígonos de delivery** (zona + costo asociado).

### Tests

- Tests unitarios solo para services nuevos críticos (descuentos,
  auditoría, pedidos). Falta cobertura E2E con Playwright para flow
  completo (login → PIN → abrir mesa → cobrar → cerrar caja).

- Tests de UI con `@testing-library/react`: ningún componente tiene
  test de render todavía. Se podría agregar smoke test para
  `PaymentDialog` (suma parcial, cubrió, distribución de propina).

### Type safety

- **Cliente Supabase sin generic Database**: ver Sprint 1. Cuando el
  schema esté estable (después de Sesión B), regenerar types con
  `supabase gen types typescript` y reactivar el generic.

## Sprints anteriores (mantener para contexto)

### Sprint 3

- Sidebar tabs UI: nada para anotar (todo está bien).

### Sprint 2

- POSTGRES_URL_NON_POOLING en Vercel todavía corrupta (16 chars de
  basura prefijada). Se sanitiza en cada script de aplicación. Fix
  manual recomendado en Vercel dashboard.

### Sprint 1

- Type generic Database en cliente Supabase comentado (ver arriba).
