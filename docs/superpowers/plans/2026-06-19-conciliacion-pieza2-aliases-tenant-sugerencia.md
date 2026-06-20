# Conciliación — Pieza 2: aliases tenant-wide + sugerencia proactiva — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps con checkbox `- [ ]`.

**Goal:** (a) Que un alias titular→proveedor aprendido sirva para TODOS los locales (no repetir el aprendizaje por local). (b) Cuando una transferencia queda `rojo_falta` y su monto coincide con el pago de un único proveedor del período, ofrecer crear el alias con 1 clic y re-cruzar.

**Decisiones de Lucas (19-jun):** aditivo (los ~800 aliases por-local viejos se DEJAN como están y siguen funcionando; los nuevos se guardan tenant-wide) + construir la sugerencia proactiva ahora.

**Architecture:** `conciliacion_alias.local_id` pasa a ser NULLable (NULL = todos los locales). El cruce lee local + global con **prioridad local**. El aprendizaje al cerrar y la RPC nueva guardan global. El cruce devuelve un array `sugerencias`; la UI las muestra con botón "Es <proveedor>" → RPC `fn_crear_alias_proveedor` (global) + `refrescarCruce()`.

**Tech Stack:** PL/pgSQL + React. Migraciones vía script Node. Cruce verificado con copia renombrada.

---

## Notas de cumplimiento (CLAUDE.md)
- **C11:** todas las RPCs SECURITY DEFINER nuevas chequean auth en las primeras líneas.
- **C9:** errores nuevos en UPPER_SNAKE mapeados en `errors.ts`.
- **C2:** la RPC `fn_crear_alias_proveedor` NO mueve plata (escribe en `conciliacion_alias`, tabla de config, no financiera) → sin mutante. El cruce es solo-lectura. Verificación = antes/después en borrador real.
- **Aditivo / no romper:** no se borran ni migran filas viejas. Índices parciales nuevos conviven con las filas por-local.

---

### Task 1: Migración de esquema + aprendizaje global + RPC nueva

**Files:** Create `packages/pase/supabase/migrations/202606191400_conciliacion_alias_tenant_wide.sql`

- [ ] **Step 1: Averiguar el nombre real del constraint UNIQUE viejo**

Con credenciales bajadas, query: `SELECT conname FROM pg_constraint WHERE conrelid='conciliacion_alias'::regclass AND contype='u';` → usar ese nombre en el DROP CONSTRAINT (fallback: `conciliacion_alias_tenant_id_local_id_titular_key`).

- [ ] **Step 2: Escribir la migración**

