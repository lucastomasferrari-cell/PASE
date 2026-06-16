# Módulo Cashflow (Ruta del Dinero) — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir el módulo Cashflow de PASE: consolida efectivo (de `movimientos`) + MercadoPago + Banco (extractos subidos), clasifica cada línea, modela la plata "en tránsito" (float), y muestra por mes saldo inicial + ingresos − egresos = saldo final verificado contra el extracto, más el puente devengado↔cash.

**Architecture:** Backend en migraciones Supabase (tablas `cashflow_*` con RLS dual + RPCs atómicas SECURITY DEFINER con auth check e idempotency). Frontend: parsers en `src/lib/`, pantalla `src/pages/Cashflow.tsx` (lazy), reusa componentes `ui/`. Efectivo se lee de `movimientos`; MP/Banco se cargan parseando el extracto. Clasificación con memoria estilo `compras_mapeo`.

**Tech Stack:** React 19 + Vite + TypeScript estricto, Supabase (Postgres + RLS), Playwright (e2e), librería `xlsx` (ya instalada), `pdfjs-dist` (a evaluar para banco PDF).

**Spec:** `docs/superpowers/specs/2026-06-14-cashflow-rene-design.md` (leer antes de empezar).

**Reglas del repo (obligatorias):** RPCs atómicas (no inserts sueltos), `applyLocalScope` en queries con `local_id`, RLS dual, lazy import en `App.tsx` (C8), idempotency en RPCs financieras (C1), error codes UPPER_SNAKE (C9), auth check en SECURITY DEFINER (C11), test E2E mutante (C2) + tocar e2e-full.

---

## FASE 1 — Esquema de datos (migración)

### Task 1: Migración con las 4 tablas `cashflow_*` + RLS — ✅ HECHO (15-jun, commit ae2e8fe, EN PROD)

**Files:**
- Create: `packages/pase/supabase/migrations/202606141200_cashflow_schema.sql`

- [ ] **Step 1: Escribir la migración**

```sql
-- 202606141200_cashflow_schema.sql
-- Módulo Cashflow: extractos cargados (MP/banco), líneas clasificadas,
-- memoria de clasificación, y cierre/bloqueo de mes. Efectivo NO se guarda
-- acá (se lee de movimientos en tiempo de cálculo).
BEGIN;

-- 1) Extractos subidos (un registro por archivo MP/banco de un mes)
CREATE TABLE IF NOT EXISTS cashflow_extractos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  local_id     INTEGER NOT NULL,
  cuenta       TEXT NOT NULL CHECK (cuenta IN ('MercadoPago','Banco')),
  periodo_mes  DATE NOT NULL,                  -- primer día del mes (ej 2026-05-01)
  saldo_inicial NUMERIC(14,2) NOT NULL DEFAULT 0,
  saldo_final   NUMERIC(14,2) NOT NULL DEFAULT 0,
  archivo_nombre TEXT,
  estado       TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador','confirmado')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, local_id, cuenta, periodo_mes)
);
CREATE INDEX IF NOT EXISTS idx_cf_extractos_tl ON cashflow_extractos(tenant_id, local_id, periodo_mes);

-- 2) Líneas de cada extracto, clasificadas
CREATE TABLE IF NOT EXISTS cashflow_lineas (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  local_id     INTEGER NOT NULL,
  extracto_id  UUID NOT NULL REFERENCES cashflow_extractos(id) ON DELETE CASCADE,
  fecha        DATE NOT NULL,
  descripcion  TEXT NOT NULL DEFAULT '',
  monto_bruto  NUMERIC(14,2) NOT NULL DEFAULT 0,   -- lo que entró/salió segun extracto (con signo)
  comision     NUMERIC(14,2) NOT NULL DEFAULT 0,   -- comisión separada (si aplica)
  retencion    NUMERIC(14,2) NOT NULL DEFAULT 0,   -- impuesto/retención separado
  categoria    TEXT,                                -- venta/comision/retencion/proveedor/sueldo/gasto/retiro_socio/aporte_socio/obra_capex/transferencia_interna/otro
  es_interno   BOOLEAN NOT NULL DEFAULT FALSE,      -- transferencia entre cuentas propias (netea)
  confirmada   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cf_lineas_ext ON cashflow_lineas(extracto_id);
CREATE INDEX IF NOT EXISTS idx_cf_lineas_tl ON cashflow_lineas(tenant_id, local_id, fecha);

-- 3) Memoria de clasificación (texto normalizado → categoría)
CREATE TABLE IF NOT EXISTS cashflow_mapeo (
  tenant_id   UUID NOT NULL,
  texto_norm  TEXT NOT NULL,
  cuenta      TEXT NOT NULL DEFAULT '*',           -- '*' = cualquier cuenta, o 'MercadoPago'/'Banco'
  categoria   TEXT NOT NULL,
  es_interno  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, texto_norm, cuenta)
);

-- 4) Cierre/bloqueo de mes
CREATE TABLE IF NOT EXISTS cashflow_cierres (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  local_id     INTEGER NOT NULL,
  periodo_mes  DATE NOT NULL,
  saldos       JSONB NOT NULL DEFAULT '{}',          -- {efectivo, mercadopago, banco, transito}
  bloqueado    BOOLEAN NOT NULL DEFAULT FALSE,
  bloqueado_at TIMESTAMPTZ,
  bloqueado_por INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, local_id, periodo_mes)
);

-- RLS dual en las 4 tablas
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['cashflow_extractos','cashflow_lineas','cashflow_cierres'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_all ON %I', t, t);
    EXECUTE format($p$CREATE POLICY %I_all ON %I FOR ALL TO authenticated
      USING (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())))
      WITH CHECK (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())))$p$, t, t);
  END LOOP;
END $$;

-- cashflow_mapeo no tiene local_id → RLS solo por tenant
ALTER TABLE cashflow_mapeo ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cashflow_mapeo_all ON cashflow_mapeo;
CREATE POLICY cashflow_mapeo_all ON cashflow_mapeo FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id()) WITH CHECK (tenant_id = auth_tenant_id());

COMMIT;
```

- [ ] **Step 2: Aplicar la migración en prod** (flujo oficial: `vercel env pull` → script Node con `pg` → ejecutar en transacción → verificar tablas existen → limpiar). Ver CLAUDE.md sección "Migraciones SQL".

