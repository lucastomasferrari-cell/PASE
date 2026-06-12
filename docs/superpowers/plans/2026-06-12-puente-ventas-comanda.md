# Puente de Ventas COMANDA → PASE — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tier 1 #2 del informe `docs/analisis-logica-2026-06/00-INFORME-EJECUTIVO.md`: las ventas cobradas en el POS COMANDA (`ventas_pos`) se proyectan automáticamente a la tabla `ventas` de PASE con `origen='comanda'`, para que EERR/Negocio/Reportes las vean sin doble carga manual.

**Architecture:** Trigger AFTER UPDATE OF estado en `ventas_pos` (mismo patrón que `trg_venta_cobrada_stock`). Al pasar a `cobrada`, `fn_proyectar_venta_pos` agrega los pagos confirmados (neto de propina) por medio y UPSERTEA filas diarias en `ventas` (clave: tenant+local+fecha+turno+medio, `origen='comanda'`, fecha = día calendario AR del cobro, turno por hora de cobro <17 = Mediodía). Una tabla de registro `ventas_pos_proyecciones` guarda exactamente qué montos aplicó cada venta → idempotencia total y reverso exacto cuando la venta deja de estar cobrada (anulada O reabierta). NO se crean `movimientos`/`saldos_caja` (el efectivo del POS vive en turnos_caja de COMANDA y sube a PASE con el retiro físico — crear movimientos duplicaría plata). Sin backfill histórico (las ventas_pos existentes son de prueba).

**Tech Stack:** Postgres/Supabase (migración SQL, flow oficial: dry-run con ROLLBACK → aplicar). Tests Playwright (`--project=mutante` / `--project=e2e-full`). Sin cambios de frontend en v1.

**Reglas del repo:** C2 (mutante, Task 3), C7 (tabla nueva con tenant_id+RLS), C9 (errores UPPER_SNAKE), `REVOKE FROM PUBLIC, anon`, e2e-full actualizado (Task 4), push + deploy READY al cierre.

**Datos verificados del relevamiento (12-jun):** `ventas` = una fila por día+local+turno+medio, columnas `id TEXT, tenant_id, local_id, fecha DATE, turno TEXT ('Mediodía'|'Noche'), medio TEXT, monto NUMERIC, origen TEXT default 'manual' ('manual'|'maxirest'), estado (anulable), venta_ids text[]`. `ventas_pos.estado='cobrada'` con `cobrada_at timestamptz`; pagos en `ventas_pos_pagos (venta_id, metodo TEXT, monto, propina_incluida, estado='confirmado', deleted_at)`. Trigger de stock existente: `AFTER UPDATE OF estado ... WHEN (NEW.estado='cobrada')` (202605203300:93-109). El duplicate-check de carga manual/Maxirest bloquea por (local,fecha,turno) → con filas comanda ese día, la carga manual queda bloqueada = protección anti doble conteo gratis.

---

### Task 1: Migración — tabla de proyecciones + funciones + triggers + índice único

**Files:**
- Create: `packages/pase/supabase/migrations/202606121200_puente_ventas_comanda.sql`

- [ ] **Step 1: Verificar supuestos contra el schema real ANTES de escribir**

Run (verificaciones en migraciones, NO en DB):
- `grep -n "ALTER TABLE ventas" packages/pase/supabase/migrations/*.sql | head -30` → confirmar que `ventas` tiene `tenant_id` (multi-tenant 202604281200+) y `estado`.
- `grep -n "CHECK (origen" packages/pase/supabase/migrations/20260423_ventas_origen.sql` → ver si `origen` tiene CHECK constraint que haya que ampliar con 'comanda' (si es TEXT libre, no hay nada que ampliar).
Si `ventas.tenant_id` NO existe o hay CHECK sobre origen, ajustar el SQL del Step 2 en consecuencia (agregar el valor al CHECK con `ALTER TABLE ... DROP CONSTRAINT/ADD CONSTRAINT`).

