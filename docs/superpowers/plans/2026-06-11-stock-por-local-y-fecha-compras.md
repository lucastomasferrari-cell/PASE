# Stock por Local + Fecha Real de Compras — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tier 1 items #1 y #5 del informe `docs/analisis-logica-2026-06/00-INFORME-EJECUTIVO.md`: (A) stock por `(insumo, local)` con cache nueva `insumo_stock_local` backfilleada desde el ledger, y (B) fechar las entradas de compra con la fecha de la factura (con backfill reversible), arreglando de paso el CMV per-local y la pantalla Stock que oculta agotados.

**Architecture:** El ledger `insumo_movimientos` ya tiene `local_id` — se agrega una tabla cache `insumo_stock_local(insumo_id, local_id) → cantidad` mantenida por el MISMO trigger BEFORE INSERT que hoy mantiene `insumos.stock_actual` (que se conserva como total global del tenant, su semántica actual). `fn_cmv_real` deja de usar snapshots globales (`stock_antes/stock_despues`) y calcula stock inicial/final por local sumando el ledger — eso arregla a la vez el bug per-local y el bug de períodos históricos. Las transferencias y conteos pasan a validar/snapshotear contra la cache per-local. El trigger de entrada por factura fecha el movimiento con `facturas.fecha` (backup de fechas viejas antes del UPDATE de backfill).

**Tech Stack:** Postgres (Supabase) — migraciones SQL aplicadas vía script Node con `POSTGRES_URL_NON_POOLING` (flow oficial CLAUDE.md). React/TS (Vite) en `packages/pase`. Tests vitest mutantes contra prod (tenant E2E aislado).

**Reglas del repo que aplican:** C2 (test mutante obligatorio — Task 6), C7 (tabla nueva con tenant_id + RLS), C9 (error codes UPPER_SNAKE), regla e2e-full (Task 7), regla `REVOKE FROM PUBLIC, anon` en funciones nuevas, commit+push al cierre y verificar deploy READY.

---

### Task 1: Migración Cambio A — tabla `insumo_stock_local` + trigger + recalc + backfill

**Files:**
- Create: `packages/pase/supabase/migrations/202606120100_stock_por_local.sql`

Referencias de código original (para contexto, NO modificar esos archivos): trigger actual en `202605203200_stock_movimientos.sql:120-155`, recalc en `:157-201`, transferencias en `202605204200_stock_transferencias.sql:85-194`.

- [ ] **Step 1: Escribir la migración completa**

Crear `packages/pase/supabase/migrations/202606120100_stock_por_local.sql` con este contenido EXACTO:

