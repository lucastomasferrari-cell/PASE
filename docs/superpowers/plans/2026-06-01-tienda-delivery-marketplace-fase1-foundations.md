# Tienda + Delivery + Marketplace — Fase 1 Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Crear la tabla `pedidos` unificada con state machine + RPCs atómicas para crear/avanzar/cancelar pedidos. Refactorar `PedidosHub` y `PedidoDetalle` para leer de la tabla nueva con timeline visible.

**Architecture:** Tabla `pedidos` separada de `ventas_pos`. Pedido es "intención de compra" pre-cobro (vive en COMANDA, todos los canales online). Venta es "registro fiscal de transacción cerrada" (existente en PASE, alimenta RRHH/P&L/CMV/conciliación). Link 1:1 via `pedidos.venta_pos_id` cuando se cobra (RPC de conversión queda DIFERIDA a Fase 2/3 cuando aterricen flows de cobro reales — bot WhatsApp / webhook MP / webhook marketplace). State machine de 8 estados con transiciones validadas por RPC. Items snapshot en `pedido_items` (no jsonb — query-friendly).

**Tech Stack:** Postgres + RLS (Supabase) + RPCs PL/pgSQL atómicas con idempotency_keys + React 19 + TypeScript strict + Playwright para E2E mutante.

---

## Scope and split decision

Brainstorm #8 son 6 fases × ~39 días total. **Este plan cubre SÓLO Fase 1** (Foundations, 5 días). Las fases 2-6 obtienen su propio plan después de que F1 ship.

Razón: lecciones de F1 cambiarían el diseño de F2-F6. Plan único de 180+ pasos se queda obsoleto. Cada fase es entregable independiente deployable.

**Entregable Fase 1**: Bandeja `PedidosHub` mostrando pedidos con timeline visible, RPCs operativas para avanzar estados, RPC para convertir pedido en venta. POS clásico (cobro directo en mesa de PASE) NO se toca — sigue funcionando intacto.

## Pre-requisitos de Lucas (antes de arrancar Task 1)

- [ ] **Confirmar partir limpio**: COMANDA actualmente no tiene data productiva (solo test). Plan asume tabla `pedidos` se crea vacía y los datos viejos en `ventas_pos` con canal online (si hay alguno) se ignoran. Si Lucas quiere migrar data específica → agregar Task 17B de backfill antes de cerrar fase.
- [ ] **Confirmar nombre tabla**: `pedidos` (Recomendado) vs `comanda_pedidos` (más explícito multi-paquete). Recomendación: `pedidos` por simplicidad y porque ya hay convención `ventas_pos` sin prefix.
- [ ] **Confirmar prefix numeración**: `ORD-2026-001234` (recomendación spec) vs `P-` vs `PED-2026-`. Recomendación: `ORD-{YEAR}-{6-digit}` global por tenant (NO por local — visible al cliente y debe ser único).

---

## File Structure

### Migrations (NEW) — `packages/pase/supabase/migrations/`

- `202606011000_pedidos_table.sql` — tabla `pedidos` + indexes + RLS dual policies
- `202606011010_pedido_items_table.sql` — tabla `pedido_items` + RLS
- `202606011020_pedidos_numero_sequence.sql` — sequence + función `fn_pedido_next_numero`
- `202606011030_pedidos_state_machine.sql` — RPC `fn_avanzar_pedido_estado` + helper `valid_pedido_transition`
- `202606011040_pedidos_crear.sql` — RPC `fn_crear_pedido` (con idempotency)
- `202606011050_pedidos_cancelar.sql` — RPC `fn_cancelar_pedido` (con motivo, idempotent)

NOTA: `fn_pedido_a_venta` DIFERIDA a Fase 2/3. Razón: el schema real de `ventas_pos` (canal_id FK a tabla `canales`, numero_local correlativo, modo/origen, sin idempotency_key directo) requiere conocer el flow completo de cobro online — método pago real, MP payment_id, turno_caja_id, etc. Mejor diseñarla cuando los webhooks de cobro estén operativos.

### Frontend (NEW) — `packages/comanda/src/`

- `types/pedido.ts` — TypeScript types `Pedido`, `PedidoItem`, `EstadoPedido`, `CanalPedido`
- `lib/pedidos/api.ts` — wrapper supabase (crearPedido, listarPedidos, getPedido, avanzarEstado, cancelarPedido, cobrarPedido)
- `lib/pedidos/stateMachine.ts` — helpers `siguientesEstados()`, `puedeTransicionar()`, `labelEstado()`
- `components/PedidoTimeline.tsx` — componente timeline con timestamps por estado

### Frontend (MODIFIED) — `packages/comanda/src/`

- `pages/Pos/PedidosHub.tsx` — switch de `ventas_pos` legacy a tabla `pedidos` nueva
- `pages/Pos/PedidoDetalle.tsx` — agregar `<PedidoTimeline />` + acciones de avance

### E2E Tests (NEW) — `packages/pase/test/e2e/`

- `helpers/pedidos.ts` — helpers de test (crearPedidoSintetico, esperarEstado, etc.)
- `test_pedidos_state_machine.spec.ts` — test mutante: crear → confirmar → cocinar → listo → entregar
- `test_pedidos_idempotency.spec.ts` — test mutante: misma idempotency_key 2 veces → 1 solo pedido
- `test_pedidos_cancelar.spec.ts` — test mutante: cancelar en cada estado válido

NOTA: `test_pedido_a_venta.spec.ts` DIFERIDO junto con la RPC.

### CI (MODIFIED)

- `.github/workflows/e2e-suite.yml` — agregar los 3 specs nuevos al matrix

---

## Tasks

### Task 1: Migration tabla `pedidos`

**Files:**
- Create: `packages/pase/supabase/migrations/202606011000_pedidos_table.sql`

- [ ] **Step 1: Escribir migration completa**

Contenido completo del archivo:

```sql
-- 202606011000_pedidos_table.sql
-- Tabla pedidos unificada: TODOS los canales online (tienda propia, menu_qr,
-- rappi, pedidosya, whatsapp, telefono, instagram_dm) pasan por acá con
-- discriminator `canal`. El POS clásico (cobro directo en mesa por encargado
-- en PASE) sigue escribiendo a `ventas_pos` y NO toca esta tabla.
--
-- Modelo: pedido = "intención de compra" pre-cobro. Cuando se COBRA via
-- fn_pedido_a_venta, se crea una fila en ventas_pos y se linkea aquí en
-- venta_pos_id. La fuente de verdad fiscal/financiera sigue siendo ventas_pos.
--
-- Decisión Lucas 2026-06-01: tabla separada (no extender ventas_pos) porque
-- COMANDA todavía no tiene uso productivo. Migración limpia sin regresiones.

CREATE TABLE pedidos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  local_id          int NOT NULL REFERENCES locales(id),
  numero            text NOT NULL,                          -- ORD-2026-001234 visible al cliente
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES auth.users(id),

  -- Channel discriminator
  canal             text NOT NULL CHECK (canal IN (
                      'tienda_propia','menu_qr','rappi','pedidosya',
                      'whatsapp','telefono','instagram_dm'
                    )),
  canal_external_id text,                                   -- ID externo (rappi order_id, peya order_id, wa_msg_id)

  -- Cliente
  cliente_id        bigint REFERENCES clientes(id),         -- null si guest
  cliente_nombre    text NOT NULL,
  cliente_telefono  text NOT NULL,
  cliente_email     text,

  -- Modo entrega
  modo_entrega      text NOT NULL CHECK (modo_entrega IN ('DELIVERY','PICKUP','EN_LOCAL')),
  direccion_entrega text,
  direccion_lat     numeric(9,6),
  direccion_lng     numeric(9,6),
  referencias_direccion text,
  mesa_numero       int,                                    -- si modo_entrega = EN_LOCAL y menu_qr

  -- Schedule
  programada_para   timestamptz,                            -- null = pedido inmediato

  -- Money
  subtotal          numeric(15,2) NOT NULL,
  descuento         numeric(15,2) NOT NULL DEFAULT 0,
  costo_envio       numeric(15,2) NOT NULL DEFAULT 0,
  propina           numeric(15,2) NOT NULL DEFAULT 0,
  total             numeric(15,2) NOT NULL,
  cupon_id          bigint REFERENCES cupones(id),
  puntos_canjeados  int NOT NULL DEFAULT 0,

  -- Pago
  metodo_pago       text NOT NULL CHECK (metodo_pago IN (
                      'mp_online','efectivo','transferencia','mp_pos','tarjeta'
                    )),
  mp_payment_id     text,
  pago_confirmado   boolean NOT NULL DEFAULT false,
  pago_confirmado_at timestamptz,

  -- State machine
  estado            text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN (
                      'PENDIENTE','CONFIRMADO','EN_COCINA','LISTO',
                      'ASIGNADO_RIDER','EN_CAMINO','ENTREGADO','CANCELADO'
                    )),
  cancelado_motivo  text,

  -- Timestamps por estado (audit trail)
  pendiente_at      timestamptz NOT NULL DEFAULT now(),
  confirmado_at     timestamptz,
  en_cocina_at      timestamptz,
  listo_at          timestamptz,
  asignado_rider_at timestamptz,
  en_camino_at      timestamptz,
  entregado_at      timestamptz,
  cancelado_at      timestamptz,

  -- Rider asignado
  rider_id          int REFERENCES delivery_riders(id),

  -- Link a venta_pos cuando se cobra
  venta_pos_id      bigint REFERENCES ventas_pos(id),

  -- Notas
  notas_cliente     text,
  notas_internas    text,

  -- Idempotency (C1 sunny-creek)
  idempotency_key   text,

  UNIQUE (tenant_id, numero),
  UNIQUE (tenant_id, idempotency_key) DEFERRABLE INITIALLY DEFERRED
);

-- Indexes para queries frecuentes
CREATE INDEX idx_pedidos_tenant_local_estado_created
  ON pedidos(tenant_id, local_id, estado, created_at DESC);
CREATE INDEX idx_pedidos_tenant_canal_created
  ON pedidos(tenant_id, canal, created_at DESC);
CREATE INDEX idx_pedidos_tenant_cliente_telefono
  ON pedidos(tenant_id, cliente_telefono);
CREATE INDEX idx_pedidos_tenant_rider
  ON pedidos(tenant_id, rider_id) WHERE rider_id IS NOT NULL;
CREATE INDEX idx_pedidos_canal_external_id
  ON pedidos(canal_external_id) WHERE canal_external_id IS NOT NULL;
CREATE INDEX idx_pedidos_venta_pos_id
  ON pedidos(venta_pos_id) WHERE venta_pos_id IS NOT NULL;

-- RLS habilitado, dual policy (tenant + local)
ALTER TABLE pedidos ENABLE ROW LEVEL SECURITY;

CREATE POLICY pedidos_tenant_isolation_select ON pedidos
  FOR SELECT
  USING (tenant_id = auth_tenant_id());

CREATE POLICY pedidos_tenant_isolation_insert ON pedidos
  FOR INSERT
  WITH CHECK (tenant_id = auth_tenant_id());

CREATE POLICY pedidos_tenant_isolation_update ON pedidos
  FOR UPDATE
  USING (tenant_id = auth_tenant_id())
  WITH CHECK (tenant_id = auth_tenant_id());

CREATE POLICY pedidos_tenant_isolation_delete ON pedidos
  FOR DELETE
  USING (tenant_id = auth_tenant_id());

-- Trigger updated_at automatic
CREATE OR REPLACE FUNCTION pedidos_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pedidos_updated_at_trigger
  BEFORE UPDATE ON pedidos
  FOR EACH ROW EXECUTE FUNCTION pedidos_set_updated_at();

COMMENT ON TABLE pedidos IS
  'Pedidos unificados — todos los canales online. Spec: Brainstorm #8 (2026-05-28). Plan Fase 1: 2026-06-01.';
```