- [ ] **Step 3: Verificar** — query `SELECT to_regclass('public.cashflow_extractos')` etc. devuelve no-null para las 4 tablas. Correr el Supabase linter: confirmar que las 4 tablas tienen RLS habilitado (no deben aparecer como findings).

- [ ] **Step 4: Commit**
```bash
git add packages/pase/supabase/migrations/202606141200_cashflow_schema.sql
git commit -m "feat(cashflow): schema base (extractos, lineas, mapeo, cierres) + RLS dual"
```

---

## FASE 2 — Parsers de extracto — ✅ HECHO (15-jun, commits 0500a10 + a324c72)

> MP ya tenía parser; se le agregó el adaptador. Banco (BBVA) = PDF (confirmado: Lucas baja `Resumen.pdf` del home banking; 8 resúmenes reales en Downloads). Se eligió opción (a): `pdfjs-dist` extrae el texto en browser → `parseExtractoBanco`. Pendiente abierto (no bloqueante): si BBVA ofrece export xlsx/CSV sería más robusto que el texto del PDF. **Corrección al diseño:** el stub asumía `saldoInicial = 1.817.391,59`, pero ese es el CIERRE (`SALDO AL`/`Saldo Consolidado`); el inicial real es `SALDO ANTERIOR` (0,00 en mayo). El signo del movimiento se deriva del **delta del saldo corrido** (el texto colapsa las columnas Débito/Crédito).

### Task 2: Parser de banco BBVA — ✅ HECHO

**Files:**
- Create: `packages/pase/src/lib/bancoExtractoParser.ts`
- Test: `packages/pase/src/lib/bancoExtractoParser.test.ts`

- [ ] **Step 1: Confirmar formato de entrada con Lucas** (PDF vs CSV/xlsx). Si PDF → instalar `pdfjs-dist` (`pnpm --filter pase add pdfjs-dist`). Documentar la decisión en el archivo.

- [ ] **Step 2: Escribir el test con un fixture real** (usar las líneas reales del resumen BBVA: `FECHA ORIGEN CONCEPTO DEBITO CREDITO SALDO`, formato `DD/MM`, montos AR `1.234,56`; header con "Saldo Consolidado $X" y "SALDO ANTERIOR"). El test verifica que devuelve `{ saldoInicial, saldoFinal, lineas: BancoLinea[] }` con `BancoLinea = { fecha: string(YYYY-MM-DD), descripcion, monto: number(signed) }`.

```typescript
// bancoExtractoParser.test.ts
import { describe, it, expect } from "vitest";
import { parseExtractoBanco } from "./bancoExtractoParser";

const SAMPLE = `... pegar 1 página real del resumen BBVA ...`;
describe("parseExtractoBanco", () => {
  it("extrae saldo inicial, final y líneas con signo", () => {
    const r = parseExtractoBanco(SAMPLE);
    expect(r.saldoInicial).toBeCloseTo(1817391.59, 2);
    expect(r.lineas.length).toBeGreaterThan(0);
    expect(r.lineas[0].fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
```

- [ ] **Step 3: Implementar `parseExtractoBanco`** replicando la lógica del relevamiento (regex `^(\d{2})/(\d{2})\s+(.*?)\s+(-?[\d.]+,\d{2})\s+(-?[\d.]+,\d{2})$`, parse de montos AR, `Saldo Consolidado` y `SALDO ANTERIOR`). Año del período se pasa como parámetro (el resumen no siempre lo trae por línea).

- [ ] **Step 4: Correr test** — `pnpm --filter pase test -- src/lib/bancoExtractoParser.test.ts` → PASS.

- [ ] **Step 5: Commit** — `feat(cashflow): parser de extracto banco BBVA`

### Task 3: Adaptar el parser MP para cashflow (bruto/comisión/neto) — ✅ HECHO

**Files:**
- Modify: `packages/pase/src/lib/mpExtractoParser.ts`
- Test: `packages/pase/src/lib/mpExtractoParser.test.ts`

- [ ] **Step 1:** Verificar que `parseExtractoMpExcel` ya devuelve por línea: fecha, monto neto, descripción (TRANSACTION_TYPE), referencia. Para el cashflow necesitamos además, cuando exista, separar bruto/comisión. El `account_statement.xlsx` da el neto; el detalle bruto/fee está en el "settlement report" (otro archivo). **MVP: usar el `account_statement` (neto) y dejar `comision`/`retencion` en 0 a nivel línea; la comisión total se estima/carga aparte.** Documentar esto.
- [ ] **Step 2:** Agregar test que confirme el mapeo de cada línea a `{ fecha, descripcion, monto_bruto: neto, comision: 0, retencion: 0 }` + saldoInicial/saldoFinal de la fila de totales.
- [ ] **Step 3:** Implementar el adaptador (función `mpLineasParaCashflow(buffer): { saldoInicial, saldoFinal, lineas }`).
- [ ] **Step 4:** Test PASS.
- [ ] **Step 5:** Commit — `feat(cashflow): adaptador MP extracto para cashflow`

---

## FASE 3 — Clasificación con memoria (backend) — ✅ HECHO (15-jun, commit 33fa38d, EN PROD)

> Migraciones 202606141300 + 202606141400 aplicadas y verificadas en prod (funciones existen, modo DEFINER/INVOKER correcto, anon/public sin EXECUTE, smoke del clasificador OK contra descripciones reales — `Transferencia enviada Baldi` → `proveedor`, NO retiro_socio). Decisión de diseño en reclasificar: la línea tocada queda `confirmada`; las hermanas en masa quedan sin confirmar (una corrección futura del mismo texto las vuelve a alcanzar); la masa nunca toca meses bloqueados.

### Task 4: RPC de upload de extracto + auto-clasificación — ✅ HECHO

**Files:**
- Create: `packages/pase/supabase/migrations/202606141300_cashflow_rpcs_upload.sql`

- [ ] **Step 1: Escribir las RPCs** (`fn_normalizar_texto` ya existe). Reusar el patrón de `compras_mapeo`/`fn_conciliar_producto`.