```sql
-- ============================================================
-- 202606120100_stock_por_local.sql
-- Tier 1 #1 (informe 2026-06-11): stock por (insumo, local).
-- - Tabla cache insumo_stock_local mantenida por el trigger del ledger.
-- - insumos.stock_actual SE CONSERVA como total global del tenant (semántica actual).
-- - Backfill desde insumo_movimientos (ya tiene local_id).
-- - Transferencias validan contra el saldo del local origen.
-- - fn_recalcular_* reconstruyen ambas caches.
-- ============================================================

BEGIN;

-- 1) Tabla cache por local ------------------------------------------------
CREATE TABLE IF NOT EXISTS insumo_stock_local (
  tenant_id   UUID NOT NULL,
  insumo_id   BIGINT NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
  local_id    INTEGER NOT NULL,
  cantidad    NUMERIC(12,4) NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (insumo_id, local_id)
);

CREATE INDEX IF NOT EXISTS idx_isl_tenant_local ON insumo_stock_local(tenant_id, local_id);

ALTER TABLE insumo_stock_local ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS insumo_stock_local_all ON insumo_stock_local;
CREATE POLICY insumo_stock_local_all ON insumo_stock_local
  FOR ALL TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  )
  WITH CHECK (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  );

-- 2) Trigger del ledger: mantiene cache global (igual que hoy) + cache por local
CREATE OR REPLACE FUNCTION fn_trg_insumo_mov_update_stock()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_stock_antes NUMERIC(12, 4);
  v_stock_despues NUMERIC(12, 4);
BEGIN
  SELECT stock_actual INTO v_stock_antes FROM insumos WHERE id = NEW.insumo_id FOR UPDATE;
  v_stock_antes := COALESCE(v_stock_antes, 0);
  v_stock_despues := v_stock_antes + NEW.cantidad;

  NEW.stock_antes := v_stock_antes;
  NEW.stock_despues := v_stock_despues;

  UPDATE insumos SET
    stock_actual = v_stock_despues,
    updated_at = NOW()
  WHERE id = NEW.insumo_id;

  IF v_stock_despues <= 0 THEN
    UPDATE insumos SET stock_disponible = FALSE
     WHERE id = NEW.insumo_id AND stock_disponible = TRUE;
  ELSE
    UPDATE insumos SET stock_disponible = TRUE
     WHERE id = NEW.insumo_id AND stock_disponible = FALSE;
  END IF;

  -- NUEVO: cache por local (solo movimientos con local)
  IF NEW.local_id IS NOT NULL THEN
    INSERT INTO insumo_stock_local (tenant_id, insumo_id, local_id, cantidad)
    VALUES (NEW.tenant_id, NEW.insumo_id, NEW.local_id, NEW.cantidad)
    ON CONFLICT (insumo_id, local_id) DO UPDATE
      SET cantidad   = insumo_stock_local.cantidad + EXCLUDED.cantidad,
          updated_at = NOW();
  END IF;

  RETURN NEW;
END;
$$;
-- (el trigger trg_insumo_mov_update_stock ya existe y apunta a esta función; no se recrea)

-- 3) Recalc defensivo: reconstruye ambas caches desde el ledger ------------
CREATE OR REPLACE FUNCTION fn_recalcular_stock_insumo(p_insumo_id BIGINT)
RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total NUMERIC(12, 4);
BEGIN
  SELECT COALESCE(SUM(cantidad), 0) INTO v_total
    FROM insumo_movimientos
   WHERE insumo_id = p_insumo_id AND deleted_at IS NULL;

  UPDATE insumos SET stock_actual = v_total, updated_at = NOW()
   WHERE id = p_insumo_id;

  -- por local: borrar y reconstruir las filas de este insumo
  DELETE FROM insumo_stock_local WHERE insumo_id = p_insumo_id;
  INSERT INTO insumo_stock_local (tenant_id, insumo_id, local_id, cantidad)
  SELECT im.tenant_id, im.insumo_id, im.local_id, SUM(im.cantidad)
    FROM insumo_movimientos im
   WHERE im.insumo_id = p_insumo_id
     AND im.local_id IS NOT NULL
     AND im.deleted_at IS NULL
   GROUP BY im.tenant_id, im.insumo_id, im.local_id;

  RETURN v_total;
END;
$$;
REVOKE ALL ON FUNCTION fn_recalcular_stock_insumo(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_recalcular_stock_insumo(BIGINT) TO authenticated;

CREATE OR REPLACE FUNCTION fn_recalcular_stock_todos(p_tenant_id UUID DEFAULT NULL)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_count INTEGER := 0;
BEGIN
  v_tenant_id := COALESCE(p_tenant_id, auth_tenant_id());
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  WITH totales AS (
    SELECT insumo_id, COALESCE(SUM(cantidad), 0) AS total
      FROM insumo_movimientos
     WHERE deleted_at IS NULL
       AND tenant_id = v_tenant_id
     GROUP BY insumo_id
  )
  UPDATE insumos i SET stock_actual = t.total, updated_at = NOW()
    FROM totales t WHERE i.id = t.insumo_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  DELETE FROM insumo_stock_local WHERE tenant_id = v_tenant_id;
  INSERT INTO insumo_stock_local (tenant_id, insumo_id, local_id, cantidad)
  SELECT im.tenant_id, im.insumo_id, im.local_id, SUM(im.cantidad)
    FROM insumo_movimientos im
   WHERE im.tenant_id = v_tenant_id
     AND im.local_id IS NOT NULL
     AND im.deleted_at IS NULL
   GROUP BY im.tenant_id, im.insumo_id, im.local_id;

  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION fn_recalcular_stock_todos(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_recalcular_stock_todos(UUID) TO authenticated;

-- 4) Backfill inicial desde el ledger (todos los tenants) ------------------
INSERT INTO insumo_stock_local (tenant_id, insumo_id, local_id, cantidad)
SELECT im.tenant_id, im.insumo_id, im.local_id, SUM(im.cantidad)
  FROM insumo_movimientos im
 WHERE im.local_id IS NOT NULL
   AND im.deleted_at IS NULL
 GROUP BY im.tenant_id, im.insumo_id, im.local_id
ON CONFLICT (insumo_id, local_id) DO UPDATE
  SET cantidad = EXCLUDED.cantidad, updated_at = NOW();

-- 5) Transferencias: validar contra el saldo del LOCAL ORIGEN --------------
CREATE OR REPLACE FUNCTION fn_transferir_stock_local(
  p_insumo_id BIGINT,
  p_local_origen_id INTEGER,
  p_local_destino_id INTEGER,
  p_cantidad NUMERIC,
  p_motivo TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_insumo_nombre TEXT;
  v_costo NUMERIC;
  v_transf_id BIGINT;
  v_mov_origen_id BIGINT;
  v_mov_destino_id BIGINT;
  v_stock_origen NUMERIC;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RAISE EXCEPTION 'CANTIDAD_INVALIDA';
  END IF;
  IF p_local_origen_id = p_local_destino_id THEN
    RAISE EXCEPTION 'LOCALES_IGUALES';
  END IF;

  SELECT nombre, COALESCE(costo_actual, 0)
    INTO v_insumo_nombre, v_costo
    FROM insumos
   WHERE id = p_insumo_id
     AND tenant_id = v_tenant_id
     AND deleted_at IS NULL;
  IF v_insumo_nombre IS NULL THEN RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO'; END IF;

  IF NOT EXISTS (SELECT 1 FROM locales WHERE id = p_local_origen_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'LOCAL_ORIGEN_NO_ENCONTRADO';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM locales WHERE id = p_local_destino_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'LOCAL_DESTINO_NO_ENCONTRADO';
  END IF;

  IF NOT (auth_es_dueno_o_admin()
          OR p_local_origen_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO_ORIGEN';
  END IF;

  -- NUEVO: el saldo que importa es el del local origen, no el global
  SELECT COALESCE(cantidad, 0) INTO v_stock_origen
    FROM insumo_stock_local
   WHERE insumo_id = p_insumo_id AND local_id = p_local_origen_id;
  IF COALESCE(v_stock_origen, 0) < p_cantidad THEN
    RAISE EXCEPTION 'STOCK_INSUFICIENTE';
  END IF;

  INSERT INTO stock_transferencias (
    tenant_id, insumo_id, local_origen_id, local_destino_id,
    cantidad, costo_unitario, motivo, usuario_id
  ) VALUES (
    v_tenant_id, p_insumo_id, p_local_origen_id, p_local_destino_id,
    p_cantidad, v_costo, NULLIF(trim(p_motivo),''),
    NULL::INTEGER
  ) RETURNING id INTO v_transf_id;

  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id
  ) VALUES (
    v_tenant_id, p_local_origen_id, p_insumo_id, 'transferencia_local',
    -p_cantidad, v_costo,
    'Transfer a local ' || p_local_destino_id || COALESCE(' — ' || p_motivo, ''),
    'stock_transferencia', v_transf_id
  ) RETURNING id INTO v_mov_origen_id;

  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id
  ) VALUES (
    v_tenant_id, p_local_destino_id, p_insumo_id, 'transferencia_local',
    p_cantidad, v_costo,
    'Transfer desde local ' || p_local_origen_id || COALESCE(' — ' || p_motivo, ''),
    'stock_transferencia', v_transf_id
  ) RETURNING id INTO v_mov_destino_id;

  UPDATE stock_transferencias SET
    movimiento_origen_id = v_mov_origen_id,
    movimiento_destino_id = v_mov_destino_id
  WHERE id = v_transf_id;

  RETURN v_transf_id;
END;
$$;
REVOKE ALL ON FUNCTION fn_transferir_stock_local(BIGINT, INTEGER, INTEGER, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_transferir_stock_local(BIGINT, INTEGER, INTEGER, NUMERIC, TEXT) TO authenticated;

COMMIT;
```

