# Conciliación — Pieza 1: emparejamiento por proveedor + fecha — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el cruce, cuando conoce el proveedor de una transferencia (vía `alias_prov`), agarre primero el pago **de ese mismo proveedor** y, si hay varios, el de **fecha más cercana** — en vez de matchear por monto y orden de `idx` (que hacía que una transferencia robara el pago de otra del mismo monto pero distinto proveedor).

**Architecture:** Se agrega un paso **R1-pre** a `fn_cruzar_extracto_mp`, entre R0 (match por referencia) y R1 (match por monto en período estricto). R1-pre recorre solo las filas `rojo_falta` con `alias_prov` conocido y busca pagos no usados **del mismo proveedor** (`m.prov_id = e.alias_prov`) con monto ≈ y fecha en el período. 1 candidato → verde; ≥2 → gana el de fecha estrictamente más cercana (verde), empate de fecha → amarillo. Es **aditivo**: las filas sin alias siguen exactamente por R1/R2/R3 como hoy. El cruce es de solo lectura (no mueve plata).

**Tech Stack:** PL/pgSQL (Postgres en Supabase), migración SQL vía script Node one-off. Verificación reproduciendo el cruce real contra borradores guardados (`conciliacion_borradores`).

---

## Contexto

- La función actual (`_cruce_def.sql`, 621 líneas) ya tiene:
  - `_ce_ext.alias_prov` (integer): proveedor resuelto del titular bancario vía `conciliacion_alias` (líneas 79-85).
  - `_ce_mov.prov_id` (integer): proveedor del pago, derivado de la factura/remito que pagó (líneas 108-109).
- R1 (líneas 156-211) matchea por `ABS(importe-monto)<=1 AND fecha BETWEEN período`, **sin mirar proveedor**. Si hay 1 candidato → verde; si ≥2 → amarillo. El orden de `idx` decide quién agarra el único candidato → bug SAN JOSE.
- R3 (combos) y R3.5 (facturas pendientes) **ya** usan `alias_prov` como filtro (`v_fila.alias_prov IS NULL OR m.prov_id = v_fila.alias_prov`). R1 es el único que no lo aprovecha. Pieza 1 lleva esa misma idea al match individual y le agrega el desempate por fecha.
- Pieza 3 (ya en prod) saca del cruce las transferencias devueltas → protege a R1-pre de aliases malos sobre transferencias que en realidad volvieron (caso Sorribas).

## Notas de cumplimiento (CLAUDE.md)

- **C2 (test mutante):** NO aplica directo — el cruce es de **solo lectura** (no INSERT/UPDATE sobre tablas financieras; calcula matches y devuelve JSONB). La verificación es reproducir el cruce real antes/después sobre borradores guardados y comparar la distribución de estados (Task 3).
- **C11 (SECURITY DEFINER con auth check):** se preserva intacto el chequeo de auth de las primeras líneas (`auth_tenant_id()` + `auth_es_dueno_o_admin()`/`auth_locales_visibles()`). No se toca.
- **E2E full:** el cruce no está en el script del mes operativo de la suite; no se agrega operación. Si conviene un invariante, plantearlo a Lucas; no bloquea.
- **Migración:** flujo oficial (commit SQL en `supabase/migrations/`, `vercel env pull`, script Node BEGIN/COMMIT, verificar, limpiar). **OJO: `pg_get_functiondef` no trae `;` final** → al recrear, el archivo de migración se escribe a mano (no copiado de functiondef), así que el `;` ya está; pero igual incluir `NOTIFY pgrst, 'reload schema';` al final.

---

### Task 1: Construir y probar la copia `fn_cruzar_extracto_mp_t` (sin tocar la real)

**Files:** ninguno commiteado (script Node temporal `packages/pase/_pieza1_test.mjs` + borrado).

Objetivo: crear una copia renombrada de la función con el paso R1-pre, correr el cruce ANTES (función real) y DESPUÉS (copia) sobre el borrador de local 1, comparar la distribución de estados. La copia se DROPea al final. No se toca la función productiva.

- [ ] **Step 1: Bajar credenciales**

Run: `cd /c/Users/lucas/Documents/PASE/packages/pase && npx vercel env pull .env.local.tmp --environment=production`
Expected: `.env.local.tmp` con `POSTGRES_URL_NON_POOLING`.

- [ ] **Step 2: Crear el script de prueba**

El R1-pre a insertar (después del bloque R0, antes del comentario `-- R1: individual`):