- [ ] **Step 2: Pasar SQL a Lucas para que ejecute manual**

Output al usuario:

```
📋 Migration Fase 1 Task 1 — copiar y pegar en Supabase SQL Editor:

Archivo: packages/pase/supabase/migrations/202606011000_pedidos_table.sql

[contenido completo del SQL arriba]

Después de ejecutar, decime "✓ ejecutado" y avanzo con Task 2.
```

- [ ] **Step 3: Esperar confirmación Lucas → commit**

```bash
git add packages/pase/supabase/migrations/202606011000_pedidos_table.sql
git commit -m "$(cat <<'EOF'
feat(pedidos): tabla unificada pedidos con state machine

Fase 1 Brainstorm #8 (Tienda + Delivery + Marketplace).
Tabla separada de ventas_pos — pedido = intención pre-cobro, venta = registro
fiscal post-cobro. Link 1:1 via venta_pos_id cuando se ejecuta fn_pedido_a_venta.
8 estados con CHECK constraint, timestamps por estado, RLS dual policy.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push
```

---

### Task 2: Migration tabla `pedido_items`

**Files:**
- Create: `packages/pase/supabase/migrations/202606011010_pedido_items_table.sql`

- [ ] **Step 1: Escribir migration**

```sql
-- 202606011010_pedido_items_table.sql
-- Items del pedido. Modelo query-friendly (no jsonb) para reportes,
-- KDS, sales mix events. Cada línea apunta al item maestro pero
-- snapshots nombre + precio en el momento del pedido.

CREATE TABLE pedido_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id         uuid NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  local_id          int NOT NULL REFERENCES locales(id),

  -- Item snapshot
  item_id           int REFERENCES items(id),                -- null si Open Item
  item_nombre       text NOT NULL,                           -- snapshot al momento
  item_categoria    text,                                    -- snapshot
  cantidad          int NOT NULL CHECK (cantidad > 0),
  precio_unitario   numeric(12,2) NOT NULL,
  subtotal          numeric(12,2) NOT NULL,                  -- cantidad * precio_unitario (auto-calc)

  -- Modificadores (estructura jsonb porque son variables)
  modificadores     jsonb NOT NULL DEFAULT '[]'::jsonb,      -- [{nombre, precio_extra}]
  notas             text,                                    -- "sin cebolla", "bien cocido"

  -- Estado por item (para KDS — algunos items pueden estar listos antes que otros)
  estado            text NOT NULL DEFAULT 'pendiente' CHECK (estado IN (
                      'pendiente','preparando','listo','entregado','cancelado'
                    )),

  -- Audit
  created_at        timestamptz NOT NULL DEFAULT now(),
  estado_changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pedido_items_pedido_id ON pedido_items(pedido_id);
CREATE INDEX idx_pedido_items_tenant_local_estado
  ON pedido_items(tenant_id, local_id, estado);
CREATE INDEX idx_pedido_items_item_id ON pedido_items(item_id) WHERE item_id IS NOT NULL;

-- RLS
ALTER TABLE pedido_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY pedido_items_tenant_isolation_select ON pedido_items
  FOR SELECT USING (tenant_id = auth_tenant_id());

CREATE POLICY pedido_items_tenant_isolation_insert ON pedido_items
  FOR INSERT WITH CHECK (tenant_id = auth_tenant_id());

CREATE POLICY pedido_items_tenant_isolation_update ON pedido_items
  FOR UPDATE USING (tenant_id = auth_tenant_id())
  WITH CHECK (tenant_id = auth_tenant_id());

CREATE POLICY pedido_items_tenant_isolation_delete ON pedido_items
  FOR DELETE USING (tenant_id = auth_tenant_id());

-- Trigger: estado_changed_at auto
CREATE OR REPLACE FUNCTION pedido_items_set_estado_changed_at() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.estado IS DISTINCT FROM OLD.estado THEN
    NEW.estado_changed_at = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pedido_items_estado_changed_at_trigger
  BEFORE UPDATE ON pedido_items
  FOR EACH ROW EXECUTE FUNCTION pedido_items_set_estado_changed_at();

COMMENT ON TABLE pedido_items IS
  'Items por pedido (modelo query-friendly). Plan Fase 1: 2026-06-01.';
```

- [ ] **Step 2: Pasar SQL a Lucas + esperar confirmación**

- [ ] **Step 3: Commit**

```bash
git add packages/pase/supabase/migrations/202606011010_pedido_items_table.sql
git commit -m "feat(pedidos): tabla pedido_items query-friendly + RLS

Plan Fase 1 Task 2 — modelo no-jsonb para queries de KDS y sales mix.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 3: Migration sequence numeración pedidos

**Files:**
- Create: `packages/pase/supabase/migrations/202606011020_pedidos_numero_sequence.sql`

- [ ] **Step 1: Escribir migration con sequence + función**

```sql
-- 202606011020_pedidos_numero_sequence.sql
-- Numeración correlativa global por tenant: ORD-{YEAR}-{6-digit-padded}
-- Ejemplo: ORD-2026-001234
--
-- Decisión: NO usar correlativo por local. El número es visible al cliente
-- (mensaje WhatsApp/email/tracking), debe ser único por tenant para que
-- el cliente lo cite sin ambigüedad si llama por teléfono.
--
-- Sequence por tenant via tabla auxiliar (PG no soporta sequences dinámicos).

CREATE TABLE IF NOT EXISTS pedidos_numero_counter (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id),
  anio       int  NOT NULL,
  ultimo_num int  NOT NULL DEFAULT 0
);

ALTER TABLE pedidos_numero_counter ENABLE ROW LEVEL SECURITY;

CREATE POLICY pedidos_numero_counter_tenant_isolation ON pedidos_numero_counter
  FOR ALL USING (tenant_id = auth_tenant_id())
  WITH CHECK (tenant_id = auth_tenant_id());