- [ ] **Step 2: Verificación local de sintaxis**

No hay Postgres local — la verificación de sintaxis se hace aplicando en una transacción con ROLLBACK primero (ver Task 4 Step 2). En este paso solo: releer el SQL completo verificando que (a) cada función SECURITY DEFINER nueva/replazada conserva su auth check o es trigger interno, (b) hay `REVOKE ... FROM PUBLIC, anon` en cada función con GRANT, (c) los nombres de columnas coinciden con el DDL del reporte (`insumo_movimientos.cantidad`, `insumos.stock_actual`, `stock_transferencias.movimiento_origen_id`).

- [ ] **Step 3: Commit**

```bash
cd C:\Users\lucas\Documents\PASE
git add packages/pase/supabase/migrations/202606120100_stock_por_local.sql
git commit -m "feat(stock): tabla insumo_stock_local + trigger + recalc + backfill (Tier1 #1)"
```

---

### Task 2: Migración Cambio A (parte 2) — conteos per-local + `fn_cmv_real` v2

**Files:**
- Create: `packages/pase/supabase/migrations/202606120110_conteos_cmv_por_local.sql`
- Read first: `packages/pase/supabase/migrations/202605203400_stock_ajustes_conteo.sql` (definiciones actuales de `fn_iniciar_conteo_fisico`, `fn_cargar_conteo_linea`, `fn_finalizar_conteo_fisico`) y cualquier migración posterior que las reemplace (`grep -l "fn_iniciar_conteo_fisico\|fn_finalizar_conteo_fisico" packages/pase/supabase/migrations/*.sql` y tomar la ÚLTIMA versión de cada una).

- [ ] **Step 1: Localizar las versiones vigentes de las funciones de conteo**

Run: `grep -ln "CREATE OR REPLACE FUNCTION fn_iniciar_conteo_fisico\|CREATE OR REPLACE FUNCTION fn_finalizar_conteo_fisico" packages/pase/supabase/migrations/*.sql`
Tomar el archivo con timestamp MÁS ALTO para cada función — esa es la versión vigente que hay que copiar como base.

- [ ] **Step 2: Escribir la migración**

Crear `packages/pase/supabase/migrations/202606120110_conteos_cmv_por_local.sql`. Contiene TRES bloques:

**Bloque 1 — `fn_iniciar_conteo_fisico` v2:** copiar ÍNTEGRA la versión vigente encontrada en Step 1 y cambiar SOLO la expresión que snapshotea el teórico. Donde hoy dice (forma actual, puede variar levemente):

```sql
-- ANTES (snapshot global):
i.stock_actual AS stock_teorico
-- o equivalente: COALESCE(i.stock_actual, 0)
```

reemplazar por (snapshot del local del conteo):

```sql
-- DESPUÉS (snapshot per-local):
COALESCE(
  (SELECT sl.cantidad FROM insumo_stock_local sl
    WHERE sl.insumo_id = i.id AND sl.local_id = p_local_id),
  0
) AS stock_teorico
```

(`p_local_id` es el parámetro existente de la función — `stock_conteos.local_id` es NOT NULL, así que siempre está.)

**Bloque 2 — `fn_finalizar_conteo_fisico` v2:** copiar ÍNTEGRA la versión vigente y verificar que el INSERT del movimiento de ajuste `tipo='conteo'` incluya `local_id` tomado de `stock_conteos.local_id`. Si ya lo incluye, recrearla igual (sin cambios funcionales, queda documentado en esta migración que se auditó); si NO lo incluye, agregar la columna `local_id` al INSERT con el valor del conteo.

**Bloque 3 — `fn_cmv_real` v2 (texto completo, reemplaza la de `202605211500_cmv_real.sql`):** misma firma y mismas columnas de salida; cambian SOLO los CTEs `stock_ini` y `stock_fin`, que dejan de usar snapshots `stock_antes/stock_despues` (globales) y pasan a sumar el ledger del local hasta el borde del período (esto arregla también los períodos históricos sin movimientos):