```sql
-- 202606141300_cashflow_rpcs_upload.sql
BEGIN;

-- Reglas default de clasificación por texto (fallback si no hay mapeo aprendido).
-- Devuelve {categoria, es_interno} para una descripción normalizada de una cuenta.
CREATE OR REPLACE FUNCTION fn_cashflow_clasificar_default(p_desc text, p_monto numeric)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public, extensions AS $$
DECLARE d text := fn_normalizar_texto(p_desc);
BEGIN
  IF d IS NULL THEN RETURN jsonb_build_object('categoria','otro','es_interno',false); END IF;
  IF d LIKE '%liquidacion%' THEN RETURN jsonb_build_object('categoria','venta','es_interno',false); END IF;
  IF d LIKE '%comision%' OR d LIKE '%fee%' THEN RETURN jsonb_build_object('categoria','comision','es_interno',false); END IF;
  IF d LIKE '%cupones prisma%' OR d LIKE '%prisma%' THEN RETURN jsonb_build_object('categoria','venta','es_interno',false); END IF;
  IF d LIKE '%alivio%' OR d LIKE '%transferencia interna%' OR d LIKE '%entre cuentas%' THEN RETURN jsonb_build_object('categoria','transferencia_interna','es_interno',true); END IF;
  IF d LIKE '%pago de servicio%' OR d LIKE '%edenor%' OR d LIKE '%metrogas%' OR d LIKE '%aysa%' THEN RETURN jsonb_build_object('categoria','gasto','es_interno',false); END IF;
  -- IMPORTANTE: NO clasificar retiro_socio por nombre. Queda 'otro' hasta confirmación humana.
  RETURN jsonb_build_object('categoria', CASE WHEN p_monto >= 0 THEN 'otro' ELSE 'proveedor' END, 'es_interno', false);
END $$;

-- Sube un extracto: crea cashflow_extractos + inserta líneas, auto-clasificando
-- por mapeo aprendido (prioridad) y luego por reglas default.
CREATE OR REPLACE FUNCTION cashflow_subir_extracto(
  p_local_id integer,
  p_cuenta text,
  p_periodo_mes date,
  p_saldo_inicial numeric,
  p_saldo_final numeric,
  p_archivo_nombre text,
  p_lineas jsonb,                 -- [{fecha, descripcion, monto_bruto, comision, retencion}]
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_tenant uuid; v_cached jsonb; v_ext_id uuid; v_ln jsonb;
  v_texto text; v_map record; v_def jsonb; v_cat text; v_int boolean; v_n int := 0;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;
  IF p_cuenta NOT IN ('MercadoPago','Banco') THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached FROM idempotency_keys
      WHERE rpc_name='cashflow_subir_extracto' AND key=p_idempotency_key AND tenant_id=v_tenant;
    IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('idempotent_replay',true); END IF;
  END IF;

  -- No permitir recargar si el mes está bloqueado
  IF EXISTS (SELECT 1 FROM cashflow_cierres WHERE tenant_id=v_tenant AND local_id=p_local_id
             AND periodo_mes=p_periodo_mes AND bloqueado) THEN
    RAISE EXCEPTION 'MES_BLOQUEADO';
  END IF;

  -- Upsert del extracto (reemplaza si ya existía para ese mes/cuenta)
  DELETE FROM cashflow_extractos WHERE tenant_id=v_tenant AND local_id=p_local_id
    AND cuenta=p_cuenta AND periodo_mes=p_periodo_mes;
  INSERT INTO cashflow_extractos (tenant_id, local_id, cuenta, periodo_mes, saldo_inicial, saldo_final, archivo_nombre)
  VALUES (v_tenant, p_local_id, p_cuenta, p_periodo_mes, p_saldo_inicial, p_saldo_final, p_archivo_nombre)
  RETURNING id INTO v_ext_id;

  FOR v_ln IN SELECT * FROM jsonb_array_elements(p_lineas) LOOP
    v_texto := fn_normalizar_texto(v_ln->>'descripcion');
    v_cat := NULL; v_int := false;
    -- 1) mapeo aprendido (cuenta específica gana sobre '*')
    SELECT categoria, es_interno INTO v_map
      FROM cashflow_mapeo
      WHERE tenant_id=v_tenant AND texto_norm=v_texto AND cuenta IN (p_cuenta,'*')
      ORDER BY (cuenta = p_cuenta) DESC LIMIT 1;
    IF FOUND THEN v_cat := v_map.categoria; v_int := v_map.es_interno;
    ELSE
      v_def := fn_cashflow_clasificar_default(v_ln->>'descripcion', (v_ln->>'monto_bruto')::numeric);
      v_cat := v_def->>'categoria'; v_int := (v_def->>'es_interno')::boolean;
    END IF;
    INSERT INTO cashflow_lineas (tenant_id, local_id, extracto_id, fecha, descripcion, monto_bruto, comision, retencion, categoria, es_interno)
    VALUES (v_tenant, p_local_id, v_ext_id, (v_ln->>'fecha')::date, COALESCE(v_ln->>'descripcion',''),
            (v_ln->>'monto_bruto')::numeric, COALESCE((v_ln->>'comision')::numeric,0),
            COALESCE((v_ln->>'retencion')::numeric,0), v_cat, v_int);
    v_n := v_n + 1;
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name,key,tenant_id,result)
    VALUES ('cashflow_subir_extracto',p_idempotency_key,v_tenant,
            jsonb_build_object('extracto_id',v_ext_id,'lineas',v_n))
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN jsonb_build_object('extracto_id', v_ext_id, 'lineas', v_n);
END $$;
REVOKE ALL ON FUNCTION cashflow_subir_extracto(integer,text,date,numeric,numeric,text,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cashflow_subir_extracto(integer,text,date,numeric,numeric,text,jsonb,text) TO authenticated;

COMMIT;
```

- [ ] **Step 2:** Aplicar migración (flujo oficial) + verificar funciones existen.
- [ ] **Step 3:** Commit — `feat(cashflow): RPC subir extracto + auto-clasificación`

### Task 5: RPC para re-clasificar una línea (con memoria) — ✅ HECHO

**Files:**
- Create: `packages/pase/supabase/migrations/202606141400_cashflow_reclasificar.sql`

- [ ] **Step 1: Escribir `cashflow_reclasificar`** — recibe `p_linea_id, p_categoria, p_es_interno, p_aplicar_todas (bool), p_global (bool)`. Actualiza la línea; si `p_aplicar_todas`, guarda en `cashflow_mapeo` (cuenta específica o '*' según `p_global`) y aplica a todas las líneas no-confirmadas con el mismo `texto_norm`. Auth check + `MES_BLOQUEADO` guard. Mismo patrón que `fn_conciliar_producto`.
- [ ] **Step 2:** Aplicar + verificar.
- [ ] **Step 3:** Commit — `feat(cashflow): RPC reclasificar línea con memoria`

---

