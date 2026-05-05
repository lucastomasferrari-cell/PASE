# Deuda técnica COMANDA

Última actualización: 2026-05-07 (final de Sprint 4 — Sesión A).

Este documento lista lo que se decidió postergar, no lo que está roto.
Todo lo de acá funciona; simplemente queda margen para crecer.

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

- **Selector de `color_ramp` en form de grupos**: el backfill heurístico
  Sprint 3 cubre los grupos existentes; nuevos quedan en gris. Cuando
  alguien quiera cambiar el color, hay que tocar DB directamente.
  Selector visual de los 8 colores en `GruposTab` queda para próximo
  sprint.

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