```sql
CREATE OR REPLACE FUNCTION fn_cmv_real(
  p_tenant_id UUID,
  p_local_id INTEGER,
  p_desde DATE,
  p_hasta DATE
) RETURNS TABLE (
  insumo_id BIGINT,
  insumo_nombre TEXT,
  unidad TEXT,
  stock_inicial NUMERIC,
  compras_cantidad NUMERIC,
  compras_valor NUMERIC,
  mermas_cantidad NUMERIC,
  mermas_valor NUMERIC,
  stock_final NUMERIC,
  consumo_real_cantidad NUMERIC,
  consumo_real_valor NUMERIC,
  consumo_teorico_cantidad NUMERIC,
  consumo_teorico_valor NUMERIC,
  diferencia_cantidad NUMERIC,
  diferencia_valor NUMERIC,
  eficiencia_pct NUMERIC,
  costo_promedio NUMERIC
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH
  stock_ini AS (
    SELECT im.insumo_id AS iid, COALESCE(SUM(im.cantidad), 0) AS stock_inicial
      FROM insumo_movimientos im
     WHERE im.tenant_id = p_tenant_id
       AND im.local_id = p_local_id
       AND im.created_at::DATE < p_desde
       AND im.deleted_at IS NULL
     GROUP BY im.insumo_id
  ),
  stock_fin AS (
    SELECT im.insumo_id AS iid, COALESCE(SUM(im.cantidad), 0) AS stock_final
      FROM insumo_movimientos im
     WHERE im.tenant_id = p_tenant_id
       AND im.local_id = p_local_id
       AND im.created_at::DATE <= p_hasta
       AND im.deleted_at IS NULL
     GROUP BY im.insumo_id
  ),
  compras AS (
    SELECT im.insumo_id AS iid,
           SUM(im.cantidad) AS cantidad,
           SUM(im.cantidad * COALESCE(im.costo_unitario, 0)) AS valor
      FROM insumo_movimientos im
     WHERE im.local_id = p_local_id
       AND im.tenant_id = p_tenant_id
       AND im.created_at::DATE BETWEEN p_desde AND p_hasta
       AND im.tipo = 'entrada_compra'
       AND im.deleted_at IS NULL
     GROUP BY im.insumo_id
  ),
  mermas AS (
    SELECT im.insumo_id AS iid,
           SUM(ABS(im.cantidad)) AS cantidad,
           SUM(ABS(im.cantidad) * COALESCE(im.costo_unitario, 0)) AS valor
      FROM insumo_movimientos im
     WHERE im.local_id = p_local_id
       AND im.tenant_id = p_tenant_id
       AND im.created_at::DATE BETWEEN p_desde AND p_hasta
       AND im.tipo IN ('merma', 'robo', 'donacion', 'salida_ajuste')
       AND im.deleted_at IS NULL
     GROUP BY im.insumo_id
  ),
  teorico AS (
    SELECT im.insumo_id AS iid,
           SUM(ABS(im.cantidad)) AS cantidad,
           SUM(ABS(im.cantidad) * COALESCE(im.costo_unitario, 0)) AS valor
      FROM insumo_movimientos im
     WHERE im.local_id = p_local_id
       AND im.tenant_id = p_tenant_id
       AND im.created_at::DATE BETWEEN p_desde AND p_hasta
       AND im.tipo = 'salida_venta'
       AND im.deleted_at IS NULL
     GROUP BY im.insumo_id
  ),
  costo_prom AS (
    SELECT im.insumo_id AS iid,
           AVG(COALESCE(im.costo_unitario, 0)) FILTER (WHERE im.costo_unitario > 0) AS costo
      FROM insumo_movimientos im
     WHERE im.local_id = p_local_id
       AND im.tenant_id = p_tenant_id
       AND im.created_at::DATE BETWEEN p_desde AND p_hasta
       AND im.deleted_at IS NULL
     GROUP BY im.insumo_id
  )
  SELECT
    i.id::BIGINT,
    i.nombre,
    i.unidad,
    COALESCE(si.stock_inicial, 0)::NUMERIC,
    COALESCE(c.cantidad, 0)::NUMERIC,
    COALESCE(c.valor, 0)::NUMERIC,
    COALESCE(m.cantidad, 0)::NUMERIC,
    COALESCE(m.valor, 0)::NUMERIC,
    COALESCE(sf.stock_final, 0)::NUMERIC,
    (COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
     - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0))::NUMERIC AS consumo_real_cantidad,
    ((COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
      - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0))
     * COALESCE(cp.costo, i.costo_actual, 0))::NUMERIC AS consumo_real_valor,
    COALESCE(t.cantidad, 0)::NUMERIC AS consumo_teorico_cantidad,
    COALESCE(t.valor, 0)::NUMERIC AS consumo_teorico_valor,
    (COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
     - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0)
     - COALESCE(t.cantidad, 0))::NUMERIC AS diferencia_cantidad,
    ((COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
      - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0)
      - COALESCE(t.cantidad, 0)) * COALESCE(cp.costo, i.costo_actual, 0))::NUMERIC AS diferencia_valor,
    CASE
      WHEN (COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
            - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0)) > 0
      THEN ROUND(
        COALESCE(t.cantidad, 0) /
        NULLIF(COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
               - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0), 0) * 100,
        2
      )
      ELSE NULL
    END AS eficiencia_pct,
    COALESCE(cp.costo, i.costo_actual, 0)::NUMERIC AS costo_promedio
  FROM insumos i
  LEFT JOIN stock_ini si ON si.iid = i.id
  LEFT JOIN stock_fin sf ON sf.iid = i.id
  LEFT JOIN compras c ON c.iid = i.id
  LEFT JOIN mermas m ON m.iid = i.id
  LEFT JOIN teorico t ON t.iid = i.id
  LEFT JOIN costo_prom cp ON cp.iid = i.id
  WHERE i.tenant_id = p_tenant_id
    AND (i.local_id = p_local_id OR i.local_id IS NULL)
    AND i.deleted_at IS NULL
    AND i.activo = TRUE
    AND (
      COALESCE(c.cantidad, 0) > 0 OR
      COALESCE(t.cantidad, 0) > 0 OR
      COALESCE(m.cantidad, 0) > 0 OR
      COALESCE(si.stock_inicial, 0) <> 0 OR
      COALESCE(sf.stock_final, 0) <> 0
    )
  ORDER BY ABS(
    (COALESCE(si.stock_inicial, 0) + COALESCE(c.cantidad, 0)
     - COALESCE(sf.stock_final, 0) - COALESCE(m.cantidad, 0)
     - COALESCE(t.cantidad, 0)) * COALESCE(cp.costo, i.costo_actual, 0)
  ) DESC NULLS LAST;
END;
$$;
REVOKE ALL ON FUNCTION fn_cmv_real(UUID, INTEGER, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_cmv_real(UUID, INTEGER, DATE, DATE) TO authenticated;
```