## FASE 3.5 — Clasificación de los movimientos de efectivo (backend) — ✅ HECHO (15-jun, commits a635240 + 6678192, EN PROD)

> Surgió del brainstorm: el efectivo (`movimientos`) hereda la categoría del PyL siguiendo el link al documento, y los manuales sin documento (`Ingreso/Egreso Manual`) se clasifican con override + memoria. Ver `docs/superpowers/specs/2026-06-14-cashflow-rene-design.md` Addendum §A–C. **`retiro_socio` NUNCA se auto-asigna en efectivo** (se gestiona en el módulo Utilidades, futuro).

### Task 5.5: Tabla de override + categoría `apertura_ajuste` + helper de categoría de efectivo

**Files:**
- Create: `packages/pase/supabase/migrations/202606141450_cashflow_efectivo_clasif.sql`

- [ ] **Step 1: Escribir la migración**

```sql
-- 202606141450_cashflow_efectivo_clasif.sql
-- Override manual de categoría de cashflow para movimientos de efectivo +
-- categoría apertura_ajuste + helper que resuelve la categoría de un movimiento
-- de efectivo: override > tipo/documento > reglas de texto.
BEGIN;

-- 1) Override por movimiento (movimientos no puede guardar la categoría del cashflow).
CREATE TABLE IF NOT EXISTS cashflow_mov_clasif (
  tenant_id     UUID NOT NULL,
  local_id      INTEGER NOT NULL,
  movimiento_id TEXT NOT NULL,                -- movimientos.id es TEXT
  categoria     TEXT NOT NULL,
  es_interno    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, movimiento_id)
);
CREATE INDEX IF NOT EXISTS idx_cf_movclasif_tl ON cashflow_mov_clasif(tenant_id, local_id);

ALTER TABLE cashflow_mov_clasif ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cashflow_mov_clasif_all ON cashflow_mov_clasif;
CREATE POLICY cashflow_mov_clasif_all ON cashflow_mov_clasif FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())))
  WITH CHECK (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles())));

-- 2) Categoría apertura_ajuste en la lista válida: recrear cashflow_reclasificar
--    con el CHECK ampliado (resto idéntico a 202606141400).
CREATE OR REPLACE FUNCTION cashflow_reclasificar(
  p_linea_id uuid, p_categoria text, p_es_interno boolean DEFAULT false,
  p_aplicar_todas boolean DEFAULT false, p_global boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_tenant uuid; v_local integer; v_desc text; v_cuenta text; v_periodo date;
  v_texto text; v_scope text; v_afectadas int := 0; v_extra int := 0;
BEGIN
  v_tenant := auth_tenant_id();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;
  IF p_categoria NOT IN ('venta','comision','retencion','proveedor','sueldo','gasto',
                         'retiro_socio','aporte_socio','obra_capex','transferencia_interna','apertura_ajuste','otro') THEN
    RAISE EXCEPTION 'CATEGORIA_INVALIDA';
  END IF;
  SELECT l.local_id, l.descripcion, e.cuenta, e.periodo_mes
    INTO v_local, v_desc, v_cuenta, v_periodo
  FROM cashflow_lineas l JOIN cashflow_extractos e ON e.id = l.extracto_id
  WHERE l.id = p_linea_id AND l.tenant_id = v_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'LINEA_NO_ENCONTRADA'; END IF;
  IF NOT (auth_es_dueno_o_admin() OR v_local = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'LOCAL_NO_PERMITIDO'; END IF;
  IF EXISTS (SELECT 1 FROM cashflow_cierres WHERE tenant_id=v_tenant AND local_id=v_local
             AND periodo_mes=v_periodo AND bloqueado) THEN RAISE EXCEPTION 'MES_BLOQUEADO'; END IF;
  v_texto := fn_normalizar_texto(v_desc);
  UPDATE cashflow_lineas SET categoria=p_categoria, es_interno=p_es_interno, confirmada=true, updated_at=NOW()
   WHERE id=p_linea_id AND tenant_id=v_tenant;
  v_afectadas := 1;
  IF p_aplicar_todas THEN
    v_scope := CASE WHEN p_global THEN '*' ELSE v_cuenta END;
    INSERT INTO cashflow_mapeo (tenant_id, texto_norm, cuenta, categoria, es_interno, updated_at)
    VALUES (v_tenant, v_texto, v_scope, p_categoria, p_es_interno, NOW())
    ON CONFLICT (tenant_id, texto_norm, cuenta)
    DO UPDATE SET categoria=EXCLUDED.categoria, es_interno=EXCLUDED.es_interno, updated_at=NOW();
    UPDATE cashflow_lineas l SET categoria=p_categoria, es_interno=p_es_interno, updated_at=NOW()
      FROM cashflow_extractos e
     WHERE l.extracto_id=e.id AND l.tenant_id=v_tenant AND l.id<>p_linea_id AND NOT l.confirmada
       AND fn_normalizar_texto(l.descripcion)=v_texto AND (p_global OR e.cuenta=v_cuenta)
       AND NOT EXISTS (SELECT 1 FROM cashflow_cierres cc WHERE cc.tenant_id=l.tenant_id
                       AND cc.local_id=l.local_id AND cc.periodo_mes=e.periodo_mes AND cc.bloqueado);
    GET DIAGNOSTICS v_extra = ROW_COUNT;
    v_afectadas := v_afectadas + v_extra;
  END IF;
  RETURN jsonb_build_object('linea_id', p_linea_id, 'afectadas', v_afectadas);
END $$;
REVOKE ALL ON FUNCTION cashflow_reclasificar(uuid,text,boolean,boolean,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cashflow_reclasificar(uuid,text,boolean,boolean,boolean) TO authenticated;

-- 3) Helper: categoría de cashflow de un movimiento de efectivo.
--    Prioridad: override manual > tipo/documento > reglas de texto (manuales).
--    NUNCA devuelve retiro_socio por texto (anti-mezcla). 'apertura_ajuste' para seeds/arqueos.
CREATE OR REPLACE FUNCTION fn_cashflow_cat_efectivo(
  p_tenant uuid, p_mov_id text, p_tipo text, p_detalle text, p_importe numeric,
  p_fact_id text, p_remito_id text, p_gasto_id text, p_liq_id uuid, p_adelanto_id uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public, extensions AS $$
DECLARE v_cat text; v_int boolean; v_ovr record; d text;
BEGIN
  -- 1) override manual
  SELECT categoria, es_interno INTO v_ovr FROM cashflow_mov_clasif
    WHERE tenant_id=p_tenant AND movimiento_id=p_mov_id;
  IF FOUND THEN RETURN jsonb_build_object('categoria',v_ovr.categoria,'es_interno',v_ovr.es_interno,'fuente','override'); END IF;
  -- 2) por tipo / documento de origen
  v_cat := CASE
    WHEN p_tipo IN ('Transferencia Entrada','Transferencia Salida') THEN 'transferencia_interna'
    WHEN p_tipo = 'Ingreso Venta' THEN 'venta'
    WHEN p_tipo = 'Pago Proveedor' OR p_fact_id IS NOT NULL OR p_remito_id IS NOT NULL THEN 'proveedor'
    WHEN p_tipo IN ('Pago Sueldo','Gasto empleado') OR p_liq_id IS NOT NULL OR p_adelanto_id IS NOT NULL THEN 'sueldo'
    WHEN p_tipo = 'Gasto impuesto' THEN 'retencion'
    WHEN p_tipo = 'Gasto retiro_socio' THEN 'retiro_socio'
    WHEN p_tipo IN ('Gasto variable','Gasto fijo') OR p_gasto_id IS NOT NULL THEN 'gasto'
    ELSE NULL END;
  IF v_cat IS NOT NULL THEN
    RETURN jsonb_build_object('categoria',v_cat,'es_interno', v_cat='transferencia_interna','fuente','tipo');
  END IF;
  -- 3) manuales sin documento → reglas de texto (NUNCA retiro_socio)
  d := fn_normalizar_texto(p_detalle);
  IF d LIKE '%saldo inicial%' OR d LIKE '%caja en 0%' OR d LIKE '%saldo caja fuerte%'
     OR d LIKE '%ajuste%' OR d LIKE '%sobrante%' OR d LIKE '%faltante%' OR d LIKE '%arqueo%' THEN
    RETURN jsonb_build_object('categoria','apertura_ajuste','es_interno',false,'fuente','texto');
  END IF;
  IF d LIKE '%retiro del local%' OR d LIKE '%caja grande%' OR d LIKE '%a caja %' OR d LIKE '%entre caja%' THEN
    RETURN jsonb_build_object('categoria','transferencia_interna','es_interno',true,'fuente','texto');
  END IF;
  IF d LIKE '%aporte%' THEN
    RETURN jsonb_build_object('categoria','aporte_socio','es_interno',false,'fuente','texto');
  END IF;
  -- default: queda 'otro' (la bandeja "Por revisar" lo levanta)
  RETURN jsonb_build_object('categoria','otro','es_interno',false,'fuente','default');
END $$;
REVOKE ALL ON FUNCTION fn_cashflow_cat_efectivo(uuid,text,text,text,numeric,text,text,text,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_cashflow_cat_efectivo(uuid,text,text,text,numeric,text,text,text,uuid,uuid) TO authenticated;

COMMIT;
```