```sql
-- Pieza 2: aliases tenant-wide. local_id NULL = todos los locales del tenant.
ALTER TABLE conciliacion_alias ALTER COLUMN local_id DROP NOT NULL;

ALTER TABLE conciliacion_alias DROP CONSTRAINT IF EXISTS conciliacion_alias_tenant_id_local_id_titular_key;
CREATE UNIQUE INDEX IF NOT EXISTS conciliacion_alias_local_uq
  ON conciliacion_alias (tenant_id, local_id, titular) WHERE local_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS conciliacion_alias_global_uq
  ON conciliacion_alias (tenant_id, titular) WHERE local_id IS NULL;

-- RLS: filas globales visibles a todo el tenant
DROP POLICY IF EXISTS concil_alias_all ON conciliacion_alias;
CREATE POLICY concil_alias_all ON conciliacion_alias
  FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())))
  WITH CHECK (tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())));

-- RPC: crear/confirmar alias titular→proveedor (tenant-wide). Usado por la sugerencia.
CREATE OR REPLACE FUNCTION fn_crear_alias_proveedor(p_titular TEXT, p_prov_id INTEGER)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_tenant_id UUID;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR auth_tiene_permiso('conciliacion')) THEN
    RAISE EXCEPTION 'SIN_PERMISO_CONCILIACION';
  END IF;
  IF p_titular IS NULL OR length(trim(p_titular)) < 4 THEN RAISE EXCEPTION 'TITULAR_INVALIDO'; END IF;
  IF NOT EXISTS (SELECT 1 FROM proveedores WHERE id = p_prov_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'PROVEEDOR_INVALIDO';
  END IF;
  INSERT INTO conciliacion_alias (tenant_id, local_id, titular, tipo, prov_id)
  VALUES (v_tenant_id, NULL, trim(p_titular), 'proveedor', p_prov_id)
  ON CONFLICT (tenant_id, titular) WHERE local_id IS NULL
  DO UPDATE SET tipo='proveedor', prov_id=EXCLUDED.prov_id,
               veces=conciliacion_alias.veces+1, updated_at=NOW();
END;
$fn$;
REVOKE ALL ON FUNCTION fn_crear_alias_proveedor(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_crear_alias_proveedor(TEXT, INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 3: Cambiar el aprendizaje al cerrar para que guarde global**

En la MISMA migración, recrear `fn_cerrar_conciliacion` igual que `202606110400` pero cambiando el bloque de aprendizaje: `local_id` del INSERT = `NULL` (en vez de `p_local_id`) y `ON CONFLICT (tenant_id, titular) WHERE local_id IS NULL`. (Copiar el cuerpo completo de la función actual desde `pg_get_functiondef`, cambiar solo esas 2 cosas, agregar `;` + grants + NOTIFY.)

- [ ] **Step 4: Aplicar + verificar**

Script Node BEGIN/COMMIT. Verificar: (a) `local_id` ahora nullable (`SELECT is_nullable FROM information_schema.columns WHERE table_name='conciliacion_alias' AND column_name='local_id'` → 'YES'); (b) los 2 índices parciales existen; (c) `fn_crear_alias_proveedor` existe; (d) insertar un alias de prueba global con un titular dummy + prov real, releer, borrarlo (BEGIN/ROLLBACK para no ensuciar).

- [ ] **Step 5: errors.ts**

Agregar a `translateRpcError`: `SIN_PERMISO_CONCILIACION`→"No tenés permiso para conciliación.", `TITULAR_INVALIDO`→"El titular es inválido.", `PROVEEDOR_INVALIDO`→"El proveedor no existe."

- [ ] **Step 6: Commit** `feat(conciliacion): aliases tenant-wide + RPC fn_crear_alias_proveedor (Pieza 2a)`

---

### Task 2: Cruce — lookup local+global con prioridad + array `sugerencias`

**Files:** Create `packages/pase/supabase/migrations/202606191410_conciliacion_cruce_alias_global_sugerencias.sql`

- [ ] **Step 1: Cambiar el lookup de alias (líneas 79-85 de la función)**

De:
```sql
  UPDATE _ce_ext e SET alias_tipo = a.tipo, alias_prov = a.prov_id
  FROM conciliacion_alias a
  WHERE a.tenant_id = v_tenant_id AND a.local_id = p_local_id
    AND a.titular = fn_extraer_titular(e.descripcion);
```
a:
```sql
  UPDATE _ce_ext e SET alias_tipo = a.tipo, alias_prov = a.prov_id
  FROM (
    SELECT DISTINCT ON (titular) titular, tipo, prov_id
    FROM conciliacion_alias
    WHERE tenant_id = v_tenant_id
      AND (local_id = p_local_id OR local_id IS NULL)
    ORDER BY titular, (local_id IS NULL)  -- local-especifico (FALSE) primero
  ) a
  WHERE a.titular = fn_extraer_titular(e.descripcion);
```

- [ ] **Step 2: Agregar el cálculo de sugerencias antes del bloque de resultado**

Nueva var `v_sugerencias JSONB;` en DECLARE. Antes del `-- ── Resultado ──`:
```sql
  -- Sugerencias proactivas: filas rojo_falta SIN alias cuyo monto coincide
  -- con el pago de UN ÚNICO proveedor del período. Ofrece aprender el alias.
  SELECT COALESCE(jsonb_agg(s.j ORDER BY s.idx), '[]'::jsonb)
  INTO v_sugerencias
  FROM (
    SELECT e.idx, jsonb_build_object(
      'ext_idx', e.idx, 'fecha', e.fecha, 'monto', e.monto,
      'descripcion', e.descripcion, 'titular', fn_extraer_titular(e.descripcion),
      'prov_id', x.prov_id, 'prov_nombre', x.prov_nombre, 'n_pagos', x.n
    ) AS j
    FROM _ce_ext e
    CROSS JOIN LATERAL (
      SELECT m.prov_id, MAX(m.prov_nombre) AS prov_nombre, COUNT(*) AS n,
             COUNT(*) OVER () AS distintos
      FROM _ce_mov m
      WHERE m.prov_id IS NOT NULL
        AND ABS(m.importe - e.monto) <= 1
        AND m.fecha BETWEEN p_periodo_desde AND p_periodo_hasta
      GROUP BY m.prov_id, m.prov_nombre
    ) x
    WHERE e.estado = 'rojo_falta' AND e.alias_prov IS NULL
      AND COALESCE(e.alias_tipo,'') <> 'gasto_directo'
      AND x.distintos = 1
      AND fn_extraer_titular(e.descripcion) IS NOT NULL
  ) s;