Nota: el alias interno de los CTEs cambió a `iid` para no chocar con la columna de salida `insumo_id` (plpgsql RETURNS TABLE hace visible el nombre de salida dentro del cuerpo). Todo el archivo va envuelto en `BEGIN; ... COMMIT;`.

- [ ] **Step 3: Commit**

```bash
git add packages/pase/supabase/migrations/202606120110_conteos_cmv_por_local.sql
git commit -m "feat(stock): conteos snapshotean per-local + fn_cmv_real v2 sin snapshots globales"
```

---

### Task 3: Migración Cambio B — fecha de factura en entradas de compra (+ backfill reversible)

**Files:**
- Create: `packages/pase/supabase/migrations/202606120120_fecha_compra_factura.sql`
- Read first: `packages/pase/supabase/migrations/202605211400_entrada_stock_por_factura.sql` (función original completa, ya transcripta abajo) y verificar el tipo de `facturas.fecha` con `grep -n "fecha" packages/pase/supabase/migrations/*facturas*.sql` (se asume DATE; si fuera TIMESTAMPTZ, quitar el `::TIMESTAMPTZ` del código).

- [ ] **Step 1: Escribir la migración**

Crear `packages/pase/supabase/migrations/202606120120_fecha_compra_factura.sql`:

```sql
-- ============================================================
-- 202606120120_fecha_compra_factura.sql
-- Tier 1 #5 (informe 2026-06-11): la entrada de stock por compra
-- se fecha con la FECHA DE LA FACTURA, no con la fecha de carga.
-- Incluye backfill de movimientos históricos con tabla de backup
-- (reversible) — el CMV ya no usa snapshots, así que re-fechar es seguro.
-- ============================================================

BEGIN;

-- 1) Trigger v2: created_at = fecha de la factura ---------------------------
CREATE OR REPLACE FUNCTION fn_trg_factura_item_entrada_stock()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
  v_factura_fecha DATE;
  v_insumo_id BIGINT;
  v_factor_conv NUMERIC;
  v_cantidad_insumo NUMERIC(14, 4);
  v_costo_unitario NUMERIC(14, 4);
BEGIN
  IF NEW.materia_prima_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM insumo_movimientos
    WHERE fuente_tipo = 'factura_item'
      AND fuente_id = NEW.id::BIGINT
      AND deleted_at IS NULL
  ) THEN
    RETURN NEW;
  END IF;

  SELECT tenant_id, local_id, fecha INTO v_tenant_id, v_local_id, v_factura_fecha
    FROM facturas
   WHERE id = NEW.factura_id;
  IF v_local_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT insumo_id, COALESCE(factor_conversion, 1)
    INTO v_insumo_id, v_factor_conv
    FROM materias_primas
   WHERE id = NEW.materia_prima_id;

  IF v_insumo_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_cantidad_insumo := COALESCE(NEW.cantidad, 0) * v_factor_conv;
  v_costo_unitario := COALESCE(NEW.precio_unitario, 0) / GREATEST(v_factor_conv, 0.0001);

  IF v_cantidad_insumo <= 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id, created_at
  ) VALUES (
    v_tenant_id, v_local_id, v_insumo_id, 'entrada_compra',
    v_cantidad_insumo, v_costo_unitario,
    'Entrada auto por factura ' || NEW.factura_id,
    'factura_item', NEW.id::BIGINT,
    COALESCE(v_factura_fecha::TIMESTAMPTZ, NOW())
  );

  RETURN NEW;
END;
$$;

-- 2) Backfill histórico con backup reversible -------------------------------
CREATE TABLE IF NOT EXISTS _backup_mov_fechas_20260612 AS
SELECT im.id, im.created_at
  FROM insumo_movimientos im
  JOIN factura_items fi ON fi.id::BIGINT = im.fuente_id
  JOIN facturas f ON f.id = fi.factura_id
 WHERE im.fuente_tipo = 'factura_item'
   AND im.deleted_at IS NULL
   AND f.fecha IS NOT NULL
   AND im.created_at::DATE <> f.fecha;

UPDATE insumo_movimientos im
   SET created_at = f.fecha::TIMESTAMPTZ
  FROM factura_items fi
  JOIN facturas f ON f.id = fi.factura_id
 WHERE im.fuente_tipo = 'factura_item'
   AND im.fuente_id = fi.id::BIGINT
   AND im.deleted_at IS NULL
   AND f.fecha IS NOT NULL
   AND im.created_at::DATE <> f.fecha;

COMMIT;
```

Nota de seguridad: la tabla `_backup_mov_fechas_20260612` permite revertir con un UPDATE join si algo sale mal. No tiene RLS porque solo es accesible vía service role / SQL directo (no se expone al cliente: verificar que el nombre con `_` inicial no esté en el schema cache de PostgREST; si Supabase la expone, ejecutar `REVOKE ALL ON _backup_mov_fechas_20260612 FROM authenticated, anon;` dentro de la migración — agregar esa línea por defecto).

