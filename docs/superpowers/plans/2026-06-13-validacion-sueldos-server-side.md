# Validación Server-Side de pagar_sueldo (Tier 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development, tarea por tarea.

**Goal:** Tier 2 ítem 8 del informe `docs/analisis-logica-2026-06/00-INFORME-EJECUTIVO.md` (y RRHH report #04 §2.3 hallazgo #2). Hoy `pagar_sueldo` recibe el desglose ya calculado por el navegador (`p_calc`) y lo guarda tal cual — un bug de JS escribe plata mal en silencio, y con multi-tenant cualquier usuario autenticado puede llamar la RPC con números inventados. Fix: la RPC **recalcula el total canónico server-side** desde la novedad + sueldo vigente + adelantos tildados, **rechaza** si el `total_a_pagar` del cliente difiere más de la tolerancia (`LIQUIDACION_CALCULO_INCONSISTENTE`), y **almacena los componentes recalculados** (no los del cliente) → el servidor pasa a ser la fuente de verdad.

**Alcance:** SOLO `pagar_sueldo` (pago mensual/quincenal — determinístico, frecuente). FUERA de alcance (documentado): `liquidacion_final_empleado`, `pagar_aguinaldo`, `pagar_vacaciones` — sus líneas/conceptos son editables por el humano legítimamente (negociación de indemnización, ajustes), no hay total canónico contra el cual validar; ahí la defensa sigue siendo "las líneas de pago suman el total ±$1" que ya tienen.

**Arquitectura:** Función SQL nueva `fn_liquidacion_total_canonico(p_nov_id uuid, p_adelantos_ids uuid[])` que espeja EXACTAMENTE `calcularTotalLiquidacion` de `packages/pase/src/lib/calculos/rrhh.ts` y devuelve el desglose completo (sueldo_base, descuento_ausencias, total_horas_extras, total_dobles, total_feriados, total_vacaciones, subtotal1, monto_presentismo, subtotal2, adelantos, otros_descuentos, bono, total_a_pagar). `pagar_sueldo` v2 la llama, valida el total del cliente, y usa los componentes canónicos para insertar/revivir la liquidación. Idempotencia, revivir-anulada, multi-cuenta, sin-capeo-de-pagos: TODO se preserva intacto (solo cambia DE DÓNDE salen los componentes guardados).

**Reglas del repo:** money-logic en prod (zona sensible — explicar antes), C2 mutante obligatorio, C9 error UPPER_SNAKE, `REVOKE FROM PUBLIC, anon` + GRANT a las mismas audiencias, dry-run con ROLLBACK antes de aplicar, e2e-full misma PR, push + deploy READY.

**Hechos verificados (relevamiento 12-jun):** `pagar_sueldo` vigente en `202606072100` (firma: `p_nov_id uuid, p_formas_pago jsonb, p_adelantos_ids uuid[], p_fecha date, p_mes int, p_anio int, p_crear_liq bool DEFAULT false, p_calc jsonb DEFAULT NULL, p_idempotency_key text DEFAULT NULL, p_liq_id uuid DEFAULT NULL`). Fórmula TS en `lib/calculos/rrhh.ts::calcularTotalLiquidacion`. Inputs: `rrhh_empleados.sueldo_mensual`; `modo_pago` que la UI DERIVA de `cuotas_total` (===2 → QUINCENAL /2, else MENSUAL; SEMANAL /4) NO de empleado.modo_pago — VERIFICAR contra TabSueldos al implementar; `valor_dia = sueldo/30`; `valor_hora = sueldo/30/8`; vacaciones plus = `sueldo/25 - sueldo/30`; `valor_doble = sueldo/30` (la UI usa esto, NO rrhh_valores_doble — VERIFICAR); presentismo = `(cuotas_total==2 && cuota_num==1) ? 0 : (mantiene ? sueldo*0.05 : 0)`; `total_a_pagar = round(subtotal2 + bono - adelantos - pagos_dobles - otros_descuentos)`, con `max(0,...)` en dobles/feriados/vacaciones/adelantos/otros/bono y hs_extra PUEDE ser negativa. Adelantos del total = SUM importe de `rrhh_adelantos WHERE id = ANY(p_adelantos_ids)` (el server ya tiene los IDs). El "pagar de más por redondeo" es a nivel PAGO (suma de p_formas_pago > total) NO en total_a_pagar → la validación de total_a_pagar puede ser tight (±$1 por orden de redondeo). `rrhh_novedades` tiene cuota_num/cuotas_total/inasistencias/horas_extras/dobles/feriados/vacaciones_dias/presentismo/otros_descuentos/bono. Tests: `anular_pago_sueldo_mutante.spec.ts`, `e2e-full/sprint-1/35-sueldo-hs-negativas-sobrepago.spec.ts`. NO existe cálculo server-side hoy.

---

### Task 1: Migración — `fn_liquidacion_total_canonico` + `pagar_sueldo` v2

**Files:** Create `packages/pase/supabase/migrations/202606130400_pagar_sueldo_recalculo_server.sql`

- [ ] **Step 0 — leer las fuentes EXACTAS** (no confiar en el resumen del relevamiento; portar línea por línea):
  - `packages/pase/src/lib/calculos/rrhh.ts`: `calcularTotalLiquidacion`, `calcularSueldoBase`, `calcularDescuentoAusencias`, `calcularHorasExtras`, `calcularPresentismo` (y cualquier helper que usen). Anotar CADA `Math.max(0,...)`, CADA `Math.round`, el orden de operaciones.
  - `packages/pase/src/pages/rrhh/TabSueldos.tsx::calcularDesglose`: cómo deriva `modo_pago` y `valor_doble` que pasa a la fórmula (CRÍTICO: si deriva modo_pago de cuotas_total y valor_doble de sueldo/30, la SQL debe hacer EXACTAMENTE eso).
  - `pagar_sueldo` vigente (202606072100, schema-qualified `public.`): copiarla ÍNTEGRA como base.

- [ ] **Step 1 — escribir `fn_liquidacion_total_canonico`** (mirror exacto). Firma:
```sql
CREATE OR REPLACE FUNCTION fn_liquidacion_total_canonico(
  p_nov_id uuid,
  p_adelantos_ids uuid[]
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_nov RECORD; v_emp RECORD;
  v_sueldo numeric; v_cuotas int; v_cuota int;
  v_sueldo_base numeric; v_valor_dia numeric; v_valor_hora numeric;
  v_desc_aus numeric; v_extras numeric; v_dobles numeric; v_feriados numeric; v_vac numeric;
  v_subtotal1 numeric; v_present numeric; v_subtotal2 numeric;
  v_adelantos numeric; v_total numeric;
BEGIN
  -- C11: auth. La RPC caller la valida; acá leemos con RLS implícito del DEFINER
  SELECT n.*, e.sueldo_mensual, e.modo_pago AS emp_modo
    INTO v_nov
    FROM rrhh_novedades n
    JOIN rrhh_empleados e ON e.id = n.empleado_id
   WHERE n.id = p_nov_id;
  IF v_nov IS NULL THEN RAISE EXCEPTION 'NOVEDAD_NO_ENCONTRADA'; END IF;

  v_sueldo := COALESCE(v_nov.sueldo_mensual, 0);
  v_cuotas := COALESCE(v_nov.cuotas_total, 1);
  v_cuota  := COALESCE(v_nov.cuota_num, 1);

  -- sueldo_base: la UI deriva modo de cuotas_total (===2 → /2). Espejar EXACTO.
  v_sueldo_base := CASE
    WHEN v_cuotas = 2 THEN v_sueldo / 2.0
    WHEN v_cuotas = 4 THEN v_sueldo / 4.0
    ELSE v_sueldo END;

  v_valor_dia  := v_sueldo / 30.0;
  v_valor_hora := v_sueldo / 30.0 / 8.0;

  v_desc_aus := GREATEST(COALESCE(v_nov.inasistencias,0), 0) * v_valor_dia;
  v_extras   := COALESCE(v_nov.horas_extras,0) * v_valor_hora;          -- PUEDE ser negativo
  v_dobles   := GREATEST(COALESCE(v_nov.dobles,0),0) * GREATEST(v_valor_dia,0);  -- valor_doble = sueldo/30
  v_feriados := GREATEST(COALESCE(v_nov.feriados,0),0) * v_valor_dia;
  v_vac      := GREATEST(COALESCE(v_nov.vacaciones_dias,0),0) * (v_sueldo/25.0 - v_sueldo/30.0);

  v_subtotal1 := v_sueldo_base - v_desc_aus + v_extras + v_dobles + v_feriados + v_vac;

  v_present := CASE
    WHEN v_cuotas = 2 AND v_cuota = 1 THEN 0  -- Q1 quincenal: presentismo diferido a Q2
    WHEN v_nov.presentismo = 'MANTIENE' THEN v_sueldo * 0.05
    ELSE 0 END;

  v_subtotal2 := v_subtotal1 + v_present;

  SELECT COALESCE(SUM(importe),0) INTO v_adelantos
    FROM rrhh_adelantos
   WHERE id = ANY(COALESCE(p_adelantos_ids, ARRAY[]::uuid[]));

  v_total := round(
    v_subtotal2
    + GREATEST(COALESCE(v_nov.bono,0),0)
    - GREATEST(v_adelantos,0)
    - GREATEST(COALESCE(v_nov.otros_descuentos,0),0)
  );

  RETURN jsonb_build_object(
    'sueldo_base', round(v_sueldo_base),
    'descuento_ausencias', round(v_desc_aus),
    'total_horas_extras', round(v_extras),
    'total_dobles', round(v_dobles),
    'total_feriados', round(v_feriados),
    'total_vacaciones', round(v_vac),
    'subtotal1', round(v_subtotal1),
    'monto_presentismo', round(v_present),
    'subtotal2', round(v_subtotal2),
    'adelantos', round(GREATEST(v_adelantos,0)),
    'otros_descuentos', round(GREATEST(COALESCE(v_nov.otros_descuentos,0),0)),
    'bono', round(GREATEST(COALESCE(v_nov.bono,0),0)),
    'total_a_pagar', GREATEST(v_total, 0)
  );
END;
$$;
REVOKE ALL ON FUNCTION fn_liquidacion_total_canonico(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_liquidacion_total_canonico(uuid, uuid[]) TO authenticated, service_role;
```
**OJO**: ese SQL es el espejo SEGÚN el resumen del relevamiento. El implementador DEBE ajustarlo a la fuente TS real leída en Step 0 (ej. si `calcularSueldoBase` usa `empleado.modo_pago` en vez de cuotas_total, o si `pagos_dobles_realizados` entra en el total, o si `round` es half-up vs banker's). El mutante de Task 3 prueba SQL==TS y es el juez final.

- [ ] **Step 2 — `pagar_sueldo` v2**: copiar la vigente y al PRINCIPIO (después del check de idempotencia, antes de insertar/revivir), insertar:
```sql
-- Recálculo canónico server-side (anti-bug del front + anti-tamper multi-tenant).
v_canon := fn_liquidacion_total_canonico(p_nov_id, p_adelantos_ids);
v_canon_total := (v_canon->>'total_a_pagar')::numeric;
IF p_calc IS NOT NULL THEN
  v_cliente_total := (p_calc->>'total_a_pagar')::numeric;
  IF abs(COALESCE(v_cliente_total, -1) - v_canon_total) > 1 THEN
    RAISE EXCEPTION 'LIQUIDACION_CALCULO_INCONSISTENTE: cliente=% server=%', v_cliente_total, v_canon_total;
  END IF;
END IF;
-- A partir de acá usar v_canon (NO p_calc) para los componentes que se guardan.
```
Reemplazar TODA lectura de `p_calc->>'campo'` en los INSERT/UPDATE de `rrhh_liquidaciones` por `v_canon->>'campo'`. `p_calc` queda solo como input a validar (compat de firma — NO cambiar la firma). Declarar las variables nuevas. Si `p_calc IS NULL` (algún caller no lo manda), usar `v_canon` directo (server-authoritative). El resto (idempotencia, formas_pago→movimientos, revivir anulada, adelantos descontado, aguinaldo_acumulado += total/12 usando v_canon_total, multi-cuenta, sin-capeo) IDÉNTICO.

- [ ] **Step 3 — `translateRpcError`**: agregar `LIQUIDACION_CALCULO_INCONSISTENTE` → mensaje español ("El monto calculado no coincide con el del sistema. Recargá la pantalla e intentá de nuevo.") en `packages/pase/src/lib/errors.ts`. (Va en Task 4 junto con cualquier toque de front, o acá si es solo el mapa — es un archivo TS, no entra en la migración.)

- [ ] **Step 4 — Commit** (solo la migración): `feat(rrhh): pagar_sueldo recalcula total canonico server-side y rechaza inconsistencias (Tier2)`

---

### Task 2: Aplicar en producción (dry-run obligatorio)

- [ ] env pull → script Write tool → DRY_RUN=1 (neutralizar BEGIN/COMMIT, ROLLBACK) → aplicar.
- [ ] Verificación post: `SELECT fn_liquidacion_total_canonico(<una novedad confirmada real>, ARRAY[]::uuid[])` y comparar a ojo contra lo que muestra la pantalla para ese empleado/mes (sanity de que el espejo da el mismo número en prod con datos reales). Documentar el caso elegido.
- [ ] Limpiar temporales.

---

### Task 3: Test mutante `pagar_sueldo_recalculo_mutante.spec.ts`

**Files:** Create `packages/pase/tests/pagar_sueldo_recalculo_mutante.spec.ts`. Patrón: `anular_pago_sueldo_mutante.spec.ts` (createDuenoClient, empleado/novedad de test, sentinels, cleanup try/catch).

- [ ] Escenarios:
  1. **SQL == TS (varias filas)**: crear empleado de test + novedad con valores variados; calcular el total esperado replicando la fórmula en el test (o importando `calcularTotalLiquidacion` del propio `lib/calculos/rrhh.ts` — preferible: importarla y comparar contra `fn_liquidacion_total_canonico`). Casos: (a) normal; (b) **hs extra NEGATIVA**; (c) **Q1 quincenal** (cuotas_total=2, cuota_num=1 → presentismo=0); (d) Q2 quincenal (presentismo aplica); (e) con bono + otros_descuentos; (f) con adelanto tildado. Para cada uno: `expect(SQL.total).toBe(TS.total)` y los componentes clave.
  2. **Pago normal funciona**: `pagar_sueldo` con `p_calc` correcto → liquidación creada, `total_a_pagar` = canónico, movimientos OK.
  3. **TAMPER rechazado**: `pagar_sueldo` con `p_calc.total_a_pagar` inflado en +$50.000 → debe fallar con `LIQUIDACION_CALCULO_INCONSISTENTE` y NO crear liquidación ni movimientos (verificar DB limpia post-error).
  4. **Sobrepago de redondeo sigue OK**: pago donde la SUMA de formas_pago excede el total por redondeo (ej. total 99.997 → pagar 100.000) con `p_calc.total_a_pagar` correcto (99.997) → NO rechaza (la validación es sobre total_a_pagar, no sobre la suma pagada); `pagos_realizados` = 100.000 (sin capeo).
- [ ] Correr: `npx playwright test --project=mutante --workers=1 tests/pagar_sueldo_recalculo_mutante.spec.ts` → PASS.
- [ ] Regresión: `anular_pago_sueldo_mutante.spec.ts` → PASS. Si falla porque ahora se guardan los componentes canónicos en vez de los del cliente y algún assert comparaba el número exacto del cliente, ajustar al canónico (documentar). Si el test viejo pasaba `p_calc` con números que NO matchean el canónico (datos de test inventados), AJUSTAR el seed del test para que la novedad produzca ese total — NO aflojar la validación.
- [ ] Commit.

---

### Task 4: errors.ts + e2e-full + cierre

- [ ] `translateRpcError` con el código nuevo (si no se hizo en Task 1 Step 3).
- [ ] e2e-full `35-sueldo-hs-negativas-sobrepago.spec.ts`: verificar que sigue verde (hs negativas + sobrepago son casos que la validación DEBE permitir — si el spec mandaba p_calc desalineado del canónico, alinear el seed). Correr suite COMPLETA `--project=e2e-full` → verde.
- [ ] `pnpm --filter pase typecheck && lint`.
- [ ] Push + deploy pase READY.
- [ ] Memoria: sprint nuevo. Registrar: pagar_sueldo ahora server-authoritative; fuera de alcance (liquidacion_final/aguinaldo/vacaciones — líneas editables, sin canónico) como pendiente Tier 2/3; la fórmula vive AHORA en DOS lugares (TS + SQL) → si se cambia la lógica de liquidación, tocar ambas + el mutante SQL==TS lo caza.

---

## Self-review
- Cobertura: recálculo server-side ✅, rechazo de tamper ✅, almacenar canónico ✅, preserva idempotencia/revivir/multi-cuenta/sin-capeo ✅, respeta hs-negativas y sobrepago-redondeo ✅ (la validación es sobre total_a_pagar canónico, no sobre el monto pagado).
- Riesgo #1: el espejo SQL debe ser EXACTO — mitigado por el mutante SQL==TS (Task 3.1) que es bloqueante. Si la fuente TS difiere del resumen del relevamiento, el implementador ajusta la SQL hasta que el mutante pase.
- Riesgo #2: drift futuro entre TS y SQL — documentado en memoria + el mutante SQL==TS lo detecta en CI si se toca uno solo.
- Fuera de alcance consciente: liquidacion_final/aguinaldo/vacaciones (human-editable, sin total canónico) — su defensa actual (líneas suman total ±$1) se mantiene; validarlas sería otro diseño (bandas de cordura), no este sprint.