```sql
  -- R1-pre: match por PROVEEDOR (alias) + FECHA más cercana. Para filas con
  -- proveedor conocido (alias_prov), agarrar primero el pago DE ESE proveedor.
  -- Evita que una transferencia robe el pago de otra del mismo monto pero
  -- distinto proveedor (caso SAN JOSE/Sorribas, Lucas 18-jun). Entre varios
  -- pagos del mismo proveedor gana el de fecha más cercana; empate → amarillo.
  FOR v_fila IN
    SELECT * FROM _ce_ext
    WHERE estado = 'rojo_falta' AND alias_prov IS NOT NULL
    ORDER BY idx
  LOOP
    SELECT COUNT(*),
           (array_agg(m.id ORDER BY ABS(m.fecha - v_fila.fecha), ABS(m.importe - v_fila.monto)))[1],
           array_agg(ABS(m.fecha - v_fila.fecha) ORDER BY ABS(m.fecha - v_fila.fecha), ABS(m.importe - v_fila.monto)),
           COALESCE(jsonb_agg(jsonb_build_object(
             'id', m.id, 'fecha', m.fecha, 'importe', m.importe, 'detalle', m.detalle,
             'dias_diff', ABS(m.fecha - v_fila.fecha), 'dif_monto', ABS(m.importe - v_fila.monto),
             'ya_conciliado', false
           ) ORDER BY ABS(m.fecha - v_fila.fecha), ABS(m.importe - v_fila.monto)), '[]'::jsonb)
    INTO v_cand_count, v_cand_id, v_dias_arr, v_cands
    FROM _ce_mov m
    WHERE NOT m.usado
      AND m.prov_id = v_fila.alias_prov
      AND ABS(m.importe - v_fila.monto) <= 1
      AND m.fecha BETWEEN p_periodo_desde AND p_periodo_hasta;

    IF v_cand_count = 1 THEN
      UPDATE _ce_mov SET usado = TRUE WHERE id = v_cand_id;
      UPDATE _ce_ext SET estado = 'verde', candidatos = v_cands WHERE idx = v_fila.idx;
    ELSIF v_cand_count >= 2 THEN
      IF v_dias_arr[1] < v_dias_arr[2] THEN
        UPDATE _ce_mov SET usado = TRUE WHERE id = v_cand_id;
        UPDATE _ce_ext SET estado = 'verde', candidatos = v_cands WHERE idx = v_fila.idx;
      ELSE
        UPDATE _ce_ext SET estado = 'amarillo', candidatos = v_cands WHERE idx = v_fila.idx;
      END IF;
    END IF;
  END LOOP;
```

Nueva variable a declarar en el bloque DECLARE: `v_dias_arr INT[];`.

El script `_pieza1_test.mjs`:
1. Lee `POSTGRES_URL_NON_POOLING`.
2. Lee la definición actual (`pg_get_functiondef`), genera la copia renombrada `fn_cruzar_extracto_mp_t` (replace del nombre en la firma + agrega el DECLARE `v_dias_arr INT[];` + inserta el bloque R1-pre antes de `-- R1: individual`). Agrega `;` final.
3. `CREATE OR REPLACE FUNCTION fn_cruzar_extracto_mp_t ...`.
4. Setea JWT del dueño: `select set_config('request.jwt.claims', '{"sub":"e31a4f75-b20d-4e47-8a24-c9ad82ff73c6","role":"authenticated"}', false)`.
5. Arma los egresos del borrador de local 1 EXCLUYENDO devueltas (replica `refsDevueltas` + filtra `monto<0`).
6. Llama la función REAL y la copia `_t` con los mismos args (`p_local_id=1, p_periodo_desde, p_periodo_hasta, p_movs_extracto=<egresos>, p_solo_egresos=true, p_match_agrupado=true`).
7. Imprime, para cada una, los `totales` (verdes, amarillos, rojos_falta, etc.) lado a lado.
8. Imprime las filas que **cambiaron** de estado (idx, descripción, monto, estado_antes → estado_despues).
9. `DROP FUNCTION fn_cruzar_extracto_mp_t(...)`.

- [ ] **Step 3: Correr y revisar**

Run: `node _pieza1_test.mjs`
Expected:
- La copia compila (sin error de sintaxis PL/pgSQL).
- `verdes_despues >= verdes_antes` (R1-pre solo agrega verdes, nunca quita).
- `rojos_falta_despues <= rojos_falta_antes`.
- Ninguna fila pasa de `verde*` a un estado peor.
- Las filas que cambian son `rojo_falta`/`amarillo` → `verde` (o `rojo_falta` → `amarillo`), todas con proveedor conocido.

Si alguna fila pasa de verde a peor, o aparecen verdes incorrectos (mismo monto distinto proveedor), PARAR y revisar el R1-pre antes de seguir.

- [ ] **Step 4: Repetir para locales 2 y 3**

Cambiar `p_local_id` a 2 y 3 (mismo borrador disponible) y re-correr Step 3. Mismas expectativas.

- [ ] **Step 5: Limpieza parcial**