- [ ] **Step 2: Agregar el REVOKE del backup** (default seguro): añadir antes del COMMIT:

```sql
REVOKE ALL ON _backup_mov_fechas_20260612 FROM authenticated, anon, PUBLIC;
```

- [ ] **Step 3: Commit**

```bash
git add packages/pase/supabase/migrations/202606120120_fecha_compra_factura.sql
git commit -m "feat(compras): entrada de stock fechada con fecha de factura + backfill reversible"
```

---

### Task 4: Aplicar las 3 migraciones en producción (flow oficial)

**Files:**
- Create (temporal, borrar al final): `run-migration.mjs`, `.env.local.tmp`

- [ ] **Step 1: Bajar la connection string**

```bash
cd C:\Users\lucas\Documents\PASE\packages\pase
npx vercel env pull .env.local.tmp --environment=production
```
Verificar que `.env.local.tmp` contiene `POSTGRES_URL_NON_POOLING` no vacía (si está vacía: la env var está marcada Sensitive — avisar a Lucas y FRENAR).

- [ ] **Step 2: Dry-run con ROLLBACK**

Crear `run-migration.mjs` en la raíz del repo:

```javascript
import { readFileSync } from "fs";
import pg from "pg";

const envFile = readFileSync("packages/pase/.env.local.tmp", "utf8");
const url = envFile.match(/POSTGRES_URL_NON_POOLING="?([^"\n]+)"?/)?.[1];
if (!url) { console.error("No POSTGRES_URL_NON_POOLING"); process.exit(1); }

const files = process.argv.slice(2);
const dryRun = process.env.DRY_RUN === "1";
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  for (const f of files) {
    let sql = readFileSync(f, "utf8");
    if (dryRun) {
      // las migraciones traen su propio BEGIN/COMMIT — en dry-run los neutralizamos
      sql = sql.replace(/^\s*BEGIN;\s*$/gim, "").replace(/^\s*COMMIT;\s*$/gim, "");
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("ROLLBACK");
      console.log(`DRY-RUN OK (rolled back): ${f}`);
    } else {
      await client.query(sql);
      console.log(`APPLIED: ${f}`);
    }
  }
  // verificaciones post-aplicación
  if (!dryRun) {
    const r1 = await client.query("SELECT COUNT(*)::int AS n FROM insumo_stock_local");
    console.log("insumo_stock_local filas:", r1.rows[0].n);
    const r2 = await client.query(`
      SELECT COUNT(*)::int AS inconsistentes FROM (
        SELECT i.id FROM insumos i
        JOIN LATERAL (
          SELECT COALESCE(SUM(cantidad),0) AS total FROM insumo_movimientos m
          WHERE m.insumo_id = i.id AND m.deleted_at IS NULL
        ) led ON TRUE
        WHERE ABS(COALESCE(i.stock_actual,0) - led.total) > 0.001
          AND EXISTS (SELECT 1 FROM insumo_movimientos m2 WHERE m2.insumo_id = i.id AND m2.deleted_at IS NULL)
      ) x`);
    console.log("insumos con cache global inconsistente vs ledger:", r2.rows[0].inconsistentes);
    const r3 = await client.query("SELECT COUNT(*)::int AS refechados FROM _backup_mov_fechas_20260612");
    console.log("movimientos re-fechados (backup):", r3.rows[0].refechados);
  }
} finally {
  await client.end();
}
```

```bash
cd C:\Users\lucas\Documents\PASE
npm install pg --no-save
DRY_RUN=1 node run-migration.mjs packages/pase/supabase/migrations/202606120100_stock_por_local.sql packages/pase/supabase/migrations/202606120110_conteos_cmv_por_local.sql packages/pase/supabase/migrations/202606120120_fecha_compra_factura.sql
```
(En PowerShell: `$env:DRY_RUN="1"; node run-migration.mjs ...`)
Expected: `DRY-RUN OK (rolled back)` × 3. Si falla, arreglar el SQL y repetir — NO aplicar hasta que el dry-run pase.

- [ ] **Step 3: Aplicar en serio**

```bash
node run-migration.mjs packages/pase/supabase/migrations/202606120100_stock_por_local.sql packages/pase/supabase/migrations/202606120110_conteos_cmv_por_local.sql packages/pase/supabase/migrations/202606120120_fecha_compra_factura.sql
```
Expected: `APPLIED` × 3 + conteo de filas de `insumo_stock_local` > 0 + `inconsistentes: 0` (si da > 0, correr `SELECT fn_recalcular_stock_todos('<tenant>')` por tenant afectado) + número de re-fechados.

- [ ] **Step 4: Limpieza**

```bash
rm run-migration.mjs packages/pase/.env.local.tmp
```
(PowerShell: `Remove-Item run-migration.mjs, packages\pase\.env.local.tmp`)

---

### Task 5: Frontend — Stock.tsx per-local + mostrar agotados

**Files:**
- Modify: `packages/pase/src/pages/Stock.tsx` (query en ~línea 97-98; lista de insumos; modal de mermas ~línea 364)

- [ ] **Step 1: Cambiar la query para traer per-local y NO ocultar agotados**

En la query actual (línea ~97):

```typescript
// ANTES
db.from("insumos").select("id, nombre, unidad, emoji, stock_actual, stock_minimo, stock_maximo, costo_actual")
  .eq("activo", true).eq("stock_disponible", true).is("deleted_at", null).order("nombre")
```

```typescript
// DESPUÉS — sin el filtro stock_disponible + embed per-local
db.from("insumos").select("id, nombre, unidad, emoji, stock_actual, stock_minimo, stock_maximo, costo_actual, insumo_stock_local(local_id, cantidad)")
  .eq("activo", true).is("deleted_at", null).order("nombre")
```

