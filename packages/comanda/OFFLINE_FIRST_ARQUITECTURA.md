# OFFLINE-FIRST — Arquitectura COMANDA

**Decidido 2026-05-16 — sesión Sprint Offline.**

Este documento es la **fuente de verdad** del proyecto de migración a offline-first. Cualquier sesión futura que trabaje en COMANDA debe leerlo antes de tocar servicios, sync o el modelo de datos del POS.

## Objetivo

Llevar COMANDA al **paridad feature con Toast** en operación offline: cada device tiene una DB local funcional + sync engine bidireccional con el cloud + (opcional) mesh entre devices del local vía LAN. Sin internet, la operación sigue normal — cobros, comandas, KDS — y al volver internet se reconcilia.

**Por qué:** COMANDA es producto SaaS para vender a otros restaurantes. La operación offline es feature crítica diferenciadora — sin ella, no compite con Toast/Square/Lightspeed.

**NO es:** un cache de lectura con bloqueo de escritura (eso es el "offline degradado" que se removerá cuando esta arquitectura esté lista).

## Decisiones arquitecturales (no negociables, congeladas)

### 1. Stack DB local: **IndexedDB** (PWA puro)

- Decisión: IndexedDB via librería `idb` (ya instalada).
- Por qué: deploy desde cualquier browser, sin app stores, sin builds nativos por plataforma. Suficiente para 99% de restaurantes (catálogos <10k items).
- Cuándo migrar a SQLite: si Fase 5 (mesh) requiere wrapper nativo Tauri/Capacitor, evaluar SQLite ahí. No antes.

### 2. IDs offline-safe: **UUIDs en tablas POS**

- Decisión: migrar `BIGSERIAL` → `UUID` en `ventas_pos`, `ventas_pos_items`, `ventas_pos_pagos`, `ventas_pos_overrides`, `mesas`, posiblemente `clientes`.
- Por qué: cada device genera IDs únicos sin coordinación, sin riesgo de colisión, sin pre-asignación de bloques.
- AFIP: no afecta — AFIP usa numeración correlativa propia (separada de IDs de DB).
- Migration: one-shot, riesgosa (PASE comparte la DB) → planificar con cuidado.

### 3. Mesh local-hub: **SÍ, modelo Toast completo**

- Decisión: implementar Fase 5 con descubrimiento P2P entre terminales del local.
- Por qué: KDS sigue recibiendo tickets sin internet, terminales se sincronizan entre sí. Diferenciador real vs sistemas cloud-only.
- Requiere: wrapper nativo (Tauri preferido, Capacitor para mobile) — se sale del PWA puro.
- Cuándo: después de Fases 1-4 (per-device offline funcional). Es la fase más compleja.

### 4. AFIP offline: **dejado para cuando se construya AFIP**

- Decisión: NO scope ahora. AFIP no está implementado ni online aún.
- Cuando se construya AFIP: ya incluir pre-asignación de bloques de CAE desde el diseño.

## Roadmap por fases (8-12 sprints totales)

### Fase 1 — DB local IndexedDB con schema completo
**Duración estimada**: 1-2 sprints.

Objetivo: cada device tiene una réplica local del modelo del POS, accesible de forma rápida y persistente entre sesiones.

Entregables:
- `lib/db/schema.ts` — definición de object stores (tablas locales) + versionado.
- `lib/db/migrations/` — migrations versionadas (ej. `001_initial.ts`, `002_add_field.ts`).
- `lib/db/repositories/` — uno por tabla, con CRUD local (ej. `ventasRepo.ts`).
- Tests unitarios de cada repo (mock IndexedDB con `fake-indexeddb`).
- Doc en CONTEXTO.md de COMANDA: cómo agregar una tabla nueva al schema local.