- [ ] **Step 2: Aplicar** (flujo oficial `vercel env pull` → script `pg`) + verificar: `cashflow_mov_clasif` existe con RLS; `cashflow_reclasificar` acepta `apertura_ajuste` (probar `SELECT cashflow_reclasificar(...)` no aplica acá sin sesión — verificar solo el `pg_get_function_arguments` y que el CHECK incluya apertura_ajuste vía `pg_get_functiondef`); smoke de `fn_cashflow_cat_efectivo` contra detalles reales (saldo inicial→apertura_ajuste, RETIRO DEL LOCAL→transferencia_interna, RETIRO SOCIOS→otro NO retiro_socio).
- [ ] **Step 3: Commit** — `feat(cashflow): override+helper de clasificación de efectivo + apertura_ajuste`

### Task 5.6: RPC `cashflow_reclasificar_mov` (clasificar/recordar un movimiento de efectivo)

**Files:**
- Create: `packages/pase/supabase/migrations/202606141460_cashflow_reclasificar_mov.sql`

- [ ] **Step 1: Escribir la RPC** — espejo de `cashflow_reclasificar` pero sobre `cashflow_mov_clasif`. Recibe `p_mov_id text, p_categoria text, p_es_interno boolean, p_aplicar_todas boolean`. Valida categoría (misma lista, **rechaza si querés impedir retiro_socio acá** — decisión: SE PERMITE retiro_socio manual para que la caja cuadre, pero el detalle de reparto es Utilidades). Auth check (lee `local_id`/`fecha` del movimiento, valida `auth_locales_visibles`, guard `MES_BLOQUEADO` si hay cierre del mes de `fecha`). Upsert en `cashflow_mov_clasif`. Si `p_aplicar_todas`: guarda en `cashflow_mapeo` (cuenta `'efectivo'`) por `fn_normalizar_texto(detalle)` y aplica override a los demás movimientos de efectivo del tenant con el mismo texto normalizado que NO tengan override y no estén en mes bloqueado. Devuelve `{mov_id, afectadas}`. `REVOKE FROM PUBLIC,anon` + `GRANT authenticated`.
- [ ] **Step 2:** Aplicar + verificar (existe, DEFINER, grants).
- [ ] **Step 3: Commit** — `feat(cashflow): RPC reclasificar movimiento de efectivo con memoria`

---

## FASE 4 — Motor de cálculo del cashflow (backend de lectura) — ✅ HECHO (15-jun, EN PROD: resumen f1bfa3e, puente 4612dfe, cerrar+libro 13b61a1)

### Task 6: RPC `cashflow_resumen_mes` — ✅ HECHO (15-jun, commit f1bfa3e, EN PROD; validado vs Rene mayo)

**Files:**
- Create: `packages/pase/supabase/migrations/202606141500_cashflow_resumen.sql`

> **Reescrito (addendum 15-jun):** el efectivo se categoriza con `fn_cashflow_cat_efectivo` (override > tipo/documento > texto), NO por `tipo` crudo. `transferencia_interna` y `apertura_ajuste` se EXCLUYEN de ingresos/egresos operativos (netean / son baseline). Cuentas de efectivo = `Caja Chica`/`Caja Mayor`/`Caja Efectivo` (las cuentas `MercadoPago`/`Banco` de `movimientos` se IGNORAN — están rotas; MP/banco salen del extracto). `CAJA UTILIDADES` (si existe) se trata como cuenta de reserva → posición `líquido vs reservado`.