- [ ] **Step 2: Derivar el stock a mostrar según el local activo**

Agregar un helper en el componente (adaptar nombres a los hooks reales del archivo — el patrón de PASE es `const { user } = useAuth()` + `localActivo` del contexto; si Stock.tsx no tiene `localActivo`, importarlo del mismo lugar que usa `rentabilidad/TabStock.tsx`):

```typescript
type StockLocalRow = { local_id: number; cantidad: number };

function stockVisible(ins: { stock_actual: number | null; insumo_stock_local?: StockLocalRow[] }, localActivo: number | null): number {
  if (localActivo != null) {
    const fila = (ins.insumo_stock_local ?? []).find(l => l.local_id === localActivo);
    return Number(fila?.cantidad ?? 0);
  }
  return Number(ins.stock_actual ?? 0); // dueño sin local activo → total global
}
```

Usar `stockVisible(i, localActivo)` en todos los lugares del archivo donde hoy se muestra `i.stock_actual` (lista principal y el `<option>` del modal de mermas en ~línea 364).

- [ ] **Step 3: Badge "Agotado"**

En la fila de la lista, donde se renderiza el stock, agregar:

```tsx
{stockVisible(i, localActivo) <= 0 && (
  <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">Agotado</span>
)}
```

(ajustar clases al design system del archivo — copiar el patrón de chips que ya use Stock.tsx o TabStock.tsx).

- [ ] **Step 4: Typecheck + lint**

```bash
cd C:\Users\lucas\Documents\PASE
pnpm --filter pase typecheck
pnpm --filter pase lint
```
Expected: 0 errors. (Nota C3: `insumos` no está en la lista de tablas con `applyLocalScope` obligatorio — el scoping per-local acá es lógico, no de seguridad; RLS de `insumo_stock_local` cubre el backend.)

- [ ] **Step 5: Commit**

```bash
git add packages/pase/src/pages/Stock.tsx
git commit -m "feat(stock): pantalla Stock muestra stock por local activo + insumos agotados con badge"
```

---

### Task 6: Test mutante nuevo `stock_por_local_mutante.spec.ts`

**Files:**
- Create: `packages/pase/tests/stock_por_local_mutante.spec.ts`
- Reference pattern: `packages/pase/tests/stock_conteo_mermas_mutante.spec.ts` (helpers `createDuenoClient`, seeds `Local Prueba 2`, sentinels numéricos, cleanup en afterEach con try/catch por paso)

- [ ] **Step 1: Escribir el test**

Estructura (adaptar imports/helpers EXACTOS copiándolos del spec de referencia — mismo `createDuenoClient`, misma forma de resolver `tenant_id` y locales):

```typescript
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createDuenoClient } from "./helpers"; // ← usar la ruta real del spec de referencia

// Sentinels distintivos
const QTY_COMPRA = 7.7301;   // entra al local A
const QTY_TRANSFER = 2.1101; // A → B
const QTY_MERMA = 1.0701;    // sale de B
const FECHA_FACTURA = "2026-06-01"; // fecha retroactiva para el assert del Cambio B

describe("stock por local + fecha de compra (mutante)", () => {
  let db: any, tenantId: string, localA: number, localB: number;
  let insumoId: number | null = null, mpId: number | null = null, facturaId: string | null = null;

  beforeAll(async () => {
    db = await createDuenoClient();
    // localA = "Local Prueba 2" (seed estándar); localB = cualquier otro local del tenant
    // (copiar el patrón de resolución de locales del spec de referencia;
    //  pre-check: si no hay 2 locales, fail con mensaje accionable "seed: crear segundo local de prueba")
  });

  afterEach(async () => {
    // cleanup: cada paso en su propio try/catch
    // 1. anular factura (dispara reverso de stock)  2. borrar movimientos de test (deleted_at)
    // 3. fn_recalcular_stock_insumo(insumoId)  4. borrar insumo/MP de test (soft delete)
  });

  it("compra entra al local de la factura, transferencia mueve entre locales, merma sale del local correcto, y la fecha es la de la factura", async () => {
    // 1. Crear insumo de test + materia prima vinculada (factor_conversion 1)
    // 2. Crear factura en localA con fecha = FECHA_FACTURA + 1 item con materia_prima_id y cantidad QTY_COMPRA
    // 3. ASSERT Cambio A: insumo_stock_local(insumoId, localA).cantidad === QTY_COMPRA  (toBe tras Number().toFixed(4))
    //    ASSERT: no existe fila (insumoId, localB) o cantidad 0
    //    ASSERT: insumos.stock_actual === QTY_COMPRA (cache global sigue siendo el total)
    // 4. ASSERT Cambio B: el movimiento entrada_compra tiene created_at::date === FECHA_FACTURA
    //    SELECT created_at FROM insumo_movimientos WHERE fuente_tipo='factura_item' AND insumo_id=...
    // 5. rpc fn_transferir_stock_local(insumoId, localA, localB, QTY_TRANSFER)
    //    ASSERT: localA = QTY_COMPRA - QTY_TRANSFER; localB = QTY_TRANSFER; global sin cambio
    // 6. rpc fn_registrar_merma en localB por QTY_MERMA
    //    ASSERT: localB = QTY_TRANSFER - QTY_MERMA
    // 7. Transferencia que excede el saldo del ORIGEN (localB, QTY grande):
    //    ASSERT: rechaza con error STOCK_INSUFICIENTE aunque el stock GLOBAL alcance
    // 8. fn_cmv_real(tenant, localA, FECHA_FACTURA, hoy):
    //    ASSERT: fila del insumo con compras_cantidad === QTY_COMPRA y stock_final === QTY_COMPRA - QTY_TRANSFER
  });
});
```