Tablas a replicar localmente:
- `items` + `item_grupos` + `item_modifier_groups` + `modifiers` (catálogo)
- `mesas` + `salones`
- `canales`
- `clientes` (subset relevante del turno)
- `rrhh_empleados` (subset POS-activos del local)
- `ventas_pos` + `ventas_pos_items` + `ventas_pos_pagos` + `ventas_pos_overrides`
- `local_settings`
- `tax_rates`
- (Opcional) `recetas` + `insumos` para CMV en vivo

### Fase 2 — Sync engine bidireccional
**Duración estimada**: 2 sprints.

Objetivo: la DB local se mantiene fresca con cloud cuando hay internet, y los cambios locales se replican al cloud cuando vuelve la conexión.

Entregables:
- `lib/sync/pullInitial.ts` — snapshot full al iniciar turno (todas las tablas relevantes).
- `lib/sync/pullIncremental.ts` — changes desde último sync via Supabase Realtime + columna `updated_at`.
- `lib/sync/pushQueue.ts` — cola persistente en IndexedDB de operaciones pendientes con retries + backoff exponencial.
- `lib/sync/conflictResolver.ts` — last-write-wins por `updated_at` + manager override para conflictos críticos.
- Hook `useSync()` que expone estado: `idle | pulling | pushing | error | offline`.
- Indicador visual `<SyncStatus>` en header (icono + tooltip "3 operaciones pendientes de sincronizar").
- Tests E2E mutantes del sync: corte simulado, queue, restore, dedup.

Decisiones de diseño:
- Pull incremental usa `updated_at > last_sync_at` en lugar de Realtime puro (Realtime es para reactividad inmediata, el pull cubre los gaps cuando se reconecta después de un corte largo).
- Push retry: 3 reintentos inmediatos, después backoff (5s, 30s, 5min, 30min, 1h cap).
- Conflict resolution: registro auditable en tabla `sync_conflicts` (nueva) con UI para resolver manualmente los que no automatizables.

### Fase 3 — Migration BIGINT → UUIDs (tablas POS)
**Duración estimada**: 1-2 sprints (la mayoría es testing y migración segura).

Objetivo: que cada device pueda generar IDs únicos sin coordinación con el servidor.

Tablas afectadas:
- `ventas_pos` (BIGSERIAL → UUID)
- `ventas_pos_items` (BIGSERIAL → UUID)
- `ventas_pos_pagos` (BIGSERIAL → UUID)
- `ventas_pos_overrides` (BIGSERIAL → UUID)
- `mesas` (INTEGER → UUID — atado a layout absoluto, validar impacto)
- `clientes` (BIGSERIAL → UUID — validar impacto en marketing/loyalty)

Estrategia de migración segura (no-downtime):
1. Agregar columna `uuid UUID DEFAULT gen_random_uuid()` paralela.
2. Backfill UUIDs en filas existentes.
3. Migrar FKs una por una: agregar columna `*_uuid`, backfill, validar, swap.
4. Update services PASE + COMANDA para usar UUIDs.
5. Después de N días de validación en prod sin issues: drop columnas BIGINT.

Impacto cross-paquete: PASE comparte la DB → coordinar release con PASE para que ambos paquetes usen UUIDs simultáneo. Considerar feature flag.

### Fase 4 — Operaciones offline (abrir, cargar, mandar, cobrar)
**Duración estimada**: 1-2 sprints.

Objetivo: el cajero/mozo puede ejecutar TODO el flujo POS sin internet.

Operaciones a soportar:
- `abrirVenta` offline → crea fila local con UUID + queued para push.
- `agregarItem` offline → escribe local + queued.
- `modificarItem` offline → idem.
- `mandarCurso` offline → cambia `estado='enviado'` local + queued. KDS recibe vía Realtime al volver internet (o via mesh Fase 5).
- `cobrarVenta` (efectivo) offline → marca venta como cobrada local + queued.
- `cobrarVenta` (tarjeta vía Point) offline → Point Smart tiene buffering propio, registramos en local con `payment_id` provisional + reconciliamos al volver.
- `aplicarDescuento`, `cortesiaItem`, `cambiarPrecio` offline → idem, con manager override local cacheado.
- `anularVenta`, `anularItem`, `transferirMesa`, `unirMesas`, `partirCuenta` offline → idem.