- [ ] **Step 2: Escribir la migración**

Crear `packages/pase/supabase/migrations/202606121200_puente_ventas_comanda.sql`:

```sql
-- ============================================================
-- 202606121200_puente_ventas_comanda.sql
-- Tier 1 #2 (informe 2026-06-11): puente ventas_pos → ventas.
-- Al cobrar una venta en COMANDA, sus pagos confirmados (neto de
-- propina) se agregan por medio en la fila diaria de `ventas`
-- (origen='comanda'). Reversible: anular/reabrir descuenta lo
-- exacto que esa venta había aportado (ventas_pos_proyecciones).
-- NO crea movimientos/saldos_caja (el efectivo del POS vive en
-- turnos_caja y sube a PASE con el retiro físico).
-- Sin backfill: arranca desde el deploy (las ventas_pos previas
-- son de prueba).
-- ============================================================

BEGIN;

-- 1) Registro de qué proyectó cada venta (idempotencia + reverso exacto)
CREATE TABLE IF NOT EXISTS ventas_pos_proyecciones (
  venta_id    BIGINT PRIMARY KEY REFERENCES ventas_pos(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL,
  local_id    INTEGER NOT NULL,
  fecha       DATE NOT NULL,
  turno       TEXT NOT NULL,
  detalle     JSONB NOT NULL,          -- [{"medio":"EFECTIVO","monto":1234.50}, ...]
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vpp_tenant_fecha ON ventas_pos_proyecciones(tenant_id, local_id, fecha);

ALTER TABLE ventas_pos_proyecciones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ventas_pos_proyecciones_all ON ventas_pos_proyecciones;
CREATE POLICY ventas_pos_proyecciones_all ON ventas_pos_proyecciones
  FOR ALL TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  )
  WITH CHECK (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  );

-- 2) Clave de upsert para las filas proyectadas en `ventas`
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ventas_comanda_dia_medio
  ON ventas (tenant_id, local_id, fecha, turno, medio)
  WHERE origen = 'comanda';

-- 3) Proyectar (llamada por trigger al cobrar) -------------------------------
CREATE OR REPLACE FUNCTION fn_proyectar_venta_pos(p_venta_id BIGINT)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_venta RECORD;
  v_fecha DATE;
  v_turno TEXT;
  v_pago RECORD;
  v_detalle JSONB := '[]'::jsonb;
  v_filas INTEGER := 0;
BEGIN
  SELECT id, tenant_id, local_id, cobrada_at
    INTO v_venta
    FROM ventas_pos
   WHERE id = p_venta_id
     AND estado = 'cobrada'
     AND deleted_at IS NULL;
  IF v_venta.id IS NULL THEN
    RETURN 0; -- no cobrada / no existe: nada que proyectar
  END IF;

  -- Idempotencia: si esta venta ya proyectó, no volver a sumar.
  IF EXISTS (SELECT 1 FROM ventas_pos_proyecciones WHERE venta_id = p_venta_id) THEN
    RETURN 0;
  END IF;

  -- Día y turno operativos en hora Argentina.
  v_fecha := (COALESCE(v_venta.cobrada_at, NOW()) AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;
  v_turno := CASE
    WHEN ((COALESCE(v_venta.cobrada_at, NOW()) AT TIME ZONE 'America/Argentina/Buenos_Aires')::TIME < TIME '17:00')
    THEN 'Mediodía' ELSE 'Noche' END;

  FOR v_pago IN
    SELECT p.metodo,
           SUM(p.monto - COALESCE(p.propina_incluida, 0)) AS neto
      FROM ventas_pos_pagos p
     WHERE p.venta_id = p_venta_id
       AND p.estado = 'confirmado'
       AND p.deleted_at IS NULL
     GROUP BY p.metodo
    HAVING SUM(p.monto - COALESCE(p.propina_incluida, 0)) <> 0
  LOOP
    INSERT INTO ventas (id, tenant_id, local_id, fecha, turno, medio, monto, origen)
    VALUES (
      'VC' || replace(gen_random_uuid()::text, '-', ''),
      v_venta.tenant_id, v_venta.local_id, v_fecha, v_turno, v_pago.metodo, v_pago.neto, 'comanda'
    )
    ON CONFLICT (tenant_id, local_id, fecha, turno, medio) WHERE origen = 'comanda'
    DO UPDATE SET monto = ventas.monto + EXCLUDED.monto;

    v_detalle := v_detalle || jsonb_build_object('medio', v_pago.metodo, 'monto', v_pago.neto);
    v_filas := v_filas + 1;
  END LOOP;

  IF v_filas > 0 THEN
    INSERT INTO ventas_pos_proyecciones (venta_id, tenant_id, local_id, fecha, turno, detalle)
    VALUES (p_venta_id, v_venta.tenant_id, v_venta.local_id, v_fecha, v_turno, v_detalle);
  END IF;

  RETURN v_filas;
END;
$$;
REVOKE ALL ON FUNCTION fn_proyectar_venta_pos(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_proyectar_venta_pos(BIGINT) TO authenticated, service_role;

-- 4) Revertir (anulada o reabierta después de cobrada) -----------------------
CREATE OR REPLACE FUNCTION fn_revertir_proyeccion_venta_pos(p_venta_id BIGINT)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proj RECORD;
  v_item JSONB;
  v_filas INTEGER := 0;
BEGIN
  SELECT * INTO v_proj FROM ventas_pos_proyecciones WHERE venta_id = p_venta_id;
  IF v_proj.venta_id IS NULL THEN
    RETURN 0; -- nunca proyectó (o ya se revirtió): nada que hacer
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_proj.detalle)
  LOOP
    UPDATE ventas v
       SET monto = v.monto - (v_item->>'monto')::NUMERIC
     WHERE v.tenant_id = v_proj.tenant_id
       AND v.local_id = v_proj.local_id
       AND v.fecha = v_proj.fecha
       AND v.turno = v_proj.turno
       AND v.medio = v_item->>'medio'
       AND v.origen = 'comanda';
    v_filas := v_filas + 1;
  END LOOP;

  -- Filas que quedaron en 0 exacto → limpiar (no ensuciar EERR con $0).
  DELETE FROM ventas v
   WHERE v.tenant_id = v_proj.tenant_id
     AND v.local_id = v_proj.local_id
     AND v.fecha = v_proj.fecha
     AND v.turno = v_proj.turno
     AND v.origen = 'comanda'
     AND abs(v.monto) < 0.005;

  DELETE FROM ventas_pos_proyecciones WHERE venta_id = p_venta_id;
  RETURN v_filas;
END;
$$;
REVOKE ALL ON FUNCTION fn_revertir_proyeccion_venta_pos(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_revertir_proyeccion_venta_pos(BIGINT) TO authenticated, service_role;

-- 5) Triggers (mismo patrón que trg_venta_cobrada_stock) ---------------------
CREATE OR REPLACE FUNCTION fn_trg_venta_pos_proyectar()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.estado = 'cobrada' AND (OLD.estado IS NULL OR OLD.estado <> 'cobrada') THEN
    PERFORM fn_proyectar_venta_pos(NEW.id);
  ELSIF OLD.estado = 'cobrada' AND NEW.estado <> 'cobrada' THEN
    -- anulada O reabierta: descontar exactamente lo aportado
    PERFORM fn_revertir_proyeccion_venta_pos(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_venta_pos_proyectar ON ventas_pos;
CREATE TRIGGER trg_venta_pos_proyectar
  AFTER UPDATE OF estado ON ventas_pos
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_venta_pos_proyectar();

COMMIT;
```