El cuerpo de cada paso usa las MISMAS llamadas Supabase que el spec de referencia (`db.from(...).insert/select`, `db.rpc(...)`) — copiar la mecánica de creación de factura+items del test `materias_primas_cmv_mutante.spec.ts`, que ya crea facturas con items mapeados a materia prima.

- [ ] **Step 2: Correr el test**

```bash
pnpm --filter pase test -- tests/stock_por_local_mutante.spec.ts
```
Expected: PASS. Si el paso 7 no tira `STOCK_INSUFICIENTE`, la validación per-local de la Task 1 está mal — arreglar la migración (nueva migración fix), no el test.

- [ ] **Step 3: Correr los mutantes existentes del circuito (regresión)**

```bash
pnpm --filter pase test -- tests/stock_conteo_mermas_mutante.spec.ts tests/cmv_insumos_recetas_mutante.spec.ts tests/materias_primas_cmv_mutante.spec.ts
```
Expected: PASS los 3. Atención esperada: si algún assert compara fechas de movimientos `entrada_compra` contra `now()`, ajustarlo a la fecha de la factura del test (cambio de comportamiento intencional del Cambio B).

- [ ] **Step 4: Commit**

```bash
git add packages/pase/tests/stock_por_local_mutante.spec.ts
git commit -m "test: mutante stock por local + fecha de compra (Tier1 #1 y #5)"
```

---

### Task 7: Actualizar suite e2e-full

**Files:**
- Modify: `packages/pase/tests/e2e-full/sprint-1/39-stock-conteo-mermas.spec.ts` (o el archivo de invariantes finales de la suite — localizar con `ls packages/pase/tests/e2e-full/`)

- [ ] **Step 1: Agregar invariante SQL per-local**

Al archivo de invariantes (o al final del #39), agregar un assert nuevo:

```typescript
// INVARIANTE: la cache per-local coincide con el ledger para todo insumo del tenant E2E
const { data: rows } = await db.rpc("exec_invariante_stock_local").catch(() => ({ data: null }));
// Si no existe RPC de invariantes, hacer la query directa:
const { data: incons } = await db
  .from("insumo_stock_local")
  .select("insumo_id, local_id, cantidad")
  .eq("tenant_id", TENANT_E2E);
for (const r of incons ?? []) {
  const { data: led } = await db
    .from("insumo_movimientos")
    .select("cantidad")
    .eq("insumo_id", r.insumo_id)
    .eq("local_id", r.local_id)
    .is("deleted_at", null);
  const total = (led ?? []).reduce((s: number, m: any) => s + Number(m.cantidad), 0);
  expect(Math.abs(Number(r.cantidad) - total)).toBeLessThan(0.001);
}
```

(usar el `TENANT_E2E` / cliente que ya use la suite — copiar de los asserts vecinos del mismo archivo).

- [ ] **Step 2: Correr la suite e2e-full completa**

```bash
pnpm --filter pase test -- tests/e2e-full
```
Expected: verde completa. **NO mergear si falla** (regla del repo).

- [ ] **Step 3: Commit**

```bash
git add packages/pase/tests/e2e-full
git commit -m "test(e2e-full): invariante cache stock per-local vs ledger"
```

---

### Task 8: Cierre — push, deploy, memoria

- [ ] **Step 1: Push y verificación de deploy**

```bash
git push
```
Verificar en Vercel que el deployment de `packages/pase` queda `state=READY` (regla del repo: build OK no alcanza).

- [ ] **Step 2: Smoke manual sugerido a Lucas** (mensaje, no código): abrir Stock con un local activo y verificar que los números son razonables y que los agotados aparecen con badge; si algún número per-local se ve raro → correr un conteo físico en ese local (el conteo ahora ajusta per-local y deja todo alineado).

- [ ] **Step 3: Actualizar memoria persistente**

Agregar al archivo de memoria de la sesión (`project_analisis_logica_11_jun.md` o uno nuevo de features): qué se implementó (Tier 1 #1 y #5), migraciones aplicadas (202606120100/110/120), backup `_backup_mov_fechas_20260612` para revertir el re-fechado, test mutante nuevo, y el pendiente operativo (conteo físico por local para calibrar los números backfilleados). Actualizar `MEMORY.md` si el archivo es nuevo.

---

## Self-review (hecho al escribir el plan)

- **Cobertura del spec:** Tier 1 #1 (tabla per-local ✅ Task 1, conteos ✅ Task 2, CMV per-local ✅ Task 2, transferencias ✅ Task 1, UI ✅ Task 5) y Tier 1 #5 (trigger fecha ✅ Task 3, backfill reversible ✅ Task 3). El fix "Stock oculta agotados" (informe 01 §2.3) ✅ Task 5. Fuera de alcance declarado: auto-86 per-local en COMANDA (depende de `insumos.stock_disponible` global — anotado como pendiente en la memoria), costo ponderado (Tier 3), recepción por remito (Tier 1 #5 del informe 01 pero alcance grande — sprint aparte).
- **Tipos consistentes:** `insumo_stock_local.cantidad NUMERIC(12,4)` = tipo del ledger; PK `(insumo_id, local_id)` usada igual en trigger/recalc/backfill/UI embed.
- **Riesgo principal y mitigación:** números per-local backfilleados pueden no reflejar la realidad física si hubo movimientos históricos sin disciplina de local → mitigado: el conteo físico per-local (Task 2) los corrige, y el dry-run con ROLLBACK (Task 4) frena errores de SQL antes de tocar prod.
