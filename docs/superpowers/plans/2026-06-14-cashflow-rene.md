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

## FASE 2 — Parsers de extracto

> MP ya tiene parser (`src/lib/mpExtractoParser.ts`). Banco (BBVA) necesita uno nuevo. **Decisión a confirmar con Lucas en el primer task:** BBVA entrega PDF; opciones: (a) parsear PDF en browser con `pdfjs-dist` (texto), (b) pedir export CSV/xlsx de BBVA si existe, (c) carga manual asistida. El plan asume (a) con fallback a carga manual.

### Task 2: Parser de banco BBVA

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

### Task 3: Adaptar el parser MP para cashflow (bruto/comisión/neto)

**Files:**
- Modify: `packages/pase/src/lib/mpExtractoParser.ts`
- Test: `packages/pase/src/lib/mpExtractoParser.test.ts`

- [ ] **Step 1:** Verificar que `parseExtractoMpExcel` ya devuelve por línea: fecha, monto neto, descripción (TRANSACTION_TYPE), referencia. Para el cashflow necesitamos además, cuando exista, separar bruto/comisión. El `account_statement.xlsx` da el neto; el detalle bruto/fee está en el "settlement report" (otro archivo). **MVP: usar el `account_statement` (neto) y dejar `comision`/`retencion` en 0 a nivel línea; la comisión total se estima/carga aparte.** Documentar esto.
- [ ] **Step 2:** Agregar test que confirme el mapeo de cada línea a `{ fecha, descripcion, monto_bruto: neto, comision: 0, retencion: 0 }` + saldoInicial/saldoFinal de la fila de totales.
- [ ] **Step 3:** Implementar el adaptador (función `mpLineasParaCashflow(buffer): { saldoInicial, saldoFinal, lineas }`).
- [ ] **Step 4:** Test PASS.
- [ ] **Step 5:** Commit — `feat(cashflow): adaptador MP extracto para cashflow`

---

## FASE 3 — Clasificación con memoria (backend)

### Task 4: RPC de upload de extracto + auto-clasificación

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

### Task 5: RPC para re-clasificar una línea (con memoria)

**Files:**
- Create: `packages/pase/supabase/migrations/202606141400_cashflow_reclasificar.sql`

- [ ] **Step 1: Escribir `cashflow_reclasificar`** — recibe `p_linea_id, p_categoria, p_es_interno, p_aplicar_todas (bool), p_global (bool)`. Actualiza la línea; si `p_aplicar_todas`, guarda en `cashflow_mapeo` (cuenta específica o '*' según `p_global`) y aplica a todas las líneas no-confirmadas con el mismo `texto_norm`. Auth check + `MES_BLOQUEADO` guard. Mismo patrón que `fn_conciliar_producto`.
- [ ] **Step 2:** Aplicar + verificar.
- [ ] **Step 3:** Commit — `feat(cashflow): RPC reclasificar línea con memoria`

---

## FASE 4 — Motor de cálculo del cashflow (backend de lectura)

### Task 6: RPC `cashflow_resumen_mes`

**Files:**
- Create: `packages/pase/supabase/migrations/202606141500_cashflow_resumen.sql`

- [ ] **Step 1: Escribir `cashflow_resumen_mes(p_local_id integer, p_periodo_mes date)`** que devuelve un jsonb con todo lo que la pantalla necesita. SECURITY DEFINER, auth check, sin idempotency (es read-only). Lógica:
  - **Efectivo del mes:** de `movimientos` (cuentas Caja Chica/Mayor/Efectivo), `anulado=false`, `local_id=p_local_id`, fecha en el mes. Excluir transferencias internas (tipo LIKE 'Transferencia%' o detalle LIKE '%alivio%'). Agrupar ingresos/egresos por categoría (`cat`/`tipo`).
  - **MP/Banco del mes:** de `cashflow_lineas` join `cashflow_extractos` por `periodo_mes`. Excluir `es_interno`. Agrupar por `categoria`.
  - **Saldos iniciales/finales:** de `cashflow_extractos.saldo_inicial/final` (MP, banco); efectivo de `saldos_caja` (o derivado).
  - **En tránsito (float):** `Σ ventas no-efectivo del mes (de tabla ventas, medio != efectivo)` − `Σ líneas categoria='venta' de MP+banco del mes` − comisiones. Devolver como bloque.
  - **Verificación:** saldo_final_calculado vs saldo_final del extracto → flag `cuadra` + `diferencia`.
  - **Total por categoría** consolidado (efvo+MP+banco), separando explícitamente `retiro_socio` y `aporte_socio` (nunca mezclados con operativo).
  - Devolver estructura: `{ saldos_iniciales, ingresos[], egresos[], retiros[], aportes[], en_transito, saldo_final_calc, saldo_final_real, cuadra, diferencia, bloqueado }`.
