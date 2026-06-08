# MESA — Sistema de Reservas (diseño de producto + arquitectura)

> Fecha: 2026-06-08 · Estado: diseño aprobado (brainstorming) · Autor: Lucas + Claude

## 1. Objetivo

Construir **MESA**, el tercer producto del ecosistema (junto a **PASE** back-office y
**COMANDA** POS): un sistema de reservas de mesa de clase mundial, **multi-tenant**,
**escalable**, con **buenas prácticas**, y **vendible como producto independiente** a
cualquier restaurante (no solo Neko).

La meta no es clonar OpenTable, sino tomar **lo mejor de los 3 referentes de USA** y
sumarles la **ventaja imbatible** que ninguno tiene: estar integrado de forma nativa
con el POS (COMANDA) y la contabilidad (PASE).

## 2. Análisis competitivo (qué tomamos de cada uno)

| Sistema | Lo mejor | Lo tomamos |
|---|---|---|
| **OpenTable** | Marketplace de descubrimiento + floor-plan/gestión de mesas robusta + analytics + loyalty | **Floor plan + motor de disponibilidad + analytics** |
| **Resy** (Amex) | Waitlist excelente + experiencia fine-dining + **sin comisión por cubierto** | **Waitlist + UX de cliente + modelo sin comisión por cubierto** |
| **SevenRooms** (DoorDash) | **CRM de huéspedes 360°** (perfil + auto-tags), marketing, revenue management, API abierta | **CRM 360° + revenue management + API** |

Debilidad común de los 3: **ninguno es dueño del POS ni del back-office.**

## 3. El diferencial de MESA (el "foso")

**MESA + COMANDA + PASE = un solo stack.** El perfil del huésped se llena **solo** con
lo que realmente consumió (qué comió, cuánto gastó, ticket promedio, rentabilidad,
frecuencia). SevenRooms paga fortunas en integraciones para acercarse a eso; en MESA
es nativo.

Pitch vendible: *"El único sistema donde la reserva, la comanda y la contabilidad son
una sola cosa — sabés todo de tu cliente sin integrar nada."*

### 3.1 Feature estrella — Disponibilidad en TIEMPO REAL ("¿hay lugar ahora?")

OpenTable/Resy muestran horarios disponibles de un inventario **estático**. MESA muestra
la **ocupación real del salón en vivo**, porque lee el estado de COMANDA.

```
Capacidad del local      = suma de mesas (o cubiertos) del local
− Ocupadas ahora         = mesas con ticket ABIERTO en COMANDA (en vivo)
− Comprometidas pronto   = reservas confirmadas/pendientes dentro de la próxima
                           ventana (default 90 min) que NO sean no-show ni canceladas
─────────────────────────────────────────
= LIBRES AHORA
```

Detalle "pro": una mesa libre ahora pero reservada en 20 min no sirve para un walk-in
de 1h30 → el motor lo contempla con la **ventana de tiempo + la duración**. Salida para
el cliente: *"Hay 4 mesas libres ahora · próxima reserva en 35 min"*.

## 4. Estado actual (lo que YA existe — no arrancamos de cero)

Del Brainstorm #8 Fase 5 (2-jun) ya hay backend base:
- Tabla **`reservas`** (migración `202605172100`): tenant_id, local_id, fecha,
  hora_inicio, duracion_min (default 90), cliente_nombre/telefono/email, covers (1-50),
  estado (`pendiente`/`confirmada`/`sentada`/`cancelada`/`no_show`), mesa_asignada (TEXT),
  notas, origen (`manual`/`whatsapp`/`web_publica`/`instagram`/`otro`).
- Reservas online + validación de capacidad server-side (migración `202605203600`).
- Config por local en `comanda_local_settings`: `reservas_activas`,
  `reservas_capacidad_max`, `reservas_anticipacion_min_hs`, `reservas_anticipacion_max_dias`.
- `fn_asignar_mesa_reserva(reserva_id, mesa_id)` + `reservasService` (COMANDA).

**Gap**: no hay UI usable, ni motor de disponibilidad en vivo, ni página pública, ni CRM.

## 5. Arquitectura

- **Multi-tenant nativo**: todo aislado por `tenant_id` + RLS dual (idéntico patrón a
  PASE/COMANDA). El mismo MESA se vende a cualquier restaurante.