- [ ] **Step 3: Releer verificando** BEGIN/COMMIT balanceados, `$$` cerrados, REVOKE antes de cada GRANT, y que el `ON CONFLICT ... WHERE origen='comanda'` matchea la definición del índice parcial (mismas columnas, mismo predicado).

- [ ] **Step 4: Commit**

```bash
cd C:\Users\lucas\Documents\PASE
git add packages/pase/supabase/migrations/202606121200_puente_ventas_comanda.sql
git commit -m "feat(ventas): puente ventas_pos -> ventas con origen=comanda (Tier1 #2)"
```

---

### Task 2: Aplicar en producción (flow oficial con dry-run)

- [ ] **Step 1:** `cd packages/pase; npx vercel env pull .env.local.tmp --environment=production` y verificar `POSTGRES_URL_NON_POOLING` presente.
- [ ] **Step 2:** Script `run-migration.mjs` (el mismo patrón del sprint anterior: neutralizar BEGIN/COMMIT del archivo, envolver en transacción propia, ROLLBACK). `DRY_RUN=1` primero → `DRY-RUN OK`. OJO con el hook de PowerShell: escribir el script con el Write tool, no con here-string + Set-Content.
- [ ] **Step 3:** Aplicar en serio. Verificaciones post: `SELECT COUNT(*) FROM ventas_pos_proyecciones` (esperado 0 — sin backfill) y `SELECT COUNT(*) FROM ventas WHERE origen='comanda'` (esperado 0).
- [ ] **Step 4:** Borrar `run-migration.mjs` y `.env.local.tmp`.