Cambios en UI:
- Sacar el bloqueo de mutations introducido en el "offline degradado" (ya no hace falta).
- Mostrar indicador "queued" en operaciones pendientes de sincronizar (icono reloj junto al item recién agregado, por ejemplo).
- Cuando se reconcilia: cambiar icono a check verde 1.5s y desaparecer.

### Fase 5 — Local hub + mesh LAN
**Duración estimada**: 2 sprints + investigación inicial.

Objetivo: las terminales del mismo local se comunican entre sí vía WiFi del local, sin necesidad de internet para coordinar entre ellas.

Requiere:
- Mover de PWA puro a app nativa via **Tauri** (desktop) + **Capacitor** (mobile) — wrappers que mantienen la base web (React + IndexedDB) pero permiten acceso a red local + APIs nativas.
- Decidir entre IndexedDB y SQLite en el wrapper (SQLite más performante, IndexedDB más compatible con la base existente).
- Implementar descubrimiento P2P:
  - **mDNS** (Bonjour/Zeroconf) para descubrir devices del local.
  - **WebRTC P2P** o **WebSockets locales** para sync entre devices.
  - Elección de Local Hub: heurística (primer device que loguea, o el más estable durante 5 min).
- KDS conectado al hub vía LAN → recibe tickets aunque no haya internet externo.
- Cuando vuelve internet, hub sincroniza todo el estado del local con cloud.

Decisiones pendientes para el inicio de Fase 5:
- Tauri vs Capacitor vs ambos (Tauri para terminales fijas, Capacitor para handhelds).
- Si seguir con IndexedDB o saltar a SQLite (con un ORM como Drizzle).
- App stores: ¿publicar como app pública o solo distribución directa a clientes?

### Fase 6 — AFIP offline (cuando se construya AFIP)
**Duración**: incluida en el sprint de AFIP.

- Pre-asignación de bloques de CAE al iniciar turno (300-1000 según volumen del local).
- Cobrar offline usa CAE del bloque pre-asignado.
- Al volver internet: reportar facturas usadas a AFIP en batch.
- Fallback: si se agota el bloque, bloquear cobro fiscal hasta volver internet (raro si bloque dimensionado bien).

## Reglas para sesiones futuras

1. **NO agregar features nuevas al modelo del POS sin extender el schema local + repo local + ruta de sync.** Si una feature solo vive en cloud, rompe la arquitectura offline-first.
2. **NO usar `db.from('...')` directo desde componentes.** Siempre vía `repositories/*` que abstraen local-first vs cloud-first.
3. **Idempotency keys SON obligatorios** en toda RPC mutativa. Sin ellos, el push queue puede duplicar.
4. **Conflict resolution debe ser auditable**: cada conflicto resuelto auto se loguea en `sync_conflicts` con quién ganó y por qué.
5. **Test E2E mutante por cada operación offline**: el flujo "carga → corta internet → opera → reconecta → verifica sync" debe pasar.

## Estado actual (al 2026-05-16)

- ❌ Fase 1: no iniciada. Hay un "offline degradado" parcial que SE REMUEVE cuando empiece Fase 1.
- ❌ Fase 2: no iniciada.
- ❌ Fase 3: no iniciada.
- ❌ Fase 4: no iniciada.
- ❌ Fase 5: no iniciada.
- ❌ Fase 6: no iniciada (atado a sprint de AFIP futuro).

**Próximo paso**: arrancar Fase 1 — schema IndexedDB + repos + tests.

## Referencias

- Toast platform offline docs: https://doc.toasttab.com/doc/platformguide/platformOfflineModeLocalSync.html
- IndexedDB API (vía `idb`): https://github.com/jakearchibald/idb
- Supabase Realtime para pull incremental: https://supabase.com/docs/guides/realtime
- Sync patterns (CRDTs, OT, LWW): https://martin.kleppmann.com/papers/local-first.pdf