Dejar `.env.local.tmp` (se usa en Task 2). Borrar `_pieza1_test.mjs`, `_explora.mjs`, `_dbg.mjs`, `_aliascount.mjs`, `_getdef.mjs`, `_cruce_def.sql` al final de la Task 2.

---

### Task 2: Escribir y aplicar la migración

**Files:**
- Create: `packages/pase/supabase/migrations/202606191200_conciliacion_r1pre_proveedor_fecha.sql`

- [ ] **Step 1: Escribir la migración**

`CREATE OR REPLACE FUNCTION public.fn_cruzar_extracto_mp(...)` — el cuerpo COMPLETO actual (de `_cruce_def.sql`) con:
1. La línea nueva `v_dias_arr INT[];` agregada en el bloque DECLARE (junto a las otras declaraciones de arrays, ~línea 22).
2. El bloque R1-pre (de Task 1 Step 2) insertado entre el fin de R0 (`END LOOP;` de la línea 154) y el comentario `-- R1: individual` (línea 156).
3. Al final del archivo, después del `$function$;`: `NOTIFY pgrst, 'reload schema';`.

(El resto del cuerpo queda idéntico — no se cambia R1/R2/R3/R4/alertas/resultado.)

- [ ] **Step 2: Aplicar la migración**

Script Node one-off `_aplicar_pieza1.mjs`: lee `POSTGRES_URL_NON_POOLING`, lee el archivo de migración, `BEGIN; <sql>; COMMIT;`. Verificar al final: `select pg_get_functiondef(oid) ~ 'R1-pre' from pg_proc where proname='fn_cruzar_extracto_mp'` → debe dar `true`.

Run: `node _aplicar_pieza1.mjs`
Expected: aplica OK, verificación `true`.

- [ ] **Step 3: Verificación post-aplicación (cruce real)**

Re-correr un mini-script que llame `fn_cruzar_extracto_mp` (la real, ya con R1-pre) sobre el borrador de local 1 y confirme la misma mejora de totales que vio la copia en Task 1. (Evita que el deploy quede con una versión distinta de la que se probó.)

- [ ] **Step 4: Limpieza**

Run: `rm packages/pase/_pieza1_test.mjs packages/pase/_aplicar_pieza1.mjs packages/pase/_explora.mjs packages/pase/_dbg.mjs packages/pase/_aliascount.mjs packages/pase/_getdef.mjs packages/pase/_cruce_def.sql packages/pase/.env.local.tmp`
Expected: sin credenciales ni scripts sueltos.

- [ ] **Step 5: Commit + push**

```bash
git add packages/pase/supabase/migrations/202606191200_conciliacion_r1pre_proveedor_fecha.sql
git commit -m "feat(conciliacion): R1-pre match por proveedor (alias) + fecha mas cercana (Pieza 1)"
git push
```
Expected: deploy Vercel `state=READY` (no se agregan functions).

---

## Self-Review

**1. Cobertura del spec (Pieza 1):**
- "Mismo proveedor primero (alias_prov vs prov_id)" → R1-pre filtra `m.prov_id = e.alias_prov`. ✅
- "Fecha más cercana entre los que quedan" → `ORDER BY ABS(m.fecha - v_fila.fecha)`, gana `v_dias_arr[1] < v_dias_arr[2]`. ✅
- "Claro ganador → verde; empate real → amarillo" → IF v_cand_count=1 verde; ≥2 con fecha estrictamente menor verde, si no amarillo. ✅
- "Preferencia/desempate, no requisito; sin alias sigue como hoy" → R1-pre solo corre sobre filas con `alias_prov IS NOT NULL`; el resto cae a R1 sin cambios. ✅
- "No ensancha la ventana a ciegas" → R1-pre exige `fecha BETWEEN período` (mismo período estricto que R1). El cross-mes sigue por "Traer a este mes". ✅

**2. Placeholders:** ninguno — el SQL del R1-pre y los pasos están completos. ✅

**3. Consistencia:** `v_dias_arr INT[]` declarado en Task 1 (test) y Task 2 (migración). `v_cand_count`/`v_cand_id`/`v_cands` ya existen en el DECLARE actual (reusados). `alias_prov`/`prov_id` son las columnas reales de `_ce_ext`/`_ce_mov`. ✅

## Riesgos
- Un `alias_prov` mal cargado podría producir un verde incorrecto, pero solo si además el monto coincide al centavo y el mov es de ese proveedor. Pieza 3 ya saca las devueltas (principal fuente de alias engañoso). Mitigación: la verificación antes/después marca cualquier verde nuevo sospechoso para revisión.
- Reproducir el cruce usa el estado VIVO de `movimientos` (no congelado). Si Lucas está conciliando en paralelo y marca movs como conciliados, los conteos pueden variar entre corridas — no invalida la comparación de la lógica (antes vs después se corren back-to-back con el mismo estado).