- [ ] **Step 2:** Aplicar + verificar con un mes real de Rene (local 5, 2026-05) → comparar contra los números que ya reconstruimos manualmente (efectivo operativo may ≈ $35M, MP proveedores may ≈ $53M, retiros may efvo $9M).
- [ ] **Step 3:** Commit — `feat(cashflow): RPC resumen mensual consolidado`

### Task 7: RPC `cashflow_puente_mes` (devengado ↔ cash)

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

### Task 8: RPC `cashflow_cerrar_mes` (bloqueo)

**Files:**
- Create: `packages/pase/supabase/migrations/202606141700_cashflow_cerrar.sql`

- [ ] **Step 1: Escribir `cashflow_cerrar_mes(p_local_id, p_periodo_mes, p_idempotency_key)`** — auth check; calcula saldos finales (llama lógica de Task 6); inserta/actualiza `cashflow_cierres` con `bloqueado=true`, `bloqueado_at=now()`, `bloqueado_por=auth_usuario_id()`. Idempotency. Error `MES_YA_BLOQUEADO` si ya estaba.
- [ ] **Step 2:** Aplicar + verificar.
- [ ] **Step 3:** Commit — `feat(cashflow): RPC cerrar/bloquear mes`

---

## FASE 5 — Frontend: servicios + pantalla

### Task 9: Servicio de cashflow (lib)

**Files:**
- Create: `packages/pase/src/lib/cashflow.ts`

- [ ] **Step 1:** Funciones tipadas que llaman las RPCs: `subirExtracto(...)`, `reclasificarLinea(...)`, `resumenMes(localId, mes)`, `puenteMes(...)`, `cerrarMes(...)`. Tipos de retorno explícitos (TS estricto). Sin lógica de negocio (solo wrappers + tipos).
- [ ] **Step 2:** Commit — `feat(cashflow): servicio lib/cashflow.ts`

### Task 10: Pantalla `Cashflow.tsx` — estructura + resumen mensual

**Files:**
- Create: `packages/pase/src/pages/Cashflow.tsx`
- Modify: `packages/pase/src/App.tsx` (lazy import + route)
- Modify: `packages/pase/src/components/Layout.tsx` (nav item + SLUG_TO_FEATURE)

- [ ] **Step 1:** Registrar la página. En `App.tsx`: `const Cashflow = lazy(() => import("./pages/Cashflow"));` + `<Route path="/cashflow" element={<Suspense fallback={<PageLoader />}><Cashflow user={user} locales={locales} localActivo={localActivo} /></Suspense>} />`. En `Layout.tsx` nav array (sección "Dirección"): `{slug:"cashflow",path:"/cashflow",label:"Cashflow",sec:"Dirección",icon:"<svg.../>"}` + en `SLUG_TO_FEATURE`: `cashflow: "modulo.cashflow"`.
- [ ] **Step 2:** Componente base: `PageHeader title="Cashflow"`, selector de mes (input month) + selector de local (si dueño/admin), llama `resumenMes`. Render del resumen: tarjetas de saldo por cuenta (efvo/MP/banco/tránsito) usando `StatCard`/`KpiTile`, y la verificación ✓/diferencia.
- [ ] **Step 3:** `applyLocalScope` no aplica (todo via RPC), pero pasar `localActivo` a las RPC. Lazy import OK (C8).
- [ ] **Step 4:** Probar en navegador (dev server) con Rene → ver el resumen de mayo cuadrar.
- [ ] **Step 5:** Commit — `feat(cashflow): pantalla base + registro nav/route`

### Task 11: Waterfall + tabla de ingresos/egresos + drill-down

**Files:**
- Modify: `packages/pase/src/pages/Cashflow.tsx`

- [ ] **Step 1:** Render del waterfall del mes (saldo inicial → +ingresos por cat → −egresos por cat → saldo final). Puede ser barras CSS simples (no requiere recharts). Mostrar `retiro_socio` y `aporte_socio` como bloques separados y claramente etiquetados (anti-mezcla).
- [ ] **Step 2:** Tabla por categoría con monto; tocar una categoría → drill-down (modal o expand) listando las líneas/movimientos de esa categoría (reusar patrón de tablas existentes).
- [ ] **Step 3:** Probar en navegador.
- [ ] **Step 4:** Commit — `feat(cashflow): waterfall + drill-down por categoría`

### Task 12: Upload de extracto + preview de clasificación + reclasificar