- [ ] **Step 1: Escribir `cashflow_resumen_mes(p_local_id integer, p_periodo_mes date)`** — SECURITY DEFINER, auth check (`NO_AUTH`/`LOCAL_NO_PERMITIDO`), read-only (sin idempotency). Lógica:
  - **Efectivo del mes:** `movimientos` con `local_id=p_local_id`, `anulado=false`, `cuenta IN ('Caja Chica','Caja Mayor','Caja Efectivo','CAJA UTILIDADES')`, `fecha` en `[p_periodo_mes, +1 mes)`. Para cada uno: categoría vía `fn_cashflow_cat_efectivo(tenant, id, tipo, detalle, importe, fact_id, remito_id_ref, gasto_id_ref, liquidacion_id, adelanto_id_ref)`. `importe>0` → ingreso, `importe<0` → egreso. **Excluir de operativo** las categorías `transferencia_interna` y `apertura_ajuste`.
  - **MP/Banco del mes:** `cashflow_lineas l JOIN cashflow_extractos e` por `e.local_id=p_local_id AND e.periodo_mes=p_periodo_mes`, `NOT l.es_interno`, categoría `l.categoria`. (Sin extracto cargado → ese bloque queda vacío + flag `falta_extracto`.)
  - **Saldos iniciales de efectivo (punto cero):** saldo corrido de cada caja al INICIO del mes = `SUM(importe)` de todos los `movimientos` de esa cuenta con `fecha < p_periodo_mes` (los `apertura_ajuste`/seeds ya están incluidos en el saldo corrido, por eso NO se cuentan como ingreso del mes). Saldo final efvo = inicial + `SUM(importe del mes)`.
  - **Saldos MP/Banco:** `saldo_inicial`/`saldo_final` de `cashflow_extractos`.
  - **En tránsito (float):** `Σ ventas no-efectivo del mes` (`ventas`, `medio <> 'EFECTIVO'`, por `fecha` y `local_id`, sumar `monto`) − `Σ líneas categoria='venta' del extracto del mes` (lo que ya se acreditó). Devolver bruto, acreditado y neto-en-tránsito.
  - **Verificación:** por cuenta con extracto, `saldo_inicial + Σ movimientos = saldo_final` declarado → flag `cuadra` + `diferencia`.
  - **Posición:** `liquido_operativo` (efvo Chica+Mayor+Efectivo + MP + banco) vs `reservado` (CAJA UTILIDADES) vs `en_transito`.
  - **Por revisar:** count de movimientos de efectivo con categoría `otro` sin override (los manuales sin resolver).
  - Devolver: `{ saldos_iniciales{efvo,mp,banco,utilidades}, ingresos[{categoria,total}], egresos[{categoria,total}], retiros_total, aportes_total, en_transito{bruto,acreditado,neto}, posicion{liquido,reservado,transito}, saldo_final_calc, saldo_final_real, cuadra, diferencia, por_revisar, bloqueado }`. Separar SIEMPRE `retiro_socio` y `aporte_socio` de los ingresos/egresos operativos.
- [ ] **Step 2:** Aplicar + verificar con Rene (local 5, 2026-05): comparar el efectivo operativo y la composición contra lo reconstruido (ventas efvo may ≈ $26M; proveedores/sueldos/gastos del efectivo; "Por revisar" debe levantar los $9M RETIRO SOCIOS + transfers local→casa). Cargar un extracto MP real (vía parser + `cashflow_subir_extracto`) y ver el bloque MP cuadrar contra el `saldo_final` del extracto.
- [ ] **Step 3:** Commit — `feat(cashflow): RPC resumen mensual consolidado (hereda categorías por documento)`

### Task 7: RPC `cashflow_puente_mes` (devengado ↔ cash) — ✅ HECHO (15-jun, commit 4612dfe, EN PROD; devengado validado vs EERR Rene mayo)

**Files:**
- Create: `packages/pase/supabase/migrations/202606141600_cashflow_puente.sql`

- [ ] **Step 1: Escribir `cashflow_puente_mes(p_local_id, p_periodo_mes)`** read-only. Calcula:
  - Ganancia teórica del mes = (mismo cálculo que el EERR: ventas − CMV − gastos − sueldos − comisiones − impuestos del mes; reusar las queries de `EERR.tsx`/facturas+gastos+liquidaciones por fecha).
  - − Δ stock (variación de inventario valorizado: usar `insumo_stock_local` × costo, o input manual si no está cargado — devolver el dato y una flag `stock_estimado`).
  - − Δ cuentas por cobrar (= en tránsito de Task 6).
  - + Δ cuentas por pagar (facturas estado='pendiente'/'vencida' del mes).
  - − retiros + aportes (de Task 6).
  - = cash generado. Devolver cada línea del puente.
- [ ] **Step 2:** Aplicar + verificar contra mayo Rene (devengado ≈ $69M vs cash ≈ $92M, dif ≈ $23M = stock + deudas).
- [ ] **Step 3:** Commit — `feat(cashflow): RPC puente devengado-cash`

### Task 8: RPC `cashflow_cerrar_mes` (bloqueo) — ✅ HECHO (15-jun, commit 13b61a1, EN PROD)

**Files:**
- Create: `packages/pase/supabase/migrations/202606141700_cashflow_cerrar.sql`

- [ ] **Step 1: Escribir `cashflow_cerrar_mes(p_local_id, p_periodo_mes, p_idempotency_key)`** — auth check; calcula saldos finales (llama lógica de Task 6); inserta/actualiza `cashflow_cierres` con `bloqueado=true`, `bloqueado_at=now()`, `bloqueado_por=auth_usuario_id()`. Idempotency. Error `MES_YA_BLOQUEADO` si ya estaba.
- [ ] **Step 2:** Aplicar + verificar.
- [ ] **Step 3:** Commit — `feat(cashflow): RPC cerrar/bloquear mes`

### Task 8.5: RPC `cashflow_libro_mes` (libro contable / línea de tiempo) — ✅ HECHO (15-jun, commit 13b61a1, EN PROD; validado: saldo corrido mayo = 7.250.339)

**Files:**
- Create: `packages/pase/supabase/migrations/202606141800_cashflow_libro.sql`