```
(`COUNT(*) OVER ()` tras `GROUP BY m.prov_id, m.prov_nombre` = nº de grupos = nº de proveedores distintos. =1 ⇒ un solo proveedor.)

- [ ] **Step 3: Incluir `sugerencias` en el JSON de resultado**

En el `jsonb_build_object` del resultado, agregar `'sugerencias', COALESCE(v_sugerencias, '[]'::jsonb),`.

- [ ] **Step 4: Probar con copia renombrada `_t`**

Script: generar `fn_cruzar_extracto_mp_t` con los 3 cambios, correr sobre borrador local 1, verificar: (a) compila, (b) totales NO empeoran vs la real (el lookup global no debería quitar verdes; podría sumar si hay aliases globales nuevos — todavía no hay), (c) `sugerencias` es un array (0+ items) sin error. DROP la copia.

- [ ] **Step 5: Escribir la migración real, aplicar, verificar (cruce real sobre local 1 sin regresión), commit + push.**

---

### Task 3: Frontend — render de sugerencias + crear alias + recruce

**Files:** Modify `packages/pase/src/pages/ConciliacionExtracto.tsx`

- [ ] **Step 1: Tipo del resultado del cruce** — agregar `sugerencias?: Sugerencia[]` al tipo `Cruce`, con `interface Sugerencia { ext_idx:number; fecha:string; monto:number; descripcion:string; titular:string; prov_id:number; prov_nombre:string; n_pagos:number }`.

- [ ] **Step 2: Estado + handler** — `const [creandoAlias, setCreandoAlias] = useState<number|null>(null)` y:
```ts
async function confirmarAliasSugerido(s: Sugerencia) {
  setCreandoAlias(s.ext_idx);
  try {
    const { error } = await db.rpc("fn_crear_alias_proveedor", { p_titular: s.titular, p_prov_id: s.prov_id });
    if (error) throw error;
    await refrescarCruce();
  } catch (e) { alert(translateRpcError(e)); }
  finally { setCreandoAlias(null); }
}
```

- [ ] **Step 3: Sección UI** — cuando `cruce?.sugerencias?.length`, una Card "💡 Sugerencias de proveedor" listando cada `s`: "«{s.titular}» ({fmt_$(s.monto)}) podría ser **{s.prov_nombre}**" + botón "✓ Es {s.prov_nombre}" (disabled si `creandoAlias===s.ext_idx`) → `confirmarAliasSugerido(s)`. Colocarla cerca del resumen del cruce (arriba de la tabla del extracto).

- [ ] **Step 4: Verificar** typecheck + lint + build. (UI nueva, sin plata → sin mutante.)

- [ ] **Step 5: Commit + push** `feat(conciliacion): UI sugerencias de proveedor + crear alias 1-clic (Pieza 2b)`.

---

## Self-Review
- **Spec Pieza 2(1) aliases tenant-wide:** Task 1 (nullable + índices + RLS + aprendizaje global) + Task 2 Step 1 (lookup local+global prioridad). ✅
- **Spec Pieza 2(2) sugerencia proactiva:** Task 2 Steps 2-3 (cálculo en cruce) + Task 3 (UI + RPC + recruce). ✅
- **"no romper aliases existentes":** índices parciales conviven; lookup prioriza local; nada se borra. ✅
- **Placeholders:** ninguno. ✅
- **Tipos:** `Sugerencia` definida en Task 3 Step 1, usada en 2/3. `fn_crear_alias_proveedor(p_titular text, p_prov_id integer)` consistente Task 1↔3. ✅

## Riesgos
- ON CONFLICT con índice parcial: la cláusula `WHERE local_id IS NULL` debe coincidir EXACTO con el predicado del índice `conciliacion_alias_global_uq`. Verificar en Task 1 Step 4.
- La sugerencia incluye movs usados (a propósito: si fueran no-usados, R1 ya los habría matcheado). Es solo sugerencia (el usuario confirma) → no auto-aplica nada.