**Files:**
- Modify: `packages/pase/src/pages/Cashflow.tsx`

- [ ] **Step 1:** Botón "Subir extracto" → elegir cuenta (MP/Banco) + archivo. Parsear con `mpLineasParaCashflow`/`parseExtractoBanco`. Mostrar preview de líneas con su categoría auto-asignada antes de confirmar.
- [ ] **Step 2:** En el preview, permitir cambiar la categoría de cada línea (dropdown con las categorías), con checkbox "aplicar a todas las iguales / recordar". Al confirmar: `subirExtracto`; las correcciones llaman `reclasificarLinea`.
- [ ] **Step 3:** Botón "Cerrar mes" (cuando cuadra) → `cerrarMes`; deshabilitar edición si `bloqueado`.
- [ ] **Step 4:** Probar el ciclo completo en navegador con un extracto real de Rene.
- [ ] **Step 5:** Commit — `feat(cashflow): upload extracto + preview + reclasificación + cierre`

### Task 13: El puente en la pantalla

**Files:**
- Modify: `packages/pase/src/pages/Cashflow.tsx`

- [ ] **Step 1:** Bloque desplegable "Puente ganancia ↔ caja" que llama `puenteMes` y muestra las líneas (ganancia teórica − Δstock − Δpor cobrar + Δpor pagar − retiros + aportes = cash generado), con la flag de stock estimado si aplica.
- [ ] **Step 2:** Probar en navegador.
- [ ] **Step 3:** Commit — `feat(cashflow): bloque puente devengado-cash en pantalla`

---

## FASE 6 — Tests

### Task 14: Test E2E mutante del cashflow

**Files:**
- Create: `packages/pase/tests/cashflow_mutante.spec.ts`

- [ ] **Step 1:** Escribir test mutante (patrón `gastos_mutante.spec.ts`): usando `createDuenoClient` + Local Prueba 2, con un sentinel: subir un extracto MP de prueba (1 línea venta sentinel + 1 línea proveedor sentinel + 1 transferencia interna), llamar `cashflow_subir_extracto`, y assert DB-only: las líneas se clasificaron, la interna quedó `es_interno=true`, y `cashflow_resumen_mes` devuelve ingresos/egresos correctos excluyendo la interna. Cleanup en afterEach (delete extracto → cascade líneas) con try/catch individual.
- [ ] **Step 2:** Correr → PASS. `pnpm --filter pase test:e2e -- cashflow_mutante`
- [ ] **Step 3:** Commit — `test(cashflow): e2e mutante de carga + clasificación + resumen`

### Task 15: Tocar e2e-full

**Files:**
- Modify: `packages/pase/tests/e2e-full/` (script del "mes operativo" + invariantes)

- [ ] **Step 1:** Agregar al script e2e-full una operación que suba un extracto al tenant aislado y verifique que el resumen consolidado cuadra (invariante SQL: saldo_final_calc == saldo_final_real para el mes de prueba). Seguir el patrón existente del e2e-full.
- [ ] **Step 2:** Correr la suite e2e-full completa → verde.
- [ ] **Step 3:** Commit — `test(cashflow): operación + invariante en e2e-full`

---

## FASE 7 — Cierre

### Task 16: Verificación final + memoria

- [ ] **Step 1:** Smoke test completo en prod con Rene: subir MP + banco de un mes, ver el resumen cuadrar contra el extracto, ver el puente, cerrar el mes. Confirmar con Lucas.
- [ ] **Step 2:** `pnpm --filter pase typecheck` + `pnpm --filter pase lint` → 0 errores. Verificar deploy Vercel `state=READY`.
- [ ] **Step 3:** Actualizar memoria (`project_pase_cashflow_rene_14_jun.md` → módulo construido) + sacar de pendientes.
- [ ] **Step 4:** Commit final si queda algo.

---

## Self-review notes (gaps conocidos a confirmar durante ejecución)
- **Banco PDF parsing** (Task 2): confirmar formato con Lucas; si PDF en browser es frágil, fallback a carga manual asistida o pedir CSV.
- **Δ stock valorizado** (Task 7): si el inventario no está cargado/costeado, el puente usa input manual del mes (flag `stock_estimado`). No bloquear por esto.
- **Comisión a nivel línea** (Task 3): el `account_statement` da neto; bruto/fee detallado está en el settlement report. MVP usa neto; la comisión total se puede sumar como categoría aparte. Mejorar en fase 2.
- **Punto cero / saldo inicial de arranque**: el primer mes que se cargue toma `saldo_inicial` del extracto — asegura que la cadena cierre mes a mes (cada `saldo_final` = `saldo_inicial` del siguiente).
