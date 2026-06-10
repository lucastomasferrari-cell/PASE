# MESA Módulo #1 — Núcleo de reservas + agenda interna · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completar el núcleo de reservas: máquina de estados estricta en backend, alta/edición manual de reservas, agenda por día en COMANDA admin, tests mutante.

**Architecture:** Construye SOBRE lo existente (tabla `reservas` 202605172100, `fn_cambiar_estado_reserva`, `fn_asignar_mesa_reserva`, `reservasService`, pantalla `ReservasAdmin.tsx`). No se crea tabla nueva. Las mutaciones van por RPCs atómicas con RLS + error codes UPPER_SNAKE.

**Tech Stack:** Postgres RPCs (Supabase) + React 19 + reservasService (COMANDA).

**Decisiones de máquina de estados (fijadas acá, eran "pendiente de definición" en el spec):**
```
pendiente  → confirmada | cumplida (walk-in directo) | cancelada
confirmada → cumplida | no_show | cancelada
cumplida / no_show / cancelada → TERMINALES (toda transición → RESERVA_TRANSICION_INVALIDA)
```
- "Sentar" = pasar a `cumplida`, con `p_mesa_id` opcional (valida mismo local).
- `no_show` solo desde `confirmada` (si nunca se confirmó, se cancela).
- Editar (`fn_editar_reserva`) solo en `pendiente`/`confirmada`.

---

### Task 1: Migración backend (RPCs del módulo #1)

**Files:**
- Create: `packages/pase/supabase/migrations/202606100400_mesa_modulo1_nucleo_reservas.sql`

- [x] **Step 1:** `fn_crear_reserva` (interna/manual): auth tenant + local visible, valida nombre requerido, personas 1-50, fecha_hora futura (tolerancia -1h para cargar "recién llegó"), idempotency vía `reservas.idempotency_key`. Returns id.
- [x] **Step 2:** `fn_editar_reserva`: solo `pendiente`/`confirmada`; campos editables: cliente_nombre/telefono/email, fecha_hora, personas, notas. Mismas validaciones.
- [x] **Step 3:** Reescribir `fn_cambiar_estado_reserva` con la máquina estricta + `p_mesa_id` opcional al pasar a `cumplida` (valida mesa del mismo local). Errores: `RESERVA_TRANSICION_INVALIDA`, `MESA_OTRO_LOCAL`.
- [x] **Step 4:** Aplicar a prod con verificación (BEGIN→test→COMMIT) según flow oficial.

### Task 2: Frontend (reservasService + ReservasAdmin)

**Files:**
- Modify: `packages/comanda/src/services/reservasService.ts`
- Modify: `packages/comanda/src/pages/Salon/ReservasAdmin.tsx`

- [x] **Step 1:** Service: `crearReserva()`, `editarReserva()`, `cambiarEstadoReserva({ mesaId? })`.
- [x] **Step 2:** ReservasAdmin: vista **Agenda** por día (date picker + lista ordenada por hora con badges + acciones rápidas confirmar/sentar/no-show/cancelar).
- [x] **Step 3:** Modal **Nueva reserva / Editar** (cliente, teléfono, email, fecha, hora, personas, notas) con validaciones.
- [x] **Step 4:** "Sentar" abre selector de mesa opcional (mesas libres del local) en un paso.
- [x] **Step 5:** typecheck + lint verdes.

### Task 3: Tests

**Files:**
- Create: `packages/comanda/tests/reservas_estado_mutante.spec.ts`

- [x] **Step 1:** Mutante DB-only (Local Prueba 2): crear → confirmar → sentar(con mesa) OK; transiciones inválidas rechazadas (cancelada→confirmada, cumplida→cancelada, no_show desde pendiente); editar solo pre-terminales; idempotency de crear; personas inválidas.
- [x] **Step 2:** Correr suite completa COMANDA → verde.
- [x] **Step 3:** Commit + push + memoria.