---

### Task 3: Test mutante `puente_ventas_comanda_mutante.spec.ts`

**Files:**
- Create: `packages/pase/tests/puente_ventas_comanda_mutante.spec.ts`
- Reference: `packages/pase/tests/e2e-full/sprint-1/02-pos-cobro-efectivo.spec.ts` (cómo crear venta_pos + cobrar con `fn_cobrar_venta_comanda`), `packages/pase/tests/ventas_efectivo_mutante.spec.ts` (helpers, cleanup, asserts DB-only).

- [ ] **Step 1: Escribir el test.** Leé los DOS specs de referencia enteros y copiá su mecánica exacta (clientes, seeds Local Prueba 2, turno_caja si hace falta para cobrar). Sentinels: PAGO_EFECTIVO=4321.17, PAGO_TARJETA=1111.11, PROPINA=200.00. Flujo y asserts:

```typescript
// 1. Crear venta_pos (estado abierta) en Local Prueba 2 + items mínimos
//    (o el camino que use el spec 02 — copiar su setup exacto, incluido
//    abrir turno_caja si fn_cobrar_venta_comanda lo exige).
// 2. Cobrar via rpc fn_cobrar_venta_comanda con 2 pagos:
//    EFECTIVO 4321.17 (propina_incluida 200) + TARJETA 1111.11.
// 3. ASSERTS proyección:
//    a. ventas_pos_proyecciones tiene fila para venta_id, con detalle de 2 medios.
//    b. ventas (origen='comanda', local, fecha AR de hoy) tiene fila EFECTIVO
//       con monto 4121.17 (pago - propina) y fila TARJETA 1111.11.
//    c. NO se creó NINGÚN movimiento en `movimientos` por esta proyección
//       (query movimientos por detalle/fecha — el puente NO toca caja PASE).
// 4. Segunda venta cobrada mismo día con EFECTIVO 1000:
//    ASSERT: la fila EFECTIVO del día queda en 5121.17 (upsert agregó, no duplicó fila).
//    ASSERT: sigue habiendo UNA sola fila (tenant,local,fecha,turno,'EFECTIVO',origen comanda).
// 5. Anular la venta 2 (el camino real: rpc anular de COMANDA con manager, o
//    UPDATE estado='anulada' via service client si los specs de referencia lo hacen así):
//    ASSERT: fila EFECTIVO vuelve a 4121.17; proyección de venta 2 eliminada.
// 6. Anular también la venta 1:
//    ASSERT: las filas del día quedaron eliminadas (monto 0 → delete) y
//    ventas_pos_proyecciones sin filas de estas ventas.
// Cleanup afterEach: anular/borrar ventas_pos de test, borrar filas ventas
// origen='comanda' remanentes del local de prueba, cerrar turno si se abrió.
```