- [ ] **Step 1: Escribir `cashflow_libro_mes(p_local_id integer, p_periodo_mes date, p_cuenta text DEFAULT NULL)`** — read-only, SECURITY DEFINER, auth check. Devuelve las filas cronológicas con saldo corrido (Debe/Haber/Saldo) para la vista de libro contable. Lógica:
  - Si `p_cuenta` es una cuenta de efectivo (o NULL=consolidado efectivo): filas de `movimientos` (cuentas de efectivo, `anulado=false`, mes), cada una con su categoría vía `fn_cashflow_cat_efectivo`, ordenadas por `fecha, created_at`. `debe = CASE WHEN importe<0 THEN -importe END`, `haber = CASE WHEN importe>0 THEN importe END`, `saldo` = corrido arrancando del saldo inicial de la cuenta (sección Task 6).
  - Si `p_cuenta IN ('MercadoPago','Banco')`: filas de `cashflow_lineas` del extracto del mes, `monto_bruto` con signo → debe/haber, `saldo` corrido desde `saldo_inicial` del extracto.
  - Cada fila: `{ fecha, concepto (detalle/descripcion), categoria, es_interno, debe, haber, saldo, ref_id }`.
  - Devolver `{ cuenta, saldo_inicial, filas[], saldo_final }`.
- [ ] **Step 2:** Aplicar + verificar contra Rene (el saldo corrido del efectivo de mayo debe terminar en el saldo real de la caja).
- [ ] **Step 3:** Commit — `feat(cashflow): RPC libro contable mensual con saldo corrido`

---

## FASE 5 — Frontend: servicios + pantalla

### Task 9: Servicio de cashflow (lib) — ✅ HECHO (15-jun, commit da964e4)

**Files:**
- Create: `packages/pase/src/lib/cashflow.ts`

- [ ] **Step 1:** Funciones tipadas que llaman las RPCs: `subirExtracto(...)`, `reclasificarLinea(...)`, `reclasificarMov(...)` (efectivo), `resumenMes(localId, mes)`, `libroMes(localId, mes, cuenta?)`, `puenteMes(...)`, `cerrarMes(...)`. Tipos de retorno explícitos (TS estricto, interfaces para el resumen/libro/puente). Sin lógica de negocio (solo wrappers + tipos).
- [ ] **Step 2:** Commit — `feat(cashflow): servicio lib/cashflow.ts`

### Task 10: Pantalla `Cashflow.tsx` — estructura + resumen mensual — ✅ HECHO (15-jun, commit b4108cc, EN PROD; falta smoke en navegador)

**Files:**
- Create: `packages/pase/src/pages/Cashflow.tsx`
- Modify: `packages/pase/src/App.tsx` (lazy import + route)
- Modify: `packages/pase/src/components/Layout.tsx` (nav item + SLUG_TO_FEATURE)

- [ ] **Step 1:** Registrar la página. En `App.tsx`: `const Cashflow = lazy(() => import("./pages/Cashflow"));` + `<Route path="/cashflow" element={<Suspense fallback={<PageLoader />}><Cashflow user={user} locales={locales} localActivo={localActivo} /></Suspense>} />`. En `Layout.tsx` nav array (sección "Dirección"): `{slug:"cashflow",path:"/cashflow",label:"Cashflow",sec:"Dirección",icon:"<svg.../>"}` + en `SLUG_TO_FEATURE`: `cashflow: "modulo.cashflow"`.
- [ ] **Step 2:** Componente base: `PageHeader title="Cashflow"`, selector de mes (input month) + selector de local (si dueño/admin), llama `resumenMes`. Render del resumen: tarjetas de saldo por cuenta (efvo/MP/banco/tránsito) usando `StatCard`/`KpiTile`, y la verificación ✓/diferencia.
- [ ] **Step 3:** `applyLocalScope` no aplica (todo via RPC), pero pasar `localActivo` a las RPC. Lazy import OK (C8).
- [ ] **Step 4:** Probar en navegador (dev server) con Rene → ver el resumen de mayo cuadrar.
- [ ] **Step 5:** Commit — `feat(cashflow): pantalla base + registro nav/route`

### Task 11: Waterfall + tabla de ingresos/egresos + drill-down — ✅ HECHO (15-jun, commit 078b316; bloque "Flujo del mes" con barras proporcionales en el Resumen)

**Files:**
- Modify: `packages/pase/src/pages/Cashflow.tsx`

- [ ] **Step 1:** Render del waterfall del mes (saldo inicial → +ingresos por cat → −egresos por cat → saldo final). Puede ser barras CSS simples (no requiere recharts). Mostrar `retiro_socio` y `aporte_socio` como bloques separados y claramente etiquetados (anti-mezcla).
- [ ] **Step 2:** Tabla por categoría con monto; tocar una categoría → drill-down (modal o expand) listando las líneas/movimientos de esa categoría (reusar patrón de tablas existentes).
- [ ] **Step 3:** Probar en navegador.
- [ ] **Step 4:** Commit — `feat(cashflow): waterfall + drill-down por categoría`

### Task 11.5: Vista libro contable / línea de tiempo — ✅ HECHO (15-jun, commit ada811b, EN PROD)

**Files:**
- Modify: `packages/pase/src/pages/Cashflow.tsx`

- [ ] **Step 1:** Pestaña/sección "Libro" que llama `libroMes(localActivo, mes, cuenta)`. Selector de cuenta (Efectivo / MercadoPago / Banco / CAJA UTILIDADES / consolidado). Tabla: `Fecha | Concepto | Categoría | Debe | Haber | Saldo` con el saldo corriendo; Debe en rojo, Haber en verde, saldo en negrita. Reusar `fmt_money`/componentes de tabla existentes.
- [ ] **Step 2:** Fila clickeable → si es un movimiento manual de efectivo sin clasificar (`categoria='otro'`), permitir reclasificar inline (dropdown de categorías) → `reclasificarMov` con checkbox "recordar / aplicar a todas las iguales". La bandeja "Por revisar" del resumen linkea acá.
- [ ] **Step 3:** Probar en navegador con Rene (ver el saldo corrido del efectivo de mayo terminar en el saldo real).
- [ ] **Step 4:** Commit — `feat(cashflow): vista libro contable con saldo corrido + reclasificar efectivo`

### Task 12: Upload de extracto + preview de clasificación + reclasificar — ✅ HECHO (15-jun, commit abb866e, EN PROD; **falta smoke pdfjs banco en navegador**)

**Files:**
- Modify: `packages/pase/src/pages/Cashflow.tsx`