- **Mutaciones de estado vía RPCs atómicas** (`crear_reserva`, `confirmar_reserva`,
  `sentar_reserva`, `cancelar_reserva`, `marcar_no_show`, `agregar_waitlist`...), con
  códigos de error UPPER_SNAKE + `translateRpcError`, idempotency donde aplique.
- **Construido sobre lo existente**: reusar `reservas`, las `mesas` de COMANDA, la config.
  `mesa_asignada` pasa a FK real a `mesas` cuando se integre.
- **Página pública white-label**: `mesa.<dominio>/<tenant-slug>` con la marca del tenant.
- **Sin comisión por cubierto** (ventaja comercial vs OpenTable).
- **Buenas prácticas**: módulos chicos y bien delimitados (cada uno su spec + plan),
  tests mutante + e2e-full por cada flujo de estado, `applyLocalScope`, lazy imports.

## 6. Descomposición en módulos (roadmap)

Cada módulo es un sub-proyecto con su propio spec → plan → implementación.

1. **Núcleo de reservas + agenda interna** — el host carga/gestiona reservas (lista por
   día/franja, confirmar, sentar, cancelar, no-show, notas). RPCs de estado + pantalla.
   **(Primer módulo a construir.)**
2. **Floor plan + motor de disponibilidad** — mesas visuales, capacidad real, turnos;
   incluye el **motor de disponibilidad en vivo** (sección 3.1).
3. **Waitlist** — lista de espera para walk-ins (estilo Resy), con estimación de tiempo.
4. **Página pública de reservas** — el cliente reserva solo (multi-tenant, white-label,
   anti-spam) + el widget "¿hay lugar ahora?".
5. **CRM de huéspedes 360°** — perfil auto-llenado con datos de COMANDA (consumo, ticket,
   frecuencia) + auto-tags + segmentación. *El diferencial.*
6. **Notificaciones** — WhatsApp/SMS/email: confirmación, recordatorio, no-show.
7. **Analytics + revenue management** — ocupación, no-shows, horas pico, precios dinámicos.

## 7. Módulo #1 — Núcleo de reservas + agenda interna (detalle)

**Qué hace:** una pantalla en el ecosistema (COMANDA admin y/o PASE) donde el staff ve y
gestiona la agenda de reservas de un local.

**Componentes:**
- **RPCs de estado** (atómicas, RLS, error codes): `crear_reserva`, `editar_reserva`,
  `confirmar_reserva`, `sentar_reserva` (check-in, opcional asignar mesa),
  `cancelar_reserva`, `marcar_no_show`. Cada transición valida estado origen→destino
  (máquina de estados) + tenant/local.
- **Vista de agenda**: lista de reservas de un local por **día** (y filtro por franja),
  ordenadas por hora; tarjeta con cliente, covers, hora, estado, notas; acciones rápidas
  (confirmar / sentar / no-show / cancelar). Badges por estado.
- **Alta/edición de reserva** (form: cliente, teléfono, covers, fecha, hora, duración,
  notas, origen). Validaciones con Zod-equivalente + RPC.
- **Servicio frontend** `reservasService` extendido (ya existe la base).

**Máquina de estados:**
```
pendiente ──confirmar──▶ confirmada ──sentar──▶ sentada
    │                         │
    └──cancelar──▶ cancelada  └──no_show──▶ no_show
```
(Reglas exactas y transiciones permitidas se fijan en el spec del módulo.)

**Fuera de alcance del #1** (YAGNI — vienen en módulos posteriores): floor plan visual,
disponibilidad en vivo, waitlist, página pública, CRM, notificaciones automáticas.

## 8. No-funcionales / criterios de aceptación

- Multi-tenant + RLS verificado (sin leaks cross-tenant) — invariante en e2e-full.
- Toda RPC de estado con test **mutante** + operación en **e2e-full**.
- Estados siempre consistentes (no se puede sentar una cancelada, etc.).
- Performance: queries de agenda con filtro de fecha (no traer histórico completo).
- Código en módulos chicos, archivos enfocados, nombres claros.

## 9. Pendiente de definición (a resolver en specs de cada módulo)

- Dónde vive la UI interna: ¿COMANDA admin, PASE, o app MESA propia? (probable: COMANDA
  admin para staff de salón + futura app MESA para el dueño multi-local).
- Modelo de "mesa" unificado entre COMANDA y MESA (hoy `mesa_asignada` es TEXT).
- Identidad del huésped (cómo se unifica un cliente entre reservas y ventas de COMANDA).
- Branding/white-label de la página pública.