- [ ] **Step 2:** `cd packages/pase; npx playwright test --project=mutante --workers=1 tests/puente_ventas_comanda_mutante.spec.ts` → PASS.
- [ ] **Step 3:** Regresión de vecinos: `npx playwright test --project=mutante --workers=1 tests/ventas_efectivo_mutante.spec.ts` → PASS (la carga manual no cambió).
- [ ] **Step 4:** Commit: `git add packages/pase/tests/puente_ventas_comanda_mutante.spec.ts` + `git commit -m "test: mutante puente ventas_pos -> ventas (proyeccion, upsert, reverso)"`.

---

### Task 4: e2e-full — asserts de proyección en el flow POS existente

**Files:**
- Modify: `packages/pase/tests/e2e-full/sprint-1/02-pos-cobro-efectivo.spec.ts` (o el spec que cobra ventas_pos en la suite)

- [ ] **Step 1:** Al final del flujo de cobro existente, agregar asserts: existe `ventas_pos_proyecciones` para la venta cobrada, y la fila `ventas` (origen='comanda') del día/local del tenant E2E refleja el monto neto. Si el spec ya anula la venta al final, assert de que el reverso dejó todo limpio. Ajustar el cleanup del spec para borrar también `ventas` origen='comanda' del tenant E2E.
- [ ] **Step 2:** Correr la suite COMPLETA: `npx playwright test --project=e2e-full --workers=1` → toda verde (regla: no merge con suite roja). Atención: otros specs que cobran ventas_pos ahora generan filas `ventas` — si algún assert de totales de ventas del tenant E2E se ve afectado, ajustarlo a la nueva semántica (es el comportamiento deseado) y documentarlo.
- [ ] **Step 3:** Commit: `test(e2e-full): asserts proyeccion ventas_pos -> ventas en flow POS`.

---

### Task 5: Cierre

- [ ] **Step 1:** `git push` + verificar deploy Vercel `state=READY`.
- [ ] **Step 2:** Memoria: actualizar `project_pase_sprint_stock_local_12_jun.md` (o archivo nuevo del sprint #2) con: qué quedó en prod, decisión "sin movimientos de caja" y por qué, decisión propina excluida, sin backfill, y el efecto secundario esperado: **las pruebas de COMANDA en locales reales ahora aparecen en Ventas/EERR como origen='comanda'** (se borran desde Ventas si molestan). Actualizar MEMORY.md.

---

## Self-review

- **Cobertura**: proyección al cobrar ✅ (T1), reverso por anulación Y por reapertura ✅ (T1 trigger doble rama — la reapertura es el caso que ya mordió en prod el 09-jun), idempotencia por tabla de registro ✅, sin doble conteo de caja ✅ (decisión documentada + assert 3c), EERR sin cambios ✅ (la forma de `ventas` se respeta), tests C2 ✅ (T3) y e2e-full ✅ (T4).
- **Riesgos asumidos**: (1) nombres de medios de COMANDA ("EFECTIVO") pueden no matchear el catálogo `medios_cobro` de PASE → en EERR caen al final como legacy; se resuelve de raíz en Tier 1 #3 (catálogo único). (2) Ventas de madrugada (00-05hs) caen al día calendario siguiente — coincide con cómo Anto carga hoy; revisar con datos reales del piloto. (3) Si Lucas testea COMANDA en un local real, esas ventas de prueba aparecen en el EERR — documentado en memoria, se borran desde Ventas.
- **Tipos**: `ventas.id TEXT` generado server-side `'VC'+uuid`; `detalle` JSONB array de {medio, monto}; montos NUMERIC con neto = monto − propina_incluida.