- [ ] **Step 1:** Botón "Subir extracto" → elegir cuenta (MP/Banco) + archivo. Parsear con `mpLineasParaCashflow`/`parseExtractoBanco`. Mostrar preview de líneas con su categoría auto-asignada antes de confirmar.
- [ ] **Step 2:** En el preview, permitir cambiar la categoría de cada línea (dropdown con las categorías), con checkbox "aplicar a todas las iguales / recordar". Al confirmar: `subirExtracto`; las correcciones llaman `reclasificarLinea`.
- [ ] **Step 3:** Botón "Cerrar mes" (cuando cuadra) → `cerrarMes`; deshabilitar edición si `bloqueado`.
- [ ] **Step 4:** Probar el ciclo completo en navegador con un extracto real de Rene.
- [ ] **Step 5:** Commit — `feat(cashflow): upload extracto + preview + reclasificación + cierre`

### Task 13: El puente en la pantalla — ✅ HECHO (15-jun, commit ada811b, EN PROD)

**Files:**
- Modify: `packages/pase/src/pages/Cashflow.tsx`

- [ ] **Step 1:** Bloque desplegable "Puente ganancia ↔ caja" que llama `puenteMes` y muestra las líneas (ganancia teórica − Δstock − Δpor cobrar + Δpor pagar − retiros + aportes = cash generado), con la flag de stock estimado si aplica.
- [ ] **Step 2:** Probar en navegador.
- [ ] **Step 3:** Commit — `feat(cashflow): bloque puente devengado-cash en pantalla`

---

## FASE 6 — Tests — ✅ HECHO (15-jun, commits 94ce1b9 + 220c3af; ambos verdes)

### Task 14: Test E2E mutante del cashflow — ✅ HECHO (1 passed 26.9s)

**Files:**
- Create: `packages/pase/tests/cashflow_mutante.spec.ts`

- [ ] **Step 1:** Escribir test mutante (patrón `gastos_mutante.spec.ts`): usando `createDuenoClient` + Local Prueba 2, con un sentinel: subir un extracto MP de prueba (1 línea venta sentinel + 1 línea proveedor sentinel + 1 transferencia interna), llamar `cashflow_subir_extracto`, y assert DB-only: las líneas se clasificaron, la interna quedó `es_interno=true`, y `cashflow_resumen_mes` devuelve ingresos/egresos correctos excluyendo la interna. Cleanup en afterEach (delete extracto → cascade líneas) con try/catch individual.
- [ ] **Step 2:** Correr → PASS. `pnpm --filter pase test:e2e -- cashflow_mutante`
- [ ] **Step 3:** Commit — `test(cashflow): e2e mutante de carga + clasificación + resumen`

### Task 15: Tocar e2e-full — ✅ HECHO (spec 45, 1 passed 19.5s)

**Files:**
- Modify: `packages/pase/tests/e2e-full/` (script del "mes operativo" + invariantes)

- [ ] **Step 1:** Agregar al script e2e-full una operación que suba un extracto al tenant aislado y verifique que el resumen consolidado cuadra (invariante SQL: saldo_final_calc == saldo_final_real para el mes de prueba). Seguir el patrón existente del e2e-full.
- [ ] **Step 2:** Correr la suite e2e-full completa → verde.
- [ ] **Step 3:** Commit — `test(cashflow): operación + invariante en e2e-full`

---

## FASE 7 — Cierre — ✅ CASI (solo falta el smoke en vivo del upload por Lucas)

### Task 16: Verificación final + memoria — ✅ CASI

- [ ] **Step 1:** Smoke test completo en prod con Rene: subir MP + banco de un mes, ver el resumen cuadrar contra el extracto, ver el puente, cerrar el mes. Confirmar con Lucas.
- [ ] **Step 2:** `pnpm --filter pase typecheck` + `pnpm --filter pase lint` → 0 errores. Verificar deploy Vercel `state=READY`.
- [ ] **Step 3:** Actualizar memoria (`project_pase_cashflow_rene_14_jun.md` → módulo construido) + sacar de pendientes.
- [ ] **Step 4:** Commit final si queda algo.

---

---

## Módulo futuro: Utilidades / Reparto de utilidades (NO en este plan)

Decidido en el brainstorm (15-jun): el reparto a socios es un **módulo aparte** con su propio spec+plan. Incluye una **CAJA UTILIDADES** (cuenta de reserva, balde Profit First), las acciones reservar/repartir, el cálculo de "cuánto es seguro repartir" (contra la repartija del mes), y la re-registración prolija de los retiros históricos mal cargados. Este plan (cashflow) solo deja a CAJA UTILIDADES tratada como una cuenta más y muestra `retiro_socio` como línea separada. **Arrancar Utilidades con `superpowers:brainstorming` cuando se retome.**

## Self-review notes (gaps conocidos a confirmar durante ejecución)
- **Clasificación de efectivo por documento** (Task 6 / Fase 3.5): el MVP mapea `tipo`→categoría de cashflow (Pago Proveedor→proveedor, etc.); la categoría DETALLADA del documento (la `cat` real de la factura/gasto) se ve en el drill-down/libro. Si Lucas quiere agrupar el waterfall por los grupos exactos del PyL (CMV/Gastos Fijos/…), es una mejora sobre `fn_cashflow_cat_efectivo` (join a `config_categorias`).
- **`apertura_ajuste` y punto cero**: los seeds/arqueos quedan fuera de ingresos/egresos operativos y ya están dentro del saldo corrido (por eso el saldo inicial del mes se deriva de `SUM(importe) WHERE fecha < mes`). Verificar que el primer mes cargado no los cuente como ingreso.
- **`retiro_socio` en efectivo**: `cashflow_reclasificar_mov` PERMITE marcar un movimiento como retiro_socio (para que la caja cuadre), pero la GESTIÓN del reparto es Utilidades. Confirmar con Lucas si el cashflow debe dejar marcar retiros o solo mostrarlos.
- **Banco PDF parsing** (Task 2): confirmar formato con Lucas; si PDF en browser es frágil, fallback a carga manual asistida o pedir CSV.
- **Δ stock valorizado** (Task 7): si el inventario no está cargado/costeado, el puente usa input manual del mes (flag `stock_estimado`). No bloquear por esto.
- **Comisión a nivel línea** (Task 3): el `account_statement` da neto; bruto/fee detallado está en el settlement report. MVP usa neto; la comisión total se puede sumar como categoría aparte. Mejorar en fase 2.
- **Punto cero / saldo inicial de arranque**: el primer mes que se cargue toma `saldo_inicial` del extracto — asegura que la cadena cierre mes a mes (cada `saldo_final` = `saldo_inicial` del siguiente).