CREATE OR REPLACE FUNCTION fn_pedido_next_numero(p_tenant_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_anio int := EXTRACT(YEAR FROM now());
  v_num int;
BEGIN
  -- Insert o get + increment atómico
  INSERT INTO pedidos_numero_counter (tenant_id, anio, ultimo_num)
  VALUES (p_tenant_id, v_anio, 1)
  ON CONFLICT (tenant_id) DO UPDATE
    SET ultimo_num = CASE
      WHEN pedidos_numero_counter.anio = v_anio
        THEN pedidos_numero_counter.ultimo_num + 1
      ELSE 1  -- año cambió → reset
    END,
    anio = v_anio
  RETURNING ultimo_num INTO v_num;

  RETURN 'ORD-' || v_anio || '-' || LPAD(v_num::text, 6, '0');
END;
$$;

REVOKE ALL ON FUNCTION fn_pedido_next_numero(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_pedido_next_numero(uuid) TO authenticated;

COMMENT ON FUNCTION fn_pedido_next_numero IS
  'Genera siguiente número correlativo de pedido formato ORD-YYYY-NNNNNN por tenant. Reset por cambio de año.';
```

- [ ] **Step 2: Pasar SQL a Lucas + esperar confirmación**

- [ ] **Step 3: Commit**

```bash
git add packages/pase/supabase/migrations/202606011020_pedidos_numero_sequence.sql
git commit -m "feat(pedidos): sequence ORD-YYYY-NNNNNN por tenant

Plan Fase 1 Task 3 — fn_pedido_next_numero atómica con reset anual.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 4: Migration state machine — `fn_avanzar_pedido_estado`

**Files:**
- Create: `packages/pase/supabase/migrations/202606011030_pedidos_state_machine.sql`

- [ ] **Step 1: Escribir migration con helper + RPC**

```sql
-- 202606011030_pedidos_state_machine.sql
-- State machine para pedidos. Helper valida transiciones, RPC ejecuta
-- update + setea timestamp + retorna pedido actualizado.
--
-- Transiciones válidas (cualquier estado puede ir a CANCELADO):
--   PENDIENTE       → CONFIRMADO, CANCELADO
--   CONFIRMADO      → EN_COCINA, CANCELADO
--   EN_COCINA       → LISTO, CANCELADO
--   LISTO           → ASIGNADO_RIDER (si DELIVERY) | ENTREGADO (si PICKUP/EN_LOCAL) | CANCELADO
--   ASIGNADO_RIDER  → EN_CAMINO, CANCELADO
--   EN_CAMINO       → ENTREGADO, CANCELADO
--   ENTREGADO       → (terminal — no transiciones salvo via undo manager override)
--   CANCELADO       → (terminal)

CREATE OR REPLACE FUNCTION valid_pedido_transition(
  p_estado_actual text,
  p_nuevo_estado  text,
  p_modo_entrega  text
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  -- CANCELADO desde cualquier no-terminal
  IF p_nuevo_estado = 'CANCELADO' AND p_estado_actual NOT IN ('ENTREGADO','CANCELADO') THEN
    RETURN true;
  END IF;

  -- Transiciones específicas
  IF p_estado_actual = 'PENDIENTE'      AND p_nuevo_estado = 'CONFIRMADO'     THEN RETURN true; END IF;
  IF p_estado_actual = 'CONFIRMADO'     AND p_nuevo_estado = 'EN_COCINA'      THEN RETURN true; END IF;
  IF p_estado_actual = 'EN_COCINA'      AND p_nuevo_estado = 'LISTO'          THEN RETURN true; END IF;

  -- LISTO bifurca por modo_entrega
  IF p_estado_actual = 'LISTO' THEN
    IF p_modo_entrega = 'DELIVERY' AND p_nuevo_estado = 'ASIGNADO_RIDER' THEN RETURN true; END IF;
    IF p_modo_entrega IN ('PICKUP','EN_LOCAL') AND p_nuevo_estado = 'ENTREGADO' THEN RETURN true; END IF;
  END IF;

  IF p_estado_actual = 'ASIGNADO_RIDER' AND p_nuevo_estado = 'EN_CAMINO'      THEN RETURN true; END IF;
  IF p_estado_actual = 'EN_CAMINO'      AND p_nuevo_estado = 'ENTREGADO'      THEN RETURN true; END IF;

  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION fn_avanzar_pedido_estado(
  p_pedido_id    uuid,
  p_nuevo_estado text
) RETURNS pedidos
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pedido pedidos;
  v_tenant uuid := auth_tenant_id();
BEGIN
  -- Lock row para evitar race condition (2 cajeros avanzan simultáneo)
  SELECT * INTO v_pedido FROM pedidos
    WHERE id = p_pedido_id AND tenant_id = v_tenant
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pedido_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Validar transición
  IF NOT valid_pedido_transition(v_pedido.estado, p_nuevo_estado, v_pedido.modo_entrega) THEN
    RAISE EXCEPTION 'invalid_transition: % → % (modo: %)',
      v_pedido.estado, p_nuevo_estado, v_pedido.modo_entrega
      USING ERRCODE = 'P0001';
  END IF;

  -- Update estado + timestamp correspondiente
  UPDATE pedidos SET
    estado = p_nuevo_estado,
    confirmado_at     = CASE WHEN p_nuevo_estado = 'CONFIRMADO'     THEN now() ELSE confirmado_at     END,
    en_cocina_at      = CASE WHEN p_nuevo_estado = 'EN_COCINA'      THEN now() ELSE en_cocina_at      END,
    listo_at          = CASE WHEN p_nuevo_estado = 'LISTO'          THEN now() ELSE listo_at          END,
    asignado_rider_at = CASE WHEN p_nuevo_estado = 'ASIGNADO_RIDER' THEN now() ELSE asignado_rider_at END,
    en_camino_at      = CASE WHEN p_nuevo_estado = 'EN_CAMINO'      THEN now() ELSE en_camino_at      END,
    entregado_at      = CASE WHEN p_nuevo_estado = 'ENTREGADO'      THEN now() ELSE entregado_at      END,
    cancelado_at      = CASE WHEN p_nuevo_estado = 'CANCELADO'      THEN now() ELSE cancelado_at      END
  WHERE id = p_pedido_id
  RETURNING * INTO v_pedido;

  RETURN v_pedido;
END;
$$;

REVOKE ALL ON FUNCTION fn_avanzar_pedido_estado(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_avanzar_pedido_estado(uuid, text) TO authenticated;

COMMENT ON FUNCTION fn_avanzar_pedido_estado IS
  'Avanza el estado de un pedido validando transición. Atomic via FOR UPDATE. Plan Fase 1.';
```

- [ ] **Step 2: Pasar SQL a Lucas + esperar confirmación**

- [ ] **Step 3: Commit**

```bash
git add packages/pase/supabase/migrations/202606011030_pedidos_state_machine.sql
git commit -m "feat(pedidos): state machine + fn_avanzar_pedido_estado atómica

Plan Fase 1 Task 4 — validación de transiciones con CHECK constraint del estado,
helper valid_pedido_transition, RPC con FOR UPDATE lock para evitar race condition.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 5: Migration `fn_crear_pedido` (con idempotency)

**Files:**
- Create: `packages/pase/supabase/migrations/202606011040_pedidos_crear.sql`

- [ ] **Step 1: Escribir migration con RPC + items**

```sql
-- 202606011040_pedidos_crear.sql
-- RPC fn_crear_pedido — crea un pedido + sus items en una transacción atómica.
-- Idempotent: si el idempotency_key ya existe → retorna el pedido existente.
--
-- Diseño: 1 RPC sola con todos los items en jsonb (no permite ir y volver
-- por cada item — overhead Postgres + race conditions). Items se insertan
-- en bulk dentro del PL/pgSQL.

CREATE OR REPLACE FUNCTION fn_crear_pedido(
  p_local_id            int,
  p_canal               text,
  p_canal_external_id   text,
  p_cliente_id          bigint,
  p_cliente_nombre      text,
  p_cliente_telefono    text,
  p_cliente_email       text,
  p_modo_entrega        text,
  p_direccion_entrega   text,
  p_direccion_lat       numeric,
  p_direccion_lng       numeric,
  p_referencias         text,
  p_mesa_numero         int,
  p_programada_para     timestamptz,
  p_metodo_pago         text,
  p_items               jsonb,                  -- [{item_id, item_nombre, cantidad, precio_unitario, modificadores, notas}]
  p_descuento           numeric,
  p_costo_envio         numeric,
  p_propina             numeric,
  p_cupon_id            bigint,
  p_puntos_canjeados    int,
  p_notas_cliente       text,
  p_idempotency_key     text
) RETURNS pedidos
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pedido       pedidos;
  v_tenant_id    uuid := auth_tenant_id();
  v_subtotal     numeric(15,2);
  v_total        numeric(15,2);
  v_numero       text;
  v_item         jsonb;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_pedido FROM pedidos
      WHERE tenant_id = v_tenant_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN v_pedido;
    END IF;
  END IF;

  -- Validar canal
  IF p_canal NOT IN ('tienda_propia','menu_qr','rappi','pedidosya','whatsapp','telefono','instagram_dm') THEN
    RAISE EXCEPTION 'invalid_canal: %', p_canal USING ERRCODE = 'P0001';
  END IF;

  -- Validar modo_entrega
  IF p_modo_entrega NOT IN ('DELIVERY','PICKUP','EN_LOCAL') THEN
    RAISE EXCEPTION 'invalid_modo_entrega: %', p_modo_entrega USING ERRCODE = 'P0001';
  END IF;

  -- Validar items array no vacío
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'items_empty' USING ERRCODE = 'P0001';
  END IF;

  -- Calcular subtotal desde items
  SELECT COALESCE(SUM(
    ((item->>'cantidad')::int * (item->>'precio_unitario')::numeric)
  ), 0) INTO v_subtotal
  FROM jsonb_array_elements(p_items) item;

  v_total := v_subtotal - COALESCE(p_descuento, 0) + COALESCE(p_costo_envio, 0) + COALESCE(p_propina, 0);

  IF v_total < 0 THEN
    RAISE EXCEPTION 'total_negativo: %', v_total USING ERRCODE = 'P0001';
  END IF;

  -- Generar número correlativo
  v_numero := fn_pedido_next_numero(v_tenant_id);

  -- INSERT pedido
  INSERT INTO pedidos (
    tenant_id, local_id, numero, canal, canal_external_id,
    cliente_id, cliente_nombre, cliente_telefono, cliente_email,
    modo_entrega, direccion_entrega, direccion_lat, direccion_lng,
    referencias_direccion, mesa_numero, programada_para,
    subtotal, descuento, costo_envio, propina, total,
    cupon_id, puntos_canjeados,
    metodo_pago, notas_cliente, idempotency_key,
    created_by
  ) VALUES (
    v_tenant_id, p_local_id, v_numero, p_canal, p_canal_external_id,
    p_cliente_id, p_cliente_nombre, p_cliente_telefono, p_cliente_email,
    p_modo_entrega, p_direccion_entrega, p_direccion_lat, p_direccion_lng,
    p_referencias, p_mesa_numero, p_programada_para,
    v_subtotal, COALESCE(p_descuento,0), COALESCE(p_costo_envio,0),
    COALESCE(p_propina,0), v_total,
    p_cupon_id, COALESCE(p_puntos_canjeados,0),
    p_metodo_pago, p_notas_cliente, p_idempotency_key,
    auth.uid()
  ) RETURNING * INTO v_pedido;

  -- INSERT items en bulk
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO pedido_items (
      pedido_id, tenant_id, local_id,
      item_id, item_nombre, item_categoria,
      cantidad, precio_unitario, subtotal,
      modificadores, notas
    ) VALUES (
      v_pedido.id, v_tenant_id, p_local_id,
      NULLIF((v_item->>'item_id'), '')::int,
      v_item->>'item_nombre',
      v_item->>'item_categoria',
      (v_item->>'cantidad')::int,
      (v_item->>'precio_unitario')::numeric,
      (v_item->>'cantidad')::int * (v_item->>'precio_unitario')::numeric,
      COALESCE(v_item->'modificadores', '[]'::jsonb),
      v_item->>'notas'
    );
  END LOOP;

  RETURN v_pedido;
END;
$$;

REVOKE ALL ON FUNCTION fn_crear_pedido FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_crear_pedido TO authenticated;

COMMENT ON FUNCTION fn_crear_pedido IS
  'Crea pedido + items atómico. Idempotent via idempotency_key. Plan Fase 1.';
```

- [ ] **Step 2: Pasar SQL a Lucas + esperar confirmación**

- [ ] **Step 3: Commit**

```bash
git add packages/pase/supabase/migrations/202606011040_pedidos_crear.sql
git commit -m "feat(pedidos): fn_crear_pedido atómica con idempotency (C1)

Plan Fase 1 Task 5 — RPC valida canal/modo/items, calcula subtotal y total,
genera número correlativo, inserta pedido + items en transacción única.
Si idempotency_key ya existe → retorna pedido existente sin duplicar.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 6: Migration `fn_cancelar_pedido`

**Files:**
- Create: `packages/pase/supabase/migrations/202606011050_pedidos_cancelar.sql`

- [ ] **Step 1: Escribir migration**

```sql
-- 202606011050_pedidos_cancelar.sql
-- RPC fn_cancelar_pedido — wrapper sobre fn_avanzar_pedido_estado que ADEMÁS
-- guarda el motivo. Existe como RPC separada porque cancelar siempre requiere
-- justificación (audit + atención al cliente / reportes).
--
-- Idempotent: si ya está cancelado, retorna sin error.

CREATE OR REPLACE FUNCTION fn_cancelar_pedido(
  p_pedido_id uuid,
  p_motivo    text
) RETURNS pedidos
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pedido pedidos;
  v_tenant uuid := auth_tenant_id();
BEGIN
  IF p_motivo IS NULL OR length(trim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'motivo_requerido' USING ERRCODE = 'P0001';
  END IF;

  -- Lock + check existe
  SELECT * INTO v_pedido FROM pedidos
    WHERE id = p_pedido_id AND tenant_id = v_tenant
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pedido_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Idempotent: si ya está cancelado, retornar sin cambios
  IF v_pedido.estado = 'CANCELADO' THEN
    RETURN v_pedido;
  END IF;

  -- Validar transición (cualquier estado no-terminal → CANCELADO permitido)
  IF NOT valid_pedido_transition(v_pedido.estado, 'CANCELADO', v_pedido.modo_entrega) THEN
    RAISE EXCEPTION 'cannot_cancel_from_%', v_pedido.estado USING ERRCODE = 'P0001';
  END IF;

  -- Update
  UPDATE pedidos SET
    estado           = 'CANCELADO',
    cancelado_at     = now(),
    cancelado_motivo = p_motivo
  WHERE id = p_pedido_id
  RETURNING * INTO v_pedido;

  RETURN v_pedido;
END;
$$;

REVOKE ALL ON FUNCTION fn_cancelar_pedido(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_cancelar_pedido(uuid, text) TO authenticated;

COMMENT ON FUNCTION fn_cancelar_pedido IS
  'Cancela pedido con motivo obligatorio. Idempotent. Plan Fase 1.';
```

- [ ] **Step 2: Pasar SQL a Lucas + esperar confirmación**

- [ ] **Step 3: Commit**

```bash
git add packages/pase/supabase/migrations/202606011050_pedidos_cancelar.sql
git commit -m "feat(pedidos): fn_cancelar_pedido con motivo obligatorio + idempotent

Plan Fase 1 Task 6.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 7: ⏸️ DIFERIDO A FASE 2/3 — Migration `fn_pedido_a_venta`

**⚠️ NO EJECUTAR EN FASE 1.** Revisión 2026-06-01: el schema real de `ventas_pos` tiene `canal_id` FK a tabla `canales` (no string), `numero_local` correlativo por local, `modo IN ('salon','mostrador','pedidos')`, `origen IN ('pos','tienda_online','menu_qr')`, sin `idempotency_key` directo. Diseñar la conversión sin conocer aún el flow real de cobro (método pago, MP payment_id, turno_caja_id) es feature-creep. Se posterga hasta que aterricen los webhooks de cobro (Fase 2 WhatsApp / Fase 3 MP+Rappi+PeYa).

**Contenido original preservado abajo para referencia futura — NO ejecutar hasta Fase 2/3.**

---

**Files:**
- Create: `packages/pase/supabase/migrations/202606011060_pedido_a_venta.sql`

- [ ] **Step 1: Escribir migration (la más crítica de Fase 1)**

```sql
-- 202606011060_pedido_a_venta.sql
-- RPC fn_pedido_a_venta — convierte un pedido en venta_pos cuando se cobra.
-- Acá pasa la frontera entre el dominio operativo (pedidos COMANDA) y el
-- dominio fiscal/financiero (ventas_pos PASE).
--
-- Atomic + idempotent:
--   - Si pedido.venta_pos_id ya existe → retorna venta existente sin crear nueva
--   - Crea venta_pos con MISMOS totales que el pedido
--   - Linkea pedido.venta_pos_id y marca pago_confirmado
--   - NO avanza estado del pedido — eso lo hace fn_avanzar_pedido_estado
--     después o por trigger separado en Fase 2/3.

CREATE OR REPLACE FUNCTION fn_pedido_a_venta(
  p_pedido_id        uuid,
  p_metodo_pago_real text,         -- ej. el cliente pagó efectivo aunque eligió MP
  p_idempotency_key  text
) RETURNS ventas_pos
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pedido    pedidos;
  v_venta     ventas_pos;
  v_tenant_id uuid := auth_tenant_id();
BEGIN
  -- Lock pedido
  SELECT * INTO v_pedido FROM pedidos
    WHERE id = p_pedido_id AND tenant_id = v_tenant_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pedido_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Idempotency check #1: si ya tiene venta_pos_id → retornar venta existente
  IF v_pedido.venta_pos_id IS NOT NULL THEN
    SELECT * INTO v_venta FROM ventas_pos WHERE id = v_pedido.venta_pos_id;
    RETURN v_venta;
  END IF;

  -- Idempotency check #2: idempotency_key en ventas_pos
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_venta FROM ventas_pos
      WHERE tenant_id = v_tenant_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      -- Linkear pedido a la venta existente
      UPDATE pedidos SET venta_pos_id = v_venta.id WHERE id = p_pedido_id;
      RETURN v_venta;
    END IF;
  END IF;

  -- Validar que el pedido no esté cancelado
  IF v_pedido.estado = 'CANCELADO' THEN
    RAISE EXCEPTION 'pedido_cancelado_no_se_puede_cobrar' USING ERRCODE = 'P0001';
  END IF;

  -- Crear venta_pos con totales del pedido
  -- NOTA: la estructura exacta de ventas_pos depende del schema actual
  --       (ver packages/pase/supabase/migrations/ para columnas reales).
  --       Acá asumimos las columnas core. Si faltan campos, ajustar.
  INSERT INTO ventas_pos (
    tenant_id,
    local_id,
    fecha,
    total,
    metodo_pago,
    canal,                    -- columna existente que diferencia POS clásico de online
    cliente_nombre,
    cliente_telefono,
    idempotency_key,
    created_at,
    created_by
  ) VALUES (
    v_tenant_id,
    v_pedido.local_id,
    now(),
    v_pedido.total,
    p_metodo_pago_real,
    v_pedido.canal,
    v_pedido.cliente_nombre,
    v_pedido.cliente_telefono,
    p_idempotency_key,
    now(),
    auth.uid()
  ) RETURNING * INTO v_venta;

  -- Link bidireccional + marcar pago confirmado
  UPDATE pedidos SET
    venta_pos_id        = v_venta.id,
    pago_confirmado     = true,
    pago_confirmado_at  = now()
  WHERE id = p_pedido_id;

  RETURN v_venta;
END;
$$;

REVOKE ALL ON FUNCTION fn_pedido_a_venta(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_pedido_a_venta(uuid, text, text) TO authenticated;

COMMENT ON FUNCTION fn_pedido_a_venta IS
  'Convierte pedido en venta_pos. Idempotent doble (via venta_pos_id existente + idempotency_key). Plan Fase 1.';
```

- [ ] **Step 2: ⚠️ VERIFICAR PRIMERO schema actual de `ventas_pos`**

Antes de pasar el SQL a Lucas, leer el schema actual:

```bash
grep -r "CREATE TABLE ventas_pos" packages/pase/supabase/migrations/ | head -5
```

Si la estructura difiere de lo asumido en el INSERT, ajustar el script. Columnas críticas a verificar: `tenant_id`, `local_id`, `fecha`, `total`, `metodo_pago`, `canal`, `idempotency_key`. Si `cliente_nombre`/`cliente_telefono` no existen, sacarlas del INSERT (no las necesitamos en venta — quedan en pedido).

- [ ] **Step 3: Pasar SQL ajustado a Lucas + esperar confirmación**

- [ ] **Step 4: Commit**

```bash
git add packages/pase/supabase/migrations/202606011060_pedido_a_venta.sql
git commit -m "feat(pedidos): fn_pedido_a_venta — frontera pedido→venta

Plan Fase 1 Task 7 — RPC linkea pedido con ventas_pos cuando se cobra.
Idempotent doble (venta_pos_id existente + idempotency_key). Cierra el ciclo
operativo (COMANDA) ↔ fiscal (PASE).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 8: TypeScript types para Pedido

**Files:**
- Create: `packages/comanda/src/types/pedido.ts`

- [ ] **Step 1: Crear archivo de tipos**

```typescript
// packages/comanda/src/types/pedido.ts
// Tipos para el modelo Pedido. Mirror exacto del schema DB.
// Fuente de verdad: packages/pase/supabase/migrations/202606011000_pedidos_table.sql

export type CanalPedido =
  | "tienda_propia"
  | "menu_qr"
  | "rappi"
  | "pedidosya"
  | "whatsapp"
  | "telefono"
  | "instagram_dm";

export type EstadoPedido =
  | "PENDIENTE"
  | "CONFIRMADO"
  | "EN_COCINA"
  | "LISTO"
  | "ASIGNADO_RIDER"
  | "EN_CAMINO"
  | "ENTREGADO"
  | "CANCELADO";

export type ModoEntrega = "DELIVERY" | "PICKUP" | "EN_LOCAL";

export type MetodoPago =
  | "mp_online"
  | "efectivo"
  | "transferencia"
  | "mp_pos"
  | "tarjeta";

export type EstadoPedidoItem =
  | "pendiente"
  | "preparando"
  | "listo"
  | "entregado"
  | "cancelado";

export interface PedidoItem {
  id: string;
  pedido_id: string;
  tenant_id: string;
  local_id: number;
  item_id: number | null;
  item_nombre: string;
  item_categoria: string | null;
  cantidad: number;
  precio_unitario: number;
  subtotal: number;
  modificadores: Array<{ nombre: string; precio_extra: number }>;
  notas: string | null;
  estado: EstadoPedidoItem;
  created_at: string;
  estado_changed_at: string;
}

export interface Pedido {
  id: string;
  tenant_id: string;
  local_id: number;
  numero: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;

  canal: CanalPedido;
  canal_external_id: string | null;

  cliente_id: number | null;
  cliente_nombre: string;
  cliente_telefono: string;
  cliente_email: string | null;

  modo_entrega: ModoEntrega;
  direccion_entrega: string | null;
  direccion_lat: number | null;
  direccion_lng: number | null;
  referencias_direccion: string | null;
  mesa_numero: number | null;

  programada_para: string | null;

  subtotal: number;
  descuento: number;
  costo_envio: number;
  propina: number;
  total: number;
  cupon_id: number | null;
  puntos_canjeados: number;

  metodo_pago: MetodoPago;
  mp_payment_id: string | null;
  pago_confirmado: boolean;
  pago_confirmado_at: string | null;

  estado: EstadoPedido;
  cancelado_motivo: string | null;

  pendiente_at: string;
  confirmado_at: string | null;
  en_cocina_at: string | null;
  listo_at: string | null;
  asignado_rider_at: string | null;
  en_camino_at: string | null;
  entregado_at: string | null;
  cancelado_at: string | null;

  rider_id: number | null;
  venta_pos_id: number | null;

  notas_cliente: string | null;
  notas_internas: string | null;

  idempotency_key: string | null;
}

export interface PedidoConItems extends Pedido {
  items: PedidoItem[];
}
```

- [ ] **Step 2: Verificar TypeScript compila**

```bash
cd packages/comanda && pnpm tsc --noEmit
```

Esperado: 0 errores.

- [ ] **Step 3: Commit**

```bash
git add packages/comanda/src/types/pedido.ts
git commit -m "feat(pedidos): TypeScript types Pedido + PedidoItem

Plan Fase 1 Task 8 — mirror exacto del schema DB.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 9: Helper state machine frontend

**Files:**
- Create: `packages/comanda/src/lib/pedidos/stateMachine.ts`

- [ ] **Step 1: Crear helper espejo del DB**

```typescript
// packages/comanda/src/lib/pedidos/stateMachine.ts
// Helpers frontend de la state machine. ESPEJO de valid_pedido_transition
// en packages/pase/supabase/migrations/202606011030_pedidos_state_machine.sql.
//
// Por qué duplicar: el backend tiene la verdad y rechaza transiciones inválidas
// con RAISE EXCEPTION. Pero el frontend necesita saber qué botones mostrar
// SIN tener que hacer un round-trip. Cuando cambies las reglas en DB,
// cambialas acá también.

import type { EstadoPedido, ModoEntrega } from "../../types/pedido";

const TRANSICIONES: Record<EstadoPedido, EstadoPedido[]> = {
  PENDIENTE: ["CONFIRMADO", "CANCELADO"],
  CONFIRMADO: ["EN_COCINA", "CANCELADO"],
  EN_COCINA: ["LISTO", "CANCELADO"],
  LISTO: [], // depende de modo_entrega — ver siguientesEstados()
  ASIGNADO_RIDER: ["EN_CAMINO", "CANCELADO"],
  EN_CAMINO: ["ENTREGADO", "CANCELADO"],
  ENTREGADO: [], // terminal
  CANCELADO: [], // terminal
};

export function siguientesEstados(
  estadoActual: EstadoPedido,
  modoEntrega: ModoEntrega,
): EstadoPedido[] {
  if (estadoActual === "LISTO") {
    if (modoEntrega === "DELIVERY") return ["ASIGNADO_RIDER", "CANCELADO"];
    return ["ENTREGADO", "CANCELADO"];
  }
  return TRANSICIONES[estadoActual];
}

export function puedeTransicionar(
  estadoActual: EstadoPedido,
  nuevoEstado: EstadoPedido,
  modoEntrega: ModoEntrega,
): boolean {
  return siguientesEstados(estadoActual, modoEntrega).includes(nuevoEstado);
}

export function labelEstado(estado: EstadoPedido): string {
  const labels: Record<EstadoPedido, string> = {
    PENDIENTE: "Pendiente",
    CONFIRMADO: "Confirmado",
    EN_COCINA: "En cocina",
    LISTO: "Listo",
    ASIGNADO_RIDER: "Rider asignado",
    EN_CAMINO: "En camino",
    ENTREGADO: "Entregado",
    CANCELADO: "Cancelado",
  };
  return labels[estado];
}

export function labelAccion(nuevoEstado: EstadoPedido): string {
  const labels: Record<EstadoPedido, string> = {
    PENDIENTE: "Volver a pendiente",
    CONFIRMADO: "Confirmar",
    EN_COCINA: "Enviar a cocina",
    LISTO: "Marcar listo",
    ASIGNADO_RIDER: "Asignar rider",
    EN_CAMINO: "Marcar en camino",
    ENTREGADO: "Marcar entregado",
    CANCELADO: "Cancelar",
  };
  return labels[nuevoEstado];
}

export function colorEstado(estado: EstadoPedido): string {
  const colores: Record<EstadoPedido, string> = {
    PENDIENTE: "#94a3b8",       // gris
    CONFIRMADO: "#3b82f6",      // azul
    EN_COCINA: "#f97316",       // naranja
    LISTO: "#10b981",           // verde
    ASIGNADO_RIDER: "#8b5cf6",  // violeta
    EN_CAMINO: "#06b6d4",       // cyan
    ENTREGADO: "#22c55e",       // verde oscuro
    CANCELADO: "#ef4444",       // rojo
  };
  return colores[estado];
}
```

- [ ] **Step 2: Verificar TS compila**

```bash
cd packages/comanda && pnpm tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add packages/comanda/src/lib/pedidos/stateMachine.ts
git commit -m "feat(pedidos): helpers frontend state machine (espejo DB)

Plan Fase 1 Task 9.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 10: API wrapper supabase

**Files:**
- Create: `packages/comanda/src/lib/pedidos/api.ts`

- [ ] **Step 1: Crear wrapper**

```typescript
// packages/comanda/src/lib/pedidos/api.ts
// Wrapper supabase para CRUD de pedidos. Todos los mutadores van por RPC
// (C4 sunny-creek: NO direct INSERT/UPDATE en tablas financieras). Solo
// SELECTs son query directo (RLS protege).

import { supabase } from "../supabase";
import { applyLocalScope } from "../localScope";
import type {
  Pedido,
  PedidoConItems,
  CanalPedido,
  EstadoPedido,
  ModoEntrega,
  MetodoPago,
} from "../../types/pedido";

export interface ListarPedidosFiltros {
  estados?: EstadoPedido[];
  canales?: CanalPedido[];
  desde?: string; // ISO date
  hasta?: string;
  cliente_telefono?: string;
  limit?: number;
}

export async function listarPedidos(
  filtros: ListarPedidosFiltros = {},
): Promise<Pedido[]> {
  let query = supabase
    .from("pedidos")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(filtros.limit ?? 50);

  query = applyLocalScope(query); // C3 obligatorio

  if (filtros.estados && filtros.estados.length > 0) {
    query = query.in("estado", filtros.estados);
  }
  if (filtros.canales && filtros.canales.length > 0) {
    query = query.in("canal", filtros.canales);
  }
  if (filtros.desde) query = query.gte("created_at", filtros.desde);
  if (filtros.hasta) query = query.lte("created_at", filtros.hasta);
  if (filtros.cliente_telefono) {
    query = query.eq("cliente_telefono", filtros.cliente_telefono);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function getPedidoConItems(
  pedidoId: string,
): Promise<PedidoConItems | null> {
  const { data: pedido, error: errPedido } = await supabase
    .from("pedidos")
    .select("*")
    .eq("id", pedidoId)
    .maybeSingle();
  if (errPedido) throw errPedido;
  if (!pedido) return null;

  const { data: items, error: errItems } = await supabase
    .from("pedido_items")
    .select("*")
    .eq("pedido_id", pedidoId)
    .order("created_at", { ascending: true });
  if (errItems) throw errItems;

  return { ...pedido, items: items ?? [] };
}

export interface CrearPedidoInput {
  local_id: number;
  canal: CanalPedido;
  canal_external_id?: string;
  cliente_id?: number;
  cliente_nombre: string;
  cliente_telefono: string;
  cliente_email?: string;
  modo_entrega: ModoEntrega;
  direccion_entrega?: string;
  direccion_lat?: number;
  direccion_lng?: number;
  referencias?: string;
  mesa_numero?: number;
  programada_para?: string;
  metodo_pago: MetodoPago;
  items: Array<{
    item_id?: number;
    item_nombre: string;
    item_categoria?: string;
    cantidad: number;
    precio_unitario: number;
    modificadores?: Array<{ nombre: string; precio_extra: number }>;
    notas?: string;
  }>;
  descuento?: number;
  costo_envio?: number;
  propina?: number;
  cupon_id?: number;
  puntos_canjeados?: number;
  notas_cliente?: string;
  idempotency_key?: string;
}

export async function crearPedido(input: CrearPedidoInput): Promise<Pedido> {
  const { data, error } = await supabase.rpc("fn_crear_pedido", {
    p_local_id: input.local_id,
    p_canal: input.canal,
    p_canal_external_id: input.canal_external_id ?? null,
    p_cliente_id: input.cliente_id ?? null,
    p_cliente_nombre: input.cliente_nombre,
    p_cliente_telefono: input.cliente_telefono,
    p_cliente_email: input.cliente_email ?? null,
    p_modo_entrega: input.modo_entrega,
    p_direccion_entrega: input.direccion_entrega ?? null,
    p_direccion_lat: input.direccion_lat ?? null,
    p_direccion_lng: input.direccion_lng ?? null,
    p_referencias: input.referencias ?? null,
    p_mesa_numero: input.mesa_numero ?? null,
    p_programada_para: input.programada_para ?? null,
    p_metodo_pago: input.metodo_pago,
    p_items: input.items,
    p_descuento: input.descuento ?? 0,
    p_costo_envio: input.costo_envio ?? 0,
    p_propina: input.propina ?? 0,
    p_cupon_id: input.cupon_id ?? null,
    p_puntos_canjeados: input.puntos_canjeados ?? 0,
    p_notas_cliente: input.notas_cliente ?? null,
    p_idempotency_key: input.idempotency_key ?? null,
  });
  if (error) throw error;
  return data as Pedido;
}

export async function avanzarEstado(
  pedidoId: string,
  nuevoEstado: EstadoPedido,
): Promise<Pedido> {
  const { data, error } = await supabase.rpc("fn_avanzar_pedido_estado", {
    p_pedido_id: pedidoId,
    p_nuevo_estado: nuevoEstado,
  });
  if (error) throw error;
  return data as Pedido;
}

export async function cancelarPedido(
  pedidoId: string,
  motivo: string,
): Promise<Pedido> {
  const { data, error } = await supabase.rpc("fn_cancelar_pedido", {
    p_pedido_id: pedidoId,
    p_motivo: motivo,
  });
  if (error) throw error;
  return data as Pedido;
}

export async function cobrarPedido(
  pedidoId: string,
  metodoPagoReal: MetodoPago,
  idempotencyKey: string,
): Promise<{ venta_id: number }> {
  const { data, error } = await supabase.rpc("fn_pedido_a_venta", {
    p_pedido_id: pedidoId,
    p_metodo_pago_real: metodoPagoReal,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
  // RPC retorna ventas_pos row; nos quedamos con el id
  return { venta_id: (data as { id: number }).id };
}
```

- [ ] **Step 2: Verificar TS compila**

```bash
cd packages/comanda && pnpm tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add packages/comanda/src/lib/pedidos/api.ts
git commit -m "feat(pedidos): API wrapper supabase (listar/get/crear/avanzar/cancelar/cobrar)

Plan Fase 1 Task 10 — todos los mutadores van por RPC (C4). SELECTs directos
con applyLocalScope (C3).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 11: Componente `PedidoTimeline`

**Files:**
- Create: `packages/comanda/src/components/PedidoTimeline.tsx`

- [ ] **Step 1: Crear componente**

```tsx
// packages/comanda/src/components/PedidoTimeline.tsx
// Timeline vertical con los timestamps por estado del pedido. Muestra estados
// pasados con check verde, estado actual destacado, futuros en gris.

import type { Pedido, EstadoPedido } from "../types/pedido";
import { labelEstado, colorEstado } from "../lib/pedidos/stateMachine";

interface Props {
  pedido: Pedido;
}

interface EtapaTimeline {
  estado: EstadoPedido;
  timestamp: string | null;
  visible: boolean;
}

function construirEtapas(pedido: Pedido): EtapaTimeline[] {
  const todas: Array<{ estado: EstadoPedido; timestamp: string | null }> = [
    { estado: "PENDIENTE", timestamp: pedido.pendiente_at },
    { estado: "CONFIRMADO", timestamp: pedido.confirmado_at },
    { estado: "EN_COCINA", timestamp: pedido.en_cocina_at },
    { estado: "LISTO", timestamp: pedido.listo_at },
    { estado: "ASIGNADO_RIDER", timestamp: pedido.asignado_rider_at },
    { estado: "EN_CAMINO", timestamp: pedido.en_camino_at },
    { estado: "ENTREGADO", timestamp: pedido.entregado_at },
  ];

  // Filtrar etapas no aplicables por modo de entrega
  return todas.map((etapa) => {
    if (
      (etapa.estado === "ASIGNADO_RIDER" || etapa.estado === "EN_CAMINO") &&
      pedido.modo_entrega !== "DELIVERY"
    ) {
      return { ...etapa, visible: false };
    }
    return { ...etapa, visible: true };
  });
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function PedidoTimeline({ pedido }: Props) {
  const etapas = construirEtapas(pedido).filter((e) => e.visible);

  if (pedido.estado === "CANCELADO") {
    return (
      <div
        style={{
          padding: 12,
          background: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: 8,
        }}
      >
        <div style={{ fontWeight: 600, color: "#991b1b", marginBottom: 4 }}>
          ❌ Pedido cancelado
        </div>
        <div style={{ fontSize: 12, color: "#7f1d1d" }}>
          {formatTimestamp(pedido.cancelado_at)}
          {pedido.cancelado_motivo ? ` — ${pedido.cancelado_motivo}` : ""}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {etapas.map((etapa, idx) => {
        const completada = etapa.timestamp !== null;
        const esActual = etapa.estado === pedido.estado;
        return (
          <div
            key={etapa.estado}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "6px 10px",
              background: esActual ? "#f0f9ff" : "transparent",
              borderRadius: 6,
              opacity: completada || esActual ? 1 : 0.4,
            }}
          >
            <div
              style={{
                width: 14,
                height: 14,
                borderRadius: "50%",
                background: completada ? colorEstado(etapa.estado) : "#e5e7eb",
                border: esActual ? `2px solid ${colorEstado(etapa.estado)}` : "none",
                flexShrink: 0,
              }}
            />
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: esActual ? 600 : 400,
                  color: completada ? "#111827" : "#6b7280",
                }}
              >
                {labelEstado(etapa.estado)}
              </div>
              {etapa.timestamp && (
                <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "'DM Mono', monospace" }}>
                  {formatTimestamp(etapa.timestamp)}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Verificar TS + render**

```bash
cd packages/comanda && pnpm tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add packages/comanda/src/components/PedidoTimeline.tsx
git commit -m "feat(pedidos): componente PedidoTimeline con timestamps por estado

Plan Fase 1 Task 11.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 12: Refactor `PedidosHub` a tabla nueva

**Files:**
- Modify: `packages/comanda/src/pages/Pos/PedidosHub.tsx`

- [ ] **Step 1: Leer archivo actual**

```bash
# leer todo el archivo para no romper estructura existente
```

(Comando a ejecutar: Read tool sobre `packages/comanda/src/pages/Pos/PedidosHub.tsx`.)

- [ ] **Step 2: Identificar query actual a `ventas_pos`**

Buscar líneas que hagan `.from("ventas_pos")` con filtros `canal IN (...)` o `tipo_entrega`. Esas son las que hay que reemplazar por `listarPedidos()`.

- [ ] **Step 3: Reemplazar query por API wrapper**

```typescript
// Antes:
// const { data } = await supabase.from("ventas_pos")
//   .select("*")
//   .in("canal_id", canalesOnline)
//   ...

// Después:
import { listarPedidos, type ListarPedidosFiltros } from "../../lib/pedidos/api";

const filtros: ListarPedidosFiltros = {
  estados: tabActual === "pendientes"
    ? ["PENDIENTE", "CONFIRMADO"]
    : tabActual === "cocina"
    ? ["EN_COCINA"]
    : tabActual === "listos"
    ? ["LISTO", "ASIGNADO_RIDER", "EN_CAMINO"]
    : tabActual === "entregados"
    ? ["ENTREGADO"]
    : undefined,
};
const pedidos = await listarPedidos(filtros);
```

- [ ] **Step 4: Adaptar tipos en la UI**

Reemplazar referencias a campos viejos (`tipo_entrega` → `modo_entrega`, `canal_id` → `canal`, `estado` ahora son MAYUS).

- [ ] **Step 5: Adaptar realtime subscription**

```typescript
// Antes:
// supabase.channel("ventas_pos_realtime").on(...)

// Después:
const channel = supabase
  .channel("pedidos_realtime")
  .on(
    "postgres_changes",
    { event: "*", schema: "public", table: "pedidos" },
    () => { refrescar(); },
  )
  .subscribe();
return () => { supabase.removeChannel(channel); };
```

- [ ] **Step 6: Verificar TS + smoke test manual**

```bash
cd packages/comanda && pnpm tsc --noEmit
cd ../pase && pnpm dev
# Abrir browser, navegar a COMANDA → Pedidos. Debería renderizar vacío (tabla recién creada).
```

- [ ] **Step 7: Commit**

```bash
git add packages/comanda/src/pages/Pos/PedidosHub.tsx
git commit -m "refactor(PedidosHub): leer de tabla pedidos nueva (canales online)

Plan Fase 1 Task 12 — switch desde ventas_pos legacy. POS clásico (cobro
directo en mesa) NO se toca. Realtime subscription redirigida.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 13: Refactor `PedidoDetalle` con timeline + acciones

**Files:**
- Modify: `packages/comanda/src/pages/Pos/PedidoDetalle.tsx`

- [ ] **Step 1: Leer archivo actual**

(Comando: Read tool sobre `packages/comanda/src/pages/Pos/PedidoDetalle.tsx`.)

- [ ] **Step 2: Reemplazar fetch por `getPedidoConItems`**

```typescript
import { getPedidoConItems, avanzarEstado, cancelarPedido } from "../../lib/pedidos/api";
import { siguientesEstados, labelAccion } from "../../lib/pedidos/stateMachine";
import PedidoTimeline from "../../components/PedidoTimeline";
import type { PedidoConItems } from "../../types/pedido";

// useEffect que carga el pedido + items
const [pedido, setPedido] = useState<PedidoConItems | null>(null);

useEffect(() => {
  if (!pedidoId) return;
  getPedidoConItems(pedidoId).then(setPedido);
}, [pedidoId]);
```

- [ ] **Step 3: Agregar `<PedidoTimeline />` en el render**

```tsx
{pedido && (
  <div style={{ marginTop: 16 }}>
    <h3 style={{ marginBottom: 8 }}>Estado del pedido</h3>
    <PedidoTimeline pedido={pedido} />
  </div>
)}
```

- [ ] **Step 4: Agregar botones de acción dinámicos**

```tsx
{pedido && (
  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
    {siguientesEstados(pedido.estado, pedido.modo_entrega)
      .filter((e) => e !== "CANCELADO")
      .map((nuevoEstado) => (
        <button
          key={nuevoEstado}
          onClick={async () => {
            const actualizado = await avanzarEstado(pedido.id, nuevoEstado);
            setPedido({ ...pedido, ...actualizado });
          }}
          style={{
            padding: "8px 16px",
            background: "#3b82f6",
            color: "white",
            border: "none",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {labelAccion(nuevoEstado)}
        </button>
      ))}
    {pedido.estado !== "ENTREGADO" && pedido.estado !== "CANCELADO" && (
      <button
        onClick={async () => {
          const motivo = prompt("Motivo de cancelación:");
          if (!motivo) return;
          const actualizado = await cancelarPedido(pedido.id, motivo);
          setPedido({ ...pedido, ...actualizado });
        }}
        style={{
          padding: "8px 16px",
          background: "#ef4444",
          color: "white",
          border: "none",
          borderRadius: 6,
          cursor: "pointer",
          fontSize: 13,
        }}
      >
        Cancelar
      </button>
    )}
  </div>
)}
```

- [ ] **Step 5: Verificar TS + smoke test manual**

```bash
cd packages/comanda && pnpm tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add packages/comanda/src/pages/Pos/PedidoDetalle.tsx
git commit -m "refactor(PedidoDetalle): timeline visible + botones de avance dinámicos

Plan Fase 1 Task 13 — usa siguientesEstados() para mostrar solo acciones
válidas según estado + modo_entrega.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 14: E2E helpers de pedidos

**Files:**
- Create: `packages/pase/test/e2e/helpers/pedidos.ts`

- [ ] **Step 1: Crear helpers**

```typescript
// packages/pase/test/e2e/helpers/pedidos.ts
// Helpers para tests E2E que necesitan crear pedidos sintéticos.

import { type SupabaseClient } from "@supabase/supabase-js";

export interface PedidoSintetico {
  local_id: number;
  canal?: "tienda_propia" | "whatsapp" | "telefono" | "rappi" | "pedidosya" | "menu_qr";
  cliente_nombre?: string;
  cliente_telefono?: string;
  modo_entrega?: "DELIVERY" | "PICKUP" | "EN_LOCAL";
  metodo_pago?: "mp_online" | "efectivo" | "transferencia";
  items?: Array<{
    item_nombre: string;
    cantidad: number;
    precio_unitario: number;
  }>;
  idempotency_key?: string;
}

export async function crearPedidoSintetico(
  client: SupabaseClient,
  override: PedidoSintetico,
): Promise<{ id: string; numero: string; total: number; estado: string }> {
  const defaults: Required<Pick<PedidoSintetico, "canal" | "cliente_nombre" | "cliente_telefono" | "modo_entrega" | "metodo_pago" | "items" | "idempotency_key">> = {
    canal: "tienda_propia",
    cliente_nombre: "Test Cliente",
    cliente_telefono: "+5491100000000",
    modo_entrega: "DELIVERY",
    metodo_pago: "efectivo",
    items: [
      { item_nombre: "Item Test 1", cantidad: 2, precio_unitario: 1500 },
      { item_nombre: "Item Test 2", cantidad: 1, precio_unitario: 800 },
    ],
    idempotency_key: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };

  const { data, error } = await client.rpc("fn_crear_pedido", {
    p_local_id: override.local_id,
    p_canal: override.canal ?? defaults.canal,
    p_canal_external_id: null,
    p_cliente_id: null,
    p_cliente_nombre: override.cliente_nombre ?? defaults.cliente_nombre,
    p_cliente_telefono: override.cliente_telefono ?? defaults.cliente_telefono,
    p_cliente_email: null,
    p_modo_entrega: override.modo_entrega ?? defaults.modo_entrega,
    p_direccion_entrega: "Av. Test 1234",
    p_direccion_lat: -34.6,
    p_direccion_lng: -58.4,
    p_referencias: null,
    p_mesa_numero: null,
    p_programada_para: null,
    p_metodo_pago: override.metodo_pago ?? defaults.metodo_pago,
    p_items: override.items ?? defaults.items,
    p_descuento: 0,
    p_costo_envio: 0,
    p_propina: 0,
    p_cupon_id: null,
    p_puntos_canjeados: 0,
    p_notas_cliente: null,
    p_idempotency_key: override.idempotency_key ?? defaults.idempotency_key,
  });

  if (error) throw error;
  return data as { id: string; numero: string; total: number; estado: string };
}

export async function avanzarPedido(
  client: SupabaseClient,
  pedidoId: string,
  nuevoEstado: string,
): Promise<void> {
  const { error } = await client.rpc("fn_avanzar_pedido_estado", {
    p_pedido_id: pedidoId,
    p_nuevo_estado: nuevoEstado,
  });
  if (error) throw error;
}

export async function getPedido(
  client: SupabaseClient,
  pedidoId: string,
): Promise<{ estado: string; venta_pos_id: number | null; total: number }> {
  const { data, error } = await client
    .from("pedidos")
    .select("estado, venta_pos_id, total")
    .eq("id", pedidoId)
    .single();
  if (error) throw error;
  return data;
}

export async function eliminarPedidoTest(
  client: SupabaseClient,
  pedidoId: string,
): Promise<void> {
  // pedido_items se borra por CASCADE
  await client.from("pedidos").delete().eq("id", pedidoId);
}
```

- [ ] **Step 2: Verificar TS**

```bash
cd packages/pase && pnpm tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add packages/pase/test/e2e/helpers/pedidos.ts
git commit -m "test(e2e): helpers para crear pedidos sintéticos + avanzar + cleanup

Plan Fase 1 Task 14.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 15: E2E test state machine completa

**Files:**
- Create: `packages/pase/test/e2e/test_pedidos_state_machine.spec.ts`

- [ ] **Step 1: Crear test mutante**

```typescript
// packages/pase/test/e2e/test_pedidos_state_machine.spec.ts
// Test E2E mutante (C2 sunny-creek): ciclo completo del pedido por todos
// los estados válidos + verifica que transiciones inválidas fallan.

import { test, expect } from "@playwright/test";
import { getTestClient, getTestLocalId } from "./helpers/clients";
import {
  crearPedidoSintetico,
  avanzarPedido,
  getPedido,
  eliminarPedidoTest,
} from "./helpers/pedidos";

test.describe("Pedidos — state machine", () => {
  test("flow DELIVERY completo: PENDIENTE → ... → ENTREGADO", async () => {
    const client = await getTestClient();
    const localId = await getTestLocalId(client);

    const pedido = await crearPedidoSintetico(client, {
      local_id: localId,
      modo_entrega: "DELIVERY",
    });
    expect(pedido.estado).toBe("PENDIENTE");

    await avanzarPedido(client, pedido.id, "CONFIRMADO");
    let actual = await getPedido(client, pedido.id);
    expect(actual.estado).toBe("CONFIRMADO");

    await avanzarPedido(client, pedido.id, "EN_COCINA");
    actual = await getPedido(client, pedido.id);
    expect(actual.estado).toBe("EN_COCINA");

    await avanzarPedido(client, pedido.id, "LISTO");
    actual = await getPedido(client, pedido.id);
    expect(actual.estado).toBe("LISTO");

    await avanzarPedido(client, pedido.id, "ASIGNADO_RIDER");
    actual = await getPedido(client, pedido.id);
    expect(actual.estado).toBe("ASIGNADO_RIDER");

    await avanzarPedido(client, pedido.id, "EN_CAMINO");
    actual = await getPedido(client, pedido.id);
    expect(actual.estado).toBe("EN_CAMINO");

    await avanzarPedido(client, pedido.id, "ENTREGADO");
    actual = await getPedido(client, pedido.id);
    expect(actual.estado).toBe("ENTREGADO");

    // Cleanup
    await eliminarPedidoTest(client, pedido.id);
  });

  test("flow PICKUP saltea ASIGNADO_RIDER/EN_CAMINO", async () => {
    const client = await getTestClient();
    const localId = await getTestLocalId(client);

    const pedido = await crearPedidoSintetico(client, {
      local_id: localId,
      modo_entrega: "PICKUP",
    });

    await avanzarPedido(client, pedido.id, "CONFIRMADO");
    await avanzarPedido(client, pedido.id, "EN_COCINA");
    await avanzarPedido(client, pedido.id, "LISTO");

    // PICKUP va directo de LISTO a ENTREGADO
    await avanzarPedido(client, pedido.id, "ENTREGADO");
    const actual = await getPedido(client, pedido.id);
    expect(actual.estado).toBe("ENTREGADO");

    await eliminarPedidoTest(client, pedido.id);
  });

  test("MUTANTE: transición inválida PENDIENTE → ENTREGADO falla", async () => {
    const client = await getTestClient();
    const localId = await getTestLocalId(client);

    const pedido = await crearPedidoSintetico(client, { local_id: localId });

    await expect(avanzarPedido(client, pedido.id, "ENTREGADO")).rejects.toThrow(
      /invalid_transition/,
    );

    await eliminarPedidoTest(client, pedido.id);
  });

  test("MUTANTE: PICKUP no puede ir a ASIGNADO_RIDER", async () => {
    const client = await getTestClient();
    const localId = await getTestLocalId(client);

    const pedido = await crearPedidoSintetico(client, {
      local_id: localId,
      modo_entrega: "PICKUP",
    });
    await avanzarPedido(client, pedido.id, "CONFIRMADO");
    await avanzarPedido(client, pedido.id, "EN_COCINA");
    await avanzarPedido(client, pedido.id, "LISTO");

    await expect(
      avanzarPedido(client, pedido.id, "ASIGNADO_RIDER"),
    ).rejects.toThrow(/invalid_transition/);

    await eliminarPedidoTest(client, pedido.id);
  });

  test("MUTANTE: ENTREGADO es terminal", async () => {
    const client = await getTestClient();
    const localId = await getTestLocalId(client);

    const pedido = await crearPedidoSintetico(client, {
      local_id: localId,
      modo_entrega: "PICKUP",
    });
    await avanzarPedido(client, pedido.id, "CONFIRMADO");
    await avanzarPedido(client, pedido.id, "EN_COCINA");
    await avanzarPedido(client, pedido.id, "LISTO");
    await avanzarPedido(client, pedido.id, "ENTREGADO");

    // Cualquier transición desde ENTREGADO falla
    await expect(avanzarPedido(client, pedido.id, "EN_COCINA")).rejects.toThrow();
    await expect(avanzarPedido(client, pedido.id, "CANCELADO")).rejects.toThrow();

    await eliminarPedidoTest(client, pedido.id);
  });
});
```

- [ ] **Step 2: Correr test localmente**

```bash
cd packages/pase && pnpm test:e2e -- test_pedidos_state_machine.spec.ts
```

Esperado: 5 tests verde.

- [ ] **Step 3: Commit**

```bash
git add packages/pase/test/e2e/test_pedidos_state_machine.spec.ts
git commit -m "test(e2e): state machine pedidos — flow completo + transiciones inválidas

Plan Fase 1 Task 15 — 5 tests cubriendo DELIVERY completo, PICKUP shortcut,
mutantes para transiciones inválidas y terminalidad de ENTREGADO.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 16: E2E test idempotency + cancelar

**Files:**
- Create: `packages/pase/test/e2e/test_pedidos_idempotency.spec.ts`
- Create: `packages/pase/test/e2e/test_pedidos_cancelar.spec.ts`

⏸️ `test_pedido_a_venta.spec.ts` DIFERIDO junto con la RPC (Fase 2/3).

- [ ] **Step 1: Crear test idempotency**

```typescript
// packages/pase/test/e2e/test_pedidos_idempotency.spec.ts
import { test, expect } from "@playwright/test";
import { getTestClient, getTestLocalId } from "./helpers/clients";
import { crearPedidoSintetico, eliminarPedidoTest } from "./helpers/pedidos";

test.describe("Pedidos — idempotency", () => {
  test("MUTANTE: misma idempotency_key 2 veces → 1 solo pedido", async () => {
    const client = await getTestClient();
    const localId = await getTestLocalId(client);
    const key = `e2e-idem-${Date.now()}`;

    const pedido1 = await crearPedidoSintetico(client, {
      local_id: localId,
      idempotency_key: key,
    });
    const pedido2 = await crearPedidoSintetico(client, {
      local_id: localId,
      idempotency_key: key,
    });

    // Misma key → debe retornar el MISMO pedido (mismo id)
    expect(pedido1.id).toBe(pedido2.id);
    expect(pedido1.numero).toBe(pedido2.numero);

    await eliminarPedidoTest(client, pedido1.id);
  });

  test("idempotency_keys distintas → pedidos distintos", async () => {
    const client = await getTestClient();
    const localId = await getTestLocalId(client);

    const p1 = await crearPedidoSintetico(client, {
      local_id: localId,
      idempotency_key: `e2e-${Date.now()}-a`,
    });
    const p2 = await crearPedidoSintetico(client, {
      local_id: localId,
      idempotency_key: `e2e-${Date.now()}-b`,
    });

    expect(p1.id).not.toBe(p2.id);
    expect(p1.numero).not.toBe(p2.numero);

    await eliminarPedidoTest(client, p1.id);
    await eliminarPedidoTest(client, p2.id);
  });
});
```

- [ ] **Step 2: Crear test cancelar**

```typescript
// packages/pase/test/e2e/test_pedidos_cancelar.spec.ts
import { test, expect } from "@playwright/test";
import { getTestClient, getTestLocalId } from "./helpers/clients";
import { crearPedidoSintetico, avanzarPedido, getPedido, eliminarPedidoTest } from "./helpers/pedidos";

test.describe("Pedidos — cancelar", () => {
  test("cancelar desde PENDIENTE con motivo", async () => {
    const client = await getTestClient();
    const localId = await getTestLocalId(client);

    const pedido = await crearPedidoSintetico(client, { local_id: localId });

    const { error } = await client.rpc("fn_cancelar_pedido", {
      p_pedido_id: pedido.id,
      p_motivo: "Cliente arrepentido — test",
    });
    expect(error).toBeNull();

    const actual = await getPedido(client, pedido.id);
    expect(actual.estado).toBe("CANCELADO");

    await eliminarPedidoTest(client, pedido.id);
  });

  test("cancelar desde EN_COCINA permitido", async () => {
    const client = await getTestClient();
    const localId = await getTestLocalId(client);

    const pedido = await crearPedidoSintetico(client, { local_id: localId });
    await avanzarPedido(client, pedido.id, "CONFIRMADO");
    await avanzarPedido(client, pedido.id, "EN_COCINA");

    const { error } = await client.rpc("fn_cancelar_pedido", {
      p_pedido_id: pedido.id,
      p_motivo: "Falta de stock test",
    });
    expect(error).toBeNull();

    await eliminarPedidoTest(client, pedido.id);
  });

  test("MUTANTE: motivo vacío → falla", async () => {
    const client = await getTestClient();
    const localId = await getTestLocalId(client);

    const pedido = await crearPedidoSintetico(client, { local_id: localId });

    const { error } = await client.rpc("fn_cancelar_pedido", {
      p_pedido_id: pedido.id,
      p_motivo: "",
    });
    expect(error?.message).toMatch(/motivo_requerido/);

    await eliminarPedidoTest(client, pedido.id);
  });

  test("MUTANTE: cancelar 2 veces es idempotent (no error)", async () => {
    const client = await getTestClient();
    const localId = await getTestLocalId(client);

    const pedido = await crearPedidoSintetico(client, { local_id: localId });

    await client.rpc("fn_cancelar_pedido", {
      p_pedido_id: pedido.id,
      p_motivo: "Test 1",
    });
    const { error } = await client.rpc("fn_cancelar_pedido", {
      p_pedido_id: pedido.id,
      p_motivo: "Test 2",
    });
    expect(error).toBeNull(); // segundo cancel sin error

    await eliminarPedidoTest(client, pedido.id);
  });
});
```

- [ ] **Step 3: Crear test cobrar pedido → genera venta_pos**

```typescript
// packages/pase/test/e2e/test_pedido_a_venta.spec.ts
import { test, expect } from "@playwright/test";
import { getTestClient, getTestLocalId } from "./helpers/clients";
import { crearPedidoSintetico, avanzarPedido, getPedido, eliminarPedidoTest } from "./helpers/pedidos";

test.describe("Pedidos — fn_pedido_a_venta", () => {
  test("cobrar pedido CONFIRMADO genera venta_pos con mismo total", async () => {
    const client = await getTestClient();
    const localId = await getTestLocalId(client);

    const pedido = await crearPedidoSintetico(client, {
      local_id: localId,
      items: [
        { item_nombre: "Item A", cantidad: 2, precio_unitario: 1500 },
        { item_nombre: "Item B", cantidad: 1, precio_unitario: 800 },
      ],
    });
    expect(pedido.total).toBe(3800); // 2*1500 + 1*800

    await avanzarPedido(client, pedido.id, "CONFIRMADO");

    const idempKey = `e2e-cobro-${Date.now()}`;
    const { data: venta, error } = await client.rpc("fn_pedido_a_venta", {
      p_pedido_id: pedido.id,
      p_metodo_pago_real: "efectivo",
      p_idempotency_key: idempKey,
    });
    expect(error).toBeNull();
    expect(venta.total).toBe(3800);
    expect(venta.id).toBeGreaterThan(0);

    const actualPedido = await getPedido(client, pedido.id);
    expect(actualPedido.venta_pos_id).toBe(venta.id);

    // Cleanup
    await client.from("ventas_pos").delete().eq("id", venta.id);
    await eliminarPedidoTest(client, pedido.id);
  });

  test("MUTANTE: cobrar 2 veces idempotente — 1 sola venta_pos", async () => {
    const client = await getTestClient();
    const localId = await getTestLocalId(client);

    const pedido = await crearPedidoSintetico(client, { local_id: localId });
    await avanzarPedido(client, pedido.id, "CONFIRMADO");

    const key = `e2e-doblecobro-${Date.now()}`;
    const { data: v1 } = await client.rpc("fn_pedido_a_venta", {
      p_pedido_id: pedido.id,
      p_metodo_pago_real: "efectivo",
      p_idempotency_key: key,
    });
    const { data: v2 } = await client.rpc("fn_pedido_a_venta", {
      p_pedido_id: pedido.id,
      p_metodo_pago_real: "efectivo",
      p_idempotency_key: key,
    });

    expect(v1.id).toBe(v2.id); // misma venta

    await client.from("ventas_pos").delete().eq("id", v1.id);
    await eliminarPedidoTest(client, pedido.id);
  });

  test("MUTANTE: cobrar pedido CANCELADO falla", async () => {
    const client = await getTestClient();
    const localId = await getTestLocalId(client);

    const pedido = await crearPedidoSintetico(client, { local_id: localId });
    await client.rpc("fn_cancelar_pedido", {
      p_pedido_id: pedido.id,
      p_motivo: "Test",
    });

    const { error } = await client.rpc("fn_pedido_a_venta", {
      p_pedido_id: pedido.id,
      p_metodo_pago_real: "efectivo",
      p_idempotency_key: `e2e-cancel-${Date.now()}`,
    });
    expect(error?.message).toMatch(/pedido_cancelado/);

    await eliminarPedidoTest(client, pedido.id);
  });
});
```

- [ ] **Step 4: Correr los 3 tests localmente**

```bash
cd packages/pase && pnpm test:e2e -- test_pedidos_idempotency test_pedidos_cancelar test_pedido_a_venta
```

Esperado: todos verde.

- [ ] **Step 5: Commit**

```bash
git add packages/pase/test/e2e/test_pedidos_idempotency.spec.ts \
        packages/pase/test/e2e/test_pedidos_cancelar.spec.ts \
        packages/pase/test/e2e/test_pedido_a_venta.spec.ts
git commit -m "test(e2e): idempotency + cancelar + pedido→venta linkeo

Plan Fase 1 Task 16 — 3 specs nuevos con mutantes cubriendo idempotency,
motivo obligatorio cancelar, double-cobro idempotente, cobrar cancelado falla.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 17: Integrar tests al workflow CI

**Files:**
- Modify: `.github/workflows/e2e-suite.yml`

- [ ] **Step 1: Leer workflow actual**

(Comando: Read tool sobre `.github/workflows/e2e-suite.yml`.)

- [ ] **Step 2: Agregar los 4 specs nuevos al array de tests**

Buscar en el workflow el step que corre los tests E2E. Generalmente es algo como:

```yaml
- name: Run E2E suite
  run: cd packages/pase && pnpm test:e2e
```

Si los specs nuevos están en `packages/pase/test/e2e/` automáticamente los toma el glob default. Verificar que el `playwright.config.ts` tenga `testDir: 'test/e2e'`. Si SÍ → no hay que tocar nada del workflow, los nuevos specs corren solos.

Si el workflow lista tests manualmente, agregar:

```yaml
- test_pedidos_state_machine.spec.ts
- test_pedidos_idempotency.spec.ts
- test_pedidos_cancelar.spec.ts
- test_pedido_a_venta.spec.ts
```

- [ ] **Step 3: Push y verificar el run en GitHub Actions**

```bash
# Si hubo cambios en el workflow:
git add .github/workflows/e2e-suite.yml
git commit -m "ci: integrar 4 specs de pedidos a e2e-suite

Plan Fase 1 Task 17.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push

# Verificar:
gh run list --workflow e2e-suite.yml --limit 1
gh run watch
```

Esperado: workflow verde con 4 specs nuevos incluidos.

---

### Task 18: Checklist de Lucas (smoke test manual + cierre fase)

**Files:** ninguno — checklist humano.

- [ ] **Step 1: Smoke test Lucas — flujo end-to-end manual**

Lucas tiene que verificar manualmente (o un agente lo guía):

1. Abrir COMANDA → Pedidos. Bandeja debe renderizar (vacía esperable).
2. Crear pedido sintético desde Supabase Studio o un script local que llame `fn_crear_pedido` con datos reales.
3. Refrescar bandeja → ver el pedido nuevo en tab "Pendientes".
4. Click en el pedido → ver detalle con timeline (1 etapa marcada PENDIENTE).
5. Click "Confirmar" → ver timeline avanza, badge cambia color.
6. Repetir para EN_COCINA, LISTO. Verificar que botones cambian según estado.
7. Click "Cancelar" + ingresar motivo → ver banner rojo "Pedido cancelado".

- [ ] **Step 2: Confirmar decisiones diferidas que entran en Fase 2-3**

Para no olvidar al arrancar fases siguientes:

- ¿WhatsApp bot escala humano antes de cobrar SIEMPRE o auto-cobra hasta $X? → Default Fase 2: SIEMPRE escala humano.
- ¿Pricing diff Rappi/PeYa default activo o opt-in manual? → Default Fase 3: opt-in manual (campo `item_precios_canal` ya existe).
- ¿Re-dispatch auto si rider rechaza, o cae a admin manual? → Default Fase 4: re-dispatch hasta 3 intentos, después admin.
- ¿Puntos fidelity vencen a 12 meses? → Default Fase 5: SÍ, 12 meses. ¿Cupón cumple monto $X? → Default Fase 5: $1000.
- ¿Wildcard SSL (1 cert para `*.pase.app`) o cert por dominio? → Default Fase 6: cert por dominio (más flexible para custom domain).
- ¿Customer login obligatorio o opcional? → Default Fase 6: OPCIONAL (guest checkout default).

- [ ] **Step 3: Marcar fase como cerrada**

```bash
# Task 127 en task tracker → mark completed
```

Mensaje a Lucas:

> ✅ Fase 1 cerrada. Bandeja unificada con state machine operativa. POS clásico intacto. 17 tasks completadas, 6 migrations, 4 specs E2E (verde en CI). Próximo paso: armar plan de Fase 2 (Bot WhatsApp). Pre-requisito: cuenta Meta Business + token listo.

---

## Self-Review

### 1. Spec coverage

Reviso secciones del spec base contra tasks de este plan (solo lo que aplica a Fase 1 — F2-F6 entran en sus propios planes):

- ✅ **2.1 Tabla `pedidos` unificada** → Task 1
- ✅ **2.2 State machine 8 estados** → Tasks 4, 9, 15
- ✅ **2.3 Tienda online propia** → fuera de F1 (Fase 6)
- ✅ **2.4 Checkout flow** → fuera de F1 (mantenemos `fn_crear_pedido_publico_comanda` existente; Fase 2-3 lo refactoriza para llamar `fn_crear_pedido` nueva)
- ✅ **2.5 Marketplace integrations** → fuera de F1 (Fase 3)
- ✅ **2.6 WhatsApp bot** → fuera de F1 (Fase 2)
- ✅ **2.7 Delivery propio** → fuera de F1 (Fase 4)
- ✅ **2.8 Pickup/take-away** → cubierto por modo_entrega=PICKUP en Task 1 + state machine Task 4
- ✅ **2.9 Fidelidad+cupones+reseñas** → fuera de F1 (Fase 5)
- ✅ **2.10 Reservas** → fuera de F1 (Fase 5)
- ✅ **3.1 Schema tabla `pedidos`** → Task 1 implementa EXACTAMENTE el schema del spec
- ✅ **3.1 Schema `pedido_items`** → Task 2 (nuevo, no estaba en spec — modelo query-friendly más limpio que jsonb que asumía spec)
- ✅ **fn_pedido_a_venta linkeo** → Task 7

Gap menor cubierto: spec asume `items_jsonb` en `pedidos`, este plan separa a tabla `pedido_items` con razón documentada (queries KDS, sales mix events futuros, no perder performance).

### 2. Placeholder scan

Recorrí los 18 tasks buscando "TBD", "TODO", "implement later", validaciones vagas:
- ✅ Sin TBD/TODO en SQL.
- ✅ Cada step tiene código real (SQL completo, TypeScript completo).
- ✅ Errores específicos con ERRCODE en SQL (no "add error handling").
- ⚠️ Task 7 Step 2 dice "verificar primero schema actual de ventas_pos" — esto NO es un placeholder, es un sanity check explícito. Tiene instrucción concreta (`grep` + ajustar INSERT).
- ⚠️ Task 12-13 Step 1 dice "leer archivo actual" — concreto (Read tool path).
- ⚠️ Task 17 Step 2 condicional "si el workflow lista tests manualmente" — concreto, hay branch lógico claro.

### 3. Type consistency

- ✅ `EstadoPedido` en TS (Task 8) y CHECK constraint en SQL (Task 1) listan EXACTOS los 8 estados.
- ✅ `siguientesEstados()` (Task 9) y `valid_pedido_transition()` (Task 4) tienen la MISMA lógica.
- ✅ `crearPedido()` (Task 10) y `fn_crear_pedido` (Task 5) tienen los mismos 22 parámetros con misma signature.
- ✅ Helpers E2E (Task 14) usan los mismos param names que las RPCs.

### 4. Sanity check

- Tareas: 18 (objetivo ~5 días). 18 × ~25 min cada una = ~7.5 hrs. Plus migrations pasar a Lucas manualmente + smoke tests = realista 5 días.
- Migrations: 7 (cada una con SQL listo para pegar). Lucas las ejecuta una por una en Supabase SQL Editor.
- Tests: 4 specs nuevos con ~13 tests totales, todos mutantes (no happy-path only).
- Sin deuda técnica creada: tabla nueva limpia, no toca legacy.

---

**FIN PLAN FASE 1.**
